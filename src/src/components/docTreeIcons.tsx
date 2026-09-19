// Hand-drawn file-type icons for the document tree (VSCode icon-theme
// style). `fileIconSpec` maps a file name to a small SVG spec — special
// file names win over extensions, unknown types fall back to the generic
// file icon. Glyphs are 16×16, single- or two-tone with a fixed palette
// that reads on both dark and light themes (like VSCode icon packs).

export interface DocIconPath {
  d: string;
  transform?: string;
}

export interface DocIconSpec {
  /** Fixed palette color (theme-independent, like VSCode icon themes). */
  color: string;
  /** Letter/short-text glyph centered in the 16×16 box. */
  text?: string;
  /** Text size in px (defaults to 8; shorter labels can go bigger). */
  textSize?: number;
  /** Serif text (used by the font icon). */
  serif?: boolean;
  fillPaths?: DocIconPath[];
  strokePaths?: DocIconPath[];
}

/* Palette (Material-Icon-Theme-adjacent hues). */
const BLUE = "#4f9cc9";
const TS_BLUE = "#3178c6";
const REACT_CYAN = "#61dafb";
const JS_YELLOW = "#e8d44d";
const HTML_ORANGE = "#e44d26";
const RUST = "#dea584";
const PY_BLUE = "#4b8bbe";
const GOLD = "#d8b355";
const GIT_ORANGE = "#f05133";
const NPM_RED = "#cb3837";
const YAML_RED = "#c0564f";
const SH_GREEN = "#89e051";
const PS_BLUE = "#2f80ed";
const IMAGE_PURPLE = "#a074c4";
const FONT_ORANGE = "#f0991e";
const ARCHIVE = "#a8a23c";
const DOCKER = "#0db7ed";
const PERSON = "#d16a6a";
const SHIELD = "#5aa65a";
const GRAY = "#8a97a3";
const C_BLUE = "#5c9bd6";
const GO_TEAL = "#00add8";
const SWIFT_ORANGE = "#f05138";
const KT_PURPLE = "#a97bff";

const MARKDOWN: DocIconSpec = {
  color: BLUE,
  fillPaths: [
    {
      d: "M2.5 3h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm5.5 3 2.5 3H9v3H7V9H5.5Z",
    },
  ],
};

const SLIDERS = (color: string): DocIconSpec => ({
  color,
  strokePaths: [{ d: "M2.5 4.5h11M2.5 8h11M2.5 11.5h11" }],
  fillPaths: [
    { d: "M7.2 4.5a1.25 1.25 0 1 0-2.5 0 1.25 1.25 0 0 0 2.5 0Z" },
    { d: "M11.2 8a1.25 1.25 0 1 0-2.5 0 1.25 1.25 0 0 0 2.5 0Z" },
    { d: "M5.7 11.5a1.25 1.25 0 1 0-2.5 0 1.25 1.25 0 0 0 2.5 0Z" },
  ],
});

const GEAR = (color: string): DocIconSpec => ({
  color,
  strokePaths: [
    {
      d: "M8 1.3v1.7M8 13v1.7M1.3 8h1.7M13 8h1.7M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2",
    },
  ],
  fillPaths: [{ d: "M8 5.4A2.6 2.6 0 1 1 5.4 8 2.6 2.6 0 0 1 8 5.4Z" }],
});

const ARCHIVE_BOX = (color: string): DocIconSpec => ({
  color,
  strokePaths: [{ d: "M3 5.5 8 3l5 2.5v5L8 13 3 10.5ZM3 5.5 8 8l5-2.5M8 8v5" }],
});

