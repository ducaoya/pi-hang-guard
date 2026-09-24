/**
 * The guard engine.
 *
 * Pure state machine: it never creates timers and never touches the clock
 * directly. The host (index.ts) calls `tick()` on an interval and supplies
 * `now()` plus a `ui` sink, which makes every behaviour deterministic and unit
 * testable without a pi runtime.
 *
 * Detection model
 * ---------------
 * - Streaming tools (built-in `bash`) emit `tool_execution_update` while they
 *   produce output, so "seconds since the last output" is a true stuck signal.
 * - Tools that never stream cannot be measured that way, so they fall back to
 *   wall-clock runtime.
 * - Commands carrying their own bound (`timeout 600 …`) also fall back to
 *   wall-clock, because their silent phases are already bounded.
 * - While pi waits on a blocking UI prompt (permission dialogs) all accounting
 *   is frozen, otherwise "user is deciding" would look like "tool is stuck".
 */

import { classifyCommand, type CommandKind } from "./classify.ts";
import { selectClassifyRules, type GuardConfig, type GuardMode } from "./config.ts";
import { actionLabel, completionMessage, criticalMessage, statusText, warnMessage } from "./format.ts";

export type GuardLevel = 0 | 1 | 2;
export type GuardBasis = "idle" | "runtime";
export type NotifyLevel = "info" | "warning" | "error";

export interface GuardUI {
	setStatus(key: string, text: string | undefined): void;
	notify(message: string, level: NotifyLevel): void;
}

export interface GuardDeps {
	ui: GuardUI;
	config: () => GuardConfig;
	/** Injectable clock. Defaults to `Date.now`. */
	now?: () => number;
	/**
	 * Escalation capabilities supplied by the host. Omit them to make the engine
	 * observe-only regardless of `mode` — the guard still works, it just never acts.
	 */
	actions?: GuardActions;
}

/** Result of a soft kill attempt (killing tracked shell children). */
export interface SoftKillOutcome {
	ok: boolean;
	detail: string;
	/** The host is still resolving its killer; retry on the next tick instead of escalating. */
	pending?: boolean;
}

export interface GuardActions {
	/** Kill the shell processes pi is tracking. Returns whether it was possible. */
	softKill(): SoftKillOutcome;
	/** Abort the current agent turn (`ctx.abort()`). */
	abortTurn(): void;
}

/** One escalation step that was actually taken. */
export interface GuardActionReport {
	action: "soft-kill" | "abort";
	toolCallId: string;
	toolName: string;
	command: string;
	kind: CommandKind;
	basis: GuardBasis;
	observedMs: number;
	thresholdSec: number;
	mode: GuardMode;
	softKillDetail?: string;
	/** Set when this action queued an automatic turn resumption. */
	resumeIndex?: number;
	maxResumes?: number;
}

export interface ToolStartInput {
	toolCallId: string;
	toolName: string;
	args: unknown;
}

export interface ToolUpdateInput {
	toolCallId: string;
}

export interface ToolEndInput {
	toolCallId: string;
	isError: boolean;
}

export interface GuardEntryStatus {
	toolCallId: string;
	toolName: string;
	command: string;
	kind: CommandKind;
	reason: string;
	basis: GuardBasis;
	observedMs: number;
	maxObservedMs: number;
	startedAt: number;
	lastActivityAt: number;
	level: GuardLevel;
	notifications: number;
	idleWhitelisted: boolean;
	selfTimed: boolean;
}

export interface GuardStats {
	running: number;
	skippedInteractive: number;
	notifications: number;
	paused: boolean;
	actions: number;
	resumes: number;
	pendingResume: boolean;
}

interface Entry {
	toolCallId: string;
	toolName: string;
	command: string;
	kind: CommandKind;
	reason: string;
	idleWhitelisted: boolean;
	selfTimed: boolean;
	startedAt: number;
	lastActivityAt: number;
	basis: GuardBasis;
	observedMs: number;
	maxObservedMs: number;
	level: GuardLevel;
	notifications: number;
	/** Last string pushed to the UI, so unchanged seconds are not re-rendered. */
	lastStatusText?: string;
	/** Set once a soft kill was issued for this tool. */
	softKilledAt?: number;
	softKillDetail?: string;
	/** Set once we requested a turn abort for this tool. */
	abortRequested?: boolean;
}

