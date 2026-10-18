import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import type { RemoteClient, RemoteConnectionStateEvent } from "../../protocol/remoteClient";
import type { MarkdownImageClient, MarkdownImageData } from "../../protocol/markdownImageClient";
import type { OpenSession } from "../sessions/types";
import { SessionFiles } from "./SessionFiles";
import { FileDownloadProvider } from "./FileDownloads";
import type { FileDownloadClient } from "../../protocol/fileDownloadClient";
import { isImageFile } from "./SessionImage";

const open = { hostProfileId: "host", session: { id: "session", cwd: "/project" } } as OpenSession;
const data = { mime: "image/png", width: 2, height: 1, contentBase64: "YQ==" };
let serial = 0;
const revoke = vi.fn();
function setup() {
  let connection: (event: RemoteConnectionStateEvent) => void = () => {};
  const request = vi.fn().mockImplementation(async (_host, method, params) => method === "session.files.list"
    ? { rootPath: "/project", path: params.path, entries: params.path === "." ? [{ name: "images", path: "images", isDir: true }, { name: "README.md", path: "README.md", isDir: false }] : [{ name: "Photo.GIF", path: "images/Photo.GIF", isDir: false }], truncated: false }
    : { rootPath: "/project", path: params.path, content: "# Notes", sizeBytes: 7, truncated: false });
  const client = { request, listHostProfiles: async () => [{ id: "host", connectionState: "connected" }], onConnectionState: async (fn: typeof connection) => { connection = fn; return async () => {}; } } as unknown as RemoteClient;
  const images: MarkdownImageClient = { local: vi.fn().mockResolvedValue(data), remote: vi.fn() };
  const props = { open, client, imageClient: images, active: true, onBack: vi.fn() };
  return { props, images, request, emit: (state: RemoteConnectionStateEvent["state"]) => connection({ profileId: "host", state }) };
}
async function openImage() {
  fireEvent.click(await screen.findByRole("button", { name: "images Directory" }));
  fireEvent.click(await screen.findByRole("button", { name: "Photo.GIF File" }));
}
function control(label: string | RegExp) {
  if (!screen.queryByRole("button", { name: label })) fireEvent.click(screen.getByRole("button", { name: "Show file title and actions" }));
  return screen.getByRole("button", { name: label });
}
function more() { fireEvent.click(control(/^More file actions/)); return screen.getByRole("dialog"); }
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); serial = 0; revoke.mockReset();
  vi.stubGlobal("URL", class extends URL { static createObjectURL() { return `blob:file-${++serial}`; } static revokeObjectURL = revoke; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("file tree image viewing", () => {
  it("recognizes only the supported filename hints, including uppercase", () => {
    for (const path of ["a.PNG", "a.jpg", "a.JPEG", "a.webp", "a.gif", "a.svg"]) expect(isImageFile(path)).toBe(true);
    for (const path of ["a.svg.html", "a.avif", "a.heic", "a.png/README", "a"]) expect(isImageFile(path)).toBe(false);
  });
  it("opens directly through the local image pipeline and returns to the exact tree", async () => {
    const state = setup(); const view = render(<SessionFiles {...state.props} />);
    await openImage(); const image = await screen.findByRole("img", { name: "Photo.GIF" });
    expect(image).toHaveAttribute("src", "blob:file-1"); expect(screen.queryByRole("dialog")).toBeNull();
    expect(state.images.local).toHaveBeenCalledWith("images/Photo.GIF", { signal: expect.any(AbortSignal), animationLimits: true });
    expect(state.images.remote).not.toHaveBeenCalled(); expect(state.request.mock.calls.some(([, method]) => method === "session.files.read")).toBe(false);
    const tree = view.container.querySelector(".files-tree-scroll")!; tree.scrollTop = 180;
    expect(view.container.querySelector(".files-image-page")).not.toBeNull(); expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
    fireEvent.click(control("Zoom in")); expect(image.style.transform).toContain("scale(1.5)");
    fireEvent.doubleClick(image.parentElement!); expect(image.style.transform).toContain("scale(1)");
    fireEvent.touchStart(image.parentElement!, { touches: [{ clientX: 10, clientY: 200 }] });
    fireEvent.touchMove(image.parentElement!, { touches: [{ clientX: 300, clientY: 200 }] });
    fireEvent.touchEnd(image.parentElement!, { touches: [] });
    expect(view.container.querySelector(".files-page-viewport")).toHaveAttribute("data-preview-visible", "true");
    fireEvent.click(control("File tree"));
    expect(screen.queryByRole("img")).toBeNull(); expect(revoke).toHaveBeenCalledWith("blob:file-1");
    expect(view.container.querySelector(".files-tree-scroll")).toBe(tree); expect(tree.scrollTop).toBe(180);
    expect(screen.getByRole("button", { name: "images Directory" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Photo.GIF File" }));
    expect(await screen.findByRole("img")).toHaveStyle({ transform: "translate(0px, 0px) scale(1)" }); expect(state.images.local).toHaveBeenCalledTimes(2);
  });
  it("aborts a pending read on return and ignores its eventual result", async () => {
    const state = setup(); let finish!: (data: MarkdownImageData) => void;
    vi.mocked(state.images.local).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<SessionFiles {...state.props} />); await openImage();
    expect(screen.getByText("Loading image…")).toBeVisible(); fireEvent.click(control("File tree"));
    expect(vi.mocked(state.images.local).mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => finish(data)); expect(serial).toBe(0); expect(screen.queryByRole("img")).toBeNull();
  });
  it("releases on disconnect/background/deactivation and never silently retains playback", async () => {
    const state = setup(); const view = render(<SessionFiles {...state.props} />); await openImage(); await screen.findByRole("img");
    act(() => state.emit("disconnected")); expect(revoke).toHaveBeenCalledWith("blob:file-1"); expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(/Reconnect to view/)).toBeVisible(); act(() => state.emit("connected")); await screen.findByRole("img");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange")); expect(revoke).toHaveBeenCalledWith("blob:file-2"); expect(screen.queryByRole("img")).toBeNull();
    visibility.mockReturnValue("visible"); fireEvent(document, new Event("visibilitychange")); expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Photo.GIF File" })); await screen.findByRole("img");
    view.rerender(<SessionFiles {...state.props} active={false} />); expect(revoke).toHaveBeenCalledWith("blob:file-3"); expect(view.container.querySelector("img")).toBeNull();
  });
  it("gives budget/format failures a retry and keeps download independent", async () => {
    const state = setup(); vi.mocked(state.images.local).mockRejectedValueOnce({ code: "animation_limit" });
    const snapshot = { jobId: "job", name: "Photo.GIF", profileId: "host", sessionId: "session", path: "images/Photo.GIF", state: "downloading" as const, totalBytes: 10, receivedBytes: 0 };
    const download: FileDownloadClient = { available: () => true, start: vi.fn().mockResolvedValue(snapshot), poll: vi.fn().mockResolvedValue(snapshot), cancel: vi.fn().mockResolvedValue({ ...snapshot, state: "cancelled" }), discard: vi.fn().mockResolvedValue(undefined), save: vi.fn().mockResolvedValue({ ...snapshot, state: "saved" }) };
    render(<FileDownloadProvider client={download}><SessionFiles {...state.props} /></FileDownloadProvider>); await openImage();
    expect(await screen.findByRole("alert")).toHaveTextContent("frame or cumulative canvas budget");
    let menu = more(); expect(within(menu).queryByRole("button", { name: "Copy content" })).toBeNull();
    expect(within(menu).getByRole("button", { name: "Download file" })).toBeEnabled();
    fireEvent.click(within(menu).getByRole("button", { name: "Download file" }));
    await waitFor(() => expect(download.start).toHaveBeenCalledWith({ profileId: "host", sessionId: "session", path: "images/Photo.GIF" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry image" })); const image = await screen.findByRole("img", { name: "Photo.GIF" });
    menu = more(); fireEvent.click(within(menu).getByRole("button", { name: "Dark" }));
    expect(image.closest(".file-image-content")).toHaveAttribute("data-image-background", "dark");
    menu = more(); fireEvent.click(within(menu).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(state.images.local).toHaveBeenCalledTimes(3)); expect(revoke).toHaveBeenCalledWith("blob:file-1");
    expect(state.request.mock.calls.some(([, method]) => method === "session.files.read")).toBe(false);
  });
  it("reports browser decode failures without showing a broken image", async () => {
    const state = setup(); render(<SessionFiles {...state.props} />); await openImage();
    fireEvent.error(await screen.findByRole("img")); expect(await screen.findByRole("alert")).toHaveTextContent("unsupported or damaged"); expect(screen.queryByRole("img")).toBeNull();
  });
});
