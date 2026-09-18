// Reproducible vendored runtime: npm ci --prefix mobile; node scripts/build-terminal-snapshot.mjs
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(`${root}mobile/package.json`);
const { build } = require("esbuild");
const target = `${root}crates/agentport-host/assets/terminal-snapshot`;
const check = process.argv.includes("--check");
if (!check) await mkdir(target, { recursive: true });
async function emit(name, content) {
  if (check) {
    if (await readFile(`${target}/${name}`, "utf8") !== content) throw new Error(`Stale snapshot asset: ${name}; run node scripts/build-terminal-snapshot.mjs`);
  } else await writeFile(`${target}/${name}`, content);
}
if (JSON.parse(await readFile(`${root}mobile/node_modules/@xterm/xterm/package.json`)).version !== "5.5.0") throw new Error("Browser snapshot restore requires xterm@5.5.0");
for (const [name, version, source, dest] of [
  ["headless", "5.5.0", "lib-headless/xterm-headless.js", "xterm.js"],
  ["addon-serialize", "0.13.0", "lib/addon-serialize.js", "serialize.js"],
]) {
  const path = `${root}mobile/node_modules/@xterm/${name}`;
  if (JSON.parse(await readFile(`${path}/package.json`)).version !== version) throw new Error(`Snapshot engine requires ${name}@${version}`);
  await emit(dest, (await readFile(`${path}/${source}`, "utf8")).replace(/\/\/# sourceMappingURL=.*$/m, ""));
}
await emit("LICENSE.xterm", await readFile(`${root}mobile/node_modules/@xterm/xterm/LICENSE`, "utf8"));
const result = await build({ entryPoints: [`${root}mobile/src/terminal/hostSnapshotEngine.ts`], bundle: true,
  write: false, platform: "neutral", format: "iife", globalName: "SnapshotEngine", target: "es2020", minify: true });
await emit("engine.js", result.outputFiles[0].text);