/** Exact (lowercased) special file names. */
const SPECIAL_NAMES: Record<string, DocIconSpec> = {
  "agents.md": MARKDOWN,
  "learns.md": MARKDOWN,
  "readme.md": {
    color: BLUE,
    fillPaths: [
      {
        d: "M8 1.5a6.5 6.5 0 1 0 6.5 6.5A6.5 6.5 0 0 0 8 1.5Zm-.9 9.9h1.8V7H7.1Zm.9-7a1.05 1.05 0 1 1-1.05 1.05A1.05 1.05 0 0 1 8 4.4Z",
      },
    ],
  },
  "contributing.md": {
    color: PERSON,
    fillPaths: [
      { d: "M8 2.7a2.35 2.35 0 1 1-2.35 2.35A2.35 2.35 0 0 1 8 2.7Z" },
      { d: "M3.8 13.4c.55-3 2.3-4.5 4.2-4.5s3.65 1.5 4.2 4.5Z" },
    ],
  },
  "security.md": {
    color: SHIELD,
    fillPaths: [
      {
        d: "M8 1.6 13.2 3.8v4c0 3.3-2.2 5.5-5.2 6.6-3-1.1-5.2-3.3-5.2-6.6v-4Zm2.9 5.5-3.4 3.6-1.8-1.9-1.1 1.1 2.9 3 4.5-4.7Z",
      },
    ],
  },
  "changelog.md": {
    color: BLUE,
    strokePaths: [{ d: "M8 2.3a5.7 5.7 0 1 1-5.7 5.7A5.7 5.7 0 0 1 8 2.3ZM8 4.8v3.4l2.5 1.7" }],
  },
  license: {
    color: GOLD,
    fillPaths: [{ d: "M5.5 2.6a2.9 2.9 0 1 1-2.9 2.9A2.9 2.9 0 0 1 5.5 2.6Z" }],
    strokePaths: [{ d: "M7.6 7.4 13 12.8M10.7 10.5l1.9-1.9M12 12l1.4-1.4" }],
  },
  copying: {
    color: GOLD,
    fillPaths: [{ d: "M5.5 2.6a2.9 2.9 0 1 1-2.9 2.9A2.9 2.9 0 0 1 5.5 2.6Z" }],
    strokePaths: [{ d: "M7.6 7.4 13 12.8M10.7 10.5l1.9-1.9M12 12l1.4-1.4" }],
  },
  ".env": SLIDERS(GOLD),
  ".gitignore": {
    color: GIT_ORANGE,
    fillPaths: [{ d: "M8 1.8 14.2 8 8 14.2 1.8 8Zm0 4.2a2 2 0 1 1-2 2 2 2 0 0 1 2-2Z" }],
  },
  ".gitattributes": {
    color: GIT_ORANGE,
    fillPaths: [{ d: "M8 1.8 14.2 8 8 14.2 1.8 8Zm0 4.2a2 2 0 1 1-2 2 2 2 0 0 1 2-2Z" }],
  },
  ".gitmodules": {
    color: GIT_ORANGE,
    fillPaths: [{ d: "M8 1.8 14.2 8 8 14.2 1.8 8Zm0 4.2a2 2 0 1 1-2 2 2 2 0 0 1 2-2Z" }],
  },
  ".npmrc": { color: NPM_RED, text: "npm", textSize: 5.4 },
  "package.json": { color: NPM_RED, text: "npm", textSize: 5.4 },
  "package-lock.json": { color: NPM_RED, text: "npm", textSize: 5.4 },
  dockerfile: {
    color: DOCKER,
    fillPaths: [
      {
        d: "M4.2 4.6h2.3v2.2H4.2ZM7 4.6h2.3v2.2H7ZM9.8 4.6h2.3v2.2H9.8ZM4.2 7.3h2.3v2.2H4.2ZM7 7.3h2.3v2.2H7ZM9.8 7.3h2.3v2.2H9.8Z",
      },
    ],
    strokePaths: [{ d: "M2.4 12.4c2.3 1.2 8.9 1.2 11.2 0" }],
  },
  ".dockerignore": {
    color: DOCKER,
    fillPaths: [
      {
        d: "M4.2 4.6h2.3v2.2H4.2ZM7 4.6h2.3v2.2H7ZM9.8 4.6h2.3v2.2H9.8ZM4.2 7.3h2.3v2.2H4.2ZM7 7.3h2.3v2.2H7ZM9.8 7.3h2.3v2.2H9.8Z",
      },
    ],
    strokePaths: [{ d: "M2.4 12.4c2.3 1.2 8.9 1.2 11.2 0" }],
  },
  makefile: GEAR(GRAY),
  "cargo.toml": ARCHIVE_BOX(RUST),
  "cargo.lock": ARCHIVE_BOX(RUST),
};

