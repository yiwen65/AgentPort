// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownView } from "../markdown";
import { applyUiLanguage } from "../i18n";
import { MarkdownImageSession, type ImageTransport } from "../markdownImages";
const image = { mime: "image/png", width: 2, height: 3, contentBase64: btoa("png") };
function session() {
  const transport: ImageTransport = { open: vi.fn(async () => ({ downloadId: "id", sizeBytes: 3, chunkBytes: 256 * 1024 })), chunk: vi.fn(async (_id, offset) => ({ offset, contentBase64: btoa("png"), eof: true })), finish: vi.fn(async () => ({})), close: vi.fn(async () => ({})), fetch: vi.fn(async () => image), validate: vi.fn(async () => image) };
  return { transport, images: new MarkdownImageSession({ path: "/p/read.md", rootPath: "/p", device: { kind: "local" } }, transport) };
}
beforeEach(async () => { await applyUiLanguage("en-US"); URL.createObjectURL = vi.fn(() => "blob:image"); URL.revokeObjectURL = vi.fn(); });
afterEach(cleanup);
it("uses one document consent action; no remote request on mount; consent loads all images", async () => {
  const { images, transport } = session();
  const view = render(<MarkdownView source="![one](https://example.com/one) ![two](https://example.com/two)" imageSession={images} />);
  await screen.findAllByText(/External image blocked/);
  expect(transport.fetch).not.toHaveBeenCalled();
  expect(screen.getAllByRole("button", { name: "Load external images for this document" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Load external images for this document" }));
  await waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2));
  await screen.findByRole("img", { name: "one" });
  view.unmount(); images.dispose();
});
it("image-wrapped links open zoom viewer, Escape closes and restores reading focus without navigation", async () => {
  const { images } = session(); const navigate = vi.fn();
  const view = render(<MarkdownView source="[![local](a.png)](https://example.com)" imageSession={images} onLinkClick={navigate} />);
  const opener = await screen.findByRole("button", { name: "View image: local" }); opener.focus();
  const reading = view.container.querySelector<HTMLElement>(".md-preview")!; reading.scrollTop = 83;
  fireEvent.click(opener);
  expect(screen.getByRole("dialog", { name: "local" }).parentElement).toBe(document.body);
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" })); expect(screen.getByRole("button", { name: "Reset zoom" }).textContent).toBe("125%");
  const stage = document.querySelector<HTMLElement>(".md-image-viewer-stage")!;
  fireEvent(stage, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 20 }));
  fireEvent(stage, new MouseEvent("pointermove", { bubbles: true, clientX: 30, clientY: 50 }));
  expect(stage.querySelector("img")?.style.transform).toContain("translate(20px, 30px)");
  fireEvent(stage, new MouseEvent("pointerup", { bubbles: true }));
  fireEvent.keyDown(window, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(opener); expect(reading.scrollTop).toBe(83); expect(navigate).not.toHaveBeenCalled();
  view.unmount(); images.dispose();
});
it("shows errors/retry and does not request an offscreen local asset until intersecting", async () => {
  let intersect!: (entries: Array<{ isIntersecting: boolean }>) => void;
  vi.stubGlobal("IntersectionObserver", class { constructor(cb: typeof intersect) { intersect = cb; } observe() {} disconnect() {} });
  const { images, transport } = session(); vi.mocked(transport.open).mockRejectedValueOnce(new Error("Disconnected"));
  const view = render(<MarkdownView source="![local](a.png)" imageSession={images} />);
  expect(transport.open).not.toHaveBeenCalled(); act(() => intersect([{ isIntersecting: true }]));
  await screen.findByRole("alert"); expect(screen.getByRole("alert").textContent).toContain("Disconnected");
  fireEvent.click(screen.getByRole("button", { name: "Retry" })); await screen.findByRole("img", { name: "local" }); expect(transport.open).toHaveBeenCalledTimes(2);
  view.unmount(); images.dispose(); vi.unstubAllGlobals();
});
