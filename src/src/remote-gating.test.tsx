// @vitest-environment jsdom
// Remote-mode feature gating (T-010): store capability predicates plus the
// Export/Diagnostics dialogs. Local mode must stay byte-identical in
// behavior; remote mode disables/annotates instead of failing.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  exportSessionMock,
  pickSavePathMock,
  diagHostsMock,
  diagSummaryMock,
  diagCapabilitiesMock,
  notifyTestMock,
  copyTextMock,
} = vi.hoisted(() => ({
  exportSessionMock: vi.fn(),
  pickSavePathMock: vi.fn(),
  diagHostsMock: vi.fn(),
  diagSummaryMock: vi.fn(),
  diagCapabilitiesMock: vi.fn(),
  notifyTestMock: vi.fn(),
  copyTextMock: vi.fn(),
}));

vi.mock("./api", () => ({
  api: {
    exportSession: exportSessionMock,
    pickSavePath: pickSavePathMock,
    diagHosts: diagHostsMock,
    diagSummary: diagSummaryMock,
    diagCapabilities: diagCapabilitiesMock,
    notifyTest: notifyTestMock,
  },
  copyText: copyTextMock,
  errorText: (error: unknown) => String(error),
}));

vi.mock("./actions", () => ({
  copyTextWithToast: vi.fn().mockResolvedValue(undefined),
}));

import { applyUiLanguage } from "./i18n";
import {
  canMutateDocumentEntries,
  canRestoreBackups,
  canRollbackNotificationSetup,
  canUseLocalOsIntegration,
  destinationsAreRemote,
  getState,
  setActiveDevice,
  setState,
  type AppState,
} from "./store";
import ExportDialog from "./components/ExportDialog";
import DiagnosticsDialog from "./components/DiagnosticsDialog";

const REMOTE_CONTEXT = {
  kind: "remote" as const,
  deviceId: "dev_1",
  deviceName: "Linux box",
  capabilities: ["session.event_push"],
};

const host = {
  sessionId: "ses_1",
  title: "Demo Session",
  hostPid: 4242,
  alive: true,
  socketPath: "/tmp/agentport-501/ses_1.sock",
  logBytes: 2048,
  lifecycle: "running",
};

function activeDeviceState(): Pick<AppState, "activeDevice"> {
  return { activeDevice: getState().activeDevice };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await applyUiLanguage("en-US", { persistHint: false });
  setActiveDevice({ kind: "local" });
  setState({ projects: [], exportsDir: "/tmp/exports", toasts: [], contextMenu: null });
});

afterEach(async () => {
  cleanup();
  setActiveDevice({ kind: "local" });
  await applyUiLanguage("zh-CN", { persistHint: false });
});

describe("remote-mode capability predicates", () => {
  it("defaults to local behavior and flips on a remote device", () => {
    expect(canUseLocalOsIntegration(activeDeviceState())).toBe(true);
    expect(canMutateDocumentEntries(activeDeviceState())).toBe(true);
    expect(canRestoreBackups(activeDeviceState())).toBe(true);
    expect(canRollbackNotificationSetup(activeDeviceState())).toBe(true);
    expect(destinationsAreRemote(activeDeviceState())).toBe(false);

    act(() => setActiveDevice(REMOTE_CONTEXT));

    expect(canUseLocalOsIntegration(activeDeviceState())).toBe(false);
    expect(canMutateDocumentEntries(activeDeviceState())).toBe(false);
    expect(canRestoreBackups(activeDeviceState())).toBe(false);
    expect(canRollbackNotificationSetup(activeDeviceState())).toBe(false);
    expect(destinationsAreRemote(activeDeviceState())).toBe(true);

    act(() => setActiveDevice({ kind: "local" }));
    expect(canUseLocalOsIntegration(activeDeviceState())).toBe(true);
  });
});

describe("ExportDialog remote gating", () => {
  it("annotates the server-side destination and drops stripAnsi remotely", async () => {
    exportSessionMock.mockResolvedValue("/tmp/agentport-ses_1.md");
    setActiveDevice(REMOTE_CONTEXT);
    render(<ExportDialog sessionId="ses_1" exportKind="md" />);

    await screen.findByText(/written at this path on the remote device/i);
    screen.getByText(/keep terminal escape sequences/i);

    // Remote default destination is server-side, not the local exportsDir.
    const input = screen.getByLabelText("Save to (absolute path)") as HTMLInputElement;
    expect(input.value).toBe("/tmp/agentport-ses_1.md");

    // The local save picker is disabled remotely.
    const browse = screen.getByRole("button", { name: /Browse/ });
    expect(browse).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(exportSessionMock).toHaveBeenCalled());
    expect(exportSessionMock).toHaveBeenCalledWith({
      sessionId: "ses_1",
      kind: "md",
      dest: "/tmp/agentport-ses_1.md",
      last: null,
      stripAnsi: false,
    });
  });

  it("keeps local behavior identical: stripAnsi on, picker enabled, local default", async () => {
    exportSessionMock.mockResolvedValue("/tmp/exports/agentport-ses_1.md");
    render(<ExportDialog sessionId="ses_1" exportKind="md" />);

    expect(screen.queryByText(/remote device/i)).toBeNull();
    const input = screen.getByLabelText("Save to (absolute path)") as HTMLInputElement;
    expect(input.value).toBe("/tmp/exports/agentport-ses_1.md");
    const browse = screen.getByRole("button", { name: /Browse/ });
    expect(browse).toHaveProperty("disabled", false);

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(exportSessionMock).toHaveBeenCalled());
    expect(exportSessionMock).toHaveBeenCalledWith({
      sessionId: "ses_1",
      kind: "md",
      dest: "/tmp/exports/agentport-ses_1.md",
      last: null,
      stripAnsi: true,
    });
  });
});

describe("DiagnosticsDialog remote gating", () => {
  it("hides PID/Socket columns and disables the local picker remotely", async () => {
    diagHostsMock.mockResolvedValue([host]);
    setActiveDevice(REMOTE_CONTEXT);
    render(<DiagnosticsDialog />);

    await screen.findByText("Demo Session");
    expect(screen.queryByText("PID")).toBeNull();
    expect(screen.queryByText("Socket")).toBeNull();
    expect(screen.queryByText("4242")).toBeNull();
    expect(screen.queryByText("/tmp/agentport-501/ses_1.sock")).toBeNull();

    // The zip destination defaults to a server-side path remotely.
    const destInput = screen.getByLabelText(/save path|destination/i) as HTMLInputElement;
    expect(destInput.value.startsWith("/tmp/")).toBe(true);
    expect(destInput.value).not.toContain("/tmp/exports");
  });

  it("shows PID/Socket columns locally", async () => {
    diagHostsMock.mockResolvedValue([host]);
    render(<DiagnosticsDialog />);

    await screen.findByText("Demo Session");
    expect(screen.getByText("PID")).toBeTruthy();
    expect(screen.getByText("Socket")).toBeTruthy();
    expect(screen.getByText("4242")).toBeTruthy();
    expect(screen.getByText("/tmp/agentport-501/ses_1.sock")).toBeTruthy();
  });
});
