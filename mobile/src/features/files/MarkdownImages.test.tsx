import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import { FileContent } from "./FileContent";
import { createImageAsset, sanitizeImageSvg } from "./markdownImageAssets";
import { resolveImageSource, type MarkdownImageClient } from "../../protocol/markdownImageClient";
const data = { mime: "image/png", width: 1, height: 1, contentBase64: "aGVsbG8=" };
let serial = 0;
const revoke = vi.fn();
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); serial = 0; revoke.mockReset();
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.stubGlobal("URL", class extends URL { static createObjectURL() { return `blob:fixture-${++serial}`; } static revokeObjectURL = revoke; });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const client = (): MarkdownImageClient => ({ scope: "host:session", local: vi.fn().mockResolvedValue(data), remote: vi.fn().mockResolvedValue(data) });
const view = (content: string, imageClient: MarkdownImageClient) => <FileContent path="docs/readme.md" content={content} rendered onOpen={() => {}} imageClient={imageClient} />;

describe("Markdown images", () => {
  it("normalizes root-contained parent paths and rejects unsafe references", () => {
    expect(resolveImageSource("docs/readme.md", "../pictures/%E5%9B%BE%20one.png")).toEqual({ kind: "local", path: "pictures/图 one.png" });
    for (const source of ["../../outside.png", "/absolute.png", "file:///a", "data:image/png,xx", "http://example.com/a", "//example.com/a", "https://user:pass@example.com/a", "bad%00.png", "..\\secret.png"]) expect(resolveImageSource("docs/readme.md", source)).toBeNull();
  });
  it("loads inline and reference local images without remote requests", async () => {
    const images = client(); render(view('![Diagram](../pictures/one.png)\n\n![Referenced][photo]\n\n[photo]: <../pictures/图 one.png>', images));
    expect(await screen.findByRole("img", { name: "Diagram" })).toHaveAttribute("src", "blob:fixture-1");
    await screen.findByRole("img", { name: "Referenced" });
    expect(images.local).toHaveBeenCalledWith("pictures/one.png"); expect(images.local).toHaveBeenCalledWith("pictures/图 one.png"); expect(images.remote).not.toHaveBeenCalled();
  });
  it("requires one document consent and retains loaded local DOM while granting it", async () => {
    const images = client(); const { container } = render(view('![Local](./local.png)\n\n![Remote](https://example.com/photo.png)\n\n![Other](https://example.com/other.png)', images));
    const local = await screen.findByRole("img", { name: "Local" });
    expect(images.remote).not.toHaveBeenCalled(); expect(container.querySelectorAll("img")).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("button", { name: "Load external images in this document" })[0]);
    await screen.findByRole("img", { name: "Remote" }); await screen.findByRole("img", { name: "Other" });
    expect(screen.getByRole("img", { name: "Local" })).toBe(local); expect(images.local).toHaveBeenCalledTimes(1); expect(images.remote).toHaveBeenCalledTimes(2);
  });
  it("preserves consent and cached images through source/rendered switching", async () => {
    const images = client(); const content = '![Remote](https://example.com/photo.png)';
    const { rerender } = render(view(content, images));
    fireEvent.click(screen.getByRole("button", { name: "Load external images in this document" }));
    const image = await screen.findByRole("img"); const url = image.getAttribute("src");
    rerender(<FileContent path="docs/readme.md" content={content} rendered={false} imageClient={images} onOpen={() => {}} />);
    expect(revoke).not.toHaveBeenCalled(); expect(screen.queryByRole("img")).toBeNull();
    rerender(view(content, images)); expect(await screen.findByRole("img")).toHaveAttribute("src", url); expect(images.remote).toHaveBeenCalledTimes(1);
  });
  it("resets consent/cache on a new file and revokes resources on unmount", async () => {
    const images = client(); const { rerender, unmount } = render(view('![Remote](https://example.com/photo.png)', images));
    fireEvent.click(screen.getByRole("button", { name: "Load external images in this document" })); await screen.findByRole("img");
    rerender(<FileContent path="docs/new.md" content="![Remote](https://example.com/photo.png)" rendered imageClient={images} onOpen={() => {}} />);
    expect(screen.queryByRole("img")).toBeNull(); expect(revoke).toHaveBeenCalledWith("blob:fixture-1"); expect(images.remote).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Load external images in this document" })); await screen.findByRole("img"); unmount(); expect(revoke).toHaveBeenCalledWith("blob:fixture-2");
  });
  it("retries failures and gives the wrapped-image click to the viewer", async () => {
    const images = client(); vi.mocked(images.local).mockRejectedValueOnce({ code: "network" });
    render(view('[![Preview](./photo.png)](https://example.com/navigation)', images));
    await screen.findByText(/Image could not load/); fireEvent.click(screen.getByRole("button", { name: "Retry image" })); await screen.findByRole("img", { name: "Preview" });
    expect(screen.queryByRole("link")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "View Preview" }));
    const dialog = screen.getByRole("dialog", { name: "Preview" });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" })); expect(dialog.querySelector("img")?.style.transform).toContain("scale(1.5)");
    fireEvent.click(screen.getByRole("button", { name: "Fit to window" })); expect(dialog.querySelector("img")?.style.transform).toContain("scale(1)");
    fireEvent.keyDown(document, { key: "Escape" }); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); await waitFor(() => expect(screen.getByRole("button", { name: "View Preview" })).toHaveFocus());
  });
  it("does not attach obsolete images after teardown", async () => {
    const images = client(); let finish!: (value: typeof data) => void; vi.mocked(images.local).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { unmount } = render(view("![Local](one.png)", images)); await waitFor(() => expect(images.local).toHaveBeenCalled()); unmount();
    await act(async () => finish(data)); expect(serial).toBe(0);
  });
  it("bounds dimensions and scrubs SVG resources/CSS while preserving static text", () => {
    expect(() => createImageAsset({ ...data, width: 20_000_001 })).toThrow();
    const svg = sanitizeImageSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><script>x</script><foreignObject>x</foreignObject><image href="https://bad.example/a"/><a href="https://bad.example"><text>label</text></a><style>@import "https://bad.example/style";</style><path style="fill:u\\72l(remote.svg)"/><use href="https://bad.example/symbol"/></svg>', 10, 10);
    expect(svg).not.toMatch(/bad.example|script|foreignObject|<image|@import|u\\72l/); expect(svg).toContain("label"); expect(svg).toContain("width:10px!important");
    expect(() => sanitizeImageSvg('<svg xmlns="http://www.w3.org/2000/svg"><g id="a"><use href="#a"/></g></svg>')).toThrow();
    const chain = Array.from({ length: 100 }, (_, index) => `<g id="n${index}">${index ? `<use href="#n${index - 1}"/>` : "<path/>"}</g>`).join("");
    expect(() => sanitizeImageSvg(`<svg xmlns="http://www.w3.org/2000/svg">${chain}</svg>`)).toThrow();
  });
});