const TS_ICON: DocIconSpec = { color: TS_BLUE, text: "TS", textSize: 7.5 };
const REACT_ICON: DocIconSpec = {
  color: REACT_CYAN,
  strokePaths: [
    { d: "M8 2.2c3.4 0 6.2 2.6 6.2 5.8s-2.8 5.8-6.2 5.8S1.8 11.2 1.8 8 4.6 2.2 8 2.2Z" },
    {
      d: "M8 2.2c3.4 0 6.2 2.6 6.2 5.8s-2.8 5.8-6.2 5.8S1.8 11.2 1.8 8 4.6 2.2 8 2.2Z",
      transform: "rotate(60 8 8)",
    },
  ],
  fillPaths: [{ d: "M8 6.9a1.1 1.1 0 1 1-1.1 1.1A1.1 1.1 0 0 1 8 6.9Z" }],
};

const JSON_ICON: DocIconSpec = { color: "#c9c24a", text: "{}", textSize: 8 };
const LOCK_ICON: DocIconSpec = {
  color: GOLD,
  fillPaths: [{ d: "M4 7.4h8a.8.8 0 0 1 .8.8v5a.8.8 0 0 1-.8.8H4a.8.8 0 0 1-.8-.8v-5a.8.8 0 0 1 .8-.8Z" }],
  strokePaths: [{ d: "M5.8 7.4V5.3a2.2 2.2 0 0 1 4.4 0v2.1" }],
};

