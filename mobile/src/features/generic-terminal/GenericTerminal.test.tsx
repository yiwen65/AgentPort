import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import { GenericTerminalWorkspace } from "./GenericTerminal";
import type { GenericTerminalClient, TerminalRecord } from "../../protocol/genericTerminalClient";
import type { HostAuthClient } from "../hosts-auth/types";

const terminalSpy = vi.hoisted(() => ({ write: vi.fn(), input: undefined as undefined | ((data: string) => void), resize: undefined as undefined | ((cols: number, rows: number) => void) }));
vi.mock("../../terminal/MobileTerminal", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { MobileTerminal: forwardRef(({ onInput, onResize }: { onInput: typeof terminalSpy.input; onResize: typeof terminalSpy.resize }, ref) => {
    terminalSpy.input = onInput; terminalSpy.resize = onResize;
    useImperativeHandle(ref, () => ({ write: terminalSpy.write, reset: vi.fn() }));
    return <div role="application" aria-label="Generic xterm" />;
  }) };
});
// Legacy records intentionally omit mode: they must remain tmux sessions.
const record: TerminalRecord = { id: "terminal-1", profileId: "host-1", name: "Persistent shell", tmuxSession: "agentport_mobile_uuid", createdAt: "2026-10-13" };
const shellRecord: TerminalRecord = { ...record, id: "shell-1", name: "Work Shell", mode: "shell", tmuxSession: "" };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function clients() {
  const client: GenericTerminalClient = {
    list: vi.fn().mockResolvedValue([record]), create: vi.fn().mockResolvedValue(record),
    connect: vi.fn().mockResolvedValue({ connectionId: "connection-1" }), input: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined), poll: vi.fn().mockImplementation(() => new Promise(() => undefined)),
    disconnect: vi.fn().mockResolvedValue(undefined), end: vi.fn().mockResolvedValue(undefined),
  };
  const auth = { getProfile: vi.fn().mockResolvedValue({ name: "Host", jump: { hostProfileId: "jump-1" } }), trustHostKey: vi.fn().mockResolvedValue(undefined) } as unknown as HostAuthClient;
  return { client, auth };
}
function mount(client: GenericTerminalClient, authClient: HostAuthClient) {
  return render(<GenericTerminalWorkspace profileId="host-1" hostName="Host" client={client} authClient={authClient} onClose={vi.fn()} />);
}
async function attach() { fireEvent.click(await screen.findByRole("button", { name: "Connect" })); }
beforeEach(async () => { await i18n.changeLanguage("en-US"); terminalSpy.write.mockReset(); terminalSpy.input = undefined; localStorage.clear(); });
afterEach(cleanup);

