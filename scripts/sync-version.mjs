// 让 index.ts 里的 VERSION 常量与 package.json 的 version 保持同步。
//
// 由 npm 的 `version` 生命周期脚本自动调用（见 package.json 的 scripts.version），
// 也就是说 `npm version patch -m "[release] %s"` 时无需手工改两处。
//
// 为什么需要它：tests/packaging.test.ts 会断言两者一致，手工只 bump package.json
// 会让 CI 的 `npm test` 直接失败，从而发布不出去。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const target = join(root, "index.ts");
const source = readFileSync(target, "utf8");

const pattern = /const VERSION = "[^"]*";/;
if (!pattern.test(source)) {
	console.error("sync-version: 在 index.ts 中找不到 VERSION 常量，已中止");
	process.exit(1);
}

const next = source.replace(pattern, `const VERSION = "${version}";`);
if (next === source) {
	console.log(`sync-version: index.ts 已是 ${version}`);
	process.exit(0);
}

writeFileSync(target, next);
console.log(`sync-version: index.ts -> ${version}`);
