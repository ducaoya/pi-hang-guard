/**
 * Guard configuration.
 *
 * Resolution order (later wins):
 *   1. built-in defaults
 *   2. `~/.pi/agent/hang-guard.json` (or `$PI_GUARD_CONFIG`)
 *   3. legacy `PI_WATCHDOG_*` environment variables
 *   4. `PI_GUARD_*` environment variables
 *
 * A missing or broken config file never fails the guard: it falls back to
 * defaults and reports a warning. Warnings are written in the configured
 * language (see `i18n.ts`), because they are shown to the user through the UI.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ClassifyRules } from "./classify.ts";
import {
	DEFAULT_LOCALE,
	isLocale,
	messagesFor,
	type GuardMessages,
	type Locale,
} from "./i18n.ts";

/** Escalation mode. `observe` never touches a running tool. */
export type GuardMode = "observe" | "guard" | "yolo";

const GUARD_MODES: readonly GuardMode[] = ["observe", "guard", "yolo"];

export interface GuardClassifyConfig extends ClassifyRules {
	extraWatcher: string[];
	extraInteractive: string[];
	idleWhitelist: string[];
}

export interface GuardConfig {
	enabled: boolean;
	mode: GuardMode;
	/** Language of every message the guard shows a human. English by default. */
	locale: Locale;
	/**
	 * Tools that stream partial output, so "time with no output" can be measured.
	 * Built-in `bash` is the only pi tool that emits `tool_execution_update`.
	 */
	streamingTools: string[];
	/** Seconds without output before a warning. Streaming tools only. */
	idleWarnSec: number;
	/** Seconds without output before a critical warning. Streaming tools only. */
	idleCriticalSec: number;
	/** Raised thresholds for commands that may legitimately stay silent. */
	idleWhitelistWarnSec: number;
	idleWhitelistCriticalSec: number;
	/** Wall-clock seconds before a warning. Non-streaming tools and self-timed commands. */
	runtimeWarnSec: number;
	runtimeCriticalSec: number;
	/** Notification budget per tool call (1 suppresses the critical tier). */
	maxNotificationsPerCall: number;
	/** Seconds to wait after a soft kill before escalating to aborting the turn. */
	softKillGraceSec: number;
	/** Maximum automatic turn resumptions per session. `0` disables resuming. */
	maxAutoResumes: number;
	/** Minimum seconds between two automatic actions. */
	actionCooldownSec: number;
	/** Allow resuming turns in modes without a UI (`-p`, `--mode json`). */
	resumeWithoutUI: boolean;
	showStatusBar: boolean;
	notifyOnCompletion: boolean;
	/** How often the guard re-evaluates running tools. */
	tickIntervalMs: number;
	classify: GuardClassifyConfig;
}

export const DEFAULT_CONFIG: GuardConfig = {
	enabled: true,
	mode: "observe",
	locale: DEFAULT_LOCALE,
	streamingTools: ["bash"],
	idleWarnSec: 90,
	idleCriticalSec: 150,
	idleWhitelistWarnSec: 300,
	idleWhitelistCriticalSec: 600,
	runtimeWarnSec: 180,
	runtimeCriticalSec: 600,
	maxNotificationsPerCall: 2,
	softKillGraceSec: 15,
	maxAutoResumes: 1,
	actionCooldownSec: 60,
	resumeWithoutUI: false,
	showStatusBar: true,
	notifyOnCompletion: true,
	tickIntervalMs: 1000,
	classify: {
		extraWatcher: [],
		extraInteractive: [],
		idleWhitelist: [],
	},
};

export interface LoadedConfig {
	config: GuardConfig;
	warnings: string[];
	path: string;
}

export function configPathFor(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	if (env.PI_GUARD_CONFIG) return env.PI_GUARD_CONFIG;
	const agentDir = env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
	return join(agentDir, "hang-guard.json");
}

