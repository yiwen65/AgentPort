// Reproducible vendored runtime. The snapshot engine source lives in the private AgentPort Mobile
// checkout, not in this repository:
//
//   AGENTPORT_SNAPSHOT_SOURCE=/path/to/mobile npm ci --prefix /path/to/mobile
//   AGENTPORT_SNAPSHOT_SOURCE=/path/to/mobile node scripts/build-terminal-snapshot.mjs
//
// The emitted assets under crates/agentport-host/assets/terminal-snapshot are committed, so desktop
// builds, tests and packaging never need that checkout; only regenerating or --check requires it.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const source = (process.env.AGENTPORT_SNAPSHOT_SOURCE ?? `${root}mobile`).replace(/\/?$/, "/");
if (!existsSync(`${source}package.json`)) {
  throw new Error(`Snapshot engine source not found at ${source}; set AGENTPORT_SNAPSHOT_SOURCE to an AgentPort Mobile checkout and run npm ci there first`);
}
const require = createRequire(`${source}package.json`);
const { build } = require("esbuild");
const target = `${root}crates/agentport-host/assets/terminal-snapshot`;
const check = process.argv.includes("--check");
if (!check) await mkdir(target, { recursive: true });
async function emit(name, content) {
  if (check) {
    if (await readFile(`${target}/${name}`, "utf8") !== content) throw new Error(`Stale snapshot asset: ${name}; run node scripts/build-terminal-snapshot.mjs`);
  } else await writeFile(`${target}/${name}`, content);
}
if (JSON.parse(await readFile(`${source}node_modules/@xterm/xterm/package.json`)).version !== "5.5.0") throw new Error("Browser snapshot restore requires xterm@5.5.0");
for (const [name, version, relativePath, dest] of [
  ["headless", "5.5.0", "lib-headless/xterm-headless.js", "xterm.js"],
  ["addon-serialize", "0.13.0", "lib/addon-serialize.js", "serialize.js"],
]) {
  const path = `${source}node_modules/@xterm/${name}`;
  if (JSON.parse(await readFile(`${path}/package.json`)).version !== version) throw new Error(`Snapshot engine requires ${name}@${version}`);
  await emit(dest, (await readFile(`${path}/${relativePath}`, "utf8")).replace(/\/\/# sourceMappingURL=.*$/m, ""));
}
await emit("LICENSE.xterm", await readFile(`${source}node_modules/@xterm/xterm/LICENSE`, "utf8"));
const result = await build({ entryPoints: [`${source}src/terminal/hostSnapshotEngine.ts`], bundle: true,
  write: false, platform: "neutral", format: "iife", globalName: "SnapshotEngine", target: "es2020", minify: true });
await emit("engine.js", result.outputFiles[0].text);
