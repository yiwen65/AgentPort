import { act, cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import type { RemoteClient } from "../../protocol/remoteClient";
import type { SessionSummary } from "./types";
import { SessionRowActions } from "./SessionRowActions";

const session = { id: "temporary-test-session", title: "Test only", lifecycle: "running" } as SessionSummary;
beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(cleanup);
function setup() {
  const request = vi.fn().mockResolvedValue({});
  const onClose = vi.fn();
  render(<SessionRowActions session={session} hostId="test-host" client={{ request } as unknown as RemoteClient} onClose={onClose} onChanged={vi.fn()} />);
  return { request, onClose };
}
it("dismisses Remove immediately but keeps it pending until safe deletion and refresh finish", async () => {
  let finish!: () => void, refresh!: () => void;
  const request = vi.fn().mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue({});
  const onChanged = vi.fn(() => new Promise<void>(resolve => { refresh = resolve; }));
  const onRemovalPending = vi.fn(), onRemovalError = vi.fn(), onClose = vi.fn();
  render(<SessionRowActions session={session} hostId="test-host" client={{ request } as unknown as RemoteClient}
    onClose={onClose} onChanged={onChanged} onRemovalPending={onRemovalPending} onRemovalError={onRemovalError} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(onRemovalPending).toHaveBeenCalledExactlyOnceWith(true);
  expect(request.mock.calls.map(call => call[1])).toEqual(["session.archive"]);
  await act(async () => finish());
  expect(request.mock.calls.map(call => call[1])).toEqual(["session.archive", "session.archives.delete"]);
  expect(onRemovalPending).not.toHaveBeenCalledWith(false);
  await act(async () => refresh());
  expect(onRemovalPending).toHaveBeenLastCalledWith(false);
  expect(onClose).toHaveBeenCalledOnce();
});

it("restores pending visibility and reports a background stop failure", async () => {
  let fail!: (error: Error) => void;
  const request = vi.fn(() => new Promise<void>((_, reject) => { fail = reject; }));
  const onRemovalPending = vi.fn(), onRemovalError = vi.fn();
  render(<SessionRowActions session={session} hostId="test-host" client={{ request } as unknown as RemoteClient}
    onClose={vi.fn()} onChanged={vi.fn()} onRemovalPending={onRemovalPending} onRemovalError={onRemovalError} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await act(async () => fail(new Error("stop failed")));
  expect(onRemovalError).toHaveBeenCalledWith("stop failed");
  expect(onRemovalPending.mock.calls).toEqual([[true], [false]]);
  expect(request).toHaveBeenCalledOnce();
});

it("requires permanent-delete confirmation and archives/stops before deleting history", async () => {
  const { request, onClose } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(request).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toHaveTextContent("Project source files will not be deleted");
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(request.mock.calls.map(call => call[1])).toEqual(["session.archive", "session.archives.delete"]);
  expect(request.mock.calls.every(call => call[0] === "test-host" && call[2].sessionId === session.id)).toBe(true);
});
it("never deletes when stopping/archiving fails, and cancel submits nothing", async () => {
  const { request } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(request).not.toHaveBeenCalled();
  request.mockRejectedValueOnce(new Error("stop failed"));
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("stop failed");
  expect(request.mock.calls.map(call => call[1])).toEqual(["session.archive"]);
});
it("retains the archived result and retries only deletion after partial failure", async () => {
  const { request, onClose } = setup();
  request.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("delete failed"));
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("was archived");
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(request.mock.calls.map(call => call[1])).toEqual(["session.archive", "session.archives.delete", "session.archives.delete"]);
});
it("renames a trimmed title and prevents empty names", async () => {
  const { request } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: " " } });
  expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Rename" })).toBeDisabled();
  fireEvent.change(input, { target: { value: " New name " } });
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("test-host", "session.rename", { sessionId: session.id, title: "New name" }));
});

it("stops on the first click, blocks duplicates, and closes only after acknowledgment", async () => {
  const { request, onClose } = setup();
  let finish!: (value: unknown) => void;
  request.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const stop = screen.getByRole("button", { name: "Stop" });
  fireEvent.click(stop);
  fireEvent.click(stop);
  expect(request).toHaveBeenCalledExactlyOnceWith("test-host", "session.stop", { sessionId: session.id, graceMs: 1500 });
  expect(stop).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => finish({}));
  expect(onClose).toHaveBeenCalledOnce();
});
it("keeps Stop errors visible without automatically replaying", async () => {
  const { request, onClose } = setup();
  request.mockRejectedValueOnce(new Error("stop outcome unknown"));
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("stop outcome unknown");
  expect(request).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
});