function cloneConfig(config: GuardConfig): GuardConfig {
	return {
		...config,
		streamingTools: [...config.streamingTools],
		classify: {
			extraWatcher: [...config.classify.extraWatcher],
			extraInteractive: [...config.classify.extraInteractive],
			idleWhitelist: [...config.classify.idleWhitelist],
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(
	source: Record<string, unknown>,
	key: string,
	current: number,
	warnings: string[],
	options: { min: number; max: number },
	messages: GuardMessages,
): number {
	const raw = source[key];
	if (raw === undefined) return current;
	const value = typeof raw === "string" ? Number(raw) : raw;
	if (typeof value !== "number" || !Number.isFinite(value) || value < options.min || value > options.max) {
		warnings.push(messages.configNumber(key, options.min, options.max, current));
		return current;
	}
	return value;
}

function readBoolean(
	source: Record<string, unknown>,
	key: string,
	current: boolean,
	warnings: string[],
	messages: GuardMessages,
): boolean {
	const raw = source[key];
	if (raw === undefined) return current;
	if (typeof raw !== "boolean") {
		warnings.push(messages.configBoolean(key, current));
		return current;
	}
	return raw;
}

function readStringArray(
	source: Record<string, unknown>,
	key: string,
	current: string[],
	warnings: string[],
	messages: GuardMessages,
): string[] {
	const raw = source[key];
	if (raw === undefined) return current;
	if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
		warnings.push(messages.configStringArray(key));
		return current;
	}
	return raw as string[];
}

function readLocale(
	source: Record<string, unknown>,
	key: string,
	current: Locale,
	warnings: string[],
): Locale {
	const raw = source[key];
	if (raw === undefined) return current;
	if (!isLocale(raw)) {
		warnings.push(messagesFor(current).configUnknownLocale(String(raw), current));
		return current;
	}
	return raw;
}

/**
 * Merge an untrusted partial config over a base config, validating each field.
 * Invalid values are ignored and reported instead of throwing.
 *
 * `locale` only selects the language of the emitted warnings; the merged config
 * always carries the value the user asked for (or the base value).
 */
export function mergeConfig(
	base: GuardConfig,
	patch: unknown,
	warnLocale: Locale = base.locale,
): { config: GuardConfig; warnings: string[] } {
	const warnings: string[] = [];
	const config = cloneConfig(base);
	config.locale = warnLocale;
	let messages = messagesFor(config.locale);
	if (patch === undefined || patch === null) return { config, warnings };
	if (!isRecord(patch)) {
		warnings.push(messages.configNotObject);
		return { config, warnings };
	}

	// Read `locale` first so every later warning already speaks the chosen language.
	config.locale = readLocale(patch, "locale", config.locale, warnings);
	messages = messagesFor(config.locale);

	config.enabled = readBoolean(patch, "enabled", config.enabled, warnings, messages);
	config.showStatusBar = readBoolean(patch, "showStatusBar", config.showStatusBar, warnings, messages);
	config.notifyOnCompletion = readBoolean(
		patch,
		"notifyOnCompletion",
		config.notifyOnCompletion,
		warnings,
		messages,
	);

	if (patch.mode !== undefined) {
		if (GUARD_MODES.includes(patch.mode as GuardMode)) {
			config.mode = patch.mode as GuardMode;
		} else {
			warnings.push(messages.configUnknownMode(String(patch.mode), config.mode));
		}
	}

	config.streamingTools = readStringArray(patch, "streamingTools", config.streamingTools, warnings, messages);

	const bounds = { min: 0.001, max: 86_400 };
	config.idleWarnSec = readNumber(patch, "idleWarnSec", config.idleWarnSec, warnings, bounds, messages);
	config.idleCriticalSec = readNumber(patch, "idleCriticalSec", config.idleCriticalSec, warnings, bounds, messages);
	config.idleWhitelistWarnSec = readNumber(patch, "idleWhitelistWarnSec", config.idleWhitelistWarnSec, warnings, bounds, messages);
	config.idleWhitelistCriticalSec = readNumber(patch, "idleWhitelistCriticalSec", config.idleWhitelistCriticalSec, warnings, bounds, messages);
	config.runtimeWarnSec = readNumber(patch, "runtimeWarnSec", config.runtimeWarnSec, warnings, bounds, messages);
	config.runtimeCriticalSec = readNumber(patch, "runtimeCriticalSec", config.runtimeCriticalSec, warnings, bounds, messages);
	config.maxNotificationsPerCall = readNumber(patch, "maxNotificationsPerCall", config.maxNotificationsPerCall, warnings, {
		min: 1,
		max: 100,
	}, messages);
	config.softKillGraceSec = readNumber(patch, "softKillGraceSec", config.softKillGraceSec, warnings, {
		min: 0,
		max: 3_600,
	}, messages);
	config.maxAutoResumes = readNumber(patch, "maxAutoResumes", config.maxAutoResumes, warnings, {
		min: 0,
		max: 10,
	}, messages);
	config.actionCooldownSec = readNumber(patch, "actionCooldownSec", config.actionCooldownSec, warnings, {
		min: 0,
		max: 86_400,
	}, messages);
	config.resumeWithoutUI = readBoolean(patch, "resumeWithoutUI", config.resumeWithoutUI, warnings, messages);
	config.tickIntervalMs = readNumber(patch, "tickIntervalMs", config.tickIntervalMs, warnings, {
		min: 20,
		max: 600_000,
	}, messages);

	if (patch.classify !== undefined) {
		if (!isRecord(patch.classify)) {
			warnings.push(messages.configClassifyNotObject);
		} else {
			const classify = patch.classify;
			config.classify.extraWatcher = readStringArray(classify, "extraWatcher", config.classify.extraWatcher, warnings, messages);
			config.classify.extraInteractive = readStringArray(
				classify,
				"extraInteractive",
				config.classify.extraInteractive,
				warnings,
				messages,
			);
			config.classify.idleWhitelist = readStringArray(classify, "idleWhitelist", config.classify.idleWhitelist, warnings, messages);
		}
	}

	if (config.idleCriticalSec < config.idleWarnSec) {
		warnings.push(messages.configOrder("idle"));
		config.idleCriticalSec = config.idleWarnSec;
	}
	if (config.runtimeCriticalSec < config.runtimeWarnSec) {
		warnings.push(messages.configOrder("runtime"));
		config.runtimeCriticalSec = config.runtimeWarnSec;
	}

	return { config, warnings };
}

function envNumberToSec(
	env: NodeJS.ProcessEnv,
	name: string,
	current: number,
	warnings: string[],
	messages: GuardMessages,
): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return current;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		warnings.push(messages.envNumber(name));
		return current;
	}
	return value / 1000;
}

