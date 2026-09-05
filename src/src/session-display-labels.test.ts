/// <reference types="vite/client" />
// @vitest-environment jsdom
import sidebarSource from "./components/Sidebar.tsx?raw";
import paletteSource from "./components/CommandPalette.tsx?raw";
import { describe, expect, it } from "vitest";
import { i18n } from "./i18n";
import { dotClassFor, dotTipFor } from "./components/StatusDot";
import type { SessionView } from "./types";

describe("compact desktop session labels", () => {
  it("presents both ended lifecycles as Stoped without changing their records", async () => {
    await i18n.changeLanguage("en-US");
    for (const lifecycle of ["exited", "stopped"] as const) {
      const session = { id: "label-test", lifecycle } as SessionView;
      expect(dotClassFor(session)).toBe("stopped");
      expect(dotTipFor(session)).toBe("Stoped");
      expect(session.lifecycle).toBe(lifecycle);
    }
  });
  it("uses the requested concise actions and no Interrupt menu command", async () => {
    await i18n.changeLanguage("en-US");
    const labels = (["restartAndResume", "stop", "remove", "exportMarkdown", "exportRawLog"] as const).map(key => i18n.t(`session:ui.menu.${key}`));
    expect(labels).toEqual(["Restart", "Stop", "Remove", "Export Markdown", "Export Json"]);
    expect(sidebarSource).not.toContain('t("session:ui.menu.interrupt")');
    expect(paletteSource).not.toContain('act("interrupt"');
  });
});
