// Check the production import graph, not source-level import spelling or hashes.
// Run from mobile/: npm run test:startup
import assert from "node:assert/strict";
import { build } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({ root, logLevel: "error", build: { write: false } });
const chunks = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output)
  .filter(output => output.type === "chunk");
const entry = chunks.find(chunk => chunk.isEntry && chunk.facadeModuleId?.endsWith("/index.html"));
assert.ok(entry, "App entry must be present");
const byName = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
const initial = new Set();
function visit(name) {
  if (initial.has(name)) return;
  initial.add(name);
  const chunk = byName.get(name);
  assert.ok(chunk, `Missing static import: ${name}`);
  chunk.imports.forEach(visit);
}
visit(entry.fileName);
const initialModules = [...initial].flatMap(name => Object.keys(byName.get(name).modules));
assert.ok(!initialModules.some(id => /\/node_modules\/@xterm\//.test(id)), "Dashboard must not eagerly load xterm/addons");
assert.ok(!initialModules.some(id => /\/(MobileTerminal|GenericTerminal)\.tsx$/.test(id)), "Terminal views must remain deferred");
assert.ok(chunks.some(chunk => Object.keys(chunk.modules).some(id => id.endsWith("/GenericTerminal.tsx"))), "Deferred generic terminal must still be bundled");
console.log(`Startup graph passed: ${initial.size} static chunks, ${initialModules.length} modules; terminals deferred.`);