/** Extension (lowercased, no dot) → icon. */
const EXTENSIONS: Record<string, DocIconSpec> = {
  md: MARKDOWN,
  markdown: MARKDOWN,
  mdx: MARKDOWN,
  json: JSON_ICON,
  jsonc: JSON_ICON,
  json5: JSON_ICON,
  ts: TS_ICON,
  mts: TS_ICON,
  cts: TS_ICON,
  tsx: REACT_ICON,
  js: { color: JS_YELLOW, text: "JS", textSize: 7.5 },
  mjs: { color: JS_YELLOW, text: "JS", textSize: 7.5 },
  cjs: { color: JS_YELLOW, text: "JS", textSize: 7.5 },
  jsx: REACT_ICON,
  css: { color: BLUE, text: "#", textSize: 9 },
  scss: { color: "#cd6799", text: "#", textSize: 9 },
  less: { color: "#2b4c80", text: "#", textSize: 9 },
  html: { color: HTML_ORANGE, text: "<>", textSize: 6.5 },
  htm: { color: HTML_ORANGE, text: "<>", textSize: 6.5 },
  rs: { color: RUST, text: "R", textSize: 9 },
  py: { color: PY_BLUE, text: "Py", textSize: 7.5 },
  toml: SLIDERS(GRAY),
  yml: {
    color: YAML_RED,
    fillPaths: [
      { d: "M2.6 3.4h2v1.5h-2ZM5.8 3.4h7.6v1.5H5.8ZM2.6 7.25h2v1.5h-2ZM5.8 7.25h7.6v1.5H5.8ZM2.6 11.1h2v1.5h-2ZM5.8 11.1h7.6v1.5H5.8Z" },
    ],
  },
  yaml: {
    color: YAML_RED,
    fillPaths: [
      { d: "M2.6 3.4h2v1.5h-2ZM5.8 3.4h7.6v1.5H5.8ZM2.6 7.25h2v1.5h-2ZM5.8 7.25h7.6v1.5H5.8ZM2.6 11.1h2v1.5h-2ZM5.8 11.1h7.6v1.5H5.8Z" },
    ],
  },
  lock: LOCK_ICON,
  sh: { color: SH_GREEN, text: "$", textSize: 9 },
  bash: { color: SH_GREEN, text: "$", textSize: 9 },
  zsh: { color: SH_GREEN, text: "$", textSize: 9 },
  ps1: { color: PS_BLUE, text: ">_", textSize: 6.5 },
  bat: {
    color: "#3aa7e8",
    fillPaths: [
      { d: "M2.9 3.6h4.5v4.1H2.9ZM8.6 3.6h4.5v4.1H8.6ZM2.9 8.3h4.5v4.1H2.9ZM8.6 8.3h4.5v4.1H8.6Z" },
    ],
  },
  cmd: {
    color: "#3aa7e8",
    fillPaths: [
      { d: "M2.9 3.6h4.5v4.1H2.9ZM8.6 3.6h4.5v4.1H8.6ZM2.9 8.3h4.5v4.1H2.9ZM8.6 8.3h4.5v4.1H8.6Z" },
    ],
  },
  png: {
    color: IMAGE_PURPLE,
    fillPaths: [
      {
        d: "M2.6 3.4h10.8a.9.9 0 0 1 .9.9v7.4a.9.9 0 0 1-.9.9H2.6a.9.9 0 0 1-.9-.9V4.3a.9.9 0 0 1 .9-.9Zm2 7.6 2.4-3 2 2.2 1.7-1.9 2.4 2.7Zm5.9-5.4a1.15 1.15 0 1 0 1.15 1.15 1.15 1.15 0 0 0-1.15-1.15Z",
      },
    ],
  },
  jpg: {
    color: IMAGE_PURPLE,
    fillPaths: [
      {
        d: "M2.6 3.4h10.8a.9.9 0 0 1 .9.9v7.4a.9.9 0 0 1-.9.9H2.6a.9.9 0 0 1-.9-.9V4.3a.9.9 0 0 1 .9-.9Zm2 7.6 2.4-3 2 2.2 1.7-1.9 2.4 2.7Zm5.9-5.4a1.15 1.15 0 1 0 1.15 1.15 1.15 1.15 0 0 0-1.15-1.15Z",
      },
    ],
  },
  jpeg: {
    color: IMAGE_PURPLE,
    fillPaths: [
      {
        d: "M2.6 3.4h10.8a.9.9 0 0 1 .9.9v7.4a.9.9 0 0 1-.9.9H2.6a.9.9 0 0 1-.9-.9V4.3a.9.9 0 0 1 .9-.9Zm2 7.6 2.4-3 2 2.2 1.7-1.9 2.4 2.7Zm5.9-5.4a1.15 1.15 0 1 0 1.15 1.15 1.15 1.15 0 0 0-1.15-1.15Z",
      },
    ],
  },
  gif: {
    color: IMAGE_PURPLE,
    fillPaths: [
      {
        d: "M2.6 3.4h10.8a.9.9 0 0 1 .9.9v7.4a.9.9 0 0 1-.9.9H2.6a.9.9 0 0 1-.9-.9V4.3a.9.9 0 0 1 .9-.9Zm2 7.6 2.4-3 2 2.2 1.7-1.9 2.4 2.7Zm5.9-5.4a1.15 1.15 0 1 0 1.15 1.15 1.15 1.15 0 0 0-1.15-1.15Z",
      },
    ],
  },
  webp: {
    color: IMAGE_PURPLE,
    fillPaths: [
      {
        d: "M2.6 3.4h10.8a.9.9 0 0 1 .9.9v7.4a.9.9 0 0 1-.9.9H2.6a.9.9 0 0 1-.9-.9V4.3a.9.9 0 0 1 .9-.9Zm2 7.6 2.4-3 2 2.2 1.7-1.9 2.4 2.7Zm5.9-5.4a1.15 1.15 0 1 0 1.15 1.15 1.15 1.15 0 0 0-1.15-1.15Z",
      },
    ],
  },
  svg: {
    color: FONT_ORANGE,
    fillPaths: [
      {
        d: "M2.6 3.4h10.8a.9.9 0 0 1 .9.9v7.4a.9.9 0 0 1-.9.9H2.6a.9.9 0 0 1-.9-.9V4.3a.9.9 0 0 1 .9-.9Zm2 7.6 2.4-3 2 2.2 1.7-1.9 2.4 2.7Zm5.9-5.4a1.15 1.15 0 1 0 1.15 1.15 1.15 1.15 0 0 0-1.15-1.15Z",
      },
    ],
  },
  ico: {
    color: IMAGE_PURPLE,
    fillPaths: [
      {
        d: "M2.6 3.4h10.8a.9.9 0 0 1 .9.9v7.4a.9.9 0 0 1-.9.9H2.6a.9.9 0 0 1-.9-.9V4.3a.9.9 0 0 1 .9-.9Zm2 7.6 2.4-3 2 2.2 1.7-1.9 2.4 2.7Zm5.9-5.4a1.15 1.15 0 1 0 1.15 1.15 1.15 1.15 0 0 0-1.15-1.15Z",
      },
    ],
  },
  icns: {
    color: IMAGE_PURPLE,
    fillPaths: [
      {
        d: "M2.6 3.4h10.8a.9.9 0 0 1 .9.9v7.4a.9.9 0 0 1-.9.9H2.6a.9.9 0 0 1-.9-.9V4.3a.9.9 0 0 1 .9-.9Zm2 7.6 2.4-3 2 2.2 1.7-1.9 2.4 2.7Zm5.9-5.4a1.15 1.15 0 1 0 1.15 1.15 1.15 1.15 0 0 0-1.15-1.15Z",
      },
    ],
  },
  ttf: { color: FONT_ORANGE, text: "A", textSize: 9, serif: true },
  otf: { color: FONT_ORANGE, text: "A", textSize: 9, serif: true },
  woff: { color: FONT_ORANGE, text: "A", textSize: 9, serif: true },
  woff2: { color: FONT_ORANGE, text: "A", textSize: 9, serif: true },
  zip: ARCHIVE_BOX(ARCHIVE),
  tar: ARCHIVE_BOX(ARCHIVE),
  gz: ARCHIVE_BOX(ARCHIVE),
  tgz: ARCHIVE_BOX(ARCHIVE),
  bz2: ARCHIVE_BOX(ARCHIVE),
  xz: ARCHIVE_BOX(ARCHIVE),
  "7z": ARCHIVE_BOX(ARCHIVE),
  rar: ARCHIVE_BOX(ARCHIVE),
  pdf: {
    color: "#e5534b",
    fillPaths: [{ d: "M4 1.5h5.5L12 4v10a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 14ZM9.5 1.5V4H12" }],
  },
  go: { color: GO_TEAL, text: "Go", textSize: 7 },
  c: { color: C_BLUE, text: "C", textSize: 9 },
  h: { color: C_BLUE, text: "H", textSize: 9 },
  cc: { color: C_BLUE, text: "C+", textSize: 6.5 },
  cpp: { color: C_BLUE, text: "C+", textSize: 6.5 },
  cxx: { color: C_BLUE, text: "C+", textSize: 6.5 },
  hpp: { color: C_BLUE, text: "H+", textSize: 6.5 },
  swift: { color: SWIFT_ORANGE, text: "S", textSize: 9 },
  kt: { color: KT_PURPLE, text: "K", textSize: 9 },
  kts: { color: KT_PURPLE, text: "K", textSize: 9 },
};

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** Maps a file name to its icon spec, or null for the generic file icon.
 * Special names win over extensions; `tsconfig*.json` is TypeScript. */
