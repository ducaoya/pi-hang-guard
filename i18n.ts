/**
 * User-facing strings, keyed by locale.
 *
 * Every string the guard shows to a human — footer status, notifications,
 * `/guard` replies, the structured resume report, and config diagnostics — is
 * defined here exactly once per locale. `format.ts` and `config.ts` both read
 * from this table, so adding a message means adding it to `GuardMessages` and
 * filling in both locales (the compiler enforces that).
 *
 * Pure data and pure functions: no timers, no I/O, no pi API.
 *
 * English is the default. `locale: "zh"` switches the whole surface.
 */

export type Locale = "en" | "zh";

export const LOCALES: readonly Locale[] = ["en", "zh"];
export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: unknown): value is Locale {
	return value === "en" || value === "zh";
}

/** Accepts anything; returns `fallback` (English by default) for unknown values. */
export function resolveLocale(value: unknown, fallback: Locale = DEFAULT_LOCALE): Locale {
	return isLocale(value) ? value : fallback;
}

export interface ResumeReportText {
	action: "soft-kill" | "abort";
	toolName: string;
	command: string;
	kind: string;
	basis: "idle" | "runtime";
	observedMs: number;
	thresholdSec: number;
	mode: string;
	resumeIndex: number;
	maxResumes: number;
	/** English capability diagnostics from the host (not localized on purpose). */
	softKillDetail?: string;
}

export interface GuardMessages {
	/* ---- observations ---- */
	/** `1m30s idle` */
	idleObservation(duration: string): string;
	/** `running 1m30s` */
	runtimeObservation(duration: string): string;
	noCommand: string;
	/** Footer tag appended in observe mode once a tool crosses the critical threshold. */
	notifyOnly: string;
	/** `1m30s idle (server/watch)` */
	observationWithKind(observation: string, kind: string): string;
	/** `2m30s idle (over the 150s threshold, server/watch)` */
	criticalReason(observation: string, thresholdSec: number, kind: string): string;
	/** `command: npm run dev` */
	commandLine(command: string): string;

	/* ---- notifications ---- */
	warnBody: string;
	criticalObserveBody: string;
	criticalActBody: string;

	/* ---- completion report ---- */
	completedOutcome: string;
	failedOutcome: string;
	/** `longest idle` / `longest run` */
	peakLabel(basis: "idle" | "runtime"): string;
	completion(input: {
		toolName: string;
		outcome: string;
		duration: string;
		peak?: { label: string; duration: string };
	}): string;

	/* ---- escalation ---- */
	actionLabel(action: "soft-kill" | "abort"): string;
	abortNotice(input: {
		toolName: string;
		basis: "idle" | "runtime";
		resume?: { index: number; max: number };
	}): string;
	softKillNotice(input: { toolName: string }): string;

	/* ---- structured report handed back to the model ---- */
	resume(input: ResumeReportText & { reason: string; outputTail?: string }): string;
	/** `captured output tail:` */
	outputTailLabel: string;
	/** The closing instruction telling the model what to do next. */
	resumeInstruction: string;

	/* ---- `/guard` command surface ---- */
	enabledNotice(mode: string): string;
	disabledNotice: string;
	reloadedNotice(path: string, warningCount: number): string;
	usageNotice: string;
	configProblemNotice(count: number, path: string, warnings: string[]): string;
	reportConfigLine(path: string): string;
	reportWarningsLine(warnings: string[]): string;
	reportActionLine(input: {
		action: string;
		toolName: string;
		command: string;
		observation: string;
	}): string;

	/* ---- config diagnostics ---- */
	configNumber(key: string, min: number, max: number, current: number): string;
	configBoolean(key: string, current: boolean): string;
	configStringArray(key: string): string;
	configNotObject: string;
	configUnknownMode(value: string, current: string): string;
	configClassifyNotObject: string;
	configOrder(field: "idle" | "runtime"): string;
	configUnknownLocale(value: string, current: string): string;
	readError(path: string, message: string): string;
	envNumber(name: string): string;
	envMode(value: string): string;
	envMaxResumes: string;
	envTick: string;
	envLocale(value: string): string;
}