it("loads native records after a new app lifetime and attaches without creating", async () => {
  const { client, auth } = clients(); const first = mount(client, auth); await attach();
  await screen.findByText("Connected · tmux keeps tasks running");
  expect(screen.getByText("Host · SSH · tmux session")).toBeInTheDocument();
  first.unmount(); await waitFor(() => expect(client.disconnect).toHaveBeenCalledWith("connection-1"));
  mount(client, auth); await attach(); await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(2));
  expect(client.create).not.toHaveBeenCalled(); expect(client.end).not.toHaveBeenCalled();
});
it("defaults to plain Shell and sends the explicit mode without credentials or commands", async () => {
  const { client, auth } = clients(); vi.mocked(client.list).mockResolvedValue([]); vi.mocked(client.create).mockResolvedValue(shellRecord); mount(client, auth);
  await screen.findByText(/No terminals yet/);
  expect(screen.getByLabelText("Terminal type")).toHaveValue("shell");
  expect(screen.getByText(/Only a shortcut is saved/)).toHaveTextContent("Each opening starts a new Shell, not your previous tasks");
  fireEvent.change(screen.getByLabelText("Terminal name"), { target: { value: "  Work  " } });
  fireEvent.click(screen.getByRole("button", { name: "Create Shell" }));
  await waitFor(() => expect(client.create).toHaveBeenCalledWith({ profileId: "host-1", name: "Work", mode: "shell" }));
  await waitFor(() => expect(client.connect).toHaveBeenCalledWith({ terminalId: shellRecord.id, transport: "ssh", cols: 80, rows: 24 }));
  await screen.findByText("Connected · plain Shell (not persistent)");
  expect(screen.queryByText(/tmux keeps tasks running/)).not.toBeInTheDocument();
});
it("only creates tmux when explicitly selected", async () => {
  const { client, auth } = clients(); vi.mocked(client.list).mockResolvedValue([]); mount(client, auth);
  await screen.findByText(/No terminals yet/);
  fireEvent.change(screen.getByLabelText("Terminal type"), { target: { value: "tmux" } });
  expect(screen.getByText(/Requires tmux on the host/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Terminal name"), { target: { value: "Work" } });
  fireEvent.click(screen.getByRole("button", { name: "Create tmux terminal" }));
  await waitFor(() => expect(client.create).toHaveBeenCalledWith({ profileId: "host-1", name: "Work", mode: "tmux" }));
  await screen.findByText("Connected · tmux keeps tasks running");
});
it("recovers an ambiguous create from native records without submitting another create", async () => {
  const { client, auth } = clients(); vi.mocked(client.list).mockResolvedValueOnce([]).mockResolvedValue([record]);
  vi.mocked(client.create).mockRejectedValue({ code: "terminal_timeout", message: "Creation result unknown" }); mount(client, auth);
  await screen.findByText(/No terminals yet/); fireEvent.change(screen.getByLabelText("Terminal name"), { target: { value: "Work" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Shell" }));
  await screen.findByText(record.name); expect(client.create).toHaveBeenCalledTimes(1);
  expect(client.connect).not.toHaveBeenCalled(); await attach();
  await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1)); expect(client.create).toHaveBeenCalledTimes(1);
});
it("never automatically recreates a missing tmux session", async () => {
  const { client, auth } = clients(); vi.mocked(client.connect).mockRejectedValue({ code: "tmux_session_missing" }); mount(client, auth); await attach();
  expect(await screen.findByRole("alert")).toHaveTextContent("will not be recreated automatically");
  fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(2)); expect(client.create).not.toHaveBeenCalled();
});
it("requires an explicit end confirmation; closing only detaches", async () => {
  const { client, auth } = clients(); mount(client, auth); await attach(); await screen.findByText("Connected · tmux keeps tasks running");
  fireEvent.click(screen.getByRole("button", { name: "Close (keep terminal)" }));
  await waitFor(() => expect(client.disconnect).toHaveBeenCalledTimes(1)); expect(client.end).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "End" })); expect(client.end).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(client.end).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "End" })); fireEvent.click(screen.getByRole("button", { name: "End and delete record" }));
  await waitFor(() => expect(client.end).toHaveBeenCalledWith(record.id)); await waitFor(() => expect(screen.queryByText(record.name)).not.toBeInTheDocument());
});
it("trusts the exact jump hop only after confirmation, then retries same record", async () => {
  const { client, auth } = clients(); vi.mocked(client.connect).mockRejectedValueOnce({ code: "jump_host_key_confirmation_required", hostKeyHop: "jump", fingerprint: "SHA256:jump" }).mockResolvedValue({ connectionId: "verified" });
  mount(client, auth); await attach(); await screen.findByText("SHA256:jump"); expect(auth.trustHostKey).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Trust and connect" }));
  await waitFor(() => expect(auth.trustHostKey).toHaveBeenCalledWith("jump-1", "SHA256:jump"));
  await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(2)); expect(client.create).not.toHaveBeenCalled();
});
it("canceling trust never authorizes or retries", async () => {
  const { client, auth } = clients(); vi.mocked(client.connect).mockRejectedValue({ code: "host_key_confirmation_required", fingerprint: "SHA256:host" });
  mount(client, auth); await attach(); await screen.findByText("SHA256:host"); fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(auth.trustHostKey).not.toHaveBeenCalled(); expect(client.connect).toHaveBeenCalledTimes(1);
});
it("never offers trust for a changed host key", async () => {
  const { client, auth } = clients(); vi.mocked(client.connect).mockRejectedValue({ code: "host_key_changed", message: "Host key changed", fingerprint: "SHA256:bad" });
  mount(client, auth); await attach(); await screen.findByText("Host key changed"); expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(); expect(auth.trustHostKey).not.toHaveBeenCalled();
});
it("blocks pending input and disconnects a late connect result after close", async () => {
  const { client, auth } = clients(); const pending = deferred<{ connectionId: string }>(); vi.mocked(client.connect).mockReturnValue(pending.promise);
  mount(client, auth); await attach(); await waitFor(() => expect(client.connect).toHaveBeenCalled());
  act(() => terminalSpy.input?.("pending")); expect(client.input).not.toHaveBeenCalled();
  expect(screen.getByRole("application").parentElement).toHaveAttribute("inert");
  fireEvent.click(screen.getByRole("button", { name: "Close (keep terminal)" }));
  await act(async () => pending.resolve({ connectionId: "late" })); await waitFor(() => expect(client.disconnect).toHaveBeenCalledWith("late")); expect(client.poll).not.toHaveBeenCalled();
});
it("polls without overlap, passes bytes unchanged and suppresses stale output", async () => {
  const { client, auth } = clients(); const frame = deferred<{ data: number[]; running: boolean }>();
  const stale = deferred<{ data: number[]; running: boolean }>();
  vi.mocked(client.poll).mockReturnValueOnce(frame.promise).mockReturnValueOnce(stale.promise);
  mount(client, auth); await attach(); await waitFor(() => expect(client.poll).toHaveBeenCalledTimes(1));
  await new Promise(resolve => setTimeout(resolve, 70)); expect(client.poll).toHaveBeenCalledTimes(1);
  await act(async () => frame.resolve({ data: [240, 159, 146, 187], running: true }));
  await waitFor(() => expect(terminalSpy.write).toHaveBeenCalledWith(new Uint8Array([240, 159, 146, 187])));
  await waitFor(() => expect(client.poll).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Close (keep terminal)" }));
  await act(async () => stale.resolve({ data: [65], running: true })); expect(terminalSpy.write).toHaveBeenCalledTimes(1);
});
it("offers SSH for the same record after Mosh failure, with no auto fallback", async () => {
  const { client, auth } = clients(); vi.mocked(client.connect).mockRejectedValueOnce({ code: "mosh_server_missing" }).mockResolvedValue({ connectionId: "ssh" });
  mount(client, auth); await screen.findByText(record.name); fireEvent.change(screen.getByLabelText("Transport"), { target: { value: "mosh" } }); await attach();
  expect(await screen.findByRole("alert")).toHaveTextContent("mosh-server is not installed"); expect(client.connect).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getAllByRole("button", { name: "Use SSH for the same terminal" })[0]);
  await waitFor(() => expect(client.connect).toHaveBeenLastCalledWith(expect.objectContaining({ terminalId: record.id, transport: "ssh" }))); expect(client.create).not.toHaveBeenCalled();
});
it("allows user SSH switch while Mosh remains alive but UDP is unreachable, waiting for detach", async () => {
  const { client, auth } = clients(); const detach = deferred<void>(); vi.mocked(client.disconnect).mockReturnValueOnce(detach.promise);
  mount(client, auth); await screen.findByText(record.name); fireEvent.change(screen.getByLabelText("Transport"), { target: { value: "mosh" } }); await attach();
  await screen.findByText("Connected · tmux keeps tasks running");
  fireEvent.click(screen.getByRole("button", { name: "Use SSH for the same terminal" }));
  await waitFor(() => expect(client.disconnect).toHaveBeenCalledTimes(1)); expect(client.connect).toHaveBeenCalledTimes(1);
  await act(async () => detach.resolve()); await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(2));
  expect(client.connect).toHaveBeenLastCalledWith(expect.objectContaining({ terminalId: record.id, transport: "ssh" }));
});
it("serializes input and resize requests and blocks writes after detach", async () => {
  const { client, auth } = clients(); const firstWrite = deferred<void>();
  vi.mocked(client.input).mockReturnValueOnce(firstWrite.promise).mockResolvedValue(undefined);
  mount(client, auth); await attach(); await screen.findByText("Connected · tmux keeps tasks running");
  await waitFor(() => expect(client.resize).toHaveBeenCalledTimes(1));
  act(() => { terminalSpy.input?.("first"); terminalSpy.input?.("second"); terminalSpy.resize?.(100, 30); });
  await waitFor(() => expect(client.input).toHaveBeenCalledTimes(1)); expect(client.resize).toHaveBeenCalledTimes(1);
  await act(async () => firstWrite.resolve());
  await waitFor(() => expect(client.input).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(client.resize).toHaveBeenLastCalledWith({ connectionId: "connection-1", cols: 100, rows: 30 }));
  fireEvent.click(screen.getByRole("button", { name: "Close (keep terminal)" }));
  act(() => terminalSpy.input?.("after close")); expect(client.input).toHaveBeenCalledTimes(2);
});
it("reopens a saved plain record only as an explicit new Shell and warns before close", async () => {
  const { client, auth } = clients(); vi.mocked(client.list).mockResolvedValue([shellRecord]);
  const first = mount(client, auth);
  expect(await screen.findByText("Plain Shell · Shortcut · starts a new Shell each time")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  expect(client.connect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Start new Shell" }));
  await screen.findByText("Connected · plain Shell (not persistent)");
  fireEvent.click(screen.getByRole("button", { name: "Close Shell…" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Disconnecting may end remote jobs");
  expect(screen.getByRole("dialog")).toHaveTextContent("opening it again starts a new Shell");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(client.disconnect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close Shell…" }));
  fireEvent.click(screen.getByRole("button", { name: "Disconnect and close" }));
  await waitFor(() => expect(client.disconnect).toHaveBeenCalledTimes(1)); expect(client.end).not.toHaveBeenCalled();
  first.unmount(); mount(client, auth);
  await screen.findByRole("button", { name: "Start new Shell" }); expect(client.connect).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Start new Shell" }));
  await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(2));
  expect(client.create).not.toHaveBeenCalled(); expect(client.input).not.toHaveBeenCalled();
});
it("plain record deletion describes local-only cleanup and requires confirmation", async () => {
  const { client, auth } = clients(); vi.mocked(client.list).mockResolvedValue([shellRecord]); mount(client, auth);
  fireEvent.click(await screen.findByRole("button", { name: "Delete record" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Only deletes the local record");
  expect(screen.getByRole("dialog")).toHaveTextContent("No remote termination command is sent");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(client.end).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete record" }));
  fireEvent.click(screen.getByRole("button", { name: "Disconnect and delete record" }));
  await waitFor(() => expect(client.end).toHaveBeenCalledWith(shellRecord.id));
  expect(client.connect).not.toHaveBeenCalled(); expect(auth.getProfile).not.toHaveBeenCalled();
});
it("plain disconnect never auto-reconnects; retry explicitly starts a new Shell without replay", async () => {
  const { client, auth } = clients(); vi.mocked(client.list).mockResolvedValue([shellRecord]);
  vi.mocked(client.poll).mockResolvedValueOnce({ data: [65], running: false }); mount(client, auth);
  fireEvent.click(await screen.findByRole("button", { name: "Start new Shell" }));
  await screen.findByText("Disconnected; input is unavailable. Opening again starts a new Shell, not the previous Shell.");
  expect(client.connect).toHaveBeenCalledTimes(1); expect(client.input).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  act(() => terminalSpy.input?.("offline")); expect(client.input).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Start new Shell" }));
  await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(2)); expect(client.input).not.toHaveBeenCalled();
});
it("plain Mosh switch can be cancelled, then waits for detach before starting a new SSH Shell", async () => {
  const { client, auth } = clients(); const detach = deferred<void>(); vi.mocked(client.disconnect).mockReturnValueOnce(detach.promise);
  vi.mocked(client.list).mockResolvedValue([shellRecord]); mount(client, auth);
  await screen.findByText(shellRecord.name); fireEvent.change(screen.getByLabelText("Transport"), { target: { value: "mosh" } });
  fireEvent.click(screen.getByRole("button", { name: "Start new Shell" })); await screen.findByText("Mosh client active · plain Shell (not persistent)");
  fireEvent.click(screen.getByRole("button", { name: "Use a new SSH Shell…" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("You may lose foreground work");
  expect(screen.getByRole("dialog")).toHaveTextContent("not the original Shell");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(client.connect).toHaveBeenCalledTimes(1); expect(client.disconnect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Use a new SSH Shell…" }));
  fireEvent.click(screen.getByRole("button", { name: "Disconnect Mosh and start SSH Shell" }));
  await waitFor(() => expect(client.disconnect).toHaveBeenCalledWith("connection-1"));
  act(() => terminalSpy.input?.("during-detach")); expect(client.input).not.toHaveBeenCalled(); expect(client.connect).toHaveBeenCalledTimes(1);
  await act(async () => detach.resolve());
  await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(2));
  expect(client.connect).toHaveBeenLastCalledWith(expect.objectContaining({ terminalId: shellRecord.id, transport: "ssh" }));
  expect(client.create).not.toHaveBeenCalled(); expect(client.input).not.toHaveBeenCalled();
});
it("plain Mosh failure offers only an explicit new SSH Shell, never same-Shell recovery", async () => {
  const { client, auth } = clients(); vi.mocked(client.list).mockResolvedValue([shellRecord]);
  vi.mocked(client.connect).mockRejectedValueOnce({ code: "mosh_server_missing" }).mockResolvedValue({ connectionId: "ssh" }); mount(client, auth);
  await screen.findByText(shellRecord.name); fireEvent.change(screen.getByLabelText("Transport"), { target: { value: "mosh" } });
  fireEvent.click(screen.getByRole("button", { name: "Start new Shell" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("mosh-server is not installed");
  expect(screen.queryByText(/Use SSH for the same terminal/)).not.toBeInTheDocument();
  expect(client.connect).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Use a new SSH Shell…" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(client.connect).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Use a new SSH Shell…" }));
  fireEvent.click(screen.getByRole("button", { name: "Disconnect Mosh and start SSH Shell" }));
  await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(2));
  expect(client.connect).toHaveBeenLastCalledWith(expect.objectContaining({ terminalId: shellRecord.id, transport: "ssh" }));
  expect(client.create).not.toHaveBeenCalled(); expect(client.input).not.toHaveBeenCalled();
});
it("plain Mosh switch cleans up a late old connect before SSH and suppresses stale bytes", async () => {
  const { client, auth } = clients(); const late = deferred<{ connectionId: string }>(); const detached = deferred<void>();
  vi.mocked(client.list).mockResolvedValue([shellRecord]);
  vi.mocked(client.connect).mockReturnValueOnce(late.promise).mockResolvedValue({ connectionId: "ssh-next" });
  vi.mocked(client.disconnect).mockReturnValueOnce(detached.promise); mount(client, auth);
  await screen.findByText(shellRecord.name); fireEvent.change(screen.getByLabelText("Transport"), { target: { value: "mosh" } });
  fireEvent.click(screen.getByRole("button", { name: "Start new Shell" }));
  await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Use a new SSH Shell…" }));
  fireEvent.click(screen.getByRole("button", { name: "Disconnect Mosh and start SSH Shell" }));
  await act(async () => late.resolve({ connectionId: "old-mosh" }));
  await waitFor(() => expect(client.disconnect).toHaveBeenCalledWith("old-mosh"));
  expect(client.connect).toHaveBeenCalledTimes(1); expect(client.poll).not.toHaveBeenCalled();
  await act(async () => detached.resolve()); await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(2));
  expect(client.poll).toHaveBeenCalledWith("ssh-next"); expect(terminalSpy.write).not.toHaveBeenCalled();
});
it("keeps the existing plain Mosh client over background/foreground without reconnecting", async () => {
  const { client, auth } = clients(); vi.mocked(client.list).mockResolvedValue([shellRecord]); mount(client, auth);
  await screen.findByText(shellRecord.name); fireEvent.change(screen.getByLabelText("Transport"), { target: { value: "mosh" } });
  fireEvent.click(screen.getByRole("button", { name: "Start new Shell" })); await screen.findByText("Mosh client active · plain Shell (not persistent)");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  fireEvent(document, new Event("visibilitychange"));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  fireEvent(document, new Event("visibilitychange"));
  expect(client.disconnect).not.toHaveBeenCalled(); expect(client.connect).toHaveBeenCalledTimes(1);
});
it.each([
  ["ssh_pty_rejected", "refused a PTY"],
  ["ssh_shell_rejected", "refused to start a Shell"],
])("keeps plain input disabled after server rejection %s", async (code, message) => {
  const { client, auth } = clients(); vi.mocked(client.list).mockResolvedValue([shellRecord]);
  vi.mocked(client.connect).mockRejectedValue({ code }); mount(client, auth);
  fireEvent.click(await screen.findByRole("button", { name: "Start new Shell" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.getByRole("application").parentElement).toHaveAttribute("inert");
  act(() => terminalSpy.input?.("must-not-send"));
  expect(client.input).not.toHaveBeenCalled(); expect(client.poll).not.toHaveBeenCalled();
});
it("rapid close and reopen waits for late connection cleanup before a new connect", async () => {
  const { client, auth } = clients(); const late = deferred<{ connectionId: string }>(); const detached = deferred<void>();
  vi.mocked(client.connect).mockReturnValueOnce(late.promise).mockResolvedValue({ connectionId: "next" });
  vi.mocked(client.disconnect).mockReturnValueOnce(detached.promise);
  mount(client, auth); await attach(); await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Close (keep terminal)" })); await attach();
  expect(client.connect).toHaveBeenCalledTimes(1);
  await act(async () => late.resolve({ connectionId: "late" })); await waitFor(() => expect(client.disconnect).toHaveBeenCalledWith("late"));
  expect(client.connect).toHaveBeenCalledTimes(1); await act(async () => detached.resolve());
  await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(2)); await screen.findByText("Connected · tmux keeps tasks running");
});
