/**
 * Command classification.
 *
 * The guard cannot tell "stuck" from "busy" by wall clock alone: `npm run build`
 * legitimately runs for minutes, while `npm run dev` may hang forever. So every
 * command is classified first, and the class decides *how* it is observed.
 *
 * Pure functions only (regex + strings) so this module is unit testable and has
 * no runtime dependency on pi.
 */

export type CommandKind = "interactive" | "watcher" | "one-shot";

export interface ClassifyRules {
	/** Extra user-supplied regexes treated as long-running servers/watchers. */
	extraWatcher?: readonly string[];
	/** Extra user-supplied regexes treated as interactive (never guarded). */
	extraInteractive?: string[];
	/** Substrings marking commands that may legitimately be silent for a long time. */
	idleWhitelist?: readonly string[];
}

export interface Classification {
	/** Coarse command shape. */
	kind: CommandKind;
	/** `false` means the guard skips this command entirely (interactive/TUI). */
	guardable: boolean;
	/** Command may legitimately produce no output for minutes. */
	idleWhitelisted: boolean;
	/** Command carries its own bound (`timeout 600 …` / `--timeout 30`). */
	selfTimed: boolean;
	/** Human-readable reason for diagnostics and `/guard status`. */
	reason: string;
}

const LEADING_ENV_ASSIGNMENT =
	/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+)+/;
const CD_PREFIX = /^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/;

const INTERACTIVE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[/^(?:vim|nvim|vi|nano|emacs|pico|micro|helix|hx|kak|less|more|most|man)\b/, "interactive editor or pager"],
	[/^(?:top|htop|btop|watch|fzf|tig|lazygit|nnn|ranger|ncdu)\b/, "interactive TUI"],
	[/\bgit\s+rebase\s+(?:-i|--interactive)\b/, "git rebase --interactive"],
	[/\bgit\s+add\s+(?:-p|--patch)\b/, "git add --patch"],
	[/\bgit\s+commit\s*(?:$|[|&;])/, "git commit without -m"],
	[/\b(?:npm|pnpm|yarn|bun)\s+login\b/, "registry login prompt"],
	[/\bdocker\s+(?:exec|run)\b[^|&;]*\s-[a-z]*t[a-z]*\s/, "docker interactive TTY"],
	[/^ssh\s+[^\s|&;]+$/, "bare ssh session"],
	[/\bread\s+-[a-z]*p\b/, "shell read prompt"],
];

const WATCHER_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[
		/(?:^|&&|;|\|)\s*(?:npm|pnpm|yarn|bun)(?:\s+--?[\w=.-]+)*\s+(?:run\s+)?(?:dev|develop|start|serve|watch)\b/,
		"package script dev/start/serve/watch",
	],
	[
		/^(?:npx\s+|pnpm\s+dlx\s+|bunx\s+)?(?:vite|nuxt|next|astro|parcel|remix|snowpack|gatsby)\b(?![^|&;]*\b(?:build|export|generate)\b)/,
		"framework dev server",
	],
	[
		/^(?:npx\s+)?(?:webpack-dev-server|nodemon|serve|http-server|live-server|browser-sync|ts-node-dev|vite-node)\b/,
		"dev server or file watcher",
	],
	[/\b(?:tsc|webpack|rollup|esbuild|swc)\b[^|&;]*--watch\b/, "watch-mode compiler"],
	[/\b(?:vitest|jest|mocha)\b[^|&;]*--watch(?:All)?\b/, "watch-mode test runner"],
	[/\bdocker\s+compose\s+up\b/, "docker compose up"],
	[/\bdocker\s+logs\b[^|&;]*\s-f\b/, "docker logs --follow"],
	[/^tail\b[^|&;]*\s-f\b/, "tail --follow"],
	[/\bjournalctl\b[^|&;]*\s-f\b/, "journalctl --follow"],
];