export interface GuardEngine {
	onToolStart(input: ToolStartInput): void;
	onToolUpdate(input: ToolUpdateInput): void;
	onToolEnd(input: ToolEndInput): void;
	onUiPromptStart(): void;
	onUiPromptEnd(): void;
	/** Safety net: drop every tracked tool (turn finished). */
	onAgentSettled(): void;
	onShutdown(): void;
	tick(): void;
	list(): GuardEntryStatus[];
	stats(): GuardStats;
	hasRunning(): boolean;
	/** Escalation steps taken so far, oldest first. */
	actionLog(): GuardActionReport[];
	/** Take the queued resumption report, if any, clearing it. */
	consumeResume(): GuardActionReport | null;
	/** Status-bar key used for a tool call. Exported for tests and `/guard status`. */
	statusKey(toolCallId: string): string;
}

export function statusKeyOf(toolCallId: string): string {
	return `guard:${toolCallId}`;
}

function commandFromArgs(args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const command = (args as { command?: unknown }).command;
	return typeof command === "string" ? command : "";
}

export function createGuardEngine(deps: GuardDeps): GuardEngine {
	const now = deps.now ?? (() => Date.now());
	const entries = new Map<string, Entry>();

	let uiPromptDepth = 0;
	let pausedAt = 0;
	let skippedInteractive = 0;
	let notificationCount = 0;

	/** UI must never be able to break guard bookkeeping. */
	function tryUi(action: () => void): void {
		try {
			action();
		} catch {
			// A stale or unavailable UI context is not fatal for a watchdog.
		}
	}

	function setStatus(entry: Entry, text: string | undefined): void {
		const key = statusKeyOf(entry.toolCallId);
		tryUi(() => deps.ui.setStatus(key, text));
	}

	function notify(message: string, level: NotifyLevel): void {
		notificationCount += 1;
		tryUi(() => deps.ui.notify(message, level));
	}

	// --- escalation state -----------------------------------------------------
	let resumeCount = 0;
	let nextActionAt = 0;
	const actionsTaken: GuardActionReport[] = [];
	let resumeRequest: GuardActionReport | null = null;

	function trySoftKill(): SoftKillOutcome {
		const actions = deps.actions;
		if (!actions) return { ok: false, detail: "host has no escalation actions" };
		try {
			return actions.softKill();
		} catch (error) {
			return { ok: false, detail: error instanceof Error ? error.message : String(error) };
		}
	}

	function buildReport(
		entry: Entry,
		result: { basis: GuardBasis; observedMs: number; warnSec: number; criticalSec: number },
		config: GuardConfig,
		action: "soft-kill" | "abort",
	): GuardActionReport {
		return {
			action,
			toolCallId: entry.toolCallId,
			toolName: entry.toolName,
			command: entry.command,
			kind: entry.kind,
			basis: result.basis,
			observedMs: result.observedMs,
			thresholdSec: result.criticalSec,
			mode: config.mode,
			softKillDetail: entry.softKillDetail,
		};
	}

	/** Queue at most one resumption at a time, capped by `maxAutoResumes`. */
	function queueResume(report: GuardActionReport, config: GuardConfig): void {
		if (config.maxAutoResumes <= 0 || resumeCount >= config.maxAutoResumes) return;
		if (resumeRequest) return;
		resumeCount += 1;
		report.resumeIndex = resumeCount;
		report.maxResumes = config.maxAutoResumes;
		resumeRequest = report;
	}

	/** Abort the turn, log it, and queue a structured report for the host to deliver. */
	function abortTurn(
		entry: Entry,
		result: { basis: GuardBasis; observedMs: number; warnSec: number; criticalSec: number },
		config: GuardConfig,
		at: number,
	): void {
		const report = buildReport(entry, result, config, "abort");
		nextActionAt = at + Math.max(0, config.actionCooldownSec) * 1000;
		queueResume(report, config);
		actionsTaken.push(report);
		try {
			deps.actions?.abortTurn();
		} catch {
			// Aborting is best effort: a stale context must not break bookkeeping.
		}
		notify(
			`pi-hang-guard: ${entry.toolName} ${result.basis === "idle" ? "静默" : "运行"}超阈值，已中止本轮对话${
			report.resumeIndex ? `（将自动续跑 ${report.resumeIndex}/${report.maxResumes}）` : ""
			}`,
			"error",
		);
	}

	/**
	 * Escalation ladder. Warnings are level 1; level 2 is where the guard acts.
	 *
	 * - `observe`  never acts
	 * - `guard`    aborts the turn (official `ctx.abort()`), then reports back
	 * - `yolo`     soft-kills the tracked shell children first (the turn survives and
	 *              the model sees a normal non-zero exit), falling back to an abort
	 *              when the soft kill is unavailable or the grace period elapses
	 */
	function escalate(
		entry: Entry,
		result: { basis: GuardBasis; observedMs: number; warnSec: number; criticalSec: number },
		config: GuardConfig,
		at: number,
	): void {
		if (config.mode === "observe" || !deps.actions) return;

		if (entry.softKilledAt !== undefined) {
			if (entry.abortRequested) return;
			if (at - entry.softKilledAt < Math.max(0, config.softKillGraceSec) * 1000) return;
			entry.abortRequested = true;
			abortTurn(entry, result, config, at);
			return;
		}
		if (entry.abortRequested) return;
		if (at < nextActionAt) return;

		if (config.mode === "yolo") {
			const outcome = trySoftKill();
			if (outcome.ok) {
				entry.softKilledAt = at;
				entry.softKillDetail = outcome.detail;
				nextActionAt = at + Math.max(0, config.softKillGraceSec) * 1000;
				actionsTaken.push(buildReport(entry, result, config, "soft-kill"));
				notify(
					`pi-hang-guard: ${entry.toolName} 超阈值，已杀掉其子进程（保留本轮对话，工具将以非零退出码返回）`,
					"warning",
				);
				return;
			}
			// The host may still be resolving its killer; give it another tick.
			if (outcome.pending) return;
			// Soft kill unavailable: fall through to aborting the turn, and tell the
			// model why the gentler option was not used.
			entry.softKillDetail = `soft kill unavailable: ${outcome.detail}`;
		}

		entry.abortRequested = true;
		abortTurn(entry, result, config, at);
	}

	function isStreaming(toolName: string, config: GuardConfig): boolean {
		return config.streamingTools.includes(toolName);
	}

	/**
	 * Decide what to measure and against which thresholds.
	 *
	 * `idle` is the trustworthy signal (the process produced nothing for N
	 * seconds). It is only available for streaming tools whose command is not
	 * already bounded by its own `timeout`.
	 */
	function measure(
		entry: Entry,
		config: GuardConfig,
		at: number,
	): { basis: GuardBasis; observedMs: number; warnSec: number; criticalSec: number; level: GuardLevel } {
		const idleCapable = isStreaming(entry.toolName, config) && !entry.selfTimed;
		const basis: GuardBasis = idleCapable ? "idle" : "runtime";
		const observedMs =
			basis === "idle"
				? at - Math.max(entry.startedAt, entry.lastActivityAt)
				: at - entry.startedAt;

		let warnSec: number;
		let criticalSec: number;
		if (basis === "idle" && entry.idleWhitelisted) {
			warnSec = config.idleWhitelistWarnSec;
			criticalSec = config.idleWhitelistCriticalSec;
		} else if (basis === "idle") {
			warnSec = config.idleWarnSec;
			criticalSec = config.idleCriticalSec;
		} else {
			warnSec = config.runtimeWarnSec;
			criticalSec = config.runtimeCriticalSec;
		}

		let level: GuardLevel = 0;
		if (observedMs >= criticalSec * 1000) level = 2;
		else if (observedMs >= warnSec * 1000) level = 1;

		return { basis, observedMs, warnSec, criticalSec, level };
	}

	function toStatus(entry: Entry, level: 1 | 2, config: GuardConfig, observedMs: number): string {
		return statusText({
			toolName: entry.toolName,
			command: entry.command,
			kind: entry.kind,
			basis: entry.basis,
			observedMs,
			level,
			mode: config.mode,
		});
	}

	function clearStatus(entry: Entry): void {
		entry.lastStatusText = undefined;
		setStatus(entry, undefined);
	}

	/** Push a status line only when the rendered text actually changed. */
	function refreshStatus(entry: Entry, status: string): void {
		if (entry.lastStatusText === status) return;
		entry.lastStatusText = status;
		setStatus(entry, status);
	}

	function clearAll(): void {
		for (const entry of entries.values()) {
			clearStatus(entry);
		}
		entries.clear();
		uiPromptDepth = 0;
		pausedAt = 0;
	}

	const engine: GuardEngine = {
		statusKey: statusKeyOf,

		onToolStart(input: ToolStartInput): void {
			const config = deps.config();
			const command = commandFromArgs(input.args);
			const classification = classifyCommand(command, selectClassifyRules(config));

			if (!classification.guardable) {
				skippedInteractive += 1;
				return;
			}
			if (!config.enabled) {
				return;
			}

			const at = now();
			entries.set(input.toolCallId, {
				toolCallId: input.toolCallId,
				toolName: input.toolName,
				command,
				kind: classification.kind,
				reason: classification.reason,
				idleWhitelisted: classification.idleWhitelisted,
				selfTimed: classification.selfTimed,
				startedAt: at,
				lastActivityAt: at,
				basis: isStreaming(input.toolName, config) && !classification.selfTimed ? "idle" : "runtime",
				observedMs: 0,
				maxObservedMs: 0,
				level: 0,
				notifications: 0,
			});
		},

		onToolUpdate(input: ToolUpdateInput): void {
			// While a blocking UI prompt is open the guard is frozen, so a
			// heartbeat would not be meaningful either.
			if (uiPromptDepth > 0) return;
			const entry = entries.get(input.toolCallId);
			if (!entry) return;
			entry.lastActivityAt = now();
		},

		onToolEnd(input: ToolEndInput): void {
			const entry = entries.get(input.toolCallId);
			if (!entry) return;
			// Delete and clear first: a UI error must not leak state.
			entries.delete(input.toolCallId);
			clearStatus(entry);

			const config = deps.config();
			if (entry.level > 0 && config.notifyOnCompletion) {
				notify(
					completionMessage({
						toolName: entry.toolName,
						observedMs: now() - entry.startedAt,
						maxObservedMs: entry.maxObservedMs,
						basis: entry.basis,
						isError: input.isError,
					}),
					input.isError ? "warning" : "info",
				);
			}
		},

		onUiPromptStart(): void {
			if (uiPromptDepth === 0) pausedAt = now();
			uiPromptDepth += 1;
		},

		onUiPromptEnd(): void {
			if (uiPromptDepth === 0) return;
			uiPromptDepth -= 1;
			if (uiPromptDepth > 0) return;
			const delta = now() - pausedAt;
			pausedAt = 0;
			if (delta <= 0) return;
			for (const entry of entries.values()) {
				entry.startedAt += delta;
				entry.lastActivityAt += delta;
			}
		},

		onAgentSettled(): void {
			clearAll();
		},

		onShutdown(): void {
			clearAll();
			resumeRequest = null;
		},

		tick(): void {
			const config = deps.config();
			if (!config.enabled || uiPromptDepth > 0) return;
			const at = now();

			for (const entry of entries.values()) {
				const result = measure(entry, config, at);
				entry.basis = result.basis;
				entry.observedMs = result.observedMs;
				if (result.observedMs > entry.maxObservedMs) entry.maxObservedMs = result.observedMs;

				if (result.level > entry.level) {
					entry.level = result.level;
					if (config.showStatusBar) refreshStatus(entry, toStatus(entry, result.level as 1 | 2, config, result.observedMs));

					if (entry.notifications < config.maxNotificationsPerCall) {
						entry.notifications += 1;
						const payload = {
							toolName: entry.toolName,
							command: entry.command,
							kind: entry.kind,
							basis: result.basis,
							observedMs: result.observedMs,
							mode: config.mode,
							thresholdSec: result.level === 2 ? result.criticalSec : result.warnSec,
						};
						notify(
							result.level === 2 ? criticalMessage(payload) : warnMessage(payload),
							result.level === 2 ? "error" : "warning",
						);
					}
				} else if (result.level >= 1 && config.showStatusBar) {
					// Keep the visible counter live once a tool has been flagged.
					refreshStatus(entry, toStatus(entry, result.level as 1 | 2, config, result.observedMs));
				}

				// Escalation runs on every critical tick, not only on the transition:
				// `yolo` needs to keep checking its soft-kill grace period.
				if (result.level === 2) escalate(entry, result, config, at);
			}
		},

		list(): GuardEntryStatus[] {
			const config = deps.config();
			const at = now();
			const out: GuardEntryStatus[] = [];
			for (const entry of entries.values()) {
				const result = measure(entry, config, at);
				out.push({
					toolCallId: entry.toolCallId,
					toolName: entry.toolName,
					command: entry.command,
					kind: entry.kind,
					reason: entry.reason,
					basis: result.basis,
					observedMs: result.observedMs,
					maxObservedMs: entry.maxObservedMs,
					startedAt: entry.startedAt,
					lastActivityAt: entry.lastActivityAt,
					level: result.level,
					notifications: entry.notifications,
					idleWhitelisted: entry.idleWhitelisted,
					selfTimed: entry.selfTimed,
				});
			}
			return out;
		},

		stats(): GuardStats {
			return {
				running: entries.size,
				skippedInteractive,
				notifications: notificationCount,
				paused: uiPromptDepth > 0,
				actions: actionsTaken.length,
				resumes: resumeCount,
				pendingResume: resumeRequest !== null,
			};
		},

		actionLog(): GuardActionReport[] {
			return [...actionsTaken];
		},

		consumeResume(): GuardActionReport | null {
			const report = resumeRequest;
			resumeRequest = null;
			return report;
		},

		hasRunning(): boolean {
			return entries.size > 0;
		},
	};

	return engine;
}
