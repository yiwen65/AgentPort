// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  branchOperationPhaseLabel,
  formatTimelineTime,
  presetDisplayName,
  relativeAge,
  recoveryActionLabel,
  repositoryProgressMessage,
} from "./format";
import {
  applyUiLanguage,
  currentUiLanguage,
  DEFAULT_UI_LANGUAGE,
  i18n,
  normalizeUiLanguage,
  UI_LANGUAGE_STORAGE_KEY,
} from "./i18n";

describe("UI language runtime", () => {
  afterEach(async () => {
    await applyUiLanguage("zh-CN");
  });

  it("normalizes missing, damaged, and unsupported settings to Simplified Chinese", () => {
    expect(normalizeUiLanguage(undefined)).toBe(DEFAULT_UI_LANGUAGE);
    expect(normalizeUiLanguage(null)).toBe(DEFAULT_UI_LANGUAGE);
    expect(normalizeUiLanguage("fr-FR")).toBe(DEFAULT_UI_LANGUAGE);
    expect(normalizeUiLanguage("en-US")).toBe("en-US");
  });

  it("applies a language immediately and keeps the startup hint and html lang in sync", async () => {
    await applyUiLanguage("en-US");

    expect(currentUiLanguage()).toBe("en-US");
    expect(document.documentElement.lang).toBe("en-US");
    expect(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe("en-US");
    expect(i18n.t("common:actions.cancel")).toBe("Cancel");
  });

  it("lets the authoritative database value replace a conflicting startup hint", async () => {
    await applyUiLanguage("en-US");
    expect(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe("en-US");

    // This mirrors App boot: the SQLite Settings value is applied before ready=true.
    await applyUiLanguage("zh-CN");

    expect(currentUiLanguage()).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe("zh-CN");
  });

  it("falls back to the Chinese resource when an English key is missing", async () => {
    const english = i18n.getResourceBundle("en-US", "common");
    i18n.removeResourceBundle("en-US", "common");
    await applyUiLanguage("en-US", { persistHint: false });
    try {
      expect(i18n.t("common:actions.cancel")).toBe("取消");
    } finally {
      i18n.addResourceBundle("en-US", "common", english, true, true);
    }
  });

  it("uses English plural rules and locale-aware date formatting", async () => {
    await applyUiLanguage("en-US", { persistHint: false });
    expect(i18n.t("runtime:export.recentBlocks", { count: 1 })).toBe("Most recent 1 output block");
    expect(i18n.t("runtime:export.recentBlocks", { count: 2 })).toBe("Most recent 2 output blocks");
    const englishDate = formatTimelineTime("2026-07-20T08:30:00Z", new Date("2026-07-23T08:30:00Z"));

    await applyUiLanguage("zh-CN", { persistHint: false });
    expect(formatTimelineTime("2026-07-20T08:30:00Z", new Date("2026-07-23T08:30:00Z"))).not.toBe(englishDate);
  });

  it("keeps sidebar session ages compact and language-independent", async () => {
    const now = Date.parse("2026-07-23T08:30:00Z");
    const ages = [
      ["2026-07-23T08:29:45Z", "1m"],
      ["2026-07-23T07:31:00Z", "59m"],
      ["2026-07-23T07:30:00Z", "1h"],
      ["2026-07-22T08:30:00Z", "1d"],
      ["2026-06-23T08:30:00Z", "30d"],
    ] as const;

    for (const language of ["zh-CN", "en-US"] as const) {
      await applyUiLanguage(language, { persistHint: false });
      for (const [timestamp, expected] of ages) {
        expect(relativeAge(timestamp, now)).toBe(expected);
      }
    }
  });

  it("localizes stable built-in preset IDs without changing custom names", async () => {
    const builtIn = { id: "pre_codex_safe", name: "Codex 安全默认", builtIn: true };
    const custom = { id: "custom_1", name: "我的预设 / Personal", builtIn: false };

    await applyUiLanguage("en-US", { persistHint: false });
    expect(presetDisplayName(builtIn)).toBe("Codex safe defaults");
    expect(presetDisplayName(custom)).toBe(custom.name);
  });

  it("localizes repository progress and recovery phases without exposing raw identifiers", async () => {
    expect(branchOperationPhaseLabel("restored_verified")).toBe("恢复已验证");
    expect(repositoryProgressMessage({
      command: "switch_local_branch",
      phase: "started",
      message: "switching local branch",
    })).toBe("正在切换本地分支");
    expect(recoveryActionLabel("refresh_and_choose_available_branch"))
      .toContain("未被任何 Worktree checkout");

    await applyUiLanguage("en-US", { persistHint: false });
    expect(branchOperationPhaseLabel("recovery_required")).toBe("Restore required");
    expect(repositoryProgressMessage({
      command: "switch_local_branch",
      phase: "started",
      message: "switching local branch",
    })).toBe("Switching local branch");
    expect(branchOperationPhaseLabel("future_phase")).toBe("Unknown state (future_phase)");
    expect(recoveryActionLabel("refresh_and_choose_available_branch"))
      .toContain("not checked out in any Worktree");
  });

  it("localizes every stable repository recovery action code", async () => {
    const codes = [
      "check_diagnostics_and_retry",
      "refresh_and_choose_available_branch",
      "refresh_and_reselect_branch",
      "resolve_repository_blockers",
      "inspect_retained_auto_stash",
      "restore_when_checkout_safe",
      "choose_nonconflicting_action",
      "refresh_repository_before_retry",
      "inspect_diagnostics_if_git_unavailable",
      "refresh_repository_and_retry",
      "retry_after_checking_diagnostics",
    ];
    for (const code of codes) expect(recoveryActionLabel(code)).not.toBe(code);

    await applyUiLanguage("en-US", { persistHint: false });
    for (const code of codes) expect(recoveryActionLabel(code)).not.toBe(code);
  });
});