const en: GuardMessages = {
	idleObservation: (duration) => `${duration} idle`,
	runtimeObservation: (duration) => `running ${duration}`,
	noCommand: "(no command)",
	notifyOnly: "notify only",
	observationWithKind: (observation, kind) => `${observation} (${kind})`,
	criticalReason: (observation, thresholdSec, kind) =>
		`${observation} (over the ${thresholdSec}s threshold, ${kind})`,
	commandLine: (command) => `command: ${command}`,

	warnBody: "Possibly stuck. Keep waiting, or press Esc to interrupt.",
	criticalObserveBody:
		"Likely stuck. Running in observe mode, so nothing is interrupted automatically — press Esc to interrupt.",
	criticalActBody: "Likely stuck. Check whether the command is waiting for input or has lost its connection.",

	completedOutcome: "completed",
	failedOutcome: "failed",
	peakLabel: (basis) => (basis === "idle" ? "longest idle" : "longest run"),
	completion: ({ toolName, outcome, duration, peak }) =>
		`${toolName} ${outcome} (took ${duration}${peak ? `, ${peak.label} ${peak.duration}` : ""})`,

	actionLabel: (action) =>
		action === "soft-kill" ? "soft-killed the tracked child processes (turn continues)" : "aborted the turn",
	abortNotice: ({ toolName, basis, resume }) =>
		`pi-hang-guard: ${toolName} ${basis === "idle" ? "idle" : "running"} past the threshold; aborted this turn` +
		(resume ? ` (auto-resuming ${resume.index}/${resume.max})` : ""),
	softKillNotice: ({ toolName }) =>
		`pi-hang-guard: ${toolName} past the threshold; killed its child processes ` +
		`(this turn continues, the tool returns a non-zero exit code)`,

	resume: (input) => {
		const lines = [
			"[pi-hang-guard] automatically handled a command that looked stuck",
			"",
			`action: ${en.actionLabel(input.action)} (auto-resume ${input.resumeIndex}/${input.maxResumes}, mode=${input.mode})`,
			`reason: ${input.reason}`,
			en.commandLine(input.command),
		];
		if (input.softKillDetail) lines.push(`detail: ${input.softKillDetail}`);
		const tail = input.outputTail?.trim() ?? "";
		if (tail !== "") {
			lines.push("", en.outputTailLabel, "```", tail.slice(-MAX_TAIL_CHARS), "```");
		}
		lines.push("", en.resumeInstruction);
		return lines.join("\n");
	},
	outputTailLabel: "captured output tail:",
	resumeInstruction:
		"Continue now. First decide whether the command is waiting for input, stalled on the network, " +
		"or is itself a dev/watch service. If it is a service, run it in the background and poll its log " +
		"instead of blocking the foreground.",

	enabledNotice: (mode) => `pi-hang-guard: enabled (${mode} mode)`,
	disabledNotice: "pi-hang-guard: disabled",
	reloadedNotice: (path, warningCount) =>
		`pi-hang-guard: config reloaded (${path}), warnings=${warningCount}`,
	usageNotice: "usage: /guard [status | on | off | reload]",
	configProblemNotice: (count, path, warnings) =>
		`pi-hang-guard: ${count} config problem(s) in ${path}\n- ${warnings.join("\n- ")}`,
	reportConfigLine: (path) => `config: ${path}`,
	reportWarningsLine: (warnings) => `warnings: ${warnings.join(" | ")}`,
	reportActionLine: ({ action, toolName, command, observation }) =>
		`action: ${action} · ${toolName} · ${command} · ${observation}`,

	configNumber: (key, min, max, current) =>
		`"${key}" must be a number between ${min} and ${max}; keeping ${current}`,
	configBoolean: (key, current) => `"${key}" must be a boolean; keeping ${current}`,
	configStringArray: (key) => `"${key}" must be an array of strings; keeping the default`,
	configNotObject: "config must be a JSON object; using defaults",
	configUnknownMode: (value, current) => `unknown mode "${value}"; keeping "${current}"`,
	configClassifyNotObject: '"classify" must be an object; keeping the default',
	configOrder: (field) =>
		field === "idle"
			? "idleCriticalSec is lower than idleWarnSec; using idleWarnSec for both"
			: "runtimeCriticalSec is lower than runtimeWarnSec; using runtimeWarnSec for both",
	configUnknownLocale: (value, current) => `unknown locale "${value}"; keeping "${current}"`,
	readError: (path, message) => `could not read ${path}: ${message}`,
	envNumber: (name) => `${name} must be a positive number of milliseconds; ignoring it`,
	envMode: (value) => `PI_GUARD_MODE="${value}" is not a known mode; ignoring it`,
	envMaxResumes: "PI_GUARD_MAX_AUTO_RESUMES must be a number between 0 and 10; ignoring it",
	envTick: "PI_GUARD_TICK_MS must be a number of milliseconds between 20 and 600000; ignoring it",
	envLocale: (value) => `PI_GUARD_LOCALE="${value}" is not a supported locale; ignoring it`,
};

