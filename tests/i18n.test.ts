import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CONFIG, mergeConfig, type GuardConfig } from "../config.ts";
import { createGuardEngine } from "../engine.ts";
import { completionMessage, criticalMessage, resumeMessage, statusText, warnMessage } from "../format.ts";
import { LOCALES, messagesFor, resolveLocale, type GuardMessages } from "../i18n.ts";

/**
 * One probe per message key, with representative arguments. Both locales must
 * fill every one of them: a missing translation would surface as an empty string
 * here, long before it reaches a user's footer.
 */
function probes(m: GuardMessages): Record<string, string> {
	return {
		idleObservation: m.idleObservation("1m30s"),
		runtimeObservation: m.runtimeObservation("1m30s"),
		noCommand: m.noCommand,
		notifyOnly: m.notifyOnly,
		observationWithKind: m.observationWithKind("obs", "kind"),
		criticalReason: m.criticalReason("obs", 150, "kind"),
		commandLine: m.commandLine("npm run dev"),
		warnBody: m.warnBody,
		criticalObserveBody: m.criticalObserveBody,
		criticalActBody: m.criticalActBody,
		completedOutcome: m.completedOutcome,
		failedOutcome: m.failedOutcome,
		peakLabelIdle: m.peakLabel("idle"),
		peakLabelRuntime: m.peakLabel("runtime"),
		completionWithPeak: m.completion({
			toolName: "bash",
			outcome: "x",
			duration: "3m12s",
			peak: { label: "p", duration: "90s" },
		}),
		completionWithoutPeak: m.completion({ toolName: "bash", outcome: "x", duration: "3m12s" }),
		actionLabelSoftKill: m.actionLabel("soft-kill"),
		actionLabelAbort: m.actionLabel("abort"),
		abortNotice: m.abortNotice({ toolName: "bash", basis: "idle" }),
		abortNoticeRuntime: m.abortNotice({ toolName: "bash", basis: "runtime", resume: { index: 1, max: 2 } }),
		softKillNotice: m.softKillNotice({ toolName: "bash" }),
		resume: m.resume({
			action: "abort",
			toolName: "bash",
			command: "npm run dev",
			kind: "watcher",
			basis: "idle",
			observedMs: 200_000,
			thresholdSec: 150,
			mode: "guard",
			resumeIndex: 1,
			maxResumes: 1,
			reason: "reason",
			outputTail: "tail",
		}),
		resumeWithoutTail: m.resume({
			action: "soft-kill",
			toolName: "bash",
			command: "npm run dev",
			kind: "watcher",
			basis: "runtime",
			observedMs: 200_000,
			thresholdSec: 150,
			mode: "yolo",
			resumeIndex: 1,
			maxResumes: 1,
			reason: "reason",
			softKillDetail: "detail",
		}),
		outputTailLabel: m.outputTailLabel,
		resumeInstruction: m.resumeInstruction,
		enabledNotice: m.enabledNotice("observe"),
		disabledNotice: m.disabledNotice,
		reloadedNotice: m.reloadedNotice("/tmp/x.json", 2),
		usageNotice: m.usageNotice,
		configProblemNotice: m.configProblemNotice(1, "/tmp/x.json", ["problem"]),
		reportConfigLine: m.reportConfigLine("/tmp/x.json"),
		reportWarningsLine: m.reportWarningsLine(["problem"]),
		reportActionLine: m.reportActionLine({
			action: "abort",
			toolName: "bash",
			command: "npm run dev",
			observation: "1m30s idle",
		}),
		configNumber: m.configNumber("idleWarnSec", 1, 10, 5),
		configBoolean: m.configBoolean("enabled", true),
		configStringArray: m.configStringArray("streamingTools"),
		configNotObject: m.configNotObject,
		configUnknownMode: m.configUnknownMode("nope", "observe"),
		configClassifyNotObject: m.configClassifyNotObject,
		configOrderIdle: m.configOrder("idle"),
		configOrderRuntime: m.configOrder("runtime"),
		configUnknownLocale: m.configUnknownLocale("ja", "en"),
		readError: m.readError("/tmp/x.json", "boom"),
		envNumber: m.envNumber("PI_GUARD_IDLE_WARN_MS"),
		envMode: m.envMode("nope"),
		envMaxResumes: m.envMaxResumes,
		envTick: m.envTick,
		envLocale: m.envLocale("ja"),
	};
}

test("resolveLocale accepts only the supported locales", () => {
	assert.equal(resolveLocale("en"), "en");
	assert.equal(resolveLocale("zh"), "zh");
	assert.equal(resolveLocale("ja"), "en", "unknown values fall back to English");
	assert.equal(resolveLocale(undefined), "en");
	assert.equal(resolveLocale(42), "en");
	assert.equal(resolveLocale("ja", "zh"), "zh", "the fallback is configurable");
});

test("every message key is filled in for every locale", () => {
	for (const locale of LOCALES) {
		const table = probes(messagesFor(locale));
		for (const [key, value] of Object.entries(table)) {
			assert.equal(typeof value, "string", `${locale}.${key} must be a string`);
			assert.ok(value.trim().length > 0, `${locale}.${key} must not be empty`);
		}
	}
});

