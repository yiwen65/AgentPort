// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applyUiLanguage } from "./i18n";
import { localizedNotices, runtimeMessageText } from "./runtimeMessages";

describe("runtime message localization", () => {
  afterEach(async () => {
    await applyUiLanguage("zh-CN");
  });

  it("localizes a stable application error code and preserves its technical detail", async () => {
    await applyUiLanguage("en-US", { persistHint: false });
    expect(runtimeMessageText({
      code: "status_persistence_failed",
      technicalDetail: "SQLITE_BUSY (5)",
      message: "状态未持久化",
    })).toBe("Could not save the Session status: SQLITE_BUSY (5)");
  });

  it("localizes a boot-time Recovery Timeline failure", async () => {
    await applyUiLanguage("en-US", { persistHint: false });
    expect(runtimeMessageText({
      code: "timeline_load_failed",
      technicalDetail: "SQLITE_CORRUPT",
      message: "恢复时间线读取失败",
    })).toBe("Could not load the Recovery Timeline: SQLITE_CORRUPT");
  });

  it("continues to display legacy Host messages that have no code", () => {
    expect(runtimeMessageText({ message: "legacy Host message" })).toBe("legacy Host message");
  });

  it("localizes current Host envelopes while keeping their technical detail separate", async () => {
    await applyUiLanguage("zh-CN", { persistHint: false });
    expect(runtimeMessageText({
      code: "host_terminal_input_unavailable",
      params: {},
      technicalDetail: "terminal input is unavailable for structured sessions",
      message: "terminal input is unavailable for structured sessions",
    })).toBe("结构化 Session 不支持终端输入。");
  });

  it("localizes Host attach failures emitted by Tauri", async () => {
    await applyUiLanguage("en-US", { persistHint: false });
    expect(runtimeMessageText({
      code: "host_connection_failed",
      technicalDetail: "connection refused",
      message: "无法连接 Host",
    })).toBe("Could not connect to the Host: connection refused");
    expect(runtimeMessageText({ code: "host_changed_during_attach" }))
      .toBe("The Host changed while the Session was connecting. Reconnect to continue.");
  });

  it("localizes structured command errors returned by Tauri", async () => {
    await applyUiLanguage("en-US", { persistHint: false });
    expect(runtimeMessageText({
      code: "project_path_missing",
      params: { path: "/tmp/missing" },
      technicalDetail: "项目目录已不存在",
      message: "项目目录已不存在",
    })).toBe(
      "The project directory no longer exists and cannot be shown in the file manager: /tmp/missing. You can remove the project record from AgentPort.",
    );
  });

  it("uses a safe localized fallback for an unknown code with no legacy text", async () => {
    await applyUiLanguage("en-US", { persistHint: false });
    expect(runtimeMessageText({ code: "future_host_error" }))
      .toBe("An unknown runtime error occurred (future_host_error)");
  });

  it("does not expose a compatibility message when an unknown stable code is present", async () => {
    await applyUiLanguage("en-US", { persistHint: false });
    expect(runtimeMessageText({
      code: "future_host_error",
      message: "未来 Host 的中文兼容消息",
      technicalDetail: "opaque detail",
    })).toBe("An unknown runtime error occurred (future_host_error)");
  });

  it("localizes the compatible Host replacement envelope", async () => {
    await applyUiLanguage("en-US", { persistHint: false });
    expect(runtimeMessageText({ code: "host_replaced", message: "Host 已被新的运行替换" }))
      .toBe("The Host was replaced by a newer run");
  });

  it("prefers stable adapter notices and falls back to legacy notes", async () => {
    await applyUiLanguage("en-US", { persistHint: false });
    expect(localizedNotices({
      notices: [{
        code: "pi_local_permissions",
        message: "Pi 不提供逐项权限确认，将以本地用户权限执行",
      }],
      notes: ["Pi 不提供逐项权限确认，将以本地用户权限执行"],
    })).toEqual([
      "Pi does not provide per-action approvals and will run with the local user's permissions.",
    ]);
    expect(localizedNotices({ notes: ["legacy adapter notice"] }))
      .toEqual(["legacy adapter notice"]);
  });

  it("explains that Codex without a verified ID starts fresh, not unrelated history", async () => {
    await applyUiLanguage("en-US", { persistHint: false });
    expect(runtimeMessageText({ code: "codex_resume_id_unavailable" }))
      .toBe("No verified Codex Session ID is available. A new conversation was started instead of resuming unrelated history.");
    await applyUiLanguage("zh-CN", { persistHint: false });
    expect(runtimeMessageText({ code: "codex_resume_id_unavailable" }))
      .toBe("没有可验证的 Codex Session ID，已启动新会话，未恢复其他历史会话。");
  });

  it("formats probe messages with named parameters and plural rules", async () => {
    await applyUiLanguage("en-US", { persistHint: false });
    expect(runtimeMessageText({ code: "probe_auto_selected", params: { count: 1 } }))
      .toContain("1 candidate.");
    expect(runtimeMessageText({ code: "probe_auto_selected", params: { count: 3 } }))
      .toContain("3 candidates.");
  });
});
