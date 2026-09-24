import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const entrySource = readFileSync(join(root, "index.ts"), "utf8");

function localImportsOf(file: string, seen = new Set<string>()): Set<string> {
	if (seen.has(file)) return seen;
	seen.add(file);
	const source = readFileSync(file, "utf8");
	for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
		const resolved = resolve(dirname(file), match[1]);
		if (existsSync(resolved)) localImportsOf(resolved, seen);
	}
	return seen;
}

test("the manifest is a valid pi package", () => {
	assert.equal(packageJson.name, "pi-hang-guard");
	assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
	assert.equal(packageJson.type, "module");
	assert.ok(packageJson.keywords.includes("pi-package"), "the pi-package keyword drives gallery discovery");
	assert.equal(packageJson.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.ok(process.versions.node, "tests require node");
});

test("the declared extension entry exists and is published", () => {
	const entries = packageJson.pi?.extensions;
	assert.ok(Array.isArray(entries) && entries.length > 0, "pi.extensions must be declared");

	const published = new Set<string>(packageJson.files);
	for (const entry of entries) {
		const relativePath = relative(root, resolve(root, entry));
		assert.ok(existsSync(resolve(root, entry)), `missing entry file: ${entry}`);
		assert.ok(published.has(relativePath), `entry ${relativePath} must be listed in "files"`);
	}
});

test("every module the entry imports is published", () => {
	const published = new Set<string>(packageJson.files);
	const imports = localImportsOf(join(root, "index.ts"));
	assert.ok(imports.size > 1, "the entry should import its modules");

	for (const file of imports) {
		const relativePath = relative(root, file);
		assert.ok(published.has(relativePath), `${relativePath} is imported but missing from "files"`);
	}
});

test("the version constant in the entry matches package.json", () => {
	const match = entrySource.match(/const VERSION = "([^"]+)"/);
	assert.ok(match, "index.ts must declare a VERSION constant");
	assert.equal(match[1], packageJson.version, "bump both files together");
});

test("the entry has no runtime dependency on the pi SDK", () => {
	const runtimeImports = [...entrySource.matchAll(/^import\s+(?!type\b)([^;]+);/gm)].map((match) => match[1]);
	const sdkImports = runtimeImports.filter((clause) => clause.includes("@earendil-works/pi-coding-agent"));
	assert.deepEqual(sdkImports, [], "the entry must use `import type` only, so it loads without pi present");
});

interface FakePi {
	api: Record<string, unknown>;
	statuses: Map<string, string>;
	notifications: Array<{ message: string; level: string }>;
	sent: Array<{ message: { customType?: string; content?: unknown }; options?: unknown }>;
	aborts: { count: number };
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	flags: Map<string, { default?: unknown }>;
	emit(event: string, payload: unknown): Promise<void>;
	ctx: Record<string, unknown>;
}

function createFakePi(): FakePi {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const flags = new Map<string, { default?: unknown }>();
	const statuses = new Map<string, string>();
	const notifications: Array<{ message: string; level: string }> = [];
	const sent: FakePi["sent"] = [];
	const aborts = { count: 0 };

	const ctx = {
		hasUI: true,
		cwd: root,
		abort: () => {
			aborts.count += 1;
		},
		ui: {
			setStatus(key: string, text: string | undefined) {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
	};

	const api = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, options);
		},
		registerFlag(name: string, options: { default?: unknown }) {
			flags.set(name, options);
		},
		getFlag(name: string) {
			return flags.get(name)?.default;
		},
		sendMessage(message: { customType?: string; content?: unknown }, options?: unknown) {
			sent.push({ message, options });
			return Promise.resolve();
		},
	};

	return {
		api,
		statuses,
		notifications,
		sent,
		aborts,
		commands,
		flags,
		ctx,
		async emit(event, payload) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		},
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

test("the extension registers its events, command and flag", async () => {
	const fake = createFakePi();
	const module = await import("../index.ts");
	assert.equal(typeof module.default, "function");
	module.default(fake.api as never);

	for (const event of [
		"tool_execution_start",
		"tool_execution_update",
		"tool_execution_end",
		"ui_prompt_start",
		"ui_prompt_end",
		"agent_settled",
		"session_start",
		"session_shutdown",
	]) {
		await assert.doesNotReject(async () => {
			await fake.emit(event, event === "session_start" ? { reason: "startup" } : {});
		}, `handler for ${event} must not throw`);
	}

	assert.ok(fake.commands.has("guard"), "/guard must be registered");
	assert.ok(fake.flags.has("no-guard"), "--no-guard must be registered");
});

