import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import type { FileDownloadClient, FileDownloadSnapshot, FileDownloadState } from "../../protocol/fileDownloadClient";
import type { OpenSession } from "../sessions/types";
import { FileDownloadIndicator, FileDownloadProvider, formatFileBytes, useFileDownloads } from "./FileDownloads";
const open = { hostProfileId: "host", hostName: "Studio", session: { id: "session", title: "Work", cwd: "/repo" } } as OpenSession;
const snapshot = (state: FileDownloadState = "downloading", extra: Partial<FileDownloadSnapshot> = {}): FileDownloadSnapshot => ({ jobId: "job", profileId: "host", sessionId: "session", path: "a.zip", name: "a.zip", totalBytes: 1024, receivedBytes: 0, state, ...extra });
function native() { return { available: vi.fn(() => true), start: vi.fn(async () => snapshot()), poll: vi.fn(async () => snapshot()), cancel: vi.fn(async () => snapshot("cancelled")), save: vi.fn(async () => snapshot("saved")), discard: vi.fn(async () => {}) } satisfies FileDownloadClient; }
function Source({ session = open }: { session?: OpenSession }) { const downloads = useFileDownloads(); return <><button disabled={!downloads.available || downloads.occupied} onClick={() => downloads.start(session, "a.zip")}>Start file</button><span>{downloads.occupied ? "occupied" : "idle"}</span></>; }
function Surface({ active = true }: { active?: boolean }) { const downloads = useFileDownloads({ immersive: active }); return <button onClick={downloads.openDetails}>More<FileDownloadIndicator /></button>; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
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

describe("Immersive file-download presentation", () => {
  it("is safe without a provider, including a standalone immersive surface", () => {
    render(<><Source /><Surface /></>);
    expect(screen.getByText("Start file")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("img")).toBeNull(); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("does not queue a modal from an idle details request and retains ready attention after the notice expires", async () => {
    vi.useFakeTimers();
    const client = native(); client.start.mockResolvedValue(snapshot("ready"));
    render(<FileDownloadProvider client={client}><Source /><Surface /></FileDownloadProvider>);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await act(async () => fireEvent.click(screen.getByText("Start file")));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("choose a save location");
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("img")).toHaveClass("has-attention");
    fireEvent.click(screen.getByRole("button", { name: /^More/ }));
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Save As…" })).toBeEnabled();
  });
  it("hides the card on entry and restores the same job and progress on exit without cancellation", async () => {
    const client = native(); client.poll.mockResolvedValue(snapshot("downloading", { receivedBytes: 512 }));
    const tree = (surface: boolean, active = true) => <FileDownloadProvider client={client}><Source />{surface ? <Surface active={active} /> : null}</FileDownloadProvider>;
    const view = render(tree(false));
    fireEvent.click(screen.getByText("Start file")); await screen.findByRole("complementary");
    view.rerender(tree(true));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(await screen.findByRole("img", { name: /512 B \/ 1.0 KiB/ })).toHaveAttribute("data-state", "downloading");
    expect(screen.getByText("Start file")).toBeDisabled();
    view.rerender(tree(true, false));
    expect(screen.getByRole("complementary")).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "512");
    view.rerender(tree(true)); expect(screen.queryByRole("complementary")).toBeNull();
    view.rerender(tree(false)); expect(screen.getByRole("progressbar")).toHaveAttribute("value", "512");
    expect(client.start).toHaveBeenCalledOnce(); expect(client.cancel).not.toHaveBeenCalled(); expect(client.discard).not.toHaveBeenCalled();
  });
  it("keeps suppression until the last surface cleans up under StrictMode", async () => {
    const client = native();
    const tree = (first: boolean, second: boolean) => <StrictMode><FileDownloadProvider client={client}><Source />{first ? <Surface key="first" /> : null}{second ? <Surface key="second" /> : null}</FileDownloadProvider></StrictMode>;
    const view = render(tree(true, true));
    fireEvent.click(screen.getByText("Start file")); await screen.findAllByRole("img");
    expect(screen.queryByRole("complementary")).toBeNull();
    view.rerender(tree(false, true)); expect(screen.queryByRole("complementary")).toBeNull();
    view.rerender(tree(false, false)); expect(screen.getByRole("complementary")).toBeVisible();
    view.rerender(tree(true, true)); expect(screen.queryByRole("complementary")).toBeNull();
    view.rerender(tree(true, false)); expect(screen.queryByRole("complementary")).toBeNull();
    view.rerender(tree(false, false)); expect(screen.getByRole("complementary")).toBeVisible();
    expect(client.start).toHaveBeenCalledOnce(); expect(client.cancel).not.toHaveBeenCalled();
  });
  it("announces ready without opening a modal or moving focus, then keeps saving authoritative", async () => {
    const client = native(); client.poll.mockResolvedValue(snapshot("ready", { receivedBytes: 1024 }));
    const save = deferred<FileDownloadSnapshot>(); client.save.mockReturnValue(save.promise);
    render(<FileDownloadProvider client={client}><Source /><Surface /></FileDownloadProvider>);
    const start = screen.getByText("Start file"); start.focus(); fireEvent.click(start);
    expect(await screen.findByRole("img", { name: /Download complete — choose a save location/ })).toHaveClass("has-attention");
    expect(screen.getByRole("status")).toHaveTextContent("Download complete");
    expect(document.activeElement).toBe(start); expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.queryByRole("complementary")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^More/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Cancel download" })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save As…" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("img")).toHaveAttribute("data-state", "saving");
    expect(screen.getByRole("img")).not.toHaveAccessibleName(/Saved to the selected location/);
    await act(async () => save.resolve(snapshot("saved")));
    expect(screen.getByRole("img")).toHaveAccessibleName(/Saved to the selected location/);
    fireEvent.click(screen.getByRole("button", { name: /^More/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
    expect(client.save).toHaveBeenCalledWith("job"); expect(client.discard).toHaveBeenCalledWith("job");
  });
  it("has progress/cancel controls in details and preserves cancelled status and retry", async () => {
    const client = native(); client.start.mockResolvedValue(snapshot("downloading", { receivedBytes: 256 }));
    render(<FileDownloadProvider client={client}><Source /><Surface /></FileDownloadProvider>);
    fireEvent.click(screen.getByText("Start file")); await screen.findByRole("img");
    fireEvent.click(screen.getByRole("button", { name: /^More/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("progressbar", { name: "Download progress" })).toHaveAttribute("value", "256");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel download" }));
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("data-state", "cancelled"));
    expect(within(dialog).getByText("Cancelled — saving was not completed")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Download again" })).toBeEnabled();
    expect(within(dialog).queryByRole("button", { name: "Save As…" })).toBeNull();
    expect(client.cancel).toHaveBeenCalledWith("job");
  });
  it("does not turn system Save As cancellation into success in immersive mode", async () => {
    const client = native(); client.start.mockResolvedValue(snapshot("ready")); client.save.mockResolvedValue(snapshot("cancelled"));
    render(<FileDownloadProvider client={client}><Source /><Surface /></FileDownloadProvider>);
    fireEvent.click(screen.getByText("Start file")); await screen.findByRole("img");
    fireEvent.click(screen.getByRole("button", { name: /^More/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save As…" }));
    expect(await screen.findByRole("img", { name: /Cancelled — saving was not completed/ })).toHaveAttribute("data-state", "cancelled");
    expect(screen.queryByText("Saved to the selected location")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^More/ }));
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Download again" })).toBeEnabled();
  });
  it("keeps failed transfer errors and retry accessible through the badge and details", async () => {
    const client = native(); client.poll.mockResolvedValue(snapshot("failed", { error: { code: "integrity_failed", message: "native secret" } }));
    render(<FileDownloadProvider client={client}><Source /><Surface /></FileDownloadProvider>);
    fireEvent.click(screen.getByText("Start file"));
    expect(await screen.findByRole("img", { name: /File integrity verification failed/ })).toHaveAttribute("data-state", "failed");
    expect(screen.getByRole("alert")).toHaveTextContent("No file was delivered");
    expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.queryByRole("complementary")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^More/ }));
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("File integrity verification failed");
    expect(screen.queryByText("native secret")).toBeNull();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Download again" }));
    await waitFor(() => expect(client.start).toHaveBeenCalledTimes(2));
    expect(client.start).toHaveBeenLastCalledWith({ profileId: "host", sessionId: "session", path: "a.zip" });
  });
  it.each([
    ["save_failed_leftover", "failed", "target could not be removed"],
    ["partial_save", "failed", "incomplete file"],
    ["saved_cleanup_failed", "saved", "temporary copy could not be removed"],
  ] as const)("retains %s after the compact alert expires and cleanup fails", async (code, state, warning) => {
    vi.useFakeTimers();
    const client = native(); client.start.mockResolvedValue(snapshot("ready"));
    client.save.mockResolvedValue(snapshot(state, { error: { code, message: "native secret" } }));
    client.discard.mockRejectedValue({ code: "cleanup_failed" });
    render(<FileDownloadProvider client={client}><Source /><Surface /></FileDownloadProvider>);
    await act(async () => fireEvent.click(screen.getByText("Start file")));
    fireEvent.click(screen.getByRole("button", { name: /^More/ }));
    await act(async () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save As…" })));
    expect(screen.getByRole("alert")).toHaveTextContent(warning);
    expect(screen.getByRole("img")).toHaveAccessibleName(new RegExp(warning));
    expect(screen.queryByRole("complementary")).toBeNull(); expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("img")).toHaveAccessibleName(new RegExp(warning));
    fireEvent.click(screen.getByRole("button", { name: /^More/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent(warning);
    if (state === "saved") expect(within(dialog).queryByRole("button", { name: "Download again" })).toBeNull();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss" })));
    expect(within(dialog).getAllByRole("alert")).toHaveLength(2);
    expect(within(dialog).getByText(new RegExp(warning))).toBeVisible();
    expect(within(dialog).getByText(/Could not clean up temporary files/)).toBeVisible();
    expect(screen.getByRole("img")).toHaveAccessibleName(new RegExp(warning));
    expect(screen.getByRole("img")).toHaveAccessibleName(/Could not clean up temporary files/);
    expect(screen.queryByText("native secret")).toBeNull(); expect(client.start).toHaveBeenCalledOnce();
  });
  it("restores a critical warning in the large banner when the last immersive surface unmounts", async () => {
    const client = native(); client.start.mockResolvedValue(snapshot("failed", { error: { code: "save_failed_leftover", message: "" } }));
    const tree = (surface: boolean) => <FileDownloadProvider client={client}><Source />{surface ? <Surface /> : null}</FileDownloadProvider>;
    const view = render(tree(true)); fireEvent.click(screen.getByText("Start file"));
    await screen.findByRole("img", { name: /target could not be removed/ });
    view.rerender(tree(false));
    expect(within(screen.getByRole("complementary")).getByRole("alert")).toHaveTextContent("target could not be removed");
    expect(client.cancel).not.toHaveBeenCalled();
  });
});