function applyEnv(
	config: GuardConfig,
	env: NodeJS.ProcessEnv,
	warnings: string[],
	warnLocale: Locale = DEFAULT_LOCALE,
): void {
	const messages = messagesFor(warnLocale);
	// Legacy PI_WATCHDOG_* names stay supported so an existing setup keeps working.
	const legacyOff = env.PI_WATCHDOG_OFF;
	if (legacyOff === "1" || legacyOff === "true") config.enabled = false;
	config.idleWarnSec = envNumberToSec(env, "PI_WATCHDOG_WARN_MS", config.idleWarnSec, warnings, messages);
	config.idleCriticalSec = envNumberToSec(env, "PI_WATCHDOG_CRITICAL_MS", config.idleCriticalSec, warnings, messages);

	const off = env.PI_GUARD_OFF;
	if (off === "1" || off === "true") config.enabled = false;
	const on = env.PI_GUARD_ON;
	if (on === "1" || on === "true") config.enabled = true;

	const mode = env.PI_GUARD_MODE;
	if (mode !== undefined && mode !== "" && !GUARD_MODES.includes(mode as GuardMode)) {
		warnings.push(messages.envMode(mode));
	} else if (mode) {
		config.mode = mode as GuardMode;
	}

	// The environment outranks the config file, so a valid PI_GUARD_LOCALE wins here.
	const locale = env.PI_GUARD_LOCALE;
	if (locale !== undefined && locale !== "") {
		if (isLocale(locale)) config.locale = locale;
		else warnings.push(messages.envLocale(locale));
	}

	config.idleWarnSec = envNumberToSec(env, "PI_GUARD_IDLE_WARN_MS", config.idleWarnSec, warnings, messages);
	config.idleCriticalSec = envNumberToSec(env, "PI_GUARD_IDLE_CRITICAL_MS", config.idleCriticalSec, warnings, messages);
	config.runtimeWarnSec = envNumberToSec(env, "PI_GUARD_RUNTIME_WARN_MS", config.runtimeWarnSec, warnings, messages);
	config.runtimeCriticalSec = envNumberToSec(env, "PI_GUARD_RUNTIME_CRITICAL_MS", config.runtimeCriticalSec, warnings, messages);
	config.softKillGraceSec = envNumberToSec(env, "PI_GUARD_SOFT_KILL_GRACE_MS", config.softKillGraceSec, warnings, messages);
	config.actionCooldownSec = envNumberToSec(env, "PI_GUARD_ACTION_COOLDOWN_MS", config.actionCooldownSec, warnings, messages);

	const maxResumes = env.PI_GUARD_MAX_AUTO_RESUMES;
	if (maxResumes !== undefined && maxResumes !== "") {
		const value = Number(maxResumes);
		if (!Number.isFinite(value) || value < 0 || value > 10) {
			warnings.push(messages.envMaxResumes);
		} else {
			config.maxAutoResumes = value;
		}
	}
	if (env.PI_GUARD_RESUME_WITHOUT_UI === "1" || env.PI_GUARD_RESUME_WITHOUT_UI === "true") {
		config.resumeWithoutUI = true;
	}
	const tickRaw = env.PI_GUARD_TICK_MS;
	if (tickRaw !== undefined && tickRaw !== "") {
		const tick = Number(tickRaw);
		if (!Number.isFinite(tick) || tick < 20 || tick > 600_000) {
			warnings.push(messages.envTick);
		} else {
			config.tickIntervalMs = tick;
		}
	}

	if (config.idleCriticalSec < config.idleWarnSec) config.idleCriticalSec = config.idleWarnSec;
	if (config.runtimeCriticalSec < config.runtimeWarnSec) config.runtimeCriticalSec = config.runtimeWarnSec;
}

