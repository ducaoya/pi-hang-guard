import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CONFIG, mergeConfig, type GuardConfig } from "../config.ts";
import { createGuardEngine, type GuardEngine, type NotifyLevel } from "../engine.ts";

interface Harness {
	engine: GuardEngine;
	notifications: Array<{ message: string; level: NotifyLevel }>;
	statusWrites: Array<{ key: string; text: string | undefined }>;
	advance(ms: number): void;
	tick(): void;
	statusOf(toolCallId: string): string | undefined;
	statusCount(): number;
	setConfig(patch: Partial<GuardConfig>): void;
}

function createHarness(patch: Partial<GuardConfig> = {}): Harness {
	let clock = 0;
	let config = mergeConfig(DEFAULT_CONFIG, { ...patch }).config;
	const statuses = new Map<string, string>();
	const notifications: Array<{ message: string; level: NotifyLevel }> = [];
	const statusWrites: Array<{ key: string; text: string | undefined }> = [];

	const engine = createGuardEngine({
		now: () => clock,
		config: () => config,
		ui: {
			setStatus(key, text) {
				statusWrites.push({ key, text });
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			notify: (message, level) => {
				notifications.push({ message, level });
			},
		},
	});

	return {
		engine,
		notifications,
		statusWrites,
		advance(ms) {
			clock += ms;
		},
		tick() {
			engine.tick();
		},
		statusOf(toolCallId) {
			return statuses.get(engine.statusKey(toolCallId));
		},
		statusCount() {
			return statuses.size;
		},
		setConfig(next) {
			config = { ...config, ...next };
		},
	};
}

function startBash(harness: Harness, toolCallId: string, command: string, toolName = "bash"): void {
	harness.engine.onToolStart({ toolCallId, toolName, args: { command } });
}

test("warns when a streaming command stops producing output", () => {
	const h = createHarness({ idleWarnSec: 90, idleCriticalSec: 150 });
	startBash(h, "t1", "sleep 600");

	h.advance(89_000);
	h.tick();
	assert.equal(h.notifications.length, 0, "must not warn before the threshold");
	assert.equal(h.statusCount(), 0, "no status before the first warning");

	h.advance(1_000);
	h.tick();
	assert.equal(h.notifications.length, 1);
	assert.equal(h.notifications[0].level, "warning");
	assert.match(h.notifications[0].message, /无输出/);
	assert.match(h.notifications[0].message, /sleep 600/);
	assert.match(h.statusOf("t1") ?? "", /1m30s 无输出/);
});

test("an update resets the silence clock so busy commands never warn", () => {
	const h = createHarness({ idleWarnSec: 90, idleCriticalSec: 150 });
	startBash(h, "t1", "npm run build");

	for (let i = 0; i < 5; i += 1) {
		h.advance(80_000);
		h.engine.onToolUpdate({ toolCallId: "t1" });
		h.tick();
	}
	assert.equal(h.notifications.length, 0, "5 minutes of work with output must not warn");

	h.advance(95_000);
	h.tick();
	assert.equal(h.notifications.length, 1, "warn only after 95s of true silence");
});

test("a non-streaming tool is measured by wall clock, not by silence", () => {
	const h = createHarness({ runtimeWarnSec: 180, runtimeCriticalSec: 600 });
	h.engine.onToolStart({ toolCallId: "r1", toolName: "read", args: { path: "/tmp/x" } });

	h.advance(179_000);
	h.tick();
	assert.equal(h.notifications.length, 0);

	h.advance(2_000);
	h.tick();
	assert.equal(h.notifications.length, 1);
	assert.match(h.notifications[0].message, /已运行/);
	assert.equal(h.engine.list()[0].basis, "runtime");
});

test("self-timed commands fall back to wall clock", () => {
	const h = createHarness({ idleWarnSec: 30, idleCriticalSec: 60, runtimeWarnSec: 180 });
	startBash(h, "t1", "timeout 600 npm run dev");

	h.advance(100_000);
	h.tick();
	assert.equal(h.notifications.length, 0, "the command carries its own bound, so silence is expected");
	assert.equal(h.engine.list()[0].basis, "runtime");
});

test("idle whitelist raises thresholds instead of disabling the guard", () => {
	const h = createHarness({
		idleWarnSec: 90,
		idleCriticalSec: 150,
		idleWhitelistWarnSec: 300,
		idleWhitelistCriticalSec: 600,
	});
	startBash(h, "t1", "docker build .");

	h.advance(200_000);
	h.tick();
	assert.equal(h.notifications.length, 0, "docker build may be silent for a while");

	h.advance(101_000);
	h.tick();
	assert.equal(h.notifications.length, 1);
});

test("interactive commands are skipped entirely", () => {
	const h = createHarness();
	startBash(h, "t1", "vim notes.md");

	assert.equal(h.engine.hasRunning(), false);
	assert.equal(h.engine.stats().skippedInteractive, 1);
	assert.equal(h.statusCount(), 0);

	h.advance(3_600_000);
	h.tick();
	assert.equal(h.notifications.length, 0);
});

test("concurrent tools keep independent status entries", () => {
	const h = createHarness({ idleWarnSec: 60, idleCriticalSec: 120 });
	startBash(h, "a", "npm run dev");
	startBash(h, "b", "npm run build");

	h.advance(61_000);
	h.tick();
	assert.equal(h.notifications.length, 2);
	assert.equal(h.statusCount(), 2);

	h.engine.onToolEnd({ toolCallId: "a", isError: false });
	assert.equal(h.statusOf("a"), undefined, "finished tool must clear its own status");
	assert.notEqual(h.statusOf("b"), undefined, "the other tool's status must survive");
	assert.equal(h.statusCount(), 1);
});

test("status is cleared even when only the critical tier fired", () => {
	const h = createHarness({ idleWarnSec: 90, idleCriticalSec: 150 });
	startBash(h, "t1", "sleep 600");

	h.advance(200_000);
	h.tick();
	assert.equal(h.notifications.length, 1);
	assert.equal(h.notifications[0].level, "error");
	assert.notEqual(h.statusOf("t1"), undefined);

	h.engine.onToolEnd({ toolCallId: "t1", isError: true });
	assert.equal(h.statusCount(), 0, "no leftover footer entry after the tool ends");
	assert.equal(h.engine.hasRunning(), false);
});

test("a blocking UI prompt freezes the accounting", () => {
	const h = createHarness({ idleWarnSec: 90, idleCriticalSec: 150 });
	startBash(h, "t1", "npm run dev");

	h.advance(30_000);
	h.tick();
	h.engine.onUiPromptStart();

	h.advance(630_000); // user is deciding for 10 minutes
	h.tick();
	assert.equal(h.notifications.length, 0, "waiting on the user is not a stuck command");

	h.engine.onUiPromptEnd();
	h.advance(59_000);
	h.tick();
	assert.equal(h.notifications.length, 0, "the 30s before the prompt plus 59s after is still below 90s");

	h.advance(2_000);
	h.tick();
	assert.equal(h.notifications.length, 1);
});

test("notifications are capped per tool call", () => {
	const capped = createHarness({ idleWarnSec: 10, idleCriticalSec: 20, maxNotificationsPerCall: 1 });
	startBash(capped, "t1", "sleep 600");
	capped.advance(25_000);
	capped.tick();
	assert.equal(capped.notifications.length, 1, "cap of 1 keeps only the first alert");

	const uncapped = createHarness({ idleWarnSec: 10, idleCriticalSec: 20 });
	startBash(uncapped, "t1", "sleep 600");
	uncapped.advance(15_000);
	uncapped.tick();
	uncapped.advance(10_000);
	uncapped.tick();
	assert.equal(uncapped.notifications.length, 2, "both tiers are reported by default");
	assert.equal(uncapped.notifications[1].level, "error");
});

test("the footer counter stays live for flagged tools", () => {
	const h = createHarness({ idleWarnSec: 90, idleCriticalSec: 150 });
	startBash(h, "t1", "sleep 600");

	h.advance(90_000);
	h.tick();
	assert.match(h.statusOf("t1") ?? "", /1m30s/);

	h.advance(30_000);
	h.tick();
	assert.match(h.statusOf("t1") ?? "", /2m00s/);
});

test("the footer is not rewritten while the rendered text is unchanged", () => {
	const h = createHarness({ idleWarnSec: 10, idleCriticalSec: 60, tickIntervalMs: 250 });
	startBash(h, "t1", "sleep 600");

	h.advance(10_000);
	h.tick();
	const afterFirstTick = h.statusWrites.length;
	assert.equal(afterFirstTick, 1, "the warning tick writes the status once");

	// Sub-second ticks that round to the same displayed second must not repaint.
	h.advance(200);
	h.tick();
	h.advance(200);
	h.tick();
	assert.equal(h.statusWrites.length, afterFirstTick, "no repaint while the text is identical");

	h.advance(1_000);
	h.tick();
	assert.equal(h.statusWrites.length, afterFirstTick + 1, "a new displayed second repaints once");

	h.engine.onToolEnd({ toolCallId: "t1", isError: false });
	assert.equal(h.statusWrites.at(-1)?.text, undefined, "the last write clears the status");
});

test("a flagged tool reports its final outcome", () => {
	const h = createHarness({ idleWarnSec: 90, idleCriticalSec: 150, notifyOnCompletion: true });
	startBash(h, "t1", "sleep 600");

	h.advance(100_000);
	h.tick();
	h.engine.onToolEnd({ toolCallId: "t1", isError: false });

	assert.equal(h.notifications.length, 2);
	assert.match(h.notifications[1].message, /最终完成/);
	assert.match(h.notifications[1].message, /最长静默/);
});

test("completion reporting can be turned off", () => {
	const h = createHarness({ idleWarnSec: 90, notifyOnCompletion: false });
	startBash(h, "t1", "sleep 600");
	h.advance(100_000);
	h.tick();
	h.engine.onToolEnd({ toolCallId: "t1", isError: false });
	assert.equal(h.notifications.length, 1);
});

test("agent_settled and shutdown clear every tracked tool", () => {
	const h = createHarness({ idleWarnSec: 10, idleCriticalSec: 20 });
	startBash(h, "a", "sleep 600");
	startBash(h, "b", "sleep 600");
	h.advance(15_000);
	h.tick();
	assert.equal(h.statusCount(), 2);

	h.engine.onAgentSettled();
	assert.equal(h.engine.hasRunning(), false);
	assert.equal(h.statusCount(), 0);

	startBash(h, "c", "sleep 600");
	h.advance(15_000);
	h.tick();
	h.engine.onShutdown();
	assert.equal(h.statusCount(), 0);
	assert.equal(h.engine.hasRunning(), false);
});

test("a disabled guard tracks nothing", () => {
	const h = createHarness({ enabled: false });
	startBash(h, "t1", "sleep 600");
	assert.equal(h.engine.hasRunning(), false);
	h.advance(3_600_000);
	h.tick();
	assert.equal(h.notifications.length, 0);
});

test("toggling the guard off mid-run stops alerts but still clears status", () => {
	const h = createHarness({ idleWarnSec: 90, idleCriticalSec: 150 });
	startBash(h, "t1", "sleep 600");
	h.advance(95_000);
	h.tick();
	assert.equal(h.notifications.length, 1);

	h.setConfig({ enabled: false });
	h.advance(600_000);
	h.tick();
	assert.equal(h.notifications.length, 1, "no further alerts while disabled");
	assert.equal(h.statusCount(), 1, "status is left to the tool-end cleanup");

	h.engine.onToolEnd({ toolCallId: "t1", isError: false });
	assert.equal(h.statusCount(), 0);
});

test("a UI sink that throws cannot break bookkeeping", () => {
	let clock = 0;
	const engine = createGuardEngine({
		now: () => clock,
		config: () => mergeConfig(DEFAULT_CONFIG, { idleWarnSec: 10, idleCriticalSec: 20 }).config,
		ui: {
			setStatus() {
				throw new Error("stale UI context");
			},
			notify() {
				throw new Error("stale UI context");
			},
		},
	});

	engine.onToolStart({ toolCallId: "t1", toolName: "bash", args: { command: "sleep 600" } });
	clock += 15_000;
	assert.doesNotThrow(() => engine.tick());
	engine.onToolEnd({ toolCallId: "t1", isError: false });
	assert.equal(engine.hasRunning(), false);
});

test("stats and list summarise the running set", () => {
	const h = createHarness({ idleWarnSec: 10, idleCriticalSec: 20 });
	startBash(h, "a", "npm run dev");
	startBash(h, "b", "vim x");
	h.advance(15_000);
	h.tick();

	const stats = h.engine.stats();
	assert.equal(stats.running, 1);
	assert.equal(stats.skippedInteractive, 1);
	assert.equal(stats.notifications, 1);
	assert.equal(stats.paused, false);

	const list = h.engine.list();
	assert.equal(list.length, 1);
	assert.equal(list[0].toolCallId, "a");
	assert.equal(list[0].kind, "watcher");
	assert.equal(list[0].level, 1);
});