export function fileIconSpec(name: string): DocIconSpec | null {
  const lower = name.toLowerCase();
  const special = SPECIAL_NAMES[lower];
  if (special) return special;
  if (lower.startsWith(".env.")) return SLIDERS(GOLD);
  if (lower.startsWith("tsconfig") && lower.endsWith(".json")) return TS_ICON;
  if (lower.startsWith("docker-compose.") || lower === "dockerfile") {
    return SPECIAL_NAMES["dockerfile"] ?? null;
  }
  if (lower === "license" || lower.startsWith("license.")) {
    return SPECIAL_NAMES["license"] ?? null;
  }
  if (lower === "copying" || lower.startsWith("copying.")) {
    return SPECIAL_NAMES["copying"] ?? null;
  }
  if (lower.endsWith(".mk")) return GEAR(GRAY);
  const ext = extensionOf(name);
  return ext ? (EXTENSIONS[ext] ?? null) : null;
}

/** Generic file icon (unchanged from the original tree). */
export function IconFile() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9 1.75H4.5a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.25L9 1.75Zm0 0v3.5h3.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Generic folder icon (unchanged from the original tree). */
export function IconFolder() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 4.25a1 1 0 0 1 1-1h2.6l1.4 1.6h6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.25Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Renders the mapped type icon, or the generic file icon when unmapped. */
export function DocFileIcon({ name }: { name: string }) {
  const spec = fileIconSpec(name);
  if (!spec) return <IconFile />;
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="doc-file-icon">
      {spec.fillPaths?.map((path, index) => (
        <path key={`f${index}`} d={path.d} transform={path.transform} fill={spec.color} fillRule="evenodd" />
      ))}
      {spec.strokePaths?.map((path, index) => (
        <path
          key={`s${index}`}
          d={path.d}
          transform={path.transform}
          fill="none"
          stroke={spec.color}
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {spec.text ? (
        <text
          x="8"
          y="11.7"
          textAnchor="middle"
          fontSize={spec.textSize ?? 8}
          fontWeight={700}
          fill={spec.color}
          fontFamily={spec.serif ? "Georgia, serif" : "var(--font-mono)"}
        >
          {spec.text}
        </text>
      ) : null}
    </svg>
  );
}
