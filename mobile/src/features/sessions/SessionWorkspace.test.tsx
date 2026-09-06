import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileTerminalAppearance } from "../../terminal/terminalAppearance";
import { i18n } from "../../i18n";
import type { RemoteClient, RemoteEvent } from "../../protocol/remoteClient";
import type { OpenSession, SessionEventPayload } from "./types";
import { SessionWorkspace } from "./SessionWorkspace";

const terminalHarness = vi.hoisted(() => ({
  props: undefined as {
    onInput?: (data: string) => void;
    onResize?: (cols: number, rows: number) => void;
    showHeading?: boolean;
    theme?: { background?: string; foreground?: string };
  } | undefined,
  writes: [] as string[],
  resets: 0,
  renders: 0,
  mounts: 0,
}));

vi.mock("../../terminal/MobileTerminal", async () => {
  const { forwardRef, useImperativeHandle, useEffect } = await vi.importActual<typeof import("react")>("react");
  return {
    MobileTerminal: forwardRef((props: NonNullable<typeof terminalHarness.props>, ref) => {
      useEffect(() => { terminalHarness.mounts += 1; }, []);
      terminalHarness.props = props;
      terminalHarness.renders += 1;
      useImperativeHandle(ref, () => ({
        write: (data: string) => terminalHarness.writes.push(data),
        reset: () => { terminalHarness.resets += 1; },
      }), []);
      return <section aria-label="Raw terminal">
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

function setupClient({ rejectResize = false }: { rejectResize?: boolean } = {}) {
  let listener: ((event: RemoteEvent<SessionEventPayload>) => void) | undefined;
  const request = vi.fn().mockImplementation((_profileId, method, params) => {
    if (method === "session.attach") return Promise.resolve({ attachmentId: "att-1", sessionId: "ses-1", childAlive: true, cursor: null, features: ["input_batch_v1", "terminal.geometry_v1"], runId: "run", runOrdinal: 1, terminalGeometry: null });
    if (method === "git.context.resolve") return Promise.resolve({ actualBranch: "main", expectedBranch: "main" });
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
  beforeEach(async () => {
    localStorage.clear();
    terminalHarness.props = undefined;
    terminalHarness.writes = [];
    terminalHarness.resets = 0;
    terminalHarness.renders = 0;
    terminalHarness.mounts = 0;
    await i18n.changeLanguage("en-US");
  });
  afterEach(() => cleanup());

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
    expect(request).toHaveBeenCalledWith("host-1", "session.restart", { sessionId: "ses-1", riskAck: false });
  });

  it("recovers the retained terminal with a resume cursor and disables input while disconnected", async () => {
    const { client, request, emit } = setupClient();
    let connection!: (event: any) => void;
    vi.mocked(client.onConnectionState).mockImplementation(async listener => { connection = listener; return async () => {}; });
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    const resume = { runId: "run", runOrdinal: 1, generation: 0, offset: 5, statusSequence: 0 };
    act(() => emit({ subscriptionId: "att-1", eventType: "output", cursor: resume, payload: { session_id: "ses-1", dataBase64: btoa("hello") } }));
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
    await act(async () => emit({ subscriptionId: "sub", eventType: "output", cursor: { runId: "run", runOrdinal: 1, generation: 0, offset: 5, statusSequence: 0 }, payload: { session_id: "ses-1", dataBase64: btoa("hello") } }));
    expect(terminalHarness.writes).toEqual(["hello"]);
    expect(terminalHarness.props?.showHeading).toBe(false);
    expect(screen.queryByRole("button", { name: "Conversation" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Send text")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("agentport-mobile-session-cursor-v1:host-1:ses-1")!)).toEqual(expect.objectContaining({ offset: 5 }));
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

    await act(async () => {
      for (let index = 0; index < 200; index += 1) {
        emit({
          subscriptionId: "sub",
          eventType: "output",
          cursor: null,
          payload: { session_id: "ses-1", dataBase64: btoa("x".repeat(256)) },
        });
      }
    });

    expect(terminalHarness.writes).toHaveLength(200);
    expect(terminalHarness.writes.every((chunk) => chunk.length === 256)).toBe(true);
    expect(terminalHarness.renders).toBe(settledRenders);
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
    await act(async () => emit({ subscriptionId: "sub", eventType: "structured", cursor: {}, payload: { sessionId: "ses-1", event: { type: "tui", text: "Approve? [y/N]" } } }));
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
      replayTailBytes: 512 * 1024,
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
