import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CONFIG, mergeConfig, type GuardConfig } from "../config.ts";
import { createGuardEngine, type GuardActions, type GuardEngine, type SoftKillOutcome } from "../engine.ts";
import { resumeMessage } from "../format.ts";

interface ActionsSpy extends GuardActions {
	softKills: number;
	aborts: number;
}

interface Harness {
	engine: GuardEngine;
	actions: ActionsSpy;
	notifications: Array<{ message: string; level: string }>;
	statuses: Map<string, string>;
	advance(ms: number): void;
	tick(): void;
	setConfig(patch: Partial<GuardConfig>): void;
	startBash(toolCallId: string, command: string): void;
}

function createHarness(patch: Partial<GuardConfig> = {}, softKillResult?: SoftKillOutcome[]): Harness {
	let clock = 0;
	let config = mergeConfig(DEFAULT_CONFIG, { idleWarnSec: 90, idleCriticalSec: 150, ...patch }).config;
	const statuses = new Map<string, string>();
	const notifications: Array<{ message: string; level: string }> = [];
	const queue = softKillResult ? [...softKillResult] : undefined;

	const actions: ActionsSpy = {
		softKills: 0,
		aborts: 0,
		softKill(): SoftKillOutcome {
			this.softKills += 1;
			if (queue) return queue.shift() ?? { ok: false, detail: "queue exhausted" };
			return { ok: true, detail: "test killer" };
		},
		abortTurn(): void {
			this.aborts += 1;
		},
	};

	const engine = createGuardEngine({
		now: () => clock,
		config: () => config,
		actions,
		ui: {
			setStatus: (key, text) => {
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
		actions,
		notifications,
		statuses,
		advance(ms) {
			clock += ms;
		},
		tick() {
			engine.tick();
		},
		setConfig(next) {
			config = { ...config, ...next };
		},
		startBash(toolCallId, command) {
			engine.onToolStart({ toolCallId, toolName: "bash", args: { command } });
		},
	};
}

test("observe mode never touches a running tool", () => {
	const h = createHarness({ mode: "observe" });
	h.startBash("t1", "npm run dev");

	h.advance(200_000);
	h.tick();

	assert.equal(h.actions.softKills, 0);
	assert.equal(h.actions.aborts, 0);
	assert.equal(h.engine.consumeResume(), null);
	assert.ok(h.notifications.some((n) => /疑似卡死/.test(n.message)));
	assert.equal(h.engine.stats().actions, 0);
});

test("guard mode aborts the turn and queues exactly one structured resume", () => {
	const h = createHarness({ mode: "guard", maxAutoResumes: 1 });
	h.startBash("t1", "npm run dev");

	h.advance(200_000);
	h.tick();

	assert.equal(h.actions.aborts, 1, "the turn is aborted once");
	assert.equal(h.actions.softKills, 0);
	assert.ok(h.notifications.some((n) => /已中止本轮对话/.test(n.message)));

	const report = h.engine.consumeResume();
	assert.ok(report, "a resume report must be queued");
	assert.equal(report?.action, "abort");
	assert.equal(report?.command, "npm run dev");
	assert.equal(report?.resumeIndex, 1);
	assert.equal(report?.maxResumes, 1);
	assert.equal(report?.observedMs, 200_000);

	assert.equal(h.engine.consumeResume(), null, "consuming clears the queue");
	assert.equal(h.engine.stats().pendingResume, false);
});

test("escalation is idempotent per tool", () => {
	const h = createHarness({ mode: "guard" });
	h.startBash("t1", "npm run dev");

	h.advance(200_000);
	h.tick();
	h.tick();
	h.tick();

	assert.equal(h.actions.aborts, 1, "a flagged tool must not be aborted repeatedly");
});

test("the action cooldown prevents cascading actions in one tick", () => {
	const h = createHarness({ mode: "guard", actionCooldownSec: 60 });
	h.startBash("a", "npm run dev");
	h.startBash("b", "npm run build");

	h.advance(200_000);
	h.tick();

	assert.equal(h.actions.aborts, 1, "only the first critical tool acts within the cooldown");
	assert.equal(h.engine.stats().actions, 1);
});

test("maxAutoResumes caps how often the flow is restarted", () => {
	const h = createHarness({ mode: "guard", maxAutoResumes: 1, actionCooldownSec: 0 });

	h.startBash("t1", "npm run dev");
	h.advance(200_000);
	h.tick();
	assert.equal(h.engine.consumeResume()?.resumeIndex, 1);

	// A second, independent stuck command after the first turn ended.
	h.engine.onAgentSettled();
	h.startBash("t2", "npm run build");
	h.advance(200_000);
	h.tick();

	assert.equal(h.actions.aborts, 2, "the guard keeps acting");
	assert.equal(h.engine.consumeResume(), null, "but stops restarting the flow");
	assert.equal(h.engine.stats().resumes, 1);
});

test("maxAutoResumes = 0 aborts without restarting", () => {
	const h = createHarness({ mode: "guard", maxAutoResumes: 0 });
	h.startBash("t1", "npm run dev");
	h.advance(200_000);
	h.tick();

	assert.equal(h.actions.aborts, 1);
	assert.equal(h.engine.consumeResume(), null);
});

test("yolo mode soft-kills first and aborts only after the grace period", () => {
	const h = createHarness({ mode: "yolo", softKillGraceSec: 15, actionCooldownSec: 0 });
	h.startBash("t1", "npm run dev");

	h.advance(200_000);
	h.tick();
	assert.equal(h.actions.softKills, 1);
	assert.equal(h.actions.aborts, 0, "the turn survives a soft kill");
	assert.ok(h.notifications.some((n) => /已杀掉其子进程/.test(n.message)));
	assert.equal(h.engine.consumeResume(), null, "no restart is needed while the turn survives");

	// The tool is still running 10s later: still inside the grace period.
	h.advance(10_000);
	h.tick();
	assert.equal(h.actions.aborts, 0);

	// Grace elapsed and the tool is still there: escalate.
	h.advance(6_000);
	h.tick();
	assert.equal(h.actions.aborts, 1);
	assert.equal(h.engine.consumeResume()?.action, "abort");
	assert.equal(h.engine.stats().actions, 2, "soft kill + abort are both logged");
});

test("yolo mode skips the soft kill when the grace period is zero", () => {
	const h = createHarness({ mode: "yolo", softKillGraceSec: 0, actionCooldownSec: 0 });
	h.startBash("t1", "npm run dev");

	h.advance(200_000);
	h.tick();
	assert.equal(h.actions.softKills, 1);
	assert.equal(h.actions.aborts, 0);

	h.advance(1_000);
	h.tick();
	assert.equal(h.actions.aborts, 1);
});

test("a pending soft kill is retried instead of escalating", () => {
	const h = createHarness({ mode: "yolo", actionCooldownSec: 0, softKillGraceSec: 15 }, [
		{ ok: false, detail: "resolving", pending: true },
		{ ok: true, detail: "test killer" },
	]);
	h.startBash("t1", "npm run dev");

	h.advance(200_000);
	h.tick();
	assert.equal(h.actions.softKills, 1);
	assert.equal(h.actions.aborts, 0, "a pending resolver must not escalate");

	h.advance(1_000);
	h.tick();
	assert.equal(h.actions.softKills, 2);
	assert.equal(h.actions.aborts, 0, "the successful soft kill keeps the turn alive");
});

test("an unavailable soft kill falls back to aborting", () => {
	const h = createHarness({ mode: "yolo", actionCooldownSec: 0 }, [
		{ ok: false, detail: "killTrackedDetachedChildren unavailable" },
	]);
	h.startBash("t1", "npm run dev");

	h.advance(200_000);
	h.tick();

	assert.equal(h.actions.softKills, 1);
	assert.equal(h.actions.aborts, 1, "escalates instead of leaving the command stuck");
	assert.match(
		h.engine.consumeResume()?.softKillDetail ?? "",
		/soft kill unavailable: killTrackedDetachedChildren unavailable/,
		"the report explains why the gentler option was skipped",
	);
});

test("a host without escalation actions stays observe-only", () => {
	let clock = 0;
	const notifications: string[] = [];
	const engine = createGuardEngine({
		now: () => clock,
		config: () => mergeConfig(DEFAULT_CONFIG, { mode: "guard", idleWarnSec: 10, idleCriticalSec: 20 }).config,
		ui: {
			setStatus: () => {},
			notify: (message) => {
				notifications.push(message);
			},
		},
	});

	engine.onToolStart({ toolCallId: "t1", toolName: "bash", args: { command: "npm run dev" } });
	clock += 30_000;
	assert.doesNotThrow(() => engine.tick());
	assert.equal(engine.consumeResume(), null);
	assert.equal(engine.stats().actions, 0);
	assert.ok(notifications.some((m) => /疑似卡死/.test(m)));
});

test("an abort that throws cannot break bookkeeping", () => {
	let clock = 0;
	const engine = createGuardEngine({
		now: () => clock,
		config: () => mergeConfig(DEFAULT_CONFIG, { mode: "guard", idleWarnSec: 10, idleCriticalSec: 20 }).config,
		ui: { setStatus: () => {}, notify: () => {} },
		actions: {
			softKill: () => ({ ok: false, detail: "n/a" }),
			abortTurn: () => {
				throw new Error("stale context");
			},
		},
	});

	engine.onToolStart({ toolCallId: "t1", toolName: "bash", args: { command: "npm run dev" } });
	clock += 30_000;
	assert.doesNotThrow(() => engine.tick());
	engine.onToolEnd({ toolCallId: "t1", isError: true });
	assert.equal(engine.hasRunning(), false);
});

test("the action log summarises what the guard did", () => {
	const h = createHarness({ mode: "guard", actionCooldownSec: 0 });
	h.startBash("t1", "npm run dev");

	h.advance(200_000);
	h.tick();

	const log = h.engine.actionLog();
	assert.equal(log.length, 1);
	assert.equal(log[0].action, "abort");
	assert.equal(log[0].toolName, "bash");
	assert.equal(log[0].mode, "guard");
	assert.equal(log[0].thresholdSec, 150);
});

test("resumeMessage carries the reason, the command and the output tail", () => {
	const message = resumeMessage({
		action: "abort",
		toolName: "bash",
		command: "npm run dev",
		kind: "watcher",
		basis: "idle",
		observedMs: 152_000,
		thresholdSec: 150,
		mode: "guard",
		resumeIndex: 1,
		maxResumes: 2,
		outputTail: "VITE v5 ready\nPre-transform error: x.vue",
	});

	assert.match(message, /pi-hang-guard/);
	assert.match(message, /中止本轮对话/);
	assert.match(message, /第 1\/2 次自动续跑/);
	assert.match(message, /2m32s 无输出/, "the observation is rendered as a duration");
	assert.match(message, /超过 150s 阈值/);
	assert.match(message, /npm run dev/);
	assert.match(message, /Pre-transform error/);
	assert.match(message, /请继续处理/);
});

test("resumeMessage omits the tail when there is none", () => {
	const message = resumeMessage({
		action: "soft-kill",
		toolName: "bash",
		command: "sleep 600",
		kind: "one-shot",
		basis: "idle",
		observedMs: 200_000,
		thresholdSec: 150,
		mode: "yolo",
	});
	assert.match(message, /杀掉已登记的子进程/);
	assert.match(message, /第 1\/1 次自动续跑/);
	assert.ok(!message.includes("输出尾部"));
});
