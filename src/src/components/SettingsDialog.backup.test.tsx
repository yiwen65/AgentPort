// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { backupCreateMock, backupListMock, backupVerifyMock, backupRestoreMock, pickFileMock, confirmMock } = vi.hoisted(() => ({
  backupCreateMock: vi.fn(),
  backupListMock: vi.fn(),
  backupVerifyMock: vi.fn(),
  backupRestoreMock: vi.fn(),
  pickFileMock: vi.fn(),
  confirmMock: vi.fn(),
}));

vi.mock("../store", async (original) => ({
  ...await original<typeof import("../store")>(),
  confirmDialog: confirmMock,
}));

vi.mock("../api", () => ({
  api: {
    backupCreate: backupCreateMock,
    backupList: backupListMock,
    backupVerify: backupVerifyMock,
    backupRestore: backupRestoreMock,
    pickFile: pickFileMock,
  },
  commitAiErrorText: (error: unknown) => String(error),
  errorText: (error: unknown) => String(error),
}));

vi.mock("../actions", () => ({
  applyThemeSettings: vi.fn(),
  refreshProjects: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../terminals", () => ({
  applyTerminalLanguage: vi.fn(),
}));

import { getState, setState } from "../store";
import { BackupSection } from "./SettingsDialog";

const archive = {
  path: "/tmp/agentport/backups/backup.zip",
  name: "backup.zip",
  size: 2048,
  modifiedAt: "2026-08-01T10:00:00Z",
};

function renderBackupSection() {
  backupListMock.mockResolvedValue([archive]);
  render(<BackupSection />);
}

function latestToast() {
  const toasts = getState().toasts;
  return toasts[toasts.length - 1];
}

describe("Settings backup native coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pickFileMock.mockResolvedValue(archive.path);
    confirmMock.mockResolvedValue(true);
    setState({ exportsDir: "/tmp/agentport/exports", toasts: [] });
  });

  afterEach(() => cleanup());

  it("reports a complete v2 native capture as success", async () => {
    backupCreateMock.mockResolvedValue({
      path: archive.path,
      files: 7,
      bytes: 4096,
      verified: true,
      nativeCoverage: {
        total: 3,
        captured: 2,
        missing: 0,
        ambiguous: 0,
        unsupported: 1,
      },
    });
    renderBackupSection();

    await screen.findByText("backup.zip");
    fireEvent.click(screen.getByRole("button", { name: "备份 Codex" }));
    expect(backupCreateMock).toHaveBeenCalledWith("codex", null);

    await screen.findByText(/有效的 v2 备份 · 受支持 Session 原生覆盖完整/);
    expect(latestToast()).toMatchObject({ kind: "success" });
    expect(latestToast()?.text).toContain("原生正文覆盖完整");
  });

  it("keeps an integrity-valid partial capture visible as incomplete", async () => {
    backupCreateMock.mockResolvedValue({
      path: archive.path,
      files: 5,
      bytes: 3072,
      verified: true,
      nativeCoverage: {
        total: 3,
        captured: 1,
        missing: 1,
        ambiguous: 1,
        unsupported: 0,
      },
    });
    renderBackupSection();

    await screen.findByText("backup.zip");
    fireEvent.click(screen.getByRole("button", { name: "备份 Claude Code" }));
    expect(backupCreateMock).toHaveBeenCalledWith("claude", null);

    const status = await screen.findByText(/有效的 v2 备份 · 原生覆盖不完整/);
    expect(status.closest("td")?.classList.contains("warn-text")).toBe(true);
    expect(latestToast()).toMatchObject({ kind: "info" });
    expect(latestToast()?.text).toContain("缺失 1，歧义 1");
  });

  it("merges the selected agent and reports existing sessions without directory swapping", async () => {
    backupRestoreMock.mockResolvedValue({ imported: ["ses_new"], skipped: ["ses_existing"] });
    renderBackupSection();
    fireEvent.click(screen.getByRole("button", { name: "恢复 Codex" }));
    await screen.findByText("ses_existing");
    expect(backupRestoreMock).toHaveBeenCalledWith(archive.path, "codex");
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: "合并恢复 Codex 会话？" }));
    expect(latestToast()).toMatchObject({ kind: "info" });
    expect(screen.getByRole("status").textContent).toContain("导入 1 个会话，跳过 1 个已有会话");
    expect(screen.queryByText(/改名备份/)).toBeNull();
  });

  it("disables all agent actions while a backup is running", async () => {
    let release!: (value: unknown) => void;
    backupCreateMock.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    renderBackupSection();
    fireEvent.click(screen.getByRole("button", { name: "备份 Codex" }));
    expect((screen.getByRole("button", { name: "恢复 Claude Code" }) as HTMLButtonElement).disabled).toBe(true);
    release({ path: archive.path, files: 1, nativeCoverage: { total: 0, captured: 0, missing: 0, ambiguous: 0, unsupported: 0 } });
    await waitFor(() => expect((screen.getByRole("button", { name: "恢复 Claude Code" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("keeps conflicts visible and permits a retry", async () => {
    backupRestoreMock.mockRejectedValue("native conflict: existing content");
    renderBackupSection();
    fireEvent.click(screen.getByRole("button", { name: "恢复 Codex" }));
    expect((await screen.findByRole("alert")).textContent).toContain("native conflict");
    expect((screen.getByRole("button", { name: "恢复 Codex" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not restore when confirmation is cancelled", async () => {
    confirmMock.mockResolvedValue(false);
    renderBackupSection();
    fireEvent.click(screen.getByRole("button", { name: "恢复 Codex" }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(backupRestoreMock).not.toHaveBeenCalled();
  });

  it("labels a verified v1 archive as legacy rather than native-covered", async () => {
    backupVerifyMock.mockResolvedValue({
      ok: true,
      formatVersion: 1,
      createdAt: "2026-01-01T00:00:00Z",
      files: 2,
      dataModelVersion: 1,
      nativeCoverage: {
        total: 0,
        captured: 0,
        missing: 0,
        ambiguous: 0,
        unsupported: 0,
      },
    });
    renderBackupSection();

    await screen.findByText("backup.zip");
    fireEvent.click(screen.getByRole("button", { name: "校验" }));

    expect(await screen.findByText(/有效的 v1 旧版备份/)).toBeTruthy();
  });
});
