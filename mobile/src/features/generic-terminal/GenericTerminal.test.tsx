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
const record: TerminalRecord = { id: "terminal-1", profileId: "host-1", name: "Persistent shell", tmuxSession: "agentport_mobile_uuid", createdAt: "2026-10-13" };
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
  first.unmount(); await waitFor(() => expect(client.disconnect).toHaveBeenCalledWith("connection-1"));
  mount(client, auth); await attach(); await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(2));
  expect(client.create).not.toHaveBeenCalled(); expect(client.end).not.toHaveBeenCalled();
});
it("creates with only a profile and display name, and attaches the returned record", async () => {
  const { client, auth } = clients(); vi.mocked(client.list).mockResolvedValue([]); mount(client, auth);
  await screen.findByText(/No terminals yet/);
  fireEvent.change(screen.getByLabelText("Terminal name"), { target: { value: "  Work  " } });
  fireEvent.click(screen.getByRole("button", { name: "Create tmux terminal" }));
  await waitFor(() => expect(client.create).toHaveBeenCalledWith({ profileId: "host-1", name: "Work" }));
  await waitFor(() => expect(client.connect).toHaveBeenCalledWith({ terminalId: record.id, transport: "ssh", cols: 80, rows: 24 }));
});
it("recovers an ambiguous create from native records without submitting another create", async () => {
  const { client, auth } = clients(); vi.mocked(client.list).mockResolvedValueOnce([]).mockResolvedValue([record]);
  vi.mocked(client.create).mockRejectedValue({ code: "terminal_timeout", message: "Creation result unknown" }); mount(client, auth);
  await screen.findByText(/No terminals yet/); fireEvent.change(screen.getByLabelText("Terminal name"), { target: { value: "Work" } });
  fireEvent.click(screen.getByRole("button", { name: "Create tmux terminal" }));
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