export interface LoadConfigOptions {
	path?: string;
	env?: NodeJS.ProcessEnv;
	/** Injectable reader so tests never touch the real filesystem. */
	readFile?: (path: string) => string;
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
	const env = options.env ?? process.env;
	const path = options.path ?? configPathFor(env);
	const readFile = options.readFile ?? ((file: string) => readFileSync(file, "utf8"));
	const warnings: string[] = [];

	let patch: unknown;
	try {
		patch = JSON.parse(readFile(path));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/ENOENT/.test(message)) {
			warnings.push(messagesFor(pickLocale(patch, env)).readError(path, message));
		}
	}

	// Warnings must already speak the user's language, so the locale is resolved
	// before the merge (env wins, then the config file, then English).
	const warnLocale = pickLocale(patch, env);
	const merged = mergeConfig(DEFAULT_CONFIG, patch, warnLocale);
	applyEnv(merged.config, env, merged.warnings, warnLocale);

	return { config: merged.config, warnings: [...warnings, ...merged.warnings], path };
}

/** Best-effort locale used to language the diagnostics emitted while loading. */
function pickLocale(patch: unknown, env: NodeJS.ProcessEnv): Locale {
	const fromEnv = env.PI_GUARD_LOCALE;
	if (isLocale(fromEnv)) return fromEnv;
	if (isRecord(patch) && isLocale(patch.locale)) return patch.locale;
	return DEFAULT_LOCALE;
}

export function selectClassifyRules(config: GuardConfig): ClassifyRules {
	return {
		extraWatcher: config.classify.extraWatcher,
		extraInteractive: config.classify.extraInteractive,
		idleWhitelist: config.classify.idleWhitelist,
	};
}
