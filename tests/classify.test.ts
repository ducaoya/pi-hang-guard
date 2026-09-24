import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyCommand, normalizeCommand } from "../classify.ts";

test("normalizeCommand strips env assignments, cd chains and sudo", () => {
	assert.equal(normalizeCommand("FOO=1 BAR=2 npm run dev"), "npm run dev");
	assert.equal(normalizeCommand("cd /tmp && cd sub && npm test"), "npm test");
	assert.equal(normalizeCommand('cd "/tmp/my dir" && vite'), "vite");
	assert.equal(normalizeCommand("sudo docker compose up"), "docker compose up");
	assert.equal(normalizeCommand("  npx   vite  "), "npx   vite");
});

test("dev servers and watchers are classified as watcher", () => {
	const watchers = [
		"npm run dev",
		"pnpm dev",
		"yarn start",
		"bun run serve",
		"npm run watch",
		"npx vite",
		"vite --host",
		"next dev",
		"nuxt dev",
		"astro dev",
		"nodemon server.js",
		"webpack-dev-server --open",
		"tsc --watch",
		"webpack --watch",
		"vitest --watch",
		"jest --watchAll",
		"docker compose up -d",
		"docker logs -f api",
		"tail -f app.log",
		"journalctl -f",
		"FOO=1 cd /srv/app && npm run dev",
	];
	for (const command of watchers) {
		const result = classifyCommand(command);
		assert.equal(result.kind, "watcher", `expected watcher: ${command} (got ${result.kind}: ${result.reason})`);
		assert.equal(result.guardable, true);
	}
});

test("builds and one-shot commands are not watchers", () => {
	const oneShot = [
		"vite build",
		"npx vite build",
		"next build",
		"nuxt build",
		"astro build",
		"npm run build",
		"npm test",
		"vitest run",
		"jest --ci",
		"tsc --noEmit",
		"git status",
		"ls -la",
	];
	for (const command of oneShot) {
		const result = classifyCommand(command);
		assert.equal(result.kind, "one-shot", `expected one-shot: ${command} (got ${result.kind}: ${result.reason})`);
	}
});

test("interactive commands are never guarded", () => {
	const interactive = [
		"vim notes.md",
		"less README.md",
		"htop",
		"git rebase -i HEAD~3",
		"git add -p",
		"git commit",
		"npm login",
		"docker exec -it api sh",
		"docker run -it --rm ubuntu",
		"ssh box",
		'read -p "user? " name',
	];
	for (const command of interactive) {
		const result = classifyCommand(command);
		assert.equal(result.kind, "interactive", `expected interactive: ${command} (got ${result.kind}: ${result.reason})`);
		assert.equal(result.guardable, false, `must not be guarded: ${command}`);
	}
});

test("git commit with a message is not interactive", () => {
	assert.equal(classifyCommand('git commit -m "fix"').kind, "one-shot");
	assert.equal(classifyCommand("docker run -d nginx").kind, "one-shot");
	assert.equal(classifyCommand("ssh box 'uptime'").kind, "one-shot");
});

test("idle whitelist covers commands that may be silent for minutes", () => {
	for (const command of ["docker build .", "npm ci", "pnpm install", "git clone https://example.com/x.git", "cargo build"]) {
		assert.equal(classifyCommand(command).idleWhitelisted, true, command);
	}
	assert.equal(classifyCommand("npm run dev").idleWhitelisted, false);
});

test("self-timed commands are detected", () => {
	assert.equal(classifyCommand("timeout 600 npm run dev").selfTimed, true);
	assert.equal(classifyCommand("timeout 30 curl -sS https://example.com").selfTimed, true);
	assert.equal(classifyCommand("curl --timeout 10 https://example.com").selfTimed, true);
	assert.equal(classifyCommand("npm run dev").selfTimed, false);
});

test("a tool call without a command is still guardable by wall clock", () => {
	const result = classifyCommand("");
	assert.equal(result.guardable, true);
	assert.equal(result.reason, "no command");
});

test("user rules extend the classifier and bad regexes are ignored", () => {
	const extraWatcher = classifyCommand("my-custom-server --port 1", { extraWatcher: ["^my-custom-server"] });
	assert.equal(extraWatcher.kind, "watcher");

	const extraInteractive = classifyCommand("psql -h db", { extraInteractive: ["^psql\\b"] });
	assert.equal(extraInteractive.guardable, false);

	const badRegex = classifyCommand("npm run dev", { extraWatcher: ["([unclosed"] });
	assert.equal(badRegex.kind, "watcher", "a broken user regex must not break classification");

	const extraWhitelist = classifyCommand("slow-import data.csv", { idleWhitelist: ["slow-import"] });
	assert.equal(extraWhitelist.idleWhitelisted, true);
});

test("matching is anchored so unrelated commands are not misclassified", () => {
	assert.equal(classifyCommand("git commit --amend --no-edit").kind, "one-shot");
	assert.equal(classifyCommand("echo 'npm run dev'").kind, "one-shot");
	assert.equal(classifyCommand("cat README.md").kind, "one-shot");
});
