import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileTerminalAppearance } from "../../terminal/terminalAppearance";
import { i18n } from "../../i18n";
import type { RemoteClient, RemoteEvent } from "../../protocol/remoteClient";
import type { OpenSession, SessionEventPayload } from "./types";
import { SessionWorkspace } from "./SessionWorkspace";
import type { MobileTerminalHandle } from "../../terminal/MobileTerminal";
import { clearTerminalCheckpoints, checkpointKey, readCheckpoint, saveCheckpoint } from "../../terminal/terminalCheckpoint";

const terminalHarness = vi.hoisted(() => ({
  props: undefined as {
    onRelease?: (handle: MobileTerminalHandle) => void;
    onInput?: (data: string) => void;
    onResize?: (cols: number, rows: number) => void;
    onReachTop?: () => void;
    showHeading?: boolean;
    obscured?: boolean;
    theme?: { background?: string; foreground?: string };
  } | undefined,
  writes: [] as string[],
  queued: false,
  writesQueue: [] as (() => void)[],
  resets: 0,
  renders: 0,
  mounts: 0,
}));

vi.mock("../../terminal/MobileTerminal", async () => {
  const { forwardRef, useImperativeHandle, useEffect, useMemo, useRef } = await vi.importActual<typeof import("react")>("react");
  return {
    MobileTerminal: forwardRef((props: NonNullable<typeof terminalHarness.props>, ref) => {
      useEffect(() => { terminalHarness.mounts += 1; }, []);
      terminalHarness.props = props;
      terminalHarness.renders += 1;
      const handle = useMemo(() => ({
        write: (data: string | Uint8Array, callback?: () => void) => {
          const parse = () => { if (data.length) terminalHarness.writes.push(typeof data === "string" ? data : new TextDecoder().decode(data)); callback?.(); };
          if (terminalHarness.queued) terminalHarness.writesQueue.push(parse); else parse();
        },
        reset: () => { terminalHarness.resets += 1; },
        capture: async () => ({ content: terminalHarness.writes.join(""), cols: 47, rows: 53, pending: [] }),
        restore: async (saved: { content: string }) => { terminalHarness.writes.push(saved.content); },
        finishRestore: () => undefined,
      }), []);
      const release = useRef(props.onRelease); release.current = props.onRelease;
      useImperativeHandle(ref, () => handle, [handle]);
      useEffect(() => () => release.current?.(handle), [handle]);
      return <section aria-label="Raw terminal" style={{ visibility: props.obscured ? "hidden" : undefined }}>
        <button type="button" onClick={() => props.onInput?.("你好\r")}>Type terminal input</button>
        <button type="button" onClick={() => { props.onResize?.(48, 40); props.onResize?.(52, 32); }}>Resize terminal</button>
      </section>;
    }),
  };
});

const open: OpenSession = {
  hostProfileId: "host-1",
  hostName: "Studio",
  projectName: "AgentSessions",
  session: {
    id: "ses-1", projectId: "prj-1", presetId: "pre-1", title: "Agent task", cwd: "/tmp", lifecycle: "running", resumePrecision: "exact", adapterType: "pi", transport: "json_rpc", permissionMode: "native", createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:01:00Z",
  },
};

function setupClient({ rejectResize = false, autoReplay = true }: { rejectResize?: boolean; autoReplay?: boolean } = {}) {
  let listener: ((event: RemoteEvent<SessionEventPayload>) => void) | undefined;
  const request = vi.fn().mockImplementation((_profileId, method, params) => {
    if (method === "session.attach") { if (autoReplay) listener?.({ subscriptionId: "att-1", eventType: "replay_done", cursor: null, payload: { session_id: "ses-1" } }); return Promise.resolve({ attachmentId: "att-1", sessionId: "ses-1", childAlive: true, cursor: null, features: ["input_batch_v1", "terminal.geometry_v1"], runId: "run", runOrdinal: 1, terminalGeometry: null }); }
    if (method === "git.context.resolve") return Promise.resolve({ actualBranch: "main", expectedBranch: "main" });
    if (method === "session.list") return Promise.resolve([]);
    if (method === "session.stop") return Promise.resolve({ groupCleaned: true });
    if (method === "session.input") return Promise.resolve({ batchId: "batch", serverSequence: 1, phase: "completed" });
    if (method === "session.control" && params.control === "resize") {
      if (rejectResize) return Promise.reject(new Error("request failed on the remote host"));
      return Promise.resolve({ accepted: true, terminalGeometry: { runId: "run", runOrdinal: 1, cols: params.cols, rows: params.rows, sourceKind: "mobile", sourceDeviceId: params.sourceDeviceId, attachmentId: "att-1", orientation: params.orientation, revision: 1, updatedAt: "2026-09-02T00:00:00Z" } });
    }
    return Promise.resolve({});
  });
  const client: RemoteClient = {
    listHostProfiles: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), request,
    subscribe: vi.fn().mockImplementation(async (_profileId, _topics, next) => { listener = next; return async () => undefined; }),
    onConnectionState: vi.fn().mockResolvedValue(async () => undefined),
  };
  return { client, request, emit: (event: RemoteEvent<SessionEventPayload>) => listener?.(event) };
}