test("the two locales actually differ where a human reads them", () => {
	const en = probes(messagesFor("en"));
	const zh = probes(messagesFor("zh"));
	const translated = [
		"idleObservation",
		"runtimeObservation",
		"warnBody",
		"criticalObserveBody",
		"abortNotice",
		"softKillNotice",
		"resume",
		"enabledNotice",
		"disabledNotice",
		"usageNotice",
		"configProblemNotice",
		"configNumber",
		"envTick",
	];
	for (const key of translated) {
		assert.notEqual(en[key], zh[key], `${key} must be translated, not copied`);
	}
});

test("formatters and notifications switch language together", () => {
	const status = {
		toolName: "bash",
		command: "npm run dev",
		kind: "watcher" as const,
		basis: "idle" as const,
		observedMs: 90_000,
		level: 2 as const,
		mode: "observe" as const,
	};
	assert.match(statusText({ ...status, locale: "en" }), /1m30s idle/);
	assert.match(statusText({ ...status, locale: "en" }), /notify only/);
	assert.match(statusText({ ...status, locale: "zh" }), /1m30s 无输出/);
	assert.match(statusText({ ...status, locale: "zh" }), /仅提醒/);
	assert.match(statusText({ ...status, locale: undefined }), /1m30s idle/, "English is the default");

	const message = { ...status, thresholdSec: 150 };
	assert.match(warnMessage({ ...message, level: 1 }), /Possibly stuck/);
	assert.match(warnMessage({ ...message, locale: "zh" }), /可能卡住/);
	assert.match(criticalMessage({ ...message, locale: "en" }), /over the 150s threshold/);
	assert.match(criticalMessage({ ...message, locale: "zh" }), /超过 150s 阈值/);

	assert.match(
		completionMessage({
			toolName: "bash",
			observedMs: 192_000,
			maxObservedMs: 90_000,
			basis: "idle",
			isError: false,
		}),
		/^bash completed \(took 3m12s, longest idle 1m30s\)$/,
	);
	assert.match(
		completionMessage({
			toolName: "bash",
			observedMs: 192_000,
			maxObservedMs: 90_000,
			basis: "idle",
			isError: true,
			locale: "zh",
		}),
		/^bash 最终失败（耗时 3m12s，最长静默 1m30s）$/,
	);
});

test("the resume report is fully localized, including the command label", () => {
	const report = {
		action: "abort" as const,
		toolName: "bash",
		command: "npm run dev",
		kind: "watcher" as const,
		basis: "idle" as const,
		observedMs: 152_000,
		thresholdSec: 150,
		mode: "guard" as const,
		resumeIndex: 1,
		maxResumes: 2,
		outputTail: "VITE v5 ready",
	};
	const english = resumeMessage(report);
	assert.match(english, /automatically handled/);
	assert.match(english, /command: npm run dev/);
	assert.match(english, /captured output tail/);
	assert.match(english, /Continue now/);

	const chinese = resumeMessage({ ...report, locale: "zh" });
	assert.match(chinese, /已自动处置/);
	assert.match(chinese, /命令: npm run dev/);
	assert.match(chinese, /已收集的输出尾部/);
	assert.match(chinese, /请继续处理/);
});

test("the engine emits notifications and status text in the configured language", () => {
	let clock = 0;
	let config = mergeConfig(DEFAULT_CONFIG, { locale: "zh", idleWarnSec: 90, idleCriticalSec: 150 }).config;
	const notifications: string[] = [];
	const statuses = new Map<string, string>();

	const engine = createGuardEngine({
		now: () => clock,
		config: () => config,
		ui: {
			setStatus: (key, text) => {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			notify: (message) => notifications.push(message),
		},
	});

	engine.onToolStart({ toolCallId: "t1", toolName: "bash", args: { command: "npm run dev" } });
	clock += 91_000;
	engine.tick();

	assert.match(notifications[0], /无输出/);
	assert.match(statuses.get("guard:t1") ?? "", /无输出/);

	config = { ...config, locale: "en" };
	clock += 70_000;
	engine.tick();
	assert.match(notifications[1], /idle/);
	assert.match(notifications[1], /over the 150s threshold/);
	assert.match(statuses.get("guard:t1") ?? "", /idle/);
	assert.ok(!(statuses.get("guard:t1") ?? "").includes("无输出"), "the footer switches language too");
});

test("config diagnostics are emitted in the language the user asked for", () => {
	const config: Partial<GuardConfig> = { locale: "zh" };
	assert.equal(mergeConfig(DEFAULT_CONFIG, config).config.locale, "zh");

	const chinese = mergeConfig(DEFAULT_CONFIG, { locale: "zh", idleWarnSec: "nope" }, "zh");
	assert.match(chinese.warnings[0], /必须是/);

	const english = mergeConfig(DEFAULT_CONFIG, { idleWarnSec: "nope" });
	assert.match(english.warnings[0], /must be a number/);
});