test("end to end: a silent bash command is reported and then cleaned up", async () => {
	process.env.PI_GUARD_CONFIG = join(tmpdir(), "pi-hang-guard-no-such-config.json");
	process.env.PI_GUARD_IDLE_WARN_MS = "40";
	process.env.PI_GUARD_IDLE_CRITICAL_MS = "80";
	process.env.PI_GUARD_TICK_MS = "25";
	process.env.PI_GUARD_RUNTIME_WARN_MS = "100000";

	const fake = createFakePi();
	const module = await import("../index.ts");
	module.default(fake.api as never);

	await fake.emit("session_start", { reason: "startup" });
	assert.equal(fake.notifications.length, 0, "a clean config must stay quiet at startup");

	await fake.emit("tool_execution_start", {
		toolCallId: "e2e",
		toolName: "bash",
		args: { command: "npm run dev" },
	});
	await sleep(150);

	const warned = fake.notifications.filter((entry) => /无输出/.test(entry.message));
	assert.ok(warned.length >= 1, `expected a silence warning, got ${JSON.stringify(fake.notifications)}`);
	assert.ok(fake.statuses.has("guard:e2e"), "the footer status must be set while the tool runs");
	assert.match(fake.statuses.get("guard:e2e") ?? "", /server\/watch/);

	await fake.emit("tool_execution_update", { toolCallId: "e2e" });
	await fake.emit("tool_execution_end", { toolCallId: "e2e", isError: false, result: {} });
	assert.equal(fake.statuses.size, 0, "the footer status must be cleared when the tool ends");

	const before = fake.notifications.length;
	await fake.emit("agent_settled", {});
	assert.ok(fake.notifications.length >= before);
});

test("end to end: a busy command with output produces no warning", async () => {
	process.env.PI_GUARD_IDLE_WARN_MS = "5000";
	process.env.PI_GUARD_IDLE_CRITICAL_MS = "9000";

	const fake = createFakePi();
	const module = await import("../index.ts");
	module.default(fake.api as never);

	await fake.emit("tool_execution_start", {
		toolCallId: "busy",
		toolName: "bash",
		args: { command: "npm run build" },
	});
	for (let i = 0; i < 6; i += 1) {
		await fake.emit("tool_execution_update", { toolCallId: "busy" });
		await sleep(30);
	}
	assert.equal(fake.notifications.length, 0);
	assert.equal(fake.statuses.size, 0);
	await fake.emit("tool_execution_end", { toolCallId: "busy", isError: false, result: {} });
});

test("end to end: /guard status and /guard off work", async () => {
	const fake = createFakePi();
	const module = await import("../index.ts");
	module.default(fake.api as never);

	const guard = fake.commands.get("guard");
	assert.ok(guard);
	await guard.handler("status", fake.ctx);
	assert.match(fake.notifications.at(-1)?.message ?? "", /pi-hang-guard v/);

	await guard.handler("off", fake.ctx);
	assert.match(fake.notifications.at(-1)?.message ?? "", /已停用/);

	await guard.handler("nonsense", fake.ctx);
	assert.match(fake.notifications.at(-1)?.message ?? "", /用法/);
});

test("end to end: observe mode only warns, even with tiny thresholds", async () => {
	process.env.PI_GUARD_MODE = "observe";
	process.env.PI_GUARD_IDLE_WARN_MS = "40";
	process.env.PI_GUARD_IDLE_CRITICAL_MS = "80";
	process.env.PI_GUARD_TICK_MS = "25";

	const fake = createFakePi();
	const module = await import("../index.ts");
	module.default(fake.api as never);

	await fake.emit("tool_execution_start", { toolCallId: "obs", toolName: "bash", args: { command: "sleep 60" } });
	await sleep(200);

	assert.ok(fake.notifications.some((n) => /无输出/.test(n.message)));
	assert.equal(fake.aborts.count, 0, "observe mode must never abort");
	assert.equal(fake.sent.length, 0, "observe mode must never restart the flow");

	await fake.emit("tool_execution_end", { toolCallId: "obs", isError: false, result: {} });
});

