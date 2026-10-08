/**
 * Human-readable formatting helpers.
 *
 * Pure string functions only — no timers, no I/O — so they can be unit tested
 * without a pi runtime. All wording comes from `i18n.ts`; this module only
 * decides how the pieces are glued together.
 *
 * Every function takes an optional `locale` (default `"en"`).
 */

import type { CommandKind } from "./classify.ts";
import type { GuardMode } from "./config.ts";
import { DEFAULT_LOCALE, messagesFor, type Locale, type ResumeReportText } from "./i18n.ts";

export interface StatusInput {
	toolName: string;
	command: string;
	kind: CommandKind;
	basis: "idle" | "runtime";
	observedMs: number;
	level: 1 | 2;
	mode: GuardMode;
	locale?: Locale;
}

export interface MessageInput {
	toolName: string;
	command: string;
	kind: CommandKind;
	basis: "idle" | "runtime";
	observedMs: number;
	mode: GuardMode;
	thresholdSec: number;
	locale?: Locale;
}

/** `95s`, `3m12s`, `1h05m`. Sub-second values round up so `0s` never appears. */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) {
		return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	}
	const hours = Math.floor(minutes / 60);
	return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

/** Collapse a multi-line command into one short line for status bars. */
export function previewCommand(command: string, max = 56, locale: Locale = DEFAULT_LOCALE): string {
	const single = command.replace(/\s+/g, " ").trim();
	if (single === "") return messagesFor(locale).noCommand;
	if (single.length <= max) return single;
	return `${single.slice(0, Math.max(1, max - 1))}…`;
}

/** `1m30s idle` for streaming tools, `running 1m30s` for the wall-clock basis. */
export function observationText(
	basis: "idle" | "runtime",
	observedMs: number,
	locale: Locale = DEFAULT_LOCALE,
): string {
	const messages = messagesFor(locale);
	return basis === "idle"
		? messages.idleObservation(formatDuration(observedMs))
		: messages.runtimeObservation(formatDuration(observedMs));
}

function kindLabel(kind: CommandKind): string {
	if (kind === "watcher") return "server/watch";
	return kind;
}

/** Footer status line for a running tool that already crossed a threshold. */
export function statusText(input: StatusInput): string {
	const messages = messagesFor(input.locale);
	const icon = input.level === 2 ? "⚠" : "⏱";
	const parts = [
		`${icon} ${input.toolName}`,
		observationText(input.basis, input.observedMs, input.locale),
		kindLabel(input.kind),
		previewCommand(input.command, 56, input.locale),
	];
	if (input.level === 2 && input.mode === "observe") {
		parts.push(messages.notifyOnly);
	}
	return parts.join(" · ");
}

/** First-tier notification: still running, may be stuck. */
export function warnMessage(input: MessageInput): string {
	const messages = messagesFor(input.locale);
	return [
		messages.observationWithKind(
			`${input.toolName} ${observationText(input.basis, input.observedMs, input.locale)}`,
			kindLabel(input.kind),
		),
		messages.commandLine(previewCommand(input.command, 80, input.locale)),
		messages.warnBody,
	].join("\n");
}

/** Second-tier notification: very likely stuck. */
export function criticalMessage(input: MessageInput): string {
	const messages = messagesFor(input.locale);
	const lines = [
		messages.criticalReason(
			`${input.toolName} ${observationText(input.basis, input.observedMs, input.locale)}`,
			input.thresholdSec,
			kindLabel(input.kind),
		),
		messages.commandLine(previewCommand(input.command, 80, input.locale)),
		input.mode === "observe" ? messages.criticalObserveBody : messages.criticalActBody,
	];
	return lines.join("\n");
}

/** Report emitted when a tool that previously warned finally finishes. */
export function completionMessage(input: {
	toolName: string;
	observedMs: number;
	maxObservedMs: number;
	basis: "idle" | "runtime";
	isError: boolean;
	locale?: Locale;
}): string {
	const messages = messagesFor(input.locale);
	return messages.completion({
		toolName: input.toolName,
		outcome: input.isError ? messages.failedOutcome : messages.completedOutcome,
		duration: formatDuration(input.observedMs),
		peak:
			input.maxObservedMs > 0
				? { label: messages.peakLabel(input.basis), duration: formatDuration(input.maxObservedMs) }
				: undefined,
	});
}

export interface ResumeReport extends Omit<ResumeReportText, "resumeIndex" | "maxResumes"> {
	/** 1-based index of this automatic resumption. Defaults to 1. */
	resumeIndex?: number;
	maxResumes?: number;
	/** Captured tail of the tool's streamed output, if any. */
	outputTail?: string;
	locale?: Locale;
}

/** Human label for an escalation step. */
export function actionLabel(action: "soft-kill" | "abort", locale: Locale = DEFAULT_LOCALE): string {
	return messagesFor(locale).actionLabel(action);
}

/**
 * Structured report handed back to the model after an automatic action.
 *
 * The aborted tool result only says `Command aborted`, so without this the model
 * has no idea why the turn ended.
 */
export function resumeMessage(report: ResumeReport): string {
	const messages = messagesFor(report.locale);
	const resumeIndex = report.resumeIndex ?? 1;
	const maxResumes = report.maxResumes ?? 1;
	return messages.resume({
		...report,
		resumeIndex,
		maxResumes,
		reason: messages.criticalReason(
			`${report.toolName} ${observationText(report.basis, report.observedMs, report.locale)}`,
			report.thresholdSec,
			kindLabel(report.kind),
		),
	});
}

/** One-line summary used by `/guard status`. */
export function statusLine(input: StatusInput): string {
	return statusText(input);
}
