/**
 * pi-hang-guard — extension entry point.
 *
 * Watches every tool call pi runs and reports shell commands that stop
 * producing output. It never overrides a built-in tool and never rewrites a
 * command: it only reads events. Escalation (`guard` aborts the turn, `yolo`
 * tries a soft kill first) is opt-in and off by default; diagnostics stay in
 * English, while every user-facing message follows `config.locale`.
 *
 * Registered events:
 *   tool_execution_start / tool_execution_update / tool_execution_end
 *   ui_prompt_start / ui_prompt_end
 *   agent_settled / session_start / session_shutdown
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_CONFIG, loadConfig, type GuardConfig } from "./config.ts";
import {
	createGuardEngine,
	type GuardActions,
	type GuardUI,
	type SoftKillOutcome,
} from "./engine.ts";
import { observationText, previewCommand, resumeMessage } from "./format.ts";
import { messagesFor } from "./i18n.ts";

const VERSION = "0.3.1";

function extractOutputText(partialResult: unknown): string {
	if (typeof partialResult !== "object" || partialResult === null) return "";
	const content = (partialResult as { content?: unknown }).content;
	if (!Array.isArray(content) || content.length === 0) return "";
	const first = content[0] as { type?: string; text?: string } | undefined;
	return first && first.type === "text" && typeof first.text === "string" ? first.text : "";
}

export default function commandGuard(pi: ExtensionAPI): void {
	pi.registerFlag("no-guard", {
		description: "Disable pi-hang-guard for this run",
		type: "boolean",
		default: false,
	});

	const state: {
		config: GuardConfig;
		warnings: string[];
		configPath: string;
		noGuard: boolean;
	} = { config: DEFAULT_CONFIG, warnings: [], configPath: "", noGuard: false };

	const loaded = loadConfig();
	state.config = loaded.config;
	state.warnings = loaded.warnings;
	state.configPath = loaded.path;

	let activeCtx: ExtensionContext | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	/** Set when the UI context goes stale (e.g. after /reload) so the ticker stops. */
	let stale = false;

	/** Last streamed output per tool call, used to give the model context when resuming. */
	const outputTails = new Map<string, string>();

	/**
	 * pi's internal "kill everything I spawned" helper lives outside the package
	 * `exports` map, so it can only be reached through `getPackageDir()`.
	 *
	 * This only works when the running pi is the *unbundled* build: the shipped
	 * `bin` is `dist/bundle/cli.js`, whose chunks export nothing, so importing
	 * `dist/utils/shell.js` yields a second module instance with its own empty
	 * process registry — calling it would silently do nothing and still look like
	 * a success. We therefore detect the bundled entry up front and report the
	 * capability as unavailable instead of pretending.
	 */
	let killer: (() => void) | null | undefined;
	let killerUnavailableReason = "not resolved yet";
	let killerPromise: Promise<void> | null = null;

	function isBundledEntry(): boolean {
		const entry = process.argv[1] ?? "";
		return /[\\/]bundle[\\/][^\\/]*\.js$/.test(entry);
	}

	async function resolveKiller(): Promise<void> {
		if (killer !== undefined) return;
		if (killerPromise) return killerPromise;
		killerPromise = (async () => {
			try {
				if (isBundledEntry()) {
					killer = null;
					killerUnavailableReason = "this pi is the bundled build; the internal process registry is a private copy";
					return;
				}
				const sdk = (await import("@earendil-works/pi-coding-agent")) as {
					getPackageDir?: () => string;
				};
				const packageDir = typeof sdk.getPackageDir === "function" ? sdk.getPackageDir() : undefined;
				if (!packageDir) {
					killer = null;
					killerUnavailableReason = "getPackageDir() is unavailable";
					return;
				}
				const shell = (await import(
					pathToFileURL(join(packageDir, "dist", "utils", "shell.js")).href
				)) as { killTrackedDetachedChildren?: () => void };
				if (typeof shell.killTrackedDetachedChildren !== "function") {
					killer = null;
					killerUnavailableReason = "killTrackedDetachedChildren() is missing from this build";
					return;
				}
				killer = shell.killTrackedDetachedChildren;
				killerUnavailableReason = "";
			} catch (error) {
				killer = null;
				killerUnavailableReason = error instanceof Error ? error.message : String(error);
			}
		})();
		return killerPromise;
	}

	const actions: GuardActions = {
		softKill(): SoftKillOutcome {
			if (killer === undefined) {
				void resolveKiller();
				return { ok: false, detail: "resolving pi's internal killer", pending: true };
			}
			if (killer === null) {
				return { ok: false, detail: killerUnavailableReason };
			}
			try {
				killer();
				return { ok: true, detail: "pi internal killTrackedDetachedChildren()" };
			} catch (error) {
				return { ok: false, detail: error instanceof Error ? error.message : String(error) };
			}
		},
		abortTurn(): void {
			activeCtx?.abort();
		},
	};

	const ui: GuardUI = {
		setStatus(key, text) {
			if (stale || !activeCtx) return;
			try {
				activeCtx.ui.setStatus(key, text);
			} catch {
				stale = true;
				stopTicker();
			}
		},
		notify(message, level) {
			if (stale || !activeCtx) return;
			try {
				activeCtx.ui.notify(message, level);
			} catch {
				stale = true;
				stopTicker();
			}
		},
	};

	const engine = createGuardEngine({
		ui,
		config: () => state.config,
		actions,
	});

	const effectiveEnabled = (): boolean => state.config.enabled && !state.noGuard;

	function startTicker(): void {
		if (ticker || stale) return;
		const interval = Math.max(20, Math.round(state.config.tickIntervalMs));
		ticker = setInterval(onTick, interval);
		// Never keep the pi process alive because of the guard.
		(ticker as unknown as { unref?: () => void }).unref?.();
	}

	function stopTicker(): void {
		if (!ticker) return;
		clearInterval(ticker);
		ticker = undefined;
	}

	function onTick(): void {
		try {
			engine.tick();
			if (!engine.hasRunning()) stopTicker();
		} catch {
			// A guard failure must never surface as an unhandled exception.
			stopTicker();
		}
	}

	function report(): string {
		const stats = engine.stats();
		const locale = state.config.locale;
		const messages = messagesFor(locale);
		const lines = [
			`pi-hang-guard v${VERSION} · mode=${state.config.mode} · locale=${locale} · ${effectiveEnabled() ? "on" : "off"}`,
			`running=${stats.running} skippedInteractive=${stats.skippedInteractive} notifications=${stats.notifications} paused=${stats.paused ? "yes" : "no"}`,
			`actions=${stats.actions} resumes=${stats.resumes}/${state.config.maxAutoResumes} pendingResume=${stats.pendingResume ? "yes" : "no"}`,
		];
		for (const entry of engine.list()) {
			const observed = observationText(entry.basis, entry.observedMs, locale);
			lines.push(
				`- ${entry.toolName} ${observed} · ${entry.kind}${entry.selfTimed ? " · self-timed" : ""}${entry.idleWhitelisted ? " · idle-tolerant" : ""} · ${previewCommand(entry.command, 48, locale)}`,
			);
		}
		lines.push(messages.reportConfigLine(state.configPath));
		for (const action of engine.actionLog().slice(-3)) {
			lines.push(
				messages.reportActionLine({
					action: action.action,
					toolName: action.toolName,
					command: previewCommand(action.command, 40, locale),
					observation: observationText(action.basis, action.observedMs, locale),
				}),
			);
		}
		if (state.warnings.length > 0) {
			lines.push(messages.reportWarningsLine(state.warnings));
		}
		return lines.join("\n");
	}

	pi.on("tool_execution_start", (event, ctx) => {
		activeCtx = ctx;
		if (!effectiveEnabled()) return;
		engine.onToolStart({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
		if (engine.hasRunning()) startTicker();
	});

	pi.on("tool_execution_update", (event, ctx) => {
		activeCtx = ctx;
		engine.onToolUpdate({ toolCallId: event.toolCallId });
		const text = extractOutputText(event.partialResult);
		if (text !== "") outputTails.set(event.toolCallId, text);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		activeCtx = ctx;
		engine.onToolEnd({ toolCallId: event.toolCallId, isError: event.isError === true });
		outputTails.delete(event.toolCallId);
		if (!engine.hasRunning()) stopTicker();
	});

	// While pi waits on a blocking UI prompt (permission dialog, selector), the
	// guard freezes so that "user is deciding" is not mistaken for "tool hung".
	pi.on("ui_prompt_start", (_event, ctx) => {
		activeCtx = ctx;
		engine.onUiPromptStart();
	});

	pi.on("ui_prompt_end", (_event, ctx) => {
		activeCtx = ctx;
		engine.onUiPromptEnd();
	});

	pi.on("agent_settled", (_event, ctx) => {
		activeCtx = ctx;
		engine.onAgentSettled();
		stopTicker();

		const report = engine.consumeResume();
		if (!report) return;
		if (!ctx.hasUI && !state.config.resumeWithoutUI) return;

		const message = resumeMessage({
			...report,
			outputTail: outputTails.get(report.toolCallId),
			locale: state.config.locale,
		});
		// `agent_settled` is emitted synchronously from the finished run's `finally`
		// block, so starting a new turn must be deferred out of that call stack.
		setTimeout(() => {
			try {
				void Promise.resolve(
					pi.sendMessage(
						{ customType: "pi-hang-guard", content: message, display: true },
						{ triggerTurn: true },
					),
				).catch(() => {});
			} catch {
				// Resuming is best effort; never let it surface as an unhandled error.
			}
		}, 0);
	});

	pi.on("session_shutdown", () => {
		engine.onShutdown();
		stopTicker();
	});

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		state.noGuard = typeof pi.getFlag === "function" && pi.getFlag("no-guard") === true;
		// Warm the internal killer resolver once so the first soft kill is synchronous.
		void resolveKiller();
		if (state.warnings.length > 0) {
			ui.notify(
				messagesFor(state.config.locale).configProblemNotice(
					state.warnings.length,
					state.configPath,
					state.warnings,
				),
				"warning",
			);
		}
	});

	pi.registerCommand("guard", {
		description: "pi-hang-guard: status | on | off | reload",
		handler: async (args, ctx) => {
			activeCtx = ctx;
			const action = (args ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
			switch (action) {
				case "on": {
					state.config.enabled = true;
					ctx.ui.notify(
						messagesFor(state.config.locale).enabledNotice(state.config.mode),
						"info",
					);
					return;
				}
				case "off": {
					state.config.enabled = false;
					engine.onAgentSettled();
					stopTicker();
					ctx.ui.notify(messagesFor(state.config.locale).disabledNotice, "info");
					return;
				}
				case "reload": {
					const next = loadConfig();
					state.config = next.config;
					state.warnings = next.warnings;
					state.configPath = next.path;
					ctx.ui.notify(
						messagesFor(state.config.locale).reloadedNotice(state.configPath, state.warnings.length),
						state.warnings.length > 0 ? "warning" : "info",
					);
					return;
				}
				case "":
				case "status": {
					ctx.ui.notify(report(), "info");
					return;
				}
				default: {
					ctx.ui.notify(messagesFor(state.config.locale).usageNotice, "warning");
				}
			}
		},
	});
}
