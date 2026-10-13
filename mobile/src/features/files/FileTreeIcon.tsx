// Mobile-owned SVG artwork: no desktop (noncommercial-licensed) source import.
// Match the desktop tree's single icon slot, type colors and compact glyph style.
const types: Record<string, readonly [string, string]> = {
  md: ["↓", "#4f9cc9"], markdown: ["↓", "#4f9cc9"], mdx: ["↓", "#4f9cc9"],
  ts: ["TS", "#3178c6"], mts: ["TS", "#3178c6"], cts: ["TS", "#3178c6"],
  js: ["JS", "#e8d44d"], mjs: ["JS", "#e8d44d"], cjs: ["JS", "#e8d44d"],
  tsx: ["⚛", "#61dafb"], jsx: ["⚛", "#61dafb"],
  json: ["{}", "#c9c24a"], jsonc: ["{}", "#c9c24a"], json5: ["{}", "#c9c24a"],
  css: ["#", "#4f9cc9"], scss: ["#", "#cd6799"], less: ["#", "#2b4c80"],
  html: ["<>", "#e44d26"], htm: ["<>", "#e44d26"],
  rs: ["R", "#dea584"], py: ["Py", "#4b8bbe"],
  toml: ["≡", "#8a97a3"], yaml: ["≡", "#c0564f"], yml: ["≡", "#c0564f"],
  sh: ["$", "#89e051"], bash: ["$", "#89e051"], zsh: ["$", "#89e051"], ps1: [">_", "#2f80ed"],
  c: ["C", "#5c9bd6"], h: ["C", "#5c9bd6"], cpp: ["C+", "#5c9bd6"], hpp: ["C+", "#5c9bd6"],
  go: ["Go", "#00add8"], swift: ["S", "#f05138"], kt: ["K", "#a97bff"], kts: ["K", "#a97bff"],
};
const special: Record<string, readonly [string, string]> = {
  "readme.md": ["i", "#4f9cc9"], "package.json": ["npm", "#cb3837"], "package-lock.json": ["npm", "#cb3837"],
  "cargo.toml": ["R", "#dea584"], "cargo.lock": ["R", "#dea584"],
  dockerfile: ["D", "#0db7ed"], ".dockerignore": ["D", "#0db7ed"],
  ".gitignore": ["git", "#f05133"], ".gitattributes": ["git", "#f05133"], ".gitmodules": ["git", "#f05133"],
  ".env": ["≡", "#d8b355"], ".npmrc": ["npm", "#cb3837"],
};

export function FileTreeIcon({ name, directory, expanded = false }: { name: string; directory: boolean; expanded?: boolean }) {
  if (directory) return <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" data-file-icon="directory"><path d={expanded ? "m4 6 4 4 4-4" : "m6 4 4 4-4 4"} /></svg>;
  const lower = name.toLowerCase();
  const extension = lower.includes(".") ? lower.split(".").pop()! : "";
  const glyph = Object.hasOwn(special, lower) ? special[lower] : Object.hasOwn(types, extension) ? types[extension] : undefined;
  const kind = /^(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/.test(extension) ? "image"
    : /^(zip|gz|tgz|tar|bz2|xz|7z|rar)$/.test(extension) ? "archive" : glyph ? "code" : "file";
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" data-file-icon={kind} style={{ color: glyph?.[1] ?? (kind === "image" ? "#a074c4" : kind === "archive" ? "#a8a23c" : "#8a97a3") }}>
    {glyph ? <text x="8" y="8.5" textAnchor="middle" dominantBaseline="middle" fill="currentColor" fontFamily="ui-monospace, monospace" fontWeight="700" fontSize={glyph[0].length > 2 ? 5.5 : glyph[0].length > 1 ? 7 : 10}>{glyph[0]}</text>
      : kind === "image" ? <g stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"><rect x="2" y="3" width="12" height="10" rx="1" /><path d="m3 11 3-4 3 3 2-2 2 3" /><circle cx="11" cy="6" r=".8" /></g>
      : kind === "archive" ? <g stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"><path d="M2 4h12v3H2zM3 7v6h10V7M6 9h4" /></g>
      : <path d="M4 2h5l3 3v9H4V2Zm5 0v4h3M6 9h4M6 11h4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />}
  </svg>;
}
