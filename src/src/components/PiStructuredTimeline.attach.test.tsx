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
  createdAt: "2026-07-23T00:00:00.000Z",
};

describe("Pi structured attachment authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channels.length = 0;
  });

  afterEach(cleanup);

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
      attach.resolve({
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
      });
      await attach.promise;
    });

    expect(screen.getByText("会话已结束")).toBeTruthy();
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    expect(apiMock.detachSession).toHaveBeenCalledWith("ses_pi", 7);
  });
});
