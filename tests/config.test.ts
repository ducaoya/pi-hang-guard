import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_CONFIG, configPathFor, loadConfig, mergeConfig } from "../config.ts";

const MISSING = () => {
	throw new Error("ENOENT: no such file or directory");
};

test("missing config file falls back to defaults without noise", () => {
	const loaded = loadConfig({ path: "/nope/hang-guard.json", env: {}, readFile: MISSING });
	assert.equal(loaded.warnings.length, 0);
	assert.deepEqual(loaded.config, DEFAULT_CONFIG);
});

test("broken JSON and unreadable files are reported but never fatal", () => {
	const broken = loadConfig({
		path: "/tmp/x.json",
		env: {},
		readFile: () => "{ not json",
	});
	assert.equal(broken.warnings.length, 1);
	assert.match(broken.warnings[0], /could not read/);
	assert.equal(broken.config.idleWarnSec, DEFAULT_CONFIG.idleWarnSec);
});

test("valid fields are applied and invalid fields keep the default", () => {
	const loaded = loadConfig({
		path: "/tmp/x.json",
		env: {},
		readFile: () =>
			JSON.stringify({
				enabled: false,
				idleWarnSec: 12,
				idleCriticalSec: 30,
				runtimeWarnSec: "45",
				showStatusBar: "yes",
				maxNotificationsPerCall: 0,
				tickIntervalMs: 250,
				streamingTools: ["bash", "custom-shell"],
				classify: { extraWatcher: ["^my-server"], idleWhitelist: ["slow-thing"] },
			}),
	});
	const config = loaded.config;
	assert.equal(config.enabled, false);
	assert.equal(config.idleWarnSec, 12);
	assert.equal(config.idleCriticalSec, 30);
	assert.equal(config.runtimeWarnSec, 45, "numeric strings should be accepted");
	assert.equal(config.showStatusBar, DEFAULT_CONFIG.showStatusBar, "wrong type keeps the default");
	assert.equal(config.maxNotificationsPerCall, DEFAULT_CONFIG.maxNotificationsPerCall, "out-of-range keeps the default");
	assert.equal(config.tickIntervalMs, 250);
	assert.deepEqual(config.streamingTools, ["bash", "custom-shell"]);
	assert.deepEqual(config.classify.extraWatcher, ["^my-server"]);
	assert.deepEqual(config.classify.idleWhitelist, ["slow-thing"]);
	assert.equal(loaded.warnings.length, 2);
});

test("critical thresholds below the warn threshold are clamped", () => {
	const loaded = loadConfig({
		path: "/tmp/x.json",
		env: {},
		readFile: () => JSON.stringify({ idleWarnSec: 100, idleCriticalSec: 10 }),
	});
	assert.equal(loaded.config.idleCriticalSec, 100);
	assert.match(loaded.warnings.join(" "), /idleCriticalSec is lower/);
});

test("non-object config and non-object classify are rejected cleanly", () => {
	assert.match(mergeConfig(DEFAULT_CONFIG, "nope").warnings.join(" "), /must be a JSON object/);
	assert.match(
		mergeConfig(DEFAULT_CONFIG, { classify: "nope" }).warnings.join(" "),
		/"classify" must be an object/,
	);
});

test("escalation modes are accepted and unknown modes are rejected", () => {
	for (const mode of ["observe", "guard", "yolo"]) {
		const loaded = loadConfig({
			path: "/tmp/x.json",
			env: {},
			readFile: () => JSON.stringify({ mode }),
		});
		assert.equal(loaded.config.mode, mode);
		assert.deepEqual(loaded.warnings, [], `mode ${mode} must not warn`);
	}

	const unknown = loadConfig({
		path: "/tmp/x.json",
		env: {},
		readFile: () => JSON.stringify({ mode: "sledgehammer" }),
	});
	assert.equal(unknown.config.mode, "observe");
	assert.match(unknown.warnings.join(" "), /unknown mode/);
});

