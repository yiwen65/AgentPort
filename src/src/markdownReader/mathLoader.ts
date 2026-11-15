// KaTeX is loaded on the first formula, including its stylesheet. Fonts are
// emitted by Vite next to the other assets and allowed by font-src 'self'.

type Katex = typeof import("katex").default;

let katexPromise: Promise<Katex> | null = null;
let cssPromise: Promise<unknown> | null = null;

function testEnvironment(): boolean {
  return (import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE === "test";
}

export function loadKatex(): Promise<Katex> {
  katexPromise ??= import("katex").then((module) => module.default);
  if (!testEnvironment()) {
    cssPromise ??= import("katex/dist/katex.min.css");
  }
  return Promise.all([katexPromise, cssPromise]).then(([katex]) => katex);
}
