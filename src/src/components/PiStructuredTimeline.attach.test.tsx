// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { channels, apiMock } = vi.hoisted(() => ({
  channels: [] as Array<{ onmessage?: (message: any) => void }>,
  apiMock: {
    abortStructuredTurn: vi.fn(),
    attachSession: vi.fn(),
    detachSession: vi.fn().mockResolvedValue(undefined),
    sendStructuredPrompt: vi.fn(),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> {
    onmessage?: (message: T) => void;

    constructor() {
      channels.push(this);
    }
  },
}));

vi.mock("../api", () => ({
  api: apiMock,
  b64ToBytes: vi.fn(() => new Uint8Array()),
  errorText: (error: unknown) => String(error),
}));

import PiStructuredTimeline from "./PiStructuredTimeline";
import type { AttachInfo, SessionView } from "../types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const attachInfo: AttachInfo = {
  attachmentId: 7,
  hostPid: 123,
  protocol: 1,
  childAlive: true,
  logBytes: 0,
  agentSessionId: null,
  runId: "run_1",
  runOrdinal: 1,
  status: null,
  logCursor: { runId: "run_1", runOrdinal: 1, generation: 0, offset: 0 },
};

const session: SessionView = {
  id: "ses_pi",
  projectId: "prj_1",
  worktreeId: null,
  title: "Pi",
  adapter: "pi",
  cwd: "/tmp/project",
  lifecycle: "running",
  agentSessionId: null,
  resumePrecision: "unavailable",
  permissionMode: "native",
  transport: "json_rpc",
  logPath: "/tmp/pi.log",
  unread: false,
  status: null,
  pinnedAt: null,
  createdAt: "2026-07-23T00:00:00.000Z",
};

describe("Pi structured attachment authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channels.length = 0;
  });

  afterEach(cleanup);

  it("replaces an ended attachment when an external restart snapshot arrives", async () => {
    apiMock.attachSession.mockResolvedValueOnce({ ...attachInfo, childAlive: false })
      .mockResolvedValueOnce({ ...attachInfo, attachmentId: 8, runId: "run_2", runOrdinal: 2 });
    const view = render(<PiStructuredTimeline ses={{ ...session, lifecycle: "stopped" }} />);
    await waitFor(() => expect(apiMock.attachSession).toHaveBeenCalledTimes(1));
    view.rerender(<PiStructuredTimeline ses={session} />);
    await waitFor(() => expect(apiMock.attachSession).toHaveBeenCalledTimes(2));
    expect(apiMock.sendStructuredPrompt).not.toHaveBeenCalled();
    expect(apiMock.abortStructuredTurn).not.toHaveBeenCalled();
  });

  it("keeps an exit authoritative when the attach reply arrives later", async () => {
    const attach = deferred<AttachInfo>();
    apiMock.attachSession.mockReturnValueOnce(attach.promise);
    render(<PiStructuredTimeline ses={session} />);
    await waitFor(() => expect(apiMock.attachSession).toHaveBeenCalledTimes(1));

    await act(async () => {
      channels[0].onmessage?.({
        t: "exit",
        code: 0,
        signal: null,
        groupCleaned: true,
        reason: "process_exit",
        runId: "run_1",
        runOrdinal: 1,
      });
      attach.resolve(attachInfo);
      await attach.promise;
    });

    expect(screen.getByText("Session 已结束")).toBeTruthy();
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    expect(apiMock.detachSession).toHaveBeenCalledWith("ses_pi", 7);
  });

  it("shows a localized Host replacement and offers reconnect", async () => {
    apiMock.attachSession.mockResolvedValueOnce(attachInfo);
    render(<PiStructuredTimeline ses={session} />);
    await screen.findByText("已连接");

    await act(async () => {
      channels[0].onmessage?.({
        t: "detached",
        code: "host_replaced",
        params: {},
        message: "Host 已被新的运行替换",
      });
    });

    expect(screen.getByRole("alert").textContent).toBe("Host 已被新的运行替换");
    expect(screen.getByRole("button", { name: "重新连接" })).toBeTruthy();
  });
});