test("escalation knobs are validated and clamped", () => {
	const loaded = loadConfig({
		path: "/tmp/x.json",
		env: {},
		readFile: () =>
			JSON.stringify({
				softKillGraceSec: 5,
				maxAutoResumes: 3,
				actionCooldownSec: 0,
				resumeWithoutUI: true,
				maxAutoResumesBogus: 1,
			}),
	});
	assert.equal(loaded.config.softKillGraceSec, 5);
	assert.equal(loaded.config.maxAutoResumes, 3);
	assert.equal(loaded.config.actionCooldownSec, 0);
	assert.equal(loaded.config.resumeWithoutUI, true);

	const outOfRange = loadConfig({
		path: "/tmp/x.json",
		env: {},
		readFile: () => JSON.stringify({ maxAutoResumes: 99, softKillGraceSec: -1, resumeWithoutUI: "yes" }),
	});
	assert.equal(outOfRange.config.maxAutoResumes, DEFAULT_CONFIG.maxAutoResumes);
	assert.equal(outOfRange.config.softKillGraceSec, DEFAULT_CONFIG.softKillGraceSec);
	assert.equal(outOfRange.config.resumeWithoutUI, DEFAULT_CONFIG.resumeWithoutUI);
	assert.equal(outOfRange.warnings.length, 3);
});

test("PI_GUARD_MODE accepts the escalation modes", () => {
	const guard = loadConfig({ path: "/tmp/x.json", env: { PI_GUARD_MODE: "guard" }, readFile: MISSING });
	assert.equal(guard.config.mode, "guard");
	assert.deepEqual(guard.warnings, []);

	const bogus = loadConfig({ path: "/tmp/x.json", env: { PI_GUARD_MODE: "nope" }, readFile: MISSING });
	assert.equal(bogus.config.mode, "observe");
	assert.match(bogus.warnings.join(" "), /not a known mode/);
});

test("PI_GUARD_* environment variables override the file", () => {
	const loaded = loadConfig({
		path: "/tmp/x.json",
		env: {
			PI_GUARD_IDLE_WARN_MS: "5000",
			PI_GUARD_IDLE_CRITICAL_MS: "9000",
			PI_GUARD_RUNTIME_WARN_MS: "1000",
			PI_GUARD_TICK_MS: "30",
		},
		readFile: () => JSON.stringify({ idleWarnSec: 120 }),
	});
	assert.equal(loaded.config.idleWarnSec, 5);
	assert.equal(loaded.config.idleCriticalSec, 9);
	assert.equal(loaded.config.runtimeWarnSec, 1);
	assert.equal(loaded.config.tickIntervalMs, 30);
});

test("legacy PI_WATCHDOG_* variables still work", () => {
	const loaded = loadConfig({
		path: "/tmp/x.json",
		env: { PI_WATCHDOG_WARN_MS: "2000", PI_WATCHDOG_CRITICAL_MS: "7000" },
		readFile: MISSING,
	});
	assert.equal(loaded.config.idleWarnSec, 2);
	assert.equal(loaded.config.idleCriticalSec, 7);
});

test("disable switches: OFF wins over the file, PI_GUARD_ON wins over OFF", () => {
	const off = loadConfig({ path: "/tmp/x.json", env: { PI_WATCHDOG_OFF: "1" }, readFile: MISSING });
	assert.equal(off.config.enabled, false);

	const reOn = loadConfig({
		path: "/tmp/x.json",
		env: { PI_GUARD_OFF: "1", PI_GUARD_ON: "1" },
		readFile: MISSING,
	});
	assert.equal(reOn.config.enabled, true);
});

test("invalid env numbers are reported and ignored", () => {
	const loaded = loadConfig({
		path: "/tmp/x.json",
		env: { PI_GUARD_IDLE_WARN_MS: "abc", PI_GUARD_TICK_MS: "-5" },
		readFile: MISSING,
	});
	assert.equal(loaded.config.idleWarnSec, DEFAULT_CONFIG.idleWarnSec);
	assert.equal(loaded.config.tickIntervalMs, DEFAULT_CONFIG.tickIntervalMs);
	assert.equal(loaded.warnings.length, 2);
});

test("configPathFor honours PI_GUARD_CONFIG and the agent dir override", () => {
	assert.equal(configPathFor({ PI_GUARD_CONFIG: "/custom/guard.json" }, "/home/u"), "/custom/guard.json");
	assert.equal(
		configPathFor({ PI_CODING_AGENT_DIR: "/custom/agent" }, "/home/u"),
		join("/custom/agent", "hang-guard.json"),
	);
	assert.match(configPathFor({}, "/home/u"), /hang-guard\.json$/);
	assert.equal(
		configPathFor({}, "/home/u"),
		join("/home/u", ".pi", "agent", "hang-guard.json"),
	);
});

test("merging never mutates the base config", () => {
	const base = structuredClone(DEFAULT_CONFIG);
	mergeConfig(base, { idleWarnSec: 1, classify: { idleWhitelist: ["x"] } });
	assert.deepEqual(base, DEFAULT_CONFIG);
});
