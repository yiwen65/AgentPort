import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import type { RemoteClient, RemoteEvent } from "../../protocol/remoteClient";
import type { OpenSession, SessionEventPayload } from "./types";
import { SessionWorkspace } from "./SessionWorkspace";

const terminalHarness = vi.hoisted(() => ({ props: undefined as {
  outputChunks?: string[];
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  showHeading?: boolean;
} | undefined }));

vi.mock("../../terminal/MobileTerminal", () => ({
  MobileTerminal: (props: NonNullable<typeof terminalHarness.props>) => {
    terminalHarness.props = props;
    return <section aria-label="Raw terminal">
      <pre data-testid="raw-terminal-output">{props.outputChunks?.join("")}</pre>
      <button type="button" onClick={() => props.onInput?.("你好\r")}>Type terminal input</button>
      <button type="button" onClick={() => { props.onResize?.(48, 40); props.onResize?.(52, 32); }}>Resize terminal</button>
    </section>;
  },
}));

const open: OpenSession = {
  hostProfileId: "host-1",
  hostName: "Studio",
  projectName: "AgentSessions",
  session: {
    id: "ses-1", projectId: "prj-1", presetId: "pre-1", title: "Agent task", cwd: "/tmp", lifecycle: "running", resumePrecision: "exact", adapterType: "pi", transport: "json_rpc", permissionMode: "native", createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:01:00Z",
  },
};

function setupClient() {
  let listener: ((event: RemoteEvent<SessionEventPayload>) => void) | undefined;
  const request = vi.fn().mockImplementation((_profileId, method, params) => {
    if (method === "session.attach") return Promise.resolve({ attachmentId: "att-1", sessionId: "ses-1", childAlive: true, cursor: null, features: ["input_batch_v1", "terminal.geometry_v1"], runId: "run", runOrdinal: 1, terminalGeometry: null });
    if (method === "session.input") return Promise.resolve({ batchId: "batch", serverSequence: 1, phase: "completed" });
    if (method === "session.control" && params.control === "resize") return Promise.resolve({ accepted: true, terminalGeometry: { runId: "run", runOrdinal: 1, cols: params.cols, rows: params.rows, sourceKind: "mobile", sourceDeviceId: params.sourceDeviceId, attachmentId: "att-1", orientation: params.orientation, revision: 1, updatedAt: "2026-09-02T00:00:00Z" } });
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
  beforeEach(async () => { localStorage.clear(); terminalHarness.props = undefined; await i18n.changeLanguage("en-US"); });
  afterEach(() => cleanup());

  it("attaches with cursor semantics and keeps interaction on the raw terminal path", async () => {
    const { client, request, emit } = setupClient();
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    expect(await screen.findByText("Adapting for phone")).toBeInTheDocument();
    expect(screen.getByText("AgentSessions")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resize terminal" }));
    expect(await screen.findByText("Live")).toBeInTheDocument();
    await act(async () => emit({ subscriptionId: "sub", eventType: "output", cursor: { runId: "run", runOrdinal: 1, generation: 0, offset: 5, statusSequence: 0 }, payload: { session_id: "ses-1", dataBase64: btoa("hello") } }));
    expect(screen.getByTestId("raw-terminal-output")).toHaveTextContent("hello");
    expect(terminalHarness.props?.showHeading).toBe(false);
    expect(screen.queryByRole("button", { name: "Conversation" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Send text")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Type terminal input" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("host-1", "session.input", expect.objectContaining({ attachmentId: "att-1", dataBase64: "5L2g5aW9DQ==" })));
    expect(JSON.parse(localStorage.getItem("agentport-mobile-session-cursor-v1:host-1:ses-1")!)).toEqual(expect.objectContaining({ offset: 5 }));
  });

  it("consumes the Host terminal_geometry_changed event contract", async () => {
    const { client, emit } = setupClient();
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await screen.findByText("Adapting for phone");

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

    expect(await screen.findByText("桌面端已恢复 120×36")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新适配手机" })).toBeInTheDocument();
  });

  it("ignores structured envelopes and coalesces resize signals onto session.control", async () => {
    const { client, request, emit } = setupClient();
    render(<SessionWorkspace open={open} client={client} onClose={vi.fn()} onSessionChanged={vi.fn()} />);
    await screen.findByText("Adapting for phone");
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
});
