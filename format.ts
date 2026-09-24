/**
 * Human-readable formatting helpers.
 *
 * Pure string functions only — no timers, no I/O — so they can be unit tested
 * without a pi runtime.
 */

import type { CommandKind } from "./classify.ts";
import type { GuardMode } from "./config.ts";

export interface StatusInput {
	toolName: string;
	command: string;
	kind: CommandKind;
	basis: "idle" | "runtime";
	observedMs: number;
	level: 1 | 2;
	mode: GuardMode;
}

export interface MessageInput {
	toolName: string;
	command: string;
	kind: CommandKind;
	basis: "idle" | "runtime";
	observedMs: number;
	mode: GuardMode;
	thresholdSec: number;
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
export function previewCommand(command: string, max = 56): string {
	const single = command.replace(/\s+/g, " ").trim();
	if (single === "") return "(no command)";
	if (single.length <= max) return single;
	return `${single.slice(0, Math.max(1, max - 1))}…`;
}

function observationLabel(basis: "idle" | "runtime", observedMs: number): string {
	return basis === "idle" ? `${formatDuration(observedMs)} 无输出` : `已运行 ${formatDuration(observedMs)}`;
}

function kindLabel(kind: CommandKind): string {
	if (kind === "watcher") return "server/watch";
	return kind;
}

/** Footer status line for a running tool that already crossed a threshold. */
export function statusText(input: StatusInput): string {
	const icon = input.level === 2 ? "⚠" : "⏱";
	const parts = [
		`${icon} ${input.toolName}`,
		observationLabel(input.basis, input.observedMs),
		kindLabel(input.kind),
		previewCommand(input.command),
	];
	if (input.level === 2 && input.mode === "observe") {
		parts.push("仅提醒");
	}
	return parts.join(" · ");
}

/** First-tier notification: still running, may be stuck. */
export function warnMessage(input: MessageInput): string {
	return [
		`${input.toolName} ${observationLabel(input.basis, input.observedMs)}（${kindLabel(input.kind)}）`,
		`命令: ${previewCommand(input.command, 80)}`,
		`可能卡住。继续等待，或按 Esc 中断。`,
	].join("\n");
}

/** Second-tier notification: very likely stuck. */
export function criticalMessage(input: MessageInput): string {
	const lines = [
		`${input.toolName} ${observationLabel(input.basis, input.observedMs)}（超过 ${input.thresholdSec}s 阈值，${kindLabel(input.kind)}）`,
		`命令: ${previewCommand(input.command, 80)}`,
	];
	if (input.mode === "observe") {
		lines.push("疑似卡死。当前为观察模式（observe），不会自动中断；按 Esc 手动中断。");
	} else {
		lines.push("疑似卡死，请检查该命令是否在等待输入或已失去连接。");
	}
	return lines.join("\n");
}

/** Report emitted when a tool that previously warned finally finishes. */
export function completionMessage(input: {
	toolName: string;
	observedMs: number;
	maxObservedMs: number;
	basis: "idle" | "runtime";
	isError: boolean;
}): string {
	const outcome = input.isError ? "失败" : "完成";
	const peak = input.maxObservedMs > 0 ? `，最长${input.basis === "idle" ? "静默" : "运行"} ${formatDuration(input.maxObservedMs)}` : "";
	return `${input.toolName} 最终${outcome}（耗时 ${formatDuration(input.observedMs)}${peak}）`;
}

/** One-line summary used by `/guard status`. */
export function statusLine(input: StatusInput): string {
	return statusText(input);
}
