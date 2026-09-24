// Live end-to-end verification for pi-hang-guard.
//
// Usage: node scripts/verify-live-rpc.mjs [observe|guard|yolo]
//   (needs a live pi + model credentials; makes one or two model calls)
//
// Launches a real `pi --mode rpc` session with tiny thresholds, asks the model to
// run a command that goes silent, and asserts what the guard actually did.
// RPC mode is used because `setStatus`/`notify` surface as observable
// `extension_ui_request` events there.
//
// Not published: see package.json "files".

import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const mode = argv[0] ?? "observe";
if (!["observe", "guard", "yolo"].includes(mode)) {
	console.error(`unknown mode: ${mode}`);
	process.exit(2);
}
const extIndex = argv.indexOf("--ext");
const extensionPath = extIndex === -1 ? undefined : argv[extIndex + 1];

const SILENT_COMMAND = "sleep 25";

const env = {
	...process.env,
	PI_GUARD_MODE: mode,
	PI_GUARD_IDLE_WARN_MS: "2000",
	PI_GUARD_IDLE_CRITICAL_MS: "4500",
	PI_GUARD_TICK_MS: "500",
	PI_GUARD_RUNTIME_WARN_MS: "999999",
	PI_GUARD_SOFT_KILL_GRACE_MS: "15000",
	PI_GUARD_ACTION_COOLDOWN_MS: "30000",
	PI_GUARD_MAX_AUTO_RESUMES: "1",
};

// `-ne` keeps the run deterministic: only the extension under test is loaded,
// never whatever happens to be installed alongside it.
const child = spawn("pi", ["--mode", "rpc", "--no-session", ...(extensionPath ? ["-ne", "-e", extensionPath] : [])], {
	cwd: process.cwd(),
	env,
	shell: process.platform === "win32",
	stdio: ["pipe", "pipe", "pipe"],
});

const ui = [];
const events = [];
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
			continue;
		}
		if (parsed.type === "extension_ui_request") ui.push(parsed);
		else events.push(parsed);
	}
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

setTimeout(() => {
	child.stdin.write(
		`${JSON.stringify({
			type: "prompt",
			id: "p1",
			message: `Use the bash tool to run exactly this command and wait for it: ${SILENT_COMMAND} . Then reply with the single word DONE.`,
		})}\n`,
	);
}, 1500);

const killTimer = setTimeout(() => {
	child.kill();
	report();
}, 150_000);

child.on("exit", () => {
	clearTimeout(killTimer);
	report();
});

let reported = false;
function report() {
	if (reported) return;
	reported = true;

	const notifications = ui.filter((e) => e.method === "notify").map((e) => String(e.message).replace(/\n/g, " | "));
	const statuses = ui.filter((e) => e.method === "setStatus");
	const customMessages = events
		.filter((e) => e.type === "message_end" && e.message?.role === "custom")
		.map((e) => ({ customType: e.message.customType, content: String(e.message.content ?? "") }));
	const agentStarts = events.filter((e) => e.type === "agent_start").length;
	const toolEnds = events.filter((e) => e.type === "tool_execution_end").map((e) => ({ isError: e.isError }));

	console.log(`\n=== mode: ${mode} · command: ${SILENT_COMMAND}${extensionPath ? ` · ext: ${extensionPath}` : ""} ===`);
	console.log(`agent_start 次数: ${agentStarts}（2 = 触发了自动续跑）`);
	console.log(`tool_execution_end: ${JSON.stringify(toolEnds)}`);
	console.log("\n--- notify ---");
	for (const n of notifications) console.log(`  ${n}`);
	console.log("\n--- 自定义消息（pi-hang-guard 报告）---");
	for (const m of customMessages) {
		console.log(`  [${m.customType}] ${m.content.split("\n").slice(0, 6).join(" / ")}`);
	}
	const guardStatuses = statuses.filter((e) => String(e.statusKey).startsWith("guard:"));
	console.log(`\n--- setStatus ---`);
	console.log(`  guard 状态写入 ${guardStatuses.length} 次，最后一条: ${guardStatuses.at(-1)?.statusText ?? "(cleared)"}`);

	const warned = notifications.some((n) => /无输出/.test(n));
	const acted = notifications.some((n) => /已中止本轮对话/.test(n));
	const softKilled = notifications.some((n) => /已杀掉其子进程/.test(n));
	const resumed = customMessages.some((m) => m.customType === "pi-hang-guard");
	const statusCleared = guardStatuses.some((e) => e.statusText === undefined);

	console.log("\n=== 断言 ===");
	const checks = [
		["产生静默预警", warned],
		["状态栏最后被清理", statusCleared],
	];
	if (mode === "observe") checks.push(["未中止对话", !acted], ["未自动续跑", !resumed]);
	if (mode === "guard") checks.push(["中止了本轮对话", acted], ["自动续跑并投递报告", resumed], ["触发第二次 agent run", agentStarts >= 2]);
	if (mode === "yolo") {
		const explained = customMessages.some((m) => /soft kill unavailable/.test(m.content));
		checks.push(
			["软杀生效，或明确降级为中正（并给出原因）", (softKilled && !acted) || (acted && explained)],
			["工具以非零退出", toolEnds.some((t) => t.isError === true)],
		);
	}

	let failed = 0;
	for (const [label, ok] of checks) {
		console.log(`  ${ok ? "✅" : "❌"} ${label}`);
		if (!ok) failed += 1;
	}
	console.log(`\nRESULT: ${failed === 0 ? "PASS" : `FAIL(${failed})`}`);
	process.exit(failed === 0 ? 0 : 1);
}
