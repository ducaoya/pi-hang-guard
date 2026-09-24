// Live end-to-end verification for pi-command-guard.
// Usage: node scripts/verify-live-rpc.mjs   (needs a live pi + model credentials; makes one model call)
// Not published: see package.json "files".

// Live verification: run pi in RPC mode and prove pi-command-guard fires.
// `notify` and `setStatus` become `extension_ui_request` events in RPC mode,
// which is the only non-interactive way to observe them.
import { spawn } from "node:child_process";

const env = {
	...process.env,
	PI_GUARD_IDLE_WARN_MS: "2000",
	PI_GUARD_IDLE_CRITICAL_MS: "4000",
	PI_GUARD_RUNTIME_WARN_MS: "999999",
	PI_GUARD_TICK_MS: "500",
};

const child = spawn("pi", ["--mode", "rpc", "--no-session"], {
	cwd: process.cwd(),
	env,
	shell: process.platform === "win32",
	stdio: ["pipe", "pipe", "pipe"],
});

const uiEvents = [];
const other = [];
let buffer = "";

child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let index = buffer.indexOf("\n");
	while (index !== -1) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		index = buffer.indexOf("\n");
		if (!line.trim()) continue;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			other.push(line);
			continue;
		}
		if (parsed.type === "extension_ui_request") uiEvents.push(parsed);
		else if (parsed.type === "response" || parsed.type === "agent_settled" || parsed.type === "tool_execution_end") {
			other.push(`${parsed.type}${parsed.command ? `:${parsed.command}` : ""}${parsed.success === false ? " FAILED" : ""}`);
		}
	}
});

child.stderr.on("data", (chunk) => process.stderr.write(chunk));

setTimeout(() => {
	child.stdin.write(
		`${JSON.stringify({
			type: "prompt",
			id: "p1",
			message: "Use the bash tool to run exactly this command and wait for it to finish: sleep 9 . Then reply with the single word DONE.",
		})}\n`,
	);
}, 1500);

const deadline = setTimeout(() => {
	child.kill();
	report();
}, 90_000);

child.on("exit", () => {
	clearTimeout(deadline);
	report();
});

let reported = false;
function report() {
	if (reported) return;
	reported = true;
	const statuses = uiEvents.filter((e) => e.method === "setStatus");
	const notifications = uiEvents.filter((e) => e.method === "notify");
	console.log("=== RPC responses/events ===");
	console.log(other.slice(-8).join("\n"));
	console.log("=== setStatus events ===");
	for (const event of statuses) console.log(`[${event.statusKey}] ${event.statusText === undefined ? "<cleared>" : event.statusText}`);
	console.log("=== notify events ===");
	for (const event of notifications) console.log(`(${event.notifyType}) ${String(event.message).replace(/\n/g, " | ")}`);

	const fired = statuses.some((e) => String(e.statusKey).startsWith("guard:")) && notifications.length > 0;
	const cleared = statuses.some((e) => e.statusText === undefined);
	console.log(`\nRESULT: guardFired=${fired} statusCleared=${cleared}`);
	process.exit(fired && cleared ? 0 : 1);
}