const IDLE_WHITELIST_SUBSTRINGS: readonly string[] = [
	"docker build",
	"docker pull",
	"docker push",
	"docker save",
	"docker load",
	"npm ci",
	"npm install",
	"npm i ",
	"pnpm install",
	"pnpm i ",
	"yarn install",
	"bun install",
	"git clone",
	"git fetch",
	"git pull",
	"git push",
	"cargo build",
	"cargo test",
	"cargo install",
	"go build",
	"go test",
	"go mod download",
	"pip install",
	"pip3 install",
	"poetry install",
	"uv sync",
	"brew install",
	"apt-get install",
	"apt install",
	"yum install",
	"dnf install",
	"playwright install",
	"prisma generate",
	"prisma migrate",
	"webpack",
	"rollup -c",
	"tsc",
	"vite build",
	"next build",
	"nuxt build",
	"astro build",
	"tar ",
	"unzip ",
	"gzip ",
	"7z ",
];

const SELF_TIMED =
	/(?:^|[\s|&;(])timeout\s+(?:-{1,2}[A-Za-z-]+\s+\d+|\d|["']\d)|--timeout[=\s]\d/;

const regexCache = new Map<string, RegExp | null>();

function compile(pattern: string): RegExp | null {
	const cached = regexCache.get(pattern);
	if (cached !== undefined) return cached;
	let compiled: RegExp | null = null;
	try {
		compiled = new RegExp(pattern);
	} catch {
		compiled = null;
	}
	regexCache.set(pattern, compiled);
	return compiled;
}

/** Strip `FOO=bar` prefixes, `cd x &&` chains, and a leading `sudo`. */
export function normalizeCommand(command: string): string {
	let out = (command ?? "").replace(/\r?\n/g, " ").trim();
	for (let i = 0; i < 8; i += 1) {
		const next = out.replace(LEADING_ENV_ASSIGNMENT, "");
		if (next === out) break;
		out = next;
	}
	for (let i = 0; i < 8; i += 1) {
		const next = out.replace(CD_PREFIX, "");
		if (next === out) break;
		out = next;
	}
	out = out.replace(/^sudo\s+/, "");
	return out.trim();
}

function isIdleWhitelisted(
	command: string,
	rules: ClassifyRules,
): boolean {
	for (const needle of IDLE_WHITELIST_SUBSTRINGS) {
		if (command.includes(needle)) return true;
	}
	for (const needle of rules.idleWhitelist ?? []) {
		if (needle && command.includes(needle)) return true;
	}
	return false;
}

/**
 * Classify a shell command.
 *
 * Precedence: interactive → watcher → one-shot. The first match wins, so a
 * command can never be both.
 */
export function classifyCommand(
	command: string,
	rules: ClassifyRules = {},
): Classification {
	const raw = command ?? "";
	const cmd = normalizeCommand(raw);

	if (cmd === "") {
		// Tools without a shell command (read, grep, …) are still worth watching,
		// but only by wall clock. `guardable: false` is reserved for interactive
		// commands, which must never be touched.
		return {
			kind: "one-shot",
			guardable: true,
			idleWhitelisted: false,
			selfTimed: false,
			reason: "no command",
		};
	}

	const idleWhitelisted = isIdleWhitelisted(cmd, rules);
	const selfTimed = SELF_TIMED.test(cmd);

	for (const pattern of rules.extraInteractive ?? []) {
		const regex = compile(pattern);
		if (regex?.test(cmd)) {
			return { kind: "interactive", guardable: false, idleWhitelisted, selfTimed, reason: `user rule: ${pattern}` };
		}
	}
	for (const [regex, reason] of INTERACTIVE_PATTERNS) {
		if (regex.test(cmd)) {
			return { kind: "interactive", guardable: false, idleWhitelisted, selfTimed, reason };
		}
	}

	for (const pattern of rules.extraWatcher ?? []) {
		const regex = compile(pattern);
		if (regex?.test(cmd)) {
			return { kind: "watcher", guardable: true, idleWhitelisted, selfTimed, reason: `user rule: ${pattern}` };
		}
	}
	for (const [regex, reason] of WATCHER_PATTERNS) {
		if (regex.test(cmd)) {
			return { kind: "watcher", guardable: true, idleWhitelisted, selfTimed, reason };
		}
	}

	return {
		kind: "one-shot",
		guardable: true,
		idleWhitelisted,
		selfTimed,
		reason: idleWhitelisted ? "one-shot (idle-tolerant)" : "one-shot",
	};
}