test("end to end: guard mode aborts the turn and hands the model a report", async () => {
	process.env.PI_GUARD_MODE = "guard";
	process.env.PI_GUARD_IDLE_WARN_MS = "40";
	process.env.PI_GUARD_IDLE_CRITICAL_MS = "80";
	process.env.PI_GUARD_TICK_MS = "25";

	const fake = createFakePi();
	const module = await import("../index.ts");
	module.default(fake.api as never);

	await fake.emit("session_start", { reason: "startup" });
	await fake.emit("tool_execution_start", { toolCallId: "act", toolName: "bash", args: { command: "npm run dev" } });
	await fake.emit("tool_execution_update", {
		toolCallId: "act",
		toolName: "bash",
		args: { command: "npm run dev" },
		partialResult: { content: [{ type: "text", text: "Pre-transform error: x.vue" }] },
	});

	await sleep(220);
	assert.equal(fake.aborts.count, 1, "the turn is aborted once the critical threshold is crossed");
	assert.ok(fake.notifications.some((n) => /已中止本轮对话/.test(n.message)));

	await fake.emit("agent_settled", {});
	await sleep(60);

	assert.equal(fake.sent.length, 1, "one structured message must be delivered");
	const delivered = fake.sent[0];
	assert.equal(delivered.message.customType, "pi-hang-guard");
	assert.deepEqual(delivered.options, { triggerTurn: true });
	const body = String(delivered.message.content);
	assert.match(body, /已自动处置/);
	assert.match(body, /npm run dev/);
	assert.match(body, /Pre-transform error/, "the captured output tail must be included");

	await fake.emit("tool_execution_end", { toolCallId: "act", isError: true, result: {} });
});

test("end to end: a bundled pi build degrades the soft kill honestly", async () => {
	process.env.PI_GUARD_MODE = "yolo";
	process.env.PI_GUARD_IDLE_WARN_MS = "40";
	process.env.PI_GUARD_IDLE_CRITICAL_MS = "80";
	process.env.PI_GUARD_TICK_MS = "25";
	process.env.PI_GUARD_SOFT_KILL_GRACE_MS = "15000";

	const originalEntry = process.argv[1];
	process.argv[1] = "C:/somewhere/dist/bundle/cli.js";
	try {
		const fake = createFakePi();
		const module = await import("../index.ts");
		module.default(fake.api as never);

		await fake.emit("session_start", { reason: "startup" });
		await fake.emit("tool_execution_start", { toolCallId: "b1", toolName: "bash", args: { command: "sleep 60" } });
		await sleep(220);

		assert.ok(
			!fake.notifications.some((n) => /已杀掉其子进程/.test(n.message)),
			"a bundled build must never claim a soft kill it cannot perform",
		);
		assert.equal(fake.aborts.count, 1, "it escalates straight to aborting the turn");

		await fake.emit("agent_settled", {});
		await sleep(60);
		const body = String(fake.sent.at(-1)?.message.content ?? "");
		assert.match(body, /soft kill unavailable: this pi is the bundled build/);
	} finally {
		if (originalEntry === undefined) delete process.argv[1];
		else process.argv[1] = originalEntry;
	}
});

test("pi's own extension loader can load this package", async (t) => {
	let sdk: { discoverAndLoadExtensions: (...args: unknown[]) => Promise<{ extensions: unknown[]; errors: unknown[]; diagnostics?: unknown[] }> };
	try {
		const entry = process.env.PI_SDK_ENTRY
			? pathToFileURL(process.env.PI_SDK_ENTRY).href
			: "@earendil-works/pi-coding-agent";
		sdk = (await import(entry)) as typeof sdk;
	} catch {
		t.skip("pi SDK not resolvable here; set PI_SDK_ENTRY to dist/index.js to enable this test");
		return;
	}

	const agentDir = join(tmpdir(), "pi-hang-guard-empty-agent");
	const result = await sdk.discoverAndLoadExtensions([root], root, agentDir);
	assert.deepEqual(result.errors, [], `loader errors: ${JSON.stringify(result.errors)}`);
	assert.equal(result.extensions.length, 1, "the package must expose exactly one extension");
});
