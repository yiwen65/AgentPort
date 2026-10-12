import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import type { FileDownloadClient, FileDownloadSnapshot, FileDownloadState } from "../../protocol/fileDownloadClient";
import type { OpenSession } from "../sessions/types";
import { FileDownloadProvider, formatFileBytes, useFileDownloads } from "./FileDownloads";
const open = { hostProfileId: "host", hostName: "Studio", session: { id: "session", title: "Work", cwd: "/repo" } } as OpenSession;
const snapshot = (state: FileDownloadState = "downloading", extra: Partial<FileDownloadSnapshot> = {}): FileDownloadSnapshot => ({ jobId: "job", profileId: "host", sessionId: "session", path: "a.zip", name: "a.zip", totalBytes: 1024, receivedBytes: 0, state, ...extra });
function native() { return { available: vi.fn(() => true), start: vi.fn(async () => snapshot()), poll: vi.fn(async () => snapshot()), cancel: vi.fn(async () => snapshot("cancelled")), save: vi.fn(async () => snapshot("saved")), discard: vi.fn(async () => {}) } satisfies FileDownloadClient; }
function Source({ session = open }: { session?: OpenSession }) { const downloads = useFileDownloads(); return <><button disabled={!downloads.available || downloads.occupied} onClick={() => downloads.start(session, "a.zip")}>Start file</button><span>{downloads.occupied ? "occupied" : "idle"}</span></>; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("App-level file downloads", () => {
  it("polls bounded progress and does not claim saving until the native exporter confirms it", async () => {
    const client = native(); client.poll.mockResolvedValue(snapshot("ready", { receivedBytes: 1024 }));
    const save = deferred<FileDownloadSnapshot>(); client.save.mockReturnValue(save.promise);
    render(<FileDownloadProvider client={client}><Source /></FileDownloadProvider>);
    fireEvent.click(screen.getByText("Start file"));
    expect(await screen.findByText("Downloading")).toBeVisible();
    expect(screen.queryByText("Saved to the selected location")).toBeNull();
    fireEvent.click(screen.getByText("Start file")); expect(client.start).toHaveBeenCalledOnce();
    fireEvent.click(await screen.findByRole("button", { name: "Save As…" }));
    expect(screen.getByText("System Save As — choosing a location or saving")).toBeVisible();
    expect(screen.queryByText("Saved to the selected location")).toBeNull();
    await act(async () => save.resolve(snapshot("saved")));
    expect(await screen.findByText("Saved to the selected location")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull()); expect(client.discard).toHaveBeenCalledWith("job");
  });
  it("retains task identity after changing the visible Session and does not start a second transfer", async () => {
    const client = native(); const view = render(<FileDownloadProvider client={client}><Source /></FileDownloadProvider>);
    fireEvent.click(screen.getByText("Start file")); await screen.findByText("Downloading");
    view.rerender(<FileDownloadProvider client={client}><Source session={{ ...open, hostProfileId: "other", session: { ...open.session, id: "other", title: "Other" } }} /></FileDownloadProvider>);
    expect(screen.getByText("Start file")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Download details for a.zip" }));
    expect(screen.getByText(/Studio · Work/)).toBeVisible(); expect(client.start).toHaveBeenCalledWith({ profileId: "host", sessionId: "session", path: "a.zip" });
    expect(client.cancel).not.toHaveBeenCalled();
  });
  it("cancels a late start before the UI has received its native ID", async () => {
    const client = native(); const start = deferred<FileDownloadSnapshot>(); client.start.mockReturnValue(start.promise);
    render(<FileDownloadProvider client={client}><Source /></FileDownloadProvider>);
    fireEvent.click(screen.getByText("Start file")); await screen.findByText("Downloading");
    fireEvent.click(screen.getByRole("button", { name: "Cancel download" }));
    await act(async () => start.resolve(snapshot()));
    await screen.findByText("Cancelled — saving was not completed"); expect(client.cancel).toHaveBeenCalledWith("job");
  });
  it("shows cancelling until an in-flight native chunk has actually stopped", async () => {
    const client = native(); client.cancel.mockResolvedValue(snapshot()); client.poll.mockResolvedValue(snapshot("cancelled"));
    render(<FileDownloadProvider client={client}><Source /></FileDownloadProvider>);
    fireEvent.click(screen.getByText("Start file")); await screen.findByText("Downloading");
    fireEvent.click(screen.getByRole("button", { name: "Cancel download" }));
    expect(await screen.findByText("Cancelling. Please wait.")).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Cancel download" })).toBeDisabled();
    await screen.findByText("Cancelled — saving was not completed");
    expect(screen.queryByText("Cancelling. Please wait.")).toBeNull();
  });
  it("retains the native job ID when cancelling a late start cannot be acknowledged", async () => {
    const client = native(); const start = deferred<FileDownloadSnapshot>(); client.start.mockReturnValue(start.promise);
    client.cancel.mockRejectedValueOnce({ code: "request_timeout" });
    render(<FileDownloadProvider client={client}><Source /></FileDownloadProvider>);
    fireEvent.click(screen.getByText("Start file")); await screen.findByText("Downloading");
    fireEvent.click(screen.getByRole("button", { name: "Cancel download" }));
    await act(async () => start.resolve(snapshot()));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Download again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel download" }));
    await screen.findByText("Cancelled — saving was not completed");
    expect(client.cancel).toHaveBeenNthCalledWith(2, "job");
  });
  it("keeps the old task available for cleanup if discard fails before retry", async () => {
    const client = native(); client.start.mockResolvedValue(snapshot("cancelled")); client.discard.mockRejectedValueOnce({ code: "cleanup_failed" });
    render(<FileDownloadProvider client={client}><Source /></FileDownloadProvider>);
    fireEvent.click(screen.getByText("Start file")); await screen.findByText("Cancelled — saving was not completed");
    fireEvent.click(screen.getByRole("button", { name: "Download again" })); await screen.findByRole("alert");
    expect(client.start).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull()); expect(client.discard).toHaveBeenNthCalledWith(2, "job");
  });
  it("ignores a late poll after cancellation and retries from the original source", async () => {
    const client = native(); const poll = deferred<FileDownloadSnapshot>(); client.poll.mockReturnValueOnce(poll.promise);
    render(<FileDownloadProvider client={client}><Source /></FileDownloadProvider>);
    fireEvent.click(screen.getByText("Start file")); await waitFor(() => expect(client.poll).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel download" })); await screen.findByText("Cancelled — saving was not completed");
    await act(async () => poll.resolve(snapshot("ready", { receivedBytes: 1024 })));
    expect(screen.queryByRole("button", { name: "Save As…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download again" }));
    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(2));
    expect(client.discard).toHaveBeenCalledWith("job");
  });
  it.each(["source_changed", "file_too_large", "outside_root", "disk_full", "integrity_failed", "unknown_method"])("localizes %s without exposing raw native details", async code => {
    const client = native(); client.start.mockRejectedValue({ code, message: "sensitive native path" });
    render(<FileDownloadProvider client={client}><Source /></FileDownloadProvider>);
    fireEvent.click(screen.getByText("Start file")); await screen.findByText("Download or save failed");
    expect(screen.getByRole("alert")).not.toHaveTextContent("sensitive native path"); expect(screen.getByRole("alert").textContent).not.toBe(`downloads.errors.${code}`);
    expect(screen.getByRole("button", { name: "Download again" })).toBeEnabled();
  });
  it("does not turn rejected or unknown save completion into success", async () => {
    const client = native(); client.start.mockResolvedValue(snapshot("ready")); client.save.mockRejectedValue({ code: "save_failed" }); client.poll.mockResolvedValue(snapshot("failed", { error: { code: "save_failed", message: "" } }));
    render(<FileDownloadProvider client={client}><Source /></FileDownloadProvider>); fireEvent.click(screen.getByText("Start file"));
    fireEvent.click(await screen.findByRole("button", { name: "Save As…" })); await screen.findByText("Download or save failed");
    expect(screen.queryByText("Saved to the selected location")).toBeNull(); expect(screen.getByRole("alert")).toHaveTextContent("Could not save");
  });
  it("warns about a leftover destination after provider cleanup fails", async () => {
    const client = native(); client.start.mockResolvedValue(snapshot("ready"));
    client.save.mockResolvedValue(snapshot("failed", { error: { code: "save_failed_leftover", message: "native detail" } }));
    render(<FileDownloadProvider client={client}><Source /></FileDownloadProvider>); fireEvent.click(screen.getByText("Start file"));
    fireEvent.click(await screen.findByRole("button", { name: "Save As…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("target could not be removed");
    expect(screen.queryByText("Saved to the selected location")).toBeNull();
  });

  it("retains the external leftover warning if retry cannot clean the private temporary file", async () => {
    const client = native(); client.start.mockResolvedValue(snapshot("ready"));
    client.save.mockResolvedValue(snapshot("failed", { error: { code: "save_failed_leftover", message: "" } }));
    client.discard.mockRejectedValue({ code: "cleanup_failed" });
    render(<FileDownloadProvider client={client}><Source /></FileDownloadProvider>); fireEvent.click(screen.getByText("Start file"));
    fireEvent.click(await screen.findByRole("button", { name: "Save As…" }));
    await screen.findByRole("alert"); fireEvent.click(screen.getByRole("button", { name: "Download again" }));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(screen.getByText(/target could not be removed/)).toBeVisible();
    expect(screen.getByText(/Could not clean up temporary files/)).toBeVisible();
    expect(client.start).toHaveBeenCalledOnce();
  });
  it("distinguishes genuine saving from temporary cleanup failure without suggesting another download", async () => {
    const client = native(); client.start.mockResolvedValue(snapshot("ready")); client.save.mockResolvedValue(snapshot("saved", { error: { code: "saved_cleanup_failed", message: "" } }));
    render(<FileDownloadProvider client={client}><Source /></FileDownloadProvider>); fireEvent.click(screen.getByText("Start file"));
    fireEvent.click(await screen.findByRole("button", { name: "Save As…" })); await screen.findByText("Saved to the selected location");
    expect(screen.getByRole("alert")).toHaveTextContent("temporary copy could not be removed");
    expect(screen.queryByRole("button", { name: "Download again" })).toBeNull();
  });
  it("honors system picker cancellation rather than showing a saved file", async () => {
    const client = native(); client.start.mockResolvedValue(snapshot("ready")); client.save.mockResolvedValue(snapshot("cancelled"));
    render(<FileDownloadProvider client={client}><Source /></FileDownloadProvider>); fireEvent.click(screen.getByText("Start file"));
    fireEvent.click(await screen.findByRole("button", { name: "Save As…" })); await screen.findByText("Cancelled — saving was not completed");
    expect(screen.queryByText("Saved to the selected location")).toBeNull();
  });
  it("does not start a browser download or fake a successful save", () => {
    const client = native(); client.available.mockReturnValue(false);
    render(<FileDownloadProvider client={client}><Source /></FileDownloadProvider>); fireEvent.click(screen.getByText("Start file"));
    expect(client.start).not.toHaveBeenCalled(); expect(screen.queryByRole("complementary")).toBeNull();
  });
  it("formats progress at the 1 GiB limit without allocating content", () => { expect(formatFileBytes(1024 ** 3)).toBe("1.00 GiB"); expect(formatFileBytes(0)).toBe("0 B"); });
});