describe("SessionWorkspace", () => {
  it("restores a replaced terminal screen and resumes strictly after its captured cursor", async () => {
    const first = setupClient();
    const props = { open, onClose: vi.fn(), onSessionChanged: vi.fn() };
    const view = render(<SessionWorkspace {...props} client={first.client} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    const consumed = { runId: "run", runOrdinal: 1, generation: 0, offset: 123, statusSequence: 0 };
    act(() => first.emit({ subscriptionId: "att-1", eventType: "output", cursor: consumed,
      payload: { session_id: "ses-1", data: btoa("HISTORY_MUST_SURVIVE") } }));
    // Release before the animation-frame output flush: the snapshot must include it.
    view.unmount();
    expect((await readCheckpoint(checkpointKey("host-1", "ses-1")))?.content).toContain("HISTORY_MUST_SURVIVE");
    terminalHarness.writes = [];
    const second = setupClient();
    render(<SessionWorkspace {...props} client={second.client} />);
    await waitFor(() => expect(second.request).toHaveBeenCalledWith("host-1", "session.attach", expect.objectContaining({ resumeFrom: consumed })));
    expect(terminalHarness.writes).toContain("HISTORY_MUST_SURVIVE");
  });

  it("waits for a pending capture and fences a reselect cancelled before it resolves", async () => {
    let resolve!: (screen: import("../../terminal/terminalCheckpoint").TerminalCheckpoint) => void;
    saveCheckpoint(checkpointKey("host-1", "ses-1"), new Promise(done => { resolve = done; }));
    const { client, request } = setupClient();
    const view = render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await act(async () => undefined);
    expect(request.mock.calls.filter(call => call[1] === "session.attach")).toHaveLength(0);
    view.unmount();
    await act(async () => resolve({ content: "late", cols: 47, rows: 53, pending: [], cursor: { runId: "run", runOrdinal: 1, generation: 0, offset: 123, statusSequence: 0 } }));
    expect(request.mock.calls.filter(call => call[1] === "session.attach")).toHaveLength(0);
    expect(terminalHarness.writes).not.toContain("late");
  });

  it("does not restore a screen from an older run", async () => {
    const saved = { content: "OLD_RUN", cols: 47, rows: 53, pending: [], cursor: { runId: "old", runOrdinal: 0, generation: 0, offset: 123, statusSequence: 0 } };
    saveCheckpoint(checkpointKey("host-1", "ses-1"), Promise.resolve(saved));
    const { client, request } = setupClient();
    render(<SessionWorkspace open={{ ...open, session: { ...open.session, latestStatus: { runId: "run", runOrdinal: 1, sequence: 1, state: "idle", source: "process", confidence: "low", occurredAt: "" } } }} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(request).toHaveBeenCalledWith("host-1", "session.attach", expect.objectContaining({ resumeFrom: undefined })));
    expect(terminalHarness.writes).not.toContain("OLD_RUN");
  });

  beforeEach(async () => {
    clearTerminalCheckpoints();
    localStorage.clear();
    terminalHarness.props = undefined;
    terminalHarness.writes = [];
    terminalHarness.queued = false;
    terminalHarness.writesQueue = [];
    terminalHarness.resets = 0;
    terminalHarness.renders = 0;
    terminalHarness.mounts = 0;
    await i18n.changeLanguage("en-US");
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("reattaches an externally restarted session without issuing Restart", async () => {
    vi.useFakeTimers();
    const { client, request } = setupClient();
    const base = request.getMockImplementation()!;
    request.mockImplementation((...args) => args[1] === "session.list"
      ? Promise.resolve([{ ...open.session, lifecycle: "running", hostAlive: true }]) : base(...args));
    const changed = vi.fn();
    render(<SessionWorkspace open={{ ...open, session: { ...open.session, lifecycle: "stopped", hostAlive: false } }} client={client} onClose={vi.fn()} onSessionChanged={changed} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(request.mock.calls.filter(([, method]) => method === "session.attach")).toHaveLength(1);
    expect(request.mock.calls.some(([, method]) => ["session.restart", "session.stop", "session.input"].includes(method))).toBe(false);
    expect(screen.queryByRole("button", { name: "Restart" })).not.toBeInTheDocument();
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ session: expect.objectContaining({ lifecycle: "running" }) }));
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(request.mock.calls.filter(([, method]) => method === "session.list")).toHaveLength(1);
  });

  it("does not overlap ended-state reads or attach after the workspace is hidden", async () => {
    vi.useFakeTimers();
    const { client, request } = setupClient();
    const base = request.getMockImplementation()!;
    let resolveList!: (value: unknown) => void;
    request.mockImplementation((...args) => args[1] === "session.list"
      ? new Promise(resolve => { resolveList = resolve; }) : base(...args));
    const props = { open: { ...open, session: { ...open.session, lifecycle: "stopped", hostAlive: false } }, client, onClose: vi.fn(), onSessionChanged: vi.fn() };
    const view = render(<SessionWorkspace {...props} active />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(request.mock.calls.filter(([, method]) => method === "session.list")).toHaveLength(1);
    view.rerender(<SessionWorkspace {...props} active={false} />);
    await act(async () => { resolveList([{ ...open.session, hostAlive: true }]); });
    expect(request.mock.calls.some(([, method]) => method === "session.attach")).toBe(false);
  });

  it("keeps Exit authoritative when it arrives before the attach reply", async () => {
    const { client, request, emit } = setupClient({ autoReplay: false });
    const base = request.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    request.mockImplementation((...args) => args[1] === "session.attach" ? new Promise(resolve => { finish = resolve; }) : base(...args));
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await act(async () => {
      emit({ subscriptionId: "att-1", eventType: "exit", cursor: null, payload: { session_id: "ses-1", run_id: "run", run_ordinal: 1, group_cleaned: true } });
      finish({ attachmentId: "att-1", sessionId: "ses-1", childAlive: true, runId: "run", runOrdinal: 1 });
    });
    expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "ended");
    expect(screen.getByRole("button", { name: "Restart" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Raw terminal" })).not.toBeInTheDocument();
  });

  it("does not let a late resize reply revive an exited session", async () => {
    const { client, request, emit } = setupClient();
    const base = request.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    request.mockImplementation((...args) => args[1] === "session.control" ? new Promise(resolve => { finish = resolve; }) : base(...args));
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    act(() => terminalHarness.props?.onResize?.(52, 32));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await act(async () => {
      emit({ subscriptionId: "att-1", eventType: "exit", cursor: null, payload: { session_id: "ses-1", group_cleaned: true } });
      finish({ accepted: true, terminalGeometry: { runId: "run", runOrdinal: 1, revision: 1, sourceKind: "mobile" } });
    });
    expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "ended");
    expect(screen.getByRole("button", { name: "Restart" })).toBeVisible();
  });

  it("ignores another attachment's late exit and output for the same Session", async () => {
    const { client, emit } = setupClient();
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    await act(async () => {
      emit({ subscriptionId: "old-attachment", eventType: "output", cursor: null, payload: { session_id: "ses-1", dataBase64: btoa("old-run") } });
      emit({ subscriptionId: "old-attachment", eventType: "exit", cursor: null, payload: { session_id: "ses-1", group_cleaned: true } });
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live");
    expect(terminalHarness.writes).not.toContain("old-run");
  });

  it("reattaches on a newer run snapshot even if both snapshots say running", async () => {
    const { client, request } = setupClient();
    const status = { runId: "run", runOrdinal: 1, sequence: 1, state: "idle", source: "process", confidence: "high", occurredAt: "2026-09-08T00:00:00Z" };
    const props = { client, onClose: vi.fn(), onSessionChanged: vi.fn() };
    const view = render(<SessionWorkspace {...props} open={{ ...open, session: { ...open.session, hostAlive: true, latestStatus: status } }} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    const base = request.getMockImplementation()!;
    request.mockImplementation((...args) => args[1] === "session.attach"
      ? Promise.resolve({ attachmentId: "att-2", sessionId: "ses-1", childAlive: true, runId: "run-2", runOrdinal: 2 }) : base(...args));
    view.rerender(<SessionWorkspace {...props} open={{ ...open, session: { ...open.session, hostAlive: true, latestStatus: { ...status, runId: "run-2", runOrdinal: 2 } } }} />);
    await waitFor(() => expect(request.mock.calls.filter(([, method]) => method === "session.attach")).toHaveLength(2));
    expect(terminalHarness.resets).toBe(1);
    expect(request.mock.calls.some(([, method]) => ["session.stop", "session.restart"].includes(method))).toBe(false);
  });

  it("publishes current state and exit while rejecting stale run and sequence events", async () => {
    const { client, emit } = setupClient();
    const changed = vi.fn();
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={changed} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    const state = { session_id: "ses-1", run_id: "run", run_ordinal: 1, sequence: 3, state: "needs_input", source: "hook", confidence: "high", occurred_at: "2026-09-08T00:00:00Z" };
    act(() => emit({ subscriptionId: "att-1", eventType: "state", cursor: null, payload: state }));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ session: expect.objectContaining({ latestStatus: expect.objectContaining({ runId: "run", sequence: 3, state: "needs_input" }) }) }));
    act(() => {
      emit({ subscriptionId: "att-1", eventType: "state", cursor: null, payload: { ...state, sequence: 2, state: "working" } });
      emit({ subscriptionId: "att-1", eventType: "exit", cursor: null, payload: { session_id: "ses-1", run_id: "old", run_ordinal: 0 } });
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live");
    act(() => emit({ subscriptionId: "att-1", eventType: "exit", cursor: null, payload: { session_id: "ses-1", run_id: "run", run_ordinal: 1, reason: "user_stop", group_cleaned: true } }));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ session: expect.objectContaining({ lifecycle: "stopped", hostAlive: false }) }));
  });

  it("ignores stale geometry revisions instead of changing ownership back", async () => {
    const { client, emit } = setupClient();
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    const geometry = { runId: "run", runOrdinal: 1, cols: 100, rows: 30, sourceKind: "desktop" as const, revision: 3, updatedAt: "2026-09-08T00:00:00Z" };
    act(() => {
      emit({ subscriptionId: "att-1", eventType: "terminal_geometry_changed", cursor: null, payload: { session_id: "ses-1", geometry } });
      emit({ subscriptionId: "att-1", eventType: "terminal_geometry_changed", cursor: null, payload: { session_id: "ses-1", geometry: { ...geometry, sourceKind: "mobile", revision: 2 } } });
    });
    expect(screen.getByRole("button", { name: "Restore phone size" })).toBeVisible();
  });

  it("accepts a current-run stopped snapshot after local Restart when Exit delivery was lost", async () => {
    const { client } = setupClient();
    const props = { client, onClose: vi.fn(), onSessionChanged: vi.fn() };
    const view = render(<SessionWorkspace {...props} open={{ ...open, session: { ...open.session, lifecycle: "stopped", hostAlive: false } }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Restart" }));
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    view.rerender(<SessionWorkspace {...props} open={{ ...open, session: { ...open.session, lifecycle: "stopped", hostAlive: false,
      latestStatus: { runId: "run", runOrdinal: 1, sequence: 2, state: "exited", source: "process", confidence: "high", occurredAt: "2026-09-08T00:00:00Z" } } }} />);
    expect(await screen.findByRole("button", { name: "Restart" })).toBeVisible();
    expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "ended");
    expect(screen.queryByRole("region", { name: "Raw terminal" })).not.toBeInTheDocument();
  });

  it("routes an early attachment-scoped resync without a Session ID after the reply identifies it", async () => {
    const { client, request, emit } = setupClient({ autoReplay: false });
    const base = request.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    request.mockImplementation((...args) => {
      if (args[1] === "session.attach" && !finish) return new Promise(resolve => { finish = resolve; });
      return base(...args);
    });
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await act(async () => {
      emit({ subscriptionId: "att-1", eventType: "resync_required", cursor: null, payload: { reason: "host_stream_closed" } });
      finish({ attachmentId: "att-1", sessionId: "ses-1", childAlive: true, runId: "run", runOrdinal: 1 });
    });
    await waitFor(() => expect(request.mock.calls.filter(([, method]) => method === "session.attach")).toHaveLength(2));
    expect(terminalHarness.resets).toBe(1);
  });

  it("offers Restart for an ended host instead of attempting an impossible attachment", async () => {
    const { client, request } = setupClient();
    render(<SessionWorkspace open={{ ...open, session: { ...open.session, lifecycle: "exited", hostAlive: false } }} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Restart" })).toBeInTheDocument();
    expect(request.mock.calls.some(([, method]) => method === "session.attach")).toBe(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agent task", level: 2 })).toBeVisible();
    expect(screen.getByText("AgentSessions")).toBeVisible();
    expect(screen.queryByText(/This session has stopped/)).not.toBeInTheDocument();
    expect(request.mock.calls.some(([, method]) => method === "session.restart")).toBe(false);
  });

  it("keeps the restart identity and disables the button while the explicit request is pending", async () => {
    const { client, request } = setupClient();
    request.mockImplementation(() => new Promise(() => {}));
    render(<SessionWorkspace open={{ ...open, projectName: undefined, session: { ...open.session, lifecycle: "stopped" } }} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    const restart = await screen.findByRole("button", { name: "Restart" });
    expect(screen.getByText("prj-1")).toBeVisible();
    fireEvent.click(restart);
    expect(restart).toBeDisabled();
    expect(restart).toHaveAttribute("aria-busy", "true");
    expect(request).toHaveBeenCalledWith("host-1", "session.restart", { sessionId: "ses-1", riskAck: true });
  });

  it("returns to the centered restart page after restarting then stopping without stale parent props", async () => {
    const { client, request } = setupClient();
    render(<SessionWorkspace open={{ ...open, session: { ...open.session, lifecycle: "stopped", hostAlive: false } }} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Restart" }));
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    fireEvent.click(screen.getByRole("button", { name: "Show session title and actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByRole("button", { name: "Restart" });
    expect(screen.queryByRole("region", { name: "Raw terminal" })).not.toBeInTheDocument();
    expect(screen.queryByText("Session stopped safely.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(request.mock.calls.filter(([, m]) => m === "session.restart")).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
  });

  it("restarts a bypass session directly without a second permission dialog", async () => {
    const { client, request } = setupClient();
    render(<SessionWorkspace open={{ ...open, session: { ...open.session, lifecycle: "stopped", permissionMode: "bypass" } }} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Restart" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("host-1", "session.restart", { sessionId: "ses-1", riskAck: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(request.mock.calls.filter(([, m]) => m === "session.stop")).toHaveLength(0);
  });

  it("stops from the action sheet immediately and preserves errors without replay", async () => {
    const { client, request } = setupClient();
    const original = request.getMockImplementation()!;
    let fail!: (reason: unknown) => void;
    request.mockImplementation((...args) => args[1] === "session.stop" ? new Promise((_resolve, reject) => { fail = reject; }) : original(...args));
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    fireEvent.click(screen.getByRole("button", { name: "Show session title and actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    const dialog = screen.getByRole("dialog");
    const stop = within(dialog).getByRole("button", { name: "Stop" });
    fireEvent.click(stop);
    fireEvent.click(stop);
    expect(request.mock.calls.filter(([, m]) => m === "session.stop")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(terminalHarness.props?.obscured).toBe(true);
    expect(screen.getByLabelText("Raw terminal")).not.toBeVisible();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    await act(async () => fail(new Error("stop outcome unknown")));
    expect(screen.getByRole("alert")).toHaveTextContent("stop outcome unknown");
    expect(screen.getByRole("region", { name: "Raw terminal" })).toBeVisible();
    expect(terminalHarness.mounts).toBe(1);
    expect(request.mock.calls.filter(([, m]) => m === "session.stop")).toHaveLength(1);
  });

  it("hides CLI exit text during Stop while retaining its output until acknowledgment", async () => {
    const { client, request, emit } = setupClient();
    const original = request.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    request.mockImplementation((...args) => args[1] === "session.stop" ? new Promise(resolve => { finish = resolve; }) : original(...args));
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    fireEvent.click(screen.getByRole("button", { name: "Show session title and actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await act(async () => {
      emit({ subscriptionId: "att-1", eventType: "output", cursor: null, payload: { session_id: "ses-1", dataBase64: btoa("Resume this session with: claude --resume fixture") } });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(terminalHarness.writes).toEqual(["Resume this session with: claude --resume fixture"]);
    expect(screen.getByLabelText("Raw terminal")).not.toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restart" })).not.toBeInTheDocument();
    act(() => terminalHarness.props?.onInput?.("not sent"));
    expect(request.mock.calls.some(([, method]) => method === "session.input")).toBe(false);
    await act(async () => finish({ groupCleaned: true }));
    expect(await screen.findByRole("button", { name: "Restart" })).toBeEnabled();
    expect(screen.queryByLabelText("Raw terminal")).not.toBeInTheDocument();
  });

  it("waits for a running session to stop before restarting, without duplicate writes or confirmation", async () => {
    const { client, request } = setupClient();
    const original = request.getMockImplementation()!;
    let finishStop!: (value: unknown) => void;
    let running = true;
    request.mockImplementation((...args) => {
      if (args[1] === "session.stop") return new Promise(resolve => { finishStop = value => { running = false; resolve(value); }; });
      if (args[1] === "session.restart" && running) return Promise.reject(new Error("request failed on the remote host"));
      return original(...args);
    });
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    fireEvent.click(screen.getByRole("button", { name: "Show session title and actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    const restart = screen.getByRole("button", { name: "Restart" });
    fireEvent.click(restart);
    fireEvent.click(restart);
    expect(request.mock.calls.filter(([, m]) => m === "session.stop")).toHaveLength(1);
    expect(request.mock.calls.filter(([, m]) => m === "session.restart")).toHaveLength(0);
    expect(restart).toBeDisabled();
    await act(async () => finishStop({ groupCleaned: true }));
    await waitFor(() => expect(request.mock.calls.filter(([, m]) => m === "session.restart")).toHaveLength(1));
    await waitFor(() => expect(request.mock.calls.filter(([, m]) => m === "session.attach")).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["Stop failed", "Stop outcome unknown"])("does not restart or replay after %s", async message => {
    const { client, request } = setupClient();
    const original = request.getMockImplementation()!;
    request.mockImplementation((...args) => args[1] === "session.stop" ? Promise.reject(new Error(message)) : original(...args));
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    fireEvent.click(screen.getByRole("button", { name: "Show session title and actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(request.mock.calls.filter(([, m]) => m === "session.stop")).toHaveLength(1);
    expect(request.mock.calls.filter(([, m]) => m === "session.restart")).toHaveLength(0);
  });

  it("retains stopped state and the error when Stop succeeds but Restart fails", async () => {
    const { client, request } = setupClient();
    const original = request.getMockImplementation()!;
    const changed = vi.fn();
    request.mockImplementation((...args) => args[1] === "session.restart" ? Promise.reject(new Error("Restart outcome unknown")) : original(...args));
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={changed} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    fireEvent.click(screen.getByRole("button", { name: "Show session title and actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "ended"));
    expect(screen.getByRole("alert")).toHaveTextContent("Restart outcome unknown");
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ session: expect.objectContaining({ lifecycle: "stopped", hostAlive: false }) }));
    expect(request.mock.calls.filter(([, m]) => m === "session.restart")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Raw terminal" })).not.toBeInTheDocument();
  });

  it("edits the action-sheet title inline and never calls a native browser prompt", async () => {
    const { client, request } = setupClient();
    const changed = vi.fn();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={changed} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    fireEvent.click(screen.getByRole("button", { name: "Show session title and actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.parentElement).toHaveClass("modal-backdrop-no-blur");
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    const input = within(dialog).getByRole("textbox", { name: "New session name" });
    expect(input.closest(".centered-modal-header")).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: "Save" }).textContent).toBe("");
    expect(within(dialog).getByRole("button", { name: "Cancel" }).textContent).toBe("");
    fireEvent.change(input, { target: { value: "Renamed task" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("host-1", "session.rename", { sessionId: "ses-1", title: "Renamed task" }));
    expect(prompt).not.toHaveBeenCalled();
    await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ session: expect.objectContaining({ title: "Renamed task" }) })));
    prompt.mockRestore();
  });

  it.each([false, true])("replaces a suspended connection and resumes once (connection events delivered: %s)", async delivered => {
    const { client, request, emit } = setupClient();
    if (delivered) {
      let connection!: (event: any) => void;
      vi.mocked(client.onConnectionState).mockImplementation(async listener => { connection = listener; return async () => {}; });
      vi.mocked(client.disconnect).mockImplementation(async () => { connection({ profileId: "host-1", state: "disconnected" }); });
      vi.mocked(client.connect).mockImplementation(async () => {
        connection({ profileId: "host-1", state: "connected" });
        return {} as Awaited<ReturnType<RemoteClient["connect"]>>;
      });
    }
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    const consumed = { runId: "run", runOrdinal: 1, generation: 0, offset: 5 };
    await act(async () => {
      emit({ subscriptionId: "att-1", eventType: "output", cursor: consumed,
        payload: { session_id: "ses-1", dataBase64: btoa("hello") } });
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange"));
    visibility.mockReturnValue("visible"); fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(client.disconnect).toHaveBeenCalledWith("host-1"));
    await waitFor(() => expect(request.mock.calls.filter(([, method]) => method === "session.attach")).toHaveLength(2));
    expect(client.connect).toHaveBeenCalledWith("host-1");
    expect(request).toHaveBeenCalledWith("host-1", "session.attach", expect.objectContaining({ resumeFrom: consumed }));
    expect(terminalHarness.mounts).toBe(1);
    expect(terminalHarness.writes).toEqual(["hello"]);
  });

  it("recovers the retained terminal with a resume cursor and disables input while disconnected", async () => {
    const { client, request, emit } = setupClient();
    let connection!: (event: any) => void;
    vi.mocked(client.onConnectionState).mockImplementation(async listener => { connection = listener; return async () => {}; });
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    const resume = { runId: "run", runOrdinal: 1, generation: 0, offset: 5, statusSequence: 0 };
    await act(async () => {
      emit({ subscriptionId: "att-1", eventType: "output", cursor: resume, payload: { session_id: "ses-1", dataBase64: btoa("hello") } });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    act(() => connection({ profileId: "host-1", state: "reconnecting" }));
    fireEvent.click(screen.getByRole("button", { name: "Type terminal input" }));
    expect(request.mock.calls.some(([, method]) => method === "session.input")).toBe(false);
    act(() => connection({ profileId: "host-1", state: "connected" }));
    await waitFor(() => expect(request.mock.calls.filter(([, method]) => method === "session.attach")).toHaveLength(2));
    expect(request).toHaveBeenLastCalledWith("host-1", "session.attach", expect.objectContaining({ resumeFrom: resume }));
    expect(terminalHarness.mounts).toBe(1);
    expect(terminalHarness.writes).toEqual(["hello"]);
  });

  it("attaches with cursor semantics and keeps interaction on the raw terminal path", async () => {
    const { client, request, emit } = setupClient();
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    expect(screen.queryByText("AgentSessions")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Type terminal input" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(
      "host-1",
      "session.input",
      expect.objectContaining({ attachmentId: "att-1", dataBase64: "5L2g5aW9DQ==" }),
      expect.objectContaining({ onSubmitted: expect.any(Function) }),
    ));
    expect(screen.queryByText("终端仍在适配手机尺寸")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resize terminal" }));
    await act(async () => {
      emit({ subscriptionId: "att-1", eventType: "output", cursor: { runId: "run", runOrdinal: 1, generation: 0, offset: 5, statusSequence: 0 }, payload: { session_id: "ses-1", dataBase64: btoa("hello") } });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(terminalHarness.writes).toEqual(["hello"]);
    expect(terminalHarness.props?.showHeading).toBe(false);
    expect(screen.queryByRole("button", { name: "Conversation" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Send text")).not.toBeInTheDocument();
    expect(localStorage.getItem("agentport-mobile-session-cursor-v1:host-1:ses-1")).toBeNull();
  });

  it("dispatches ordered input batches without waiting for earlier remote results", async () => {
    const { client, request } = setupClient();
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));

    let resolveInputs!: (value: { phase: string }) => void;
    const pendingInput = new Promise<{ phase: string }>((resolve) => { resolveInputs = resolve; });
    request.mockImplementation((_profileId, method, _params, options) => {
      if (method !== "session.input") return Promise.resolve({});
      options?.onSubmitted?.();
      return pendingInput;
    });
    request.mockClear();

    terminalHarness.props?.onInput?.("a");
    terminalHarness.props?.onInput?.("b");
    terminalHarness.props?.onInput?.("c");
    await act(async () => { await Promise.resolve(); });

    const inputCalls = request.mock.calls.filter(([, method]) => method === "session.input");
    expect(inputCalls).toHaveLength(3);
    expect(inputCalls.map(([, , params]) => atob(params.dataBase64))).toEqual(["a", "b", "c"]);

    resolveInputs({ phase: "completed" });
    await act(async () => { await pendingInput; });
  });

  it("streams output without retaining chunks or rerendering the workspace", async () => {
    const { client, emit } = setupClient();
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    const settledRenders = terminalHarness.renders;
    const persist = vi.spyOn(Storage.prototype, "setItem");

    await act(async () => {
      for (let index = 0; index < 200; index += 1) {
        emit({
          subscriptionId: "att-1",
          eventType: "output",
          cursor: { runId: "run", runOrdinal: 1, generation: 0, offset: index * 256, statusSequence: 0 },
          payload: { session_id: "ses-1", dataBase64: btoa("x".repeat(256)) },
        });
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(terminalHarness.writes).toHaveLength(1);
    expect(terminalHarness.writes[0]).toHaveLength(200 * 256);
    expect(terminalHarness.renders).toBe(settledRenders);
    expect(persist).not.toHaveBeenCalled();
    persist.mockRestore();
  });

  it("shows the small replay immediately and allows input before replay completes", async () => {
    const { client, request, emit } = setupClient({ autoReplay: false });
    terminalHarness.queued = true;
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    expect(terminalHarness.props?.obscured).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Type terminal input" }));
    await waitFor(() => expect(request.mock.calls.some(([, method]) => method === "session.input")).toBe(true));
    act(() => terminalHarness.props?.onResize?.(52, 32));
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(request.mock.calls.some(([, method]) => method === "session.control")).toBe(false);
    act(() => {
      emit({ subscriptionId: "att-1", eventType: "output", cursor: null, payload: { session_id: "ses-1", dataBase64: btoa("replay") } });
      emit({ subscriptionId: "att-1", eventType: "replay_done", cursor: null, payload: { session_id: "ses-1" } });
      emit({ subscriptionId: "att-1", eventType: "output", cursor: null, payload: { session_id: "ses-1", dataBase64: btoa("live") } });
    });
    expect(terminalHarness.props?.obscured).toBe(false);
    act(() => terminalHarness.writesQueue.shift()?.());
    expect(terminalHarness.writes).toEqual(["replay"]);
    expect(terminalHarness.props?.obscured).toBe(false);
    act(() => terminalHarness.writesQueue.shift()?.());
    expect(terminalHarness.props?.obscured).toBe(false);
    await waitFor(() => expect(request.mock.calls.some(([, method]) => method === "session.control")).toBe(true));
    act(() => { while (terminalHarness.writesQueue.length) terminalHarness.writesQueue.shift()?.(); });
    expect(terminalHarness.writes).toEqual(["replay", "live"]);
    expect(terminalHarness.props?.onReachTop).toBeUndefined();
    expect(terminalHarness.resets).toBe(0);
    expect(request.mock.calls.some(([, method]) => method === "session.recovery_context.read")).toBe(false);
  });

  it("does not let an old parse completion release resize before the replacement replay", async () => {
    const { client, request, emit } = setupClient({ autoReplay: false });
    terminalHarness.queued = true;
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    act(() => terminalHarness.props?.onResize?.(52, 32));
    act(() => {
      emit({ subscriptionId: "att-1", eventType: "replay_done", cursor: null, payload: { session_id: "ses-1" } });
      emit({ subscriptionId: "att-1", eventType: "resync_required", cursor: null, payload: { session_id: "ses-1" } });
    });
    await waitFor(() => expect(request.mock.calls.filter(([, method]) => method === "session.attach")).toHaveLength(2));
    act(() => terminalHarness.writesQueue.shift()?.());
    expect(request.mock.calls.some(([, method]) => method === "session.control")).toBe(false);
    expect(terminalHarness.props?.obscured).toBe(false);
    act(() => emit({ subscriptionId: "att-1", eventType: "replay_done", cursor: null, payload: { session_id: "ses-1" } }));
    act(() => { while (terminalHarness.writesQueue.length) terminalHarness.writesQueue.shift()?.(); });
    expect(terminalHarness.props?.obscured).toBe(false);
    await waitFor(() => expect(request.mock.calls.some(([, method]) => method === "session.control")).toBe(true));
  });

  it("fences queued events immediately when resync resets the renderer", async () => {
    const { client, request, emit } = setupClient({ autoReplay: false });
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    const stale = { runId: "old", runOrdinal: 1, generation: 0, offset: 999, statusSequence: 1 };
    act(() => {
      emit({ subscriptionId: "att-1", eventType: "resync_required", cursor: stale, payload: { reason: "host_stream_closed" } });
      emit({ subscriptionId: "att-1", eventType: "heartbeat", cursor: stale, payload: { session_id: "ses-1" } });
      emit({ subscriptionId: "att-1", eventType: "output", cursor: stale, payload: { session_id: "ses-1", dataBase64: btoa("stale") } });
      emit({ subscriptionId: "att-1", eventType: "replay_done", cursor: stale, payload: { session_id: "ses-1" } });
    });
    await waitFor(() => expect(request.mock.calls.filter(([, method]) => method === "session.attach")).toHaveLength(2));
    const attach = request.mock.calls.filter(([, method]) => method === "session.attach")[1];
    expect(attach[2].resumeFrom).toBeUndefined();
    expect(terminalHarness.writes).not.toContain("stale");
    expect(terminalHarness.props?.obscured).toBe(false);
  });

  it("consumes the Host terminal_geometry_changed event contract", async () => {
    const { client, request, emit } = setupClient();
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    fireEvent.click(screen.getByRole("button", { name: "Resize terminal" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("host-1", "session.control", expect.objectContaining({ control: "resize", expectedRevision: 0 })));

    await act(async () => emit({
      subscriptionId: "att-1",
      eventType: "terminal_geometry_changed",
      cursor: null,
      payload: {
        type: "terminal_geometry_changed",
        session_id: "ses-1",
        geometry: {
          runId: "run",
          runOrdinal: 1,
          cols: 120,
          rows: 36,
          sourceKind: "desktop",
          revision: 2,
          updatedAt: "2026-09-02T00:00:00Z",
        },
      },
    }));

    expect(screen.queryByText("桌面端已恢复 120×36")).not.toBeInTheDocument();
    const restore = await screen.findByRole("button", { name: "Restore phone size" });
    fireEvent.click(restore);
    await waitFor(() => expect(request).toHaveBeenCalledWith("host-1", "session.control", expect.objectContaining({
      control: "resize",
      cols: 52,
      rows: 32,
      expectedRevision: 2,
      sourceKind: "mobile",
    })));
  });

  it("ignores structured envelopes and coalesces resize signals onto session.control", async () => {
    const { client, request, emit } = setupClient();
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    await act(async () => emit({ subscriptionId: "att-1", eventType: "structured", cursor: {}, payload: { sessionId: "ses-1", event: { type: "tui", text: "Approve? [y/N]" } } }));
    expect(screen.queryByText("Approval requested")).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalledWith("host-1", "session.structured_input", expect.anything());

    fireEvent.click(screen.getByRole("button", { name: "Resize terminal" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("host-1", "session.control", expect.objectContaining({
      attachmentId: "att-1",
      control: "resize",
      cols: 52,
      rows: 32,
      expectedRevision: 0,
      sourceKind: "mobile",
      sourceDeviceId: expect.any(String),
      orientation: "portrait",
    })));
    expect(request.mock.calls.filter(([, method, params]) => method === "session.control" && params.control === "resize")).toHaveLength(1);
  });

  it("serializes keyboard animation resizes and publishes the final rows with the acknowledged revision", async () => {
    const { client, request } = setupClient();
    const original = request.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    request.mockImplementation((...args) => {
      if (args[1] === "session.control") return new Promise(resolve => { finish = resolve; });
      return original(...args);
    });
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    act(() => terminalHarness.props!.onResize!(52, 40));
    await waitFor(() => expect(request.mock.calls.filter(([, m]) => m === "session.control")).toHaveLength(1));
    act(() => terminalHarness.props!.onResize!(52, 24));
    // Allow another animation frame while the network acknowledgment is pending.
    await act(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(request.mock.calls.filter(([, m]) => m === "session.control")).toHaveLength(1);
    await act(async () => finish({ accepted: true, terminalGeometry: { cols: 52, rows: 40, revision: 1, sourceKind: "mobile" } }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("host-1", "session.control", expect.objectContaining({ rows: 24, expectedRevision: 1 })));
  });

  it("keeps the live terminal clean and interactive when phone resize fails", async () => {
    const { client, request } = setupClient({ rejectResize: true });
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));

    fireEvent.click(screen.getByRole("button", { name: "Resize terminal" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("host-1", "session.control", expect.objectContaining({ control: "resize" })));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Type terminal input" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(
      "host-1",
      "session.input",
      expect.objectContaining({ dataBase64: "5L2g5aW9DQ==" }),
      expect.objectContaining({ onSubmitted: expect.any(Function) }),
    ));
  });

  it("requests a bounded tail for every fresh terminal renderer instead of resuming from a stale persisted cursor", async () => {
    localStorage.setItem("agentport-mobile-session-cursor-v1:host-1:ses-1", JSON.stringify({
      runId: "run", runOrdinal: 1, generation: 0, offset: 4096, statusSequence: 3,
    }));
    const { client, request } = setupClient();
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    expect(request).toHaveBeenCalledWith("host-1", "session.attach", expect.objectContaining({
      replayTailBytes: 64 * 1024,
      resumeFrom: undefined,
      subscribeOutput: true,
    }));
  });

  it("restores stored colors and updates a hidden live renderer without reattaching", async () => {
    localStorage.setItem("agentport-mobile-v2:terminal-appearance", JSON.stringify({ theme: "aurora", mode: "light" }));
    function AppearanceControl() {
      const [, update] = useMobileTerminalAppearance();
      return <button onClick={() => update({ theme: "one", mode: "dark" })}>Update appearance</button>;
    }
    const { client, request } = setupClient();
    const { container } = render(<>
      <div hidden><SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} /></div>
      <AppearanceControl />
    </>);
    const workspace = container.querySelector("article")!;
    await waitFor(() => expect(workspace).toHaveAttribute("data-connection-state", "live"));
    expect(workspace).toHaveAttribute("data-terminal-theme", "aurora");
    expect(terminalHarness.props?.theme?.background).toBe("#f7f9ff");
    const mounts = terminalHarness.mounts;
    fireEvent.click(screen.getByRole("button", { name: "Update appearance" }));
    expect(workspace).toHaveAttribute("data-terminal-theme", "one");
    expect(workspace).toHaveStyle({ colorScheme: "dark" });
    expect(workspace.style.getPropertyValue("--terminal-bg")).toBe("#282c34");
    expect(terminalHarness.props?.theme?.background).toBe("#282c34");
    expect(terminalHarness.mounts).toBe(mounts);
    expect(request.mock.calls.filter(([, method]) => method === "session.attach")).toHaveLength(1);
    expect(request.mock.calls.filter(([, method]) => method === "session.detach")).toHaveLength(0);
    expect(document.documentElement.style.getPropertyValue("--terminal-bg")).toBe("");
  });

  it("moves keyboard focus into the actions sheet, traps Tab, and restores the trigger on Escape", async () => {
    const { client } = setupClient();
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));

    fireEvent.click(screen.getByRole("button", { name: "Show session title and actions" }));
    const trigger = screen.getByRole("button", { name: "Session actions" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("radiogroup")).not.toBeInTheDocument();
    const close = within(dialog).getByRole("button", { name: "Close" });
    const last = within(dialog).getByRole("button", { name: "A+" });
    expect(close).toHaveFocus();

    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(close).toHaveFocus();

    fireEvent.keyDown(close, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("starts immersive, reveals only title/actions, and returns to the list without detaching", async () => {
    const { client, request } = setupClient();
    const onClose = vi.fn();
    const props = { open, client, onClose, onSessionChanged: vi.fn() };
    const { rerender } = render(<SessionWorkspace {...props} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    expect(screen.queryByRole("heading", { name: "Agent task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Session actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to sessions" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("session-project-branch")).not.toBeInTheDocument();
    expect(request.mock.calls.some(([, method]) => method === "git.context.resolve")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Show session title and actions" }));
    expect(screen.getByRole("heading", { name: "Agent task" })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("region", { name: "Raw terminal" }));
    expect(screen.queryByRole("heading", { name: "Agent task" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show session title and actions" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Session actions" }), { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Show session title and actions" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Show session title and actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    const menu = screen.getByRole("dialog");
    expect([...menu.querySelectorAll(".terminal-action-grid button")].map(button => button.textContent)).toEqual(["Rename", "Pin", "Restart", "Stop", "A−", "A+"]);
    expect(menu).toHaveTextContent("AgentSessions · main");
    expect(menu).not.toHaveTextContent("running · native");
    fireEvent.click(within(menu).getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(<SessionWorkspace {...props} active={false} />);
    rerender(<SessionWorkspace {...props} active />);
    expect(screen.queryByRole("heading", { name: "Agent task" })).not.toBeInTheDocument();
    expect(terminalHarness.mounts).toBe(1);
    expect(request.mock.calls.filter(([, method]) => method === "session.attach")).toHaveLength(1);
    expect(request.mock.calls.filter(([, method]) => method === "session.detach")).toHaveLength(0);
  });
});
