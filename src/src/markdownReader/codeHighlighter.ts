// Shiki integration for fenced code. Only the fine-grained core + JavaScript
// regex engine are used: the default Oniguruma engine needs WebAssembly,
// which the Tauri CSP deliberately does not allow. Languages and themes are
// loaded on demand and cached; anything unsupported falls back to plain text.

import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { HighlighterCore } from "shiki/core";
import type { LanguageRegistration, ThemedToken, ThemeRegistration } from "@shikijs/types";
import type { DocReadingTheme } from "./types";

type ThemeLoader = () => Promise<{ default: ThemeRegistration }>;
type LangLoader = () => Promise<{ default: LanguageRegistration[] }>;

export type CodeThemeName =
  | "github-light-default"
  | "github-dark-default"
  | "min-light"
  | "vitesse-dark";

const THEME_LOADERS: Record<CodeThemeName, ThemeLoader> = {
  "github-light-default": () => import("@shikijs/themes/github-light-default"),
  "github-dark-default": () => import("@shikijs/themes/github-dark-default"),
  "min-light": () => import("@shikijs/themes/min-light"),
  "vitesse-dark": () => import("@shikijs/themes/vitesse-dark"),
};

const LANG_LOADERS: Record<string, LangLoader> = {
  typescript: () => import("@shikijs/langs/typescript"),
  javascript: () => import("@shikijs/langs/javascript"),
  tsx: () => import("@shikijs/langs/tsx"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  rust: () => import("@shikijs/langs/rust"),
  python: () => import("@shikijs/langs/python"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  bash: () => import("@shikijs/langs/bash"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  sql: () => import("@shikijs/langs/sql"),
  go: () => import("@shikijs/langs/go"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  swift: () => import("@shikijs/langs/swift"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  ruby: () => import("@shikijs/langs/ruby"),
  php: () => import("@shikijs/langs/php"),
  lua: () => import("@shikijs/langs/lua"),
  graphql: () => import("@shikijs/langs/graphql"),
  diff: () => import("@shikijs/langs/diff"),
  markdown: () => import("@shikijs/langs/markdown"),
  xml: () => import("@shikijs/langs/xml"),
  ini: () => import("@shikijs/langs/ini"),
  docker: () => import("@shikijs/langs/docker"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
};

const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  py: "python",
  python3: "python",
  rs: "rust",
  sh: "shellscript",
  shell: "shellscript",
  zsh: "shellscript",
  console: "shellscript",
  yml: "yaml",
  md: "markdown",
  htm: "html",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  gql: "graphql",
  patch: "diff",
  dockerfile: "docker",
  make: "bash",
};

const MAX_HIGHLIGHT_CHARS = 200_000;
const CACHE_LIMIT = 40;

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedThemes = new Map<string, Promise<void>>();
const loadedLanguages = new Map<string, Promise<boolean>>();
const tokenCache = new Map<string, ThemedToken[][]>();

function testEnvironment(): boolean {
  return (import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE === "test";
}

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [],
    langs: [],
    // ES2018 keeps the engine usable on older WKWebView versions; the
    // JavaScript engine never touches WebAssembly.
    engine: createJavaScriptRegexEngine({ target: "ES2018" }),
    warnings: false,
  });
  return highlighterPromise;
}

export function codeThemeFor(
  readingTheme: DocReadingTheme,
  effective: "light" | "dark",
): CodeThemeName {
  if (readingTheme === "paper") return "min-light";
  if (readingTheme === "night") return "vitesse-dark";
  return effective === "dark" ? "github-dark-default" : "github-light-default";
}

function canonicalLanguage(lang: string): string {
  const key = lang.trim().toLowerCase();
  return LANG_ALIASES[key] ?? key;
}

async function ensureTheme(highlighter: HighlighterCore, theme: CodeThemeName): Promise<void> {
  let pending = loadedThemes.get(theme);
  if (!pending) {
    pending = THEME_LOADERS[theme]().then((module) => highlighter.loadTheme(module.default));
    loadedThemes.set(theme, pending);
  }
  await pending;
}

async function ensureLanguage(highlighter: HighlighterCore, lang: string): Promise<boolean> {
  let pending = loadedLanguages.get(lang);
  if (!pending) {
    const loader = LANG_LOADERS[lang];
    if (!loader) return false;
    pending = loader()
      .then((module) => highlighter.loadLanguage(...module.default).then(() => true))
      .catch(() => false);
    loadedLanguages.set(lang, pending);
  }
  return pending;
}

function cacheGet(key: string): ThemedToken[][] | undefined {
  const value = tokenCache.get(key);
  if (value) {
    tokenCache.delete(key);
    tokenCache.set(key, value);
  }
  return value;
}

function cacheSet(key: string, value: ThemedToken[][]): void {
  if (tokenCache.size >= CACHE_LIMIT) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }
  tokenCache.set(key, value);
}

/** Highlight one fenced block. Returns null for plain-text fallbacks. */
export async function highlightCode(
  code: string,
  lang: string,
  theme: CodeThemeName,
): Promise<ThemedToken[][] | null> {
  if (!lang || !code || code.length > MAX_HIGHLIGHT_CHARS || testEnvironment()) return null;
  const canonical = canonicalLanguage(lang);
  if (!LANG_LOADERS[canonical]) return null;
  const key = `${theme}\u0000${canonical}\u0000${code}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const highlighter = await getHighlighter();
    await ensureTheme(highlighter, theme);
    if (!(await ensureLanguage(highlighter, canonical))) return null;
    const tokens = highlighter.codeToTokensBase(code, { lang: canonical, theme });
    cacheSet(key, tokens);
    return tokens;
  } catch {
    return null;
  }
}
