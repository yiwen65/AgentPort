import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = process.cwd();
const localeRoot = path.join(root, "src", "locales");
const sourceRoot = path.join(root, "src");
const languages = ["zh-CN", "en-US"];
const namespaces = ["common", "shell", "session", "worktree", "settings", "runtime"];
const errors = [];
const chinese = /[\u3400-\u9fff]/;
const untranslatedEnglishUiWord = /\b(?:Detached|Unknown|Loading|Settings|Cancel|Save|Delete|Remove|Restore|Resume|Running|Working|Disconnected|Failed)\b/;
// Language choices are always shown in their own language by design.
const englishCatalogChineseAllowlist = new Set(["common:language.zhCN"]);
const sharedValueAllowlist = new Set(readJson(
  path.join(root, "scripts", "i18n-shared-value-allowlist.json"),
));
const usedSharedValueAllowlist = new Set();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${path.relative(root, file)}: ${error.message}`);
    return {};
  }
}

const fragmentRoot = path.join(localeRoot, "fragments");
const fragmentFilesByLanguage = new Map(languages.map((language) => {
  const directory = path.join(fragmentRoot, language);
  const files = fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort()
    : [];
  return [language, files];
}));

const expectedFragmentFiles = fragmentFilesByLanguage.get(languages[0]) ?? [];
for (const language of languages.slice(1)) {
  const files = fragmentFilesByLanguage.get(language) ?? [];
  const missing = expectedFragmentFiles.filter((file) => !files.includes(file));
  const extra = files.filter((file) => !expectedFragmentFiles.includes(file));
  if (missing.length) errors.push(`${language}/fragments: missing files: ${missing.join(", ")}`);
  if (extra.length) errors.push(`${language}/fragments: extra files: ${extra.join(", ")}`);
}

const resourcesFile = path.join(localeRoot, "resources.ts");
const resourcesSource = fs.readFileSync(resourcesFile, "utf8");
const resourceAst = ts.createSourceFile(
  resourcesFile,
  resourcesSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const resourceImports = new Map();
for (const statement of resourceAst.statements) {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
  const localName = statement.importClause?.name?.text;
  if (localName) resourceImports.set(statement.moduleSpecifier.text, localName);
}

function requireRuntimeResource(modulePath) {
  const localName = resourceImports.get(modulePath);
  if (!localName) {
    errors.push(`src/locales/resources.ts: missing resource import ${modulePath}`);
    return;
  }
  const references = resourcesSource.match(new RegExp(`\\b${localName}\\b`, "g"))?.length ?? 0;
  if (references < 2) {
    errors.push(`src/locales/resources.ts: imported resource is not merged: ${modulePath}`);
  }
}

for (const language of languages) {
  for (const namespace of namespaces) requireRuntimeResource(`./${language}/${namespace}.json`);
  for (const fragmentFile of fragmentFilesByLanguage.get(language) ?? []) {
    requireRuntimeResource(`./fragments/${language}/${fragmentFile}`);
  }
}

function flatten(value, prefix = "", result = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "string") result.set(fullKey, child);
    else if (child && typeof child === "object" && !Array.isArray(child)) flatten(child, fullKey, result);
    else errors.push(`invalid catalog value at ${fullKey}`);
  }
  return result;
}

function placeholders(text) {
  return [...text.matchAll(/{{\s*([\w.]+)(?:\s*,[^}]*)?\s*}}/g)].map((match) => match[1]).sort();
}

function readCatalog(language, namespace) {
  const catalog = flatten(readJson(path.join(localeRoot, language, `${namespace}.json`)));
  const fragmentFiles = (fragmentFilesByLanguage.get(language) ?? [])
    .filter((file) => file.startsWith(`${namespace}-`));
  for (const fragmentFile of fragmentFiles) {
    const fragmentPath = path.join(fragmentRoot, language, fragmentFile);
    for (const [key, value] of flatten(readJson(fragmentPath))) {
      if (catalog.has(key)) {
        errors.push(`${path.relative(root, fragmentPath)}:${key}: duplicate translation key`);
      } else {
        catalog.set(key, value);
      }
    }
  }
  return catalog;
}

for (const language of languages) {
  for (const fragmentFile of fragmentFilesByLanguage.get(language) ?? []) {
    const namespace = fragmentFile.split("-", 1)[0];
    if (!namespaces.includes(namespace)) {
      errors.push(`${language}/fragments/${fragmentFile}: namespace prefix is not supported`);
    }
  }
}

for (const namespace of namespaces) {
  const base = readCatalog(languages[0], namespace);
  for (const language of languages) {
    const catalog = readCatalog(language, namespace);
    const missing = [...base.keys()].filter((key) => !catalog.has(key));
    const extra = [...catalog.keys()].filter((key) => !base.has(key));
    if (missing.length) errors.push(`${language}/${namespace}: missing keys: ${missing.join(", ")}`);
    if (extra.length) errors.push(`${language}/${namespace}: extra keys: ${extra.join(", ")}`);
    for (const [key, value] of catalog) {
      if (!value.trim()) errors.push(`${language}/${namespace}:${key}: empty translation`);
      if (
        language === "en-US" &&
        chinese.test(value) &&
        !englishCatalogChineseAllowlist.has(`${namespace}:${key}`)
      ) {
        errors.push(`${language}/${namespace}:${key}: unexpected Chinese in English translation`);
      }
      if (language === "zh-CN" && untranslatedEnglishUiWord.test(value)) {
        errors.push(`${language}/${namespace}:${key}: unexpected untranslated English UI word`);
      }
      const expected = placeholders(base.get(key) ?? "");
      const actual = placeholders(value);
      if (expected.join("|") !== actual.join("|")) {
        errors.push(`${language}/${namespace}:${key}: interpolation mismatch (${expected.join(", ")} vs ${actual.join(", ")})`);
      }
    }
    const pluralStems = new Set([...catalog.keys()].flatMap((key) => {
      const match = key.match(/^(.*)_(zero|one|two|few|many|other)$/);
      return match ? [match[1]] : [];
    }));
    for (const stem of pluralStems) {
      if (!catalog.has(`${stem}_one`)) {
        errors.push(`${language}/${namespace}:${stem}: missing _one plural form`);
      }
      if (!catalog.has(`${stem}_other`)) {
        errors.push(`${language}/${namespace}:${stem}: missing _other plural form`);
      }
    }
  }
  const english = readCatalog("en-US", namespace);
  for (const [key, value] of base) {
    if (!/[A-Za-z]/.test(value) || english.get(key) !== value) continue;
    const qualifiedKey = `${namespace}:${key}`;
    if (sharedValueAllowlist.has(qualifiedKey)) usedSharedValueAllowlist.add(qualifiedKey);
    else errors.push(`${qualifiedKey}: identical Chinese and English UI translation`);
  }
}

for (const qualifiedKey of sharedValueAllowlist) {
  if (!usedSharedValueAllowlist.has(qualifiedKey)) {
    errors.push(`stale shared-value allowlist entry: ${qualifiedKey}`);
  }
}

const allowlistPath = path.join(root, "scripts", "i18n-allowlist.json");
const allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
const usedAllowlist = new Set();

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["locales", "assets"].includes(entry.name)) return [];
      return sourceFiles(file);
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) return [];
    return [file];
  });
}

for (const file of sourceFiles(sourceRoot)) {
  const relative = path.relative(root, file).replaceAll(path.sep, "/");
  const sourceText = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  function visit(node) {
    let value = null;
    if (
      ts.isStringLiteralLike(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) value = node.text;
    if (value && chinese.test(value)) {
      const permitted = (allowlist[relative] ?? []).includes(value);
      if (permitted) usedAllowlist.add(`${relative}\0${value}`);
      else {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        errors.push(`${relative}:${line}: untranslated Chinese literal: ${JSON.stringify(value.trim())}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

