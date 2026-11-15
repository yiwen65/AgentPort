// Filename/shebang language detection and lazy CodeMirror language loading.
// Unknown files fall back to plain text; loaders are cached per language.

import type { Extension } from "@codemirror/state";

export type CodeLanguageId =
  | "javascript"
  | "typescript"
  | "jsx"
  | "tsx"
  | "json"
  | "jsonc"
  | "html"
  | "css"
  | "scss"
  | "sass"
  | "markdown"
  | "xml"
  | "sql"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "c"
  | "cpp"
  | "php"
  | "yaml"
  | "vue"
  | "shell"
  | "toml"
  | "ini"
  | "dockerfile"
  | "diff"
  | "lua"
  | "ruby"
  | "swift"
  | "kotlin"
  | "csharp";

const EXTENSION_LANGUAGES: Record<string, CodeLanguageId> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  json: "json",
  jsonc: "jsonc",
  json5: "jsonc",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  xml: "xml",
  svg: "xml",
  xsl: "xml",
  sql: "sql",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  php: "php",
  yaml: "yaml",
  yml: "yaml",
  vue: "vue",
  svelte: "html",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  env: "ini",
  diff: "diff",
  patch: "diff",
  lua: "lua",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
};

const BASENAME_LANGUAGES: Record<string, CodeLanguageId> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  ".env": "ini",
  ".editorconfig": "ini",
  ".gitignore": "ini",
  ".dockerignore": "ini",
  ".npmrc": "ini",
  ".prettierrc": "json",
  ".babelrc": "json",
  ".eslintrc": "json",
};

const SHEBANG_LANGUAGES: Record<string, CodeLanguageId> = {
  node: "javascript",
  nodejs: "javascript",
  deno: "javascript",
  bun: "javascript",
  python: "python",
  python3: "python",
  ruby: "ruby",
  bash: "shell",
  sh: "shell",
  zsh: "shell",
  php: "php",
};

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).toLowerCase();
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

function languageFromShebang(line: string): CodeLanguageId | null {
  const match = /^#!\s*(\S+)(?:\s+(.*))?$/.exec(line.trim());
  if (!match) return null;
  const interpreter = match[1].split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (interpreter === "env") {
    const command = match[2]?.trim().split(/\s+/)[0]?.toLowerCase();
    return command ? SHEBANG_LANGUAGES[command] ?? null : null;
  }
  return SHEBANG_LANGUAGES[interpreter] ?? null;
}

/** Detects a language from the filename, then the first line for scripts. */
export function detectLanguage(path: string, firstLine?: string): CodeLanguageId | null {
  const name = basename(path);
  const exact = BASENAME_LANGUAGES[name];
  if (exact) return exact;
  if (name.startsWith(".env.")) return "ini";
  const byExtension = EXTENSION_LANGUAGES[extensionOf(name)];
  if (byExtension) return byExtension;
  if (extensionOf(name)) return null;
  return firstLine ? languageFromShebang(firstLine) : null;
}

async function streamLanguage(
  load: () => Promise<Record<string, unknown>>,
  exportName: string,
): Promise<Extension> {
  const [{ StreamLanguage }, module] = await Promise.all([
    import("@codemirror/language"),
    load(),
  ]);
  const parser = module[exportName];
  if (!parser) throw new Error(`missing legacy mode export: ${exportName}`);
  return StreamLanguage.define(parser as Parameters<typeof StreamLanguage.define>[0]);
}

type LanguageLoader = () => Promise<Extension>;

const LOADERS: Record<CodeLanguageId, LanguageLoader> = {
  javascript: async () => {
    const { javascript } = await import("@codemirror/lang-javascript");
    return javascript();
  },
  typescript: async () => {
    const { javascript } = await import("@codemirror/lang-javascript");
    return javascript({ typescript: true });
  },
  jsx: async () => {
    const { javascript } = await import("@codemirror/lang-javascript");
    return javascript({ jsx: true });
  },
  tsx: async () => {
    const { javascript } = await import("@codemirror/lang-javascript");
    return javascript({ jsx: true, typescript: true });
  },
  json: async () => {
    const { json } = await import("@codemirror/lang-json");
    return json();
  },
  jsonc: () => streamLanguage(() => import("@codemirror/legacy-modes/mode/javascript"), "javascript"),
  html: async () => {
    const { html } = await import("@codemirror/lang-html");
    return html();
  },
  css: async () => {
    const { css } = await import("@codemirror/lang-css");
    return css();
  },
  scss: async () => {
    const { sass } = await import("@codemirror/lang-sass");
    return sass();
  },
  sass: async () => {
    const { sass } = await import("@codemirror/lang-sass");
    return sass({ indented: true });
  },
  markdown: async () => {
    const { markdown } = await import("@codemirror/lang-markdown");
    return markdown();
  },
  xml: async () => {
    const { xml } = await import("@codemirror/lang-xml");
    return xml();
  },
  sql: async () => {
    const { sql } = await import("@codemirror/lang-sql");
    return sql();
  },
  python: async () => {
    const { python } = await import("@codemirror/lang-python");
    return python();
  },
  rust: async () => {
    const { rust } = await import("@codemirror/lang-rust");
    return rust();
  },
  go: async () => {
    const { go } = await import("@codemirror/lang-go");
    return go();
  },
  java: async () => {
    const { java } = await import("@codemirror/lang-java");
    return java();
  },
  c: async () => {
    const { cpp } = await import("@codemirror/lang-cpp");
    return cpp();
  },
  cpp: async () => {
    const { cpp } = await import("@codemirror/lang-cpp");
    return cpp();
  },
  php: async () => {
    const { php } = await import("@codemirror/lang-php");
    return php();
  },
  yaml: async () => {
    const { yaml } = await import("@codemirror/lang-yaml");
    return yaml();
  },
  vue: async () => {
    const { vue } = await import("@codemirror/lang-vue");
    return vue();
  },
  shell: () => streamLanguage(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  toml: () => streamLanguage(() => import("@codemirror/legacy-modes/mode/toml"), "toml"),
  ini: () => streamLanguage(() => import("@codemirror/legacy-modes/mode/properties"), "properties"),
  dockerfile: () =>
    streamLanguage(() => import("@codemirror/legacy-modes/mode/dockerfile"), "dockerFile"),
  diff: () => streamLanguage(() => import("@codemirror/legacy-modes/mode/diff"), "diff"),
  lua: () => streamLanguage(() => import("@codemirror/legacy-modes/mode/lua"), "lua"),
  ruby: () => streamLanguage(() => import("@codemirror/legacy-modes/mode/ruby"), "ruby"),
  swift: () => streamLanguage(() => import("@codemirror/legacy-modes/mode/swift"), "swift"),
  kotlin: () => streamLanguage(() => import("@codemirror/legacy-modes/mode/clike"), "kotlin"),
  csharp: () => streamLanguage(() => import("@codemirror/legacy-modes/mode/clike"), "csharp"),
};

const loaded = new Map<CodeLanguageId, Promise<Extension | null>>();

/** Loads and caches the language extension; failures resolve to plain text. */
export function loadLanguage(language: CodeLanguageId | null): Promise<Extension | null> {
  if (!language) return Promise.resolve(null);
  let pending = loaded.get(language);
  if (!pending) {
    pending = LOADERS[language]().catch(() => null);
    loaded.set(language, pending);
  }
  return pending;
}
