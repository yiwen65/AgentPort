// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applyUiLanguage, i18n } from "./i18n";
import shellEnUS from "./locales/en-US/shell.json";
import shellZhCN from "./locales/zh-CN/shell.json";

const PANE_KEYS = [
  "workspaceLabel",
  "headerLabel",
  "splitRight",
  "splitDown",
  "maximize",
  "restore",
  "remove",
  "inLayout",
  "dragLabel",
  "dropRight",
  "dropDown",
  "tooSmall",
  "resizeVertical",
  "resizeHorizontal",
  "resizeHint",
  "focused",
] as const;

type PaneKey = (typeof PANE_KEYS)[number];

const EXPECTED_PANE_COPY = {
  "zh-CN": {
    workspaceLabel: "终端分屏工作区",
    headerLabel: "“{{title}}”的分屏操作",
    splitRight: "向右分屏",
    splitDown: "向下分屏",
    maximize: "最大化分屏",
    restore: "恢复分屏布局",
    remove: "从分屏移除",
    inLayout: "已在分屏中",
    dragLabel: "拖动 Session“{{title}}”",
    dropRight: "放到右侧",
    dropDown: "放到下方",
    tooSmall: "当前空间太小，无法继续分屏",
    resizeVertical: "调整垂直分隔线",
    resizeHorizontal: "调整水平分隔线",
    resizeHint: "拖动调整分屏大小；使用方向键微调",
    focused: "当前聚焦分屏",
  },
  "en-US": {
    workspaceLabel: "Terminal split workspace",
    headerLabel: "Split pane controls for “{{title}}”",
    splitRight: "Split right",
    splitDown: "Split down",
    maximize: "Maximize pane",
    restore: "Restore split layout",
    remove: "Remove from split",
    inLayout: "In split layout",
    dragLabel: "Drag Session “{{title}}”",
    dropRight: "Drop to the right",
    dropDown: "Drop below",
    tooSmall: "This area is too small to split",
    resizeVertical: "Resize the vertical divider",
    resizeHorizontal: "Resize the horizontal divider",
    resizeHint: "Drag to resize panes; use the arrow keys for fine adjustments",
    focused: "Focused pane",
  },
} satisfies Record<"zh-CN" | "en-US", Record<PaneKey, string>>;

const PANE_CATALOGS = {
  "zh-CN": shellZhCN.pane,
  "en-US": shellEnUS.pane,
};

describe("pane split translations", () => {
  afterEach(async () => {
    await applyUiLanguage("zh-CN", { persistHint: false });
  });

  it("keeps the complete pane key contract symmetric across locales", () => {
    expect(Object.keys(PANE_CATALOGS["zh-CN"]).sort()).toEqual(
      Object.keys(PANE_CATALOGS["en-US"]).sort(),
    );
    expect(Object.keys(PANE_CATALOGS["zh-CN"]).sort()).toEqual([...PANE_KEYS].sort());
  });

  it("preserves the confirmed Chinese and English interaction wording", () => {
    expect(PANE_CATALOGS["zh-CN"]).toEqual(EXPECTED_PANE_COPY["zh-CN"]);
    expect(PANE_CATALOGS["en-US"]).toEqual(EXPECTED_PANE_COPY["en-US"]);
  });

  it("resolves every pane key after language changes and interpolates titles", async () => {
    for (const language of ["zh-CN", "en-US"] as const) {
      const title = language === "zh-CN" ? "构建日志" : "Build logs";
      await applyUiLanguage(language, { persistHint: false });

      for (const key of PANE_KEYS) {
        const resourceKey = `shell:pane.${key}` as const;
        expect(i18n.exists(resourceKey)).toBe(true);
        expect(i18n.t(resourceKey, { title })).toBe(
          EXPECTED_PANE_COPY[language][key].replace("{{title}}", title),
        );
      }
    }
  });
});