for (const [file, values] of Object.entries(allowlist)) {
  for (const value of values) {
    if (!usedAllowlist.has(`${file}\0${value}`)) errors.push(`${file}: stale i18n allowlist entry: ${JSON.stringify(value)}`);
  }
}

const repositoryRoot = path.resolve(root, "..");
const rustFiles = [
  "crates/agentport-core/src/models.rs",
  "crates/agentport-core/src/db/mod.rs",
  "crates/agentport-core/src/error.rs",
  "crates/agentport-core/src/notify.rs",
  "crates/agentport-core/src/timeline.rs",
  "crates/agentport-core/src/protocol.rs",
  "crates/agentport-core/src/adapters/mod.rs",
  "crates/agentport-core/src/adapters/capability.rs",
  "crates/agentport-core/src/adapters/claude.rs",
  "crates/agentport-core/src/adapters/codex.rs",
  "crates/agentport-core/src/adapters/kimi.rs",
  "crates/agentport-core/src/adapters/qoder.rs",
  "crates/agentport-core/src/adapters/pi.rs",
  "crates/agentport-core/src/adapters/shell.rs",
  "crates/agentport-host/src/main.rs",
  "crates/agentport-host/src/server.rs",
  "crates/agentport-cli/src/main.rs",
  "src-tauri/src/main.rs",
  "src-tauri/src/git_commands.rs",
];
const rustAllowlistPath = path.join(root, "scripts", "i18n-rust-allowlist.json");
const rustAllowlist = JSON.parse(fs.readFileSync(rustAllowlistPath, "utf8"));
const usedRustAllowlist = new Set();

function stripRustLineComment(line) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length - 1; index += 1) {
    const character = line[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "/" && line[index + 1] === "/") return line.slice(0, index);
  }
  return line;
}

for (const relative of rustFiles) {
  const file = path.join(repositoryRoot, relative);
  if (!fs.existsSync(file)) continue;
  const sourceText = fs.readFileSync(file, "utf8");
  // These modules keep unit fixtures after their first cfg(test) module. The
  // fixtures intentionally contain multilingual user data and are not GUI copy.
  const testStart = sourceText.search(/\n#\[cfg\(test\)\]\s*\nmod\s+/);
  const productionText = testStart >= 0 ? sourceText.slice(0, testStart) : sourceText;
  const withoutBlockComments = productionText.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [lineIndex, originalLine] of withoutBlockComments.split(/\r?\n/).entries()) {
    const line = stripRustLineComment(originalLine);
    for (const match of line.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
      const value = match[1];
      if (!chinese.test(value)) continue;
      const permitted = (rustAllowlist[relative] ?? []).includes(value);
      if (permitted) usedRustAllowlist.add(`${relative}\0${value}`);
      else errors.push(`${relative}:${lineIndex + 1}: untranslated Rust UI literal: ${JSON.stringify(value)}`);
    }
  }
}

for (const [file, values] of Object.entries(rustAllowlist)) {
  for (const value of values) {
    if (!usedRustAllowlist.has(`${file}\0${value}`)) {
      errors.push(`${file}: stale Rust i18n allowlist entry: ${JSON.stringify(value)}`);
    }
  }
}

if (errors.length) {
  console.error(`i18n check failed (${errors.length} issue${errors.length === 1 ? "" : "s"}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(
  `i18n check passed: ${languages.length} locales, ${namespaces.length} namespaces, ` +
  `${expectedFragmentFiles.length} resource fragments, no untranslated UI literals.`,
);