const zh: GuardMessages = {
	idleObservation: (duration) => `${duration} 无输出`,
	runtimeObservation: (duration) => `已运行 ${duration}`,
	noCommand: "(无命令)",
	notifyOnly: "仅提醒",
	observationWithKind: (observation, kind) => `${observation}（${kind}）`,
	criticalReason: (observation, thresholdSec, kind) =>
		`${observation}（超过 ${thresholdSec}s 阈值，${kind}）`,
	commandLine: (command) => `命令: ${command}`,

	warnBody: "可能卡住。继续等待，或按 Esc 中断。",
	criticalObserveBody: "疑似卡死。当前为观察模式（observe），不会自动中断；按 Esc 手动中断。",
	criticalActBody: "疑似卡死，请检查该命令是否在等待输入或已失去连接。",

	completedOutcome: "完成",
	failedOutcome: "失败",
	peakLabel: (basis) => (basis === "idle" ? "最长静默" : "最长运行"),
	completion: ({ toolName, outcome, duration, peak }) =>
		`${toolName} 最终${outcome}（耗时 ${duration}${peak ? `，${peak.label} ${peak.duration}` : ""}）`,

	actionLabel: (action) =>
		action === "soft-kill" ? "杀掉已登记的子进程（保留本轮对话）" : "中止本轮对话",
	abortNotice: ({ toolName, basis, resume }) =>
		`pi-hang-guard: ${toolName} ${basis === "idle" ? "静默" : "运行"}超阈值，已中止本轮对话` +
		(resume ? `（将自动续跑 ${resume.index}/${resume.max}）` : ""),
	softKillNotice: ({ toolName }) =>
		`pi-hang-guard: ${toolName} 超阈值，已杀掉其子进程（保留本轮对话，工具将以非零退出码返回）`,

	resume: (input) => {
		const lines = [
			"[pi-hang-guard] 已自动处置一个疑似卡死的命令",
			"",
			`动作: ${zh.actionLabel(input.action)}（第 ${input.resumeIndex}/${input.maxResumes} 次自动续跑，mode=${input.mode}）`,
			`原因: ${input.reason}`,
			zh.commandLine(input.command),
		];
		if (input.softKillDetail) lines.push(`补充: ${input.softKillDetail}`);
		const tail = input.outputTail?.trim() ?? "";
		if (tail !== "") {
			lines.push("", zh.outputTailLabel, "```", tail.slice(-MAX_TAIL_CHARS), "```");
		}
		lines.push("", zh.resumeInstruction);
		return lines.join("\n");
	},
	outputTailLabel: "已收集的输出尾部:",
	resumeInstruction:
		"请继续处理：先判断该命令是在等待输入、网络挂起，还是本身就是 dev/watch 服务；" +
		"若是服务类命令，改用后台运行并轮询日志，不要在前台阻塞。",

	enabledNotice: (mode) => `pi-hang-guard: 已启用（${mode} 模式）`,
	disabledNotice: "pi-hang-guard: 已停用",
	reloadedNotice: (path, warningCount) =>
		`pi-hang-guard: 配置已重载（${path}），warnings=${warningCount}`,
	usageNotice: "用法: /guard [status | on | off | reload]",
	configProblemNotice: (count, path, warnings) =>
		`pi-hang-guard: 配置文件有 ${count} 处问题（${path}）\n- ${warnings.join("\n- ")}`,
	reportConfigLine: (path) => `配置文件: ${path}`,
	reportWarningsLine: (warnings) => `配置告警: ${warnings.join(" | ")}`,
	reportActionLine: ({ action, toolName, command, observation }) =>
		`动作: ${action} · ${toolName} · ${command} · ${observation}`,

	configNumber: (key, min, max, current) =>
		`"${key}" 必须是 ${min} 到 ${max} 之间的数字；保留 ${current}`,
	configBoolean: (key, current) => `"${key}" 必须是布尔值；保留 ${current}`,
	configStringArray: (key) => `"${key}" 必须是字符串数组；保留默认值`,
	configNotObject: "配置必须是一个 JSON 对象；使用默认值",
	configUnknownMode: (value, current) => `未知的 mode "${value}"；保留 "${current}"`,
	configClassifyNotObject: '"classify" 必须是对象；保留默认值',
	configOrder: (field) =>
		field === "idle"
			? "idleCriticalSec 小于 idleWarnSec；两者都按 idleWarnSec 处理"
			: "runtimeCriticalSec 小于 runtimeWarnSec；两者都按 runtimeWarnSec 处理",
	configUnknownLocale: (value, current) => `未知的 locale "${value}"；保留 "${current}"`,
	readError: (path, message) => `无法读取 ${path}：${message}`,
	envNumber: (name) => `${name} 必须是正的毫秒数；已忽略`,
	envMode: (value) => `PI_GUARD_MODE="${value}" 不是已知模式；已忽略`,
	envMaxResumes: "PI_GUARD_MAX_AUTO_RESUMES 必须是 0 到 10 之间的数字；已忽略",
	envTick: "PI_GUARD_TICK_MS 必须是 20 到 600000 之间的毫秒数；已忽略",
	envLocale: (value) => `PI_GUARD_LOCALE="${value}" 不是支持的语言；已忽略`,
};

/** Truncation budget for the captured output tail in a resume report. */
export const MAX_TAIL_CHARS = 1500;

const TABLES: Record<Locale, GuardMessages> = { en, zh };

/** The message table for a locale. Unknown values fall back to English. */
export function messagesFor(locale: unknown): GuardMessages {
	return TABLES[resolveLocale(locale)];
}
