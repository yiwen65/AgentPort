import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { WebglAddon } from "@xterm/addon-webgl";
import { installWebglAtlasRepair } from "./webglAtlas";

function fixture() {
  const removed = new Set<() => void>();
  const atlas = {};
  const renderer = {
    _charAtlas: atlas,
    _glyphRenderer: { value: { setAtlas: vi.fn() } },
    _clearModel: vi.fn(),
    _updateModel: vi.fn((_start: number, _end: number) => undefined),
  };
  const terminal = { rows: 52, _core: { _renderService: { _renderer: { value: renderer } } } };
  const addon = { onRemoveTextureAtlasCanvas: (listener: () => void) => {
    removed.add(listener);
    return { dispose: () => removed.delete(listener) };
  } };
  const original = renderer._updateModel;
  const dispose = installWebglAtlasRepair(terminal as unknown as Terminal, addon as unknown as WebglAddon);
  return { renderer, original, dispose, removed, merge: () => removed.forEach(listener => listener()) };
}

describe("WebGL atlas pre-draw repair", () => {
  it("keeps ordinary row updates and cached textures untouched", () => {
    const f = fixture();
    f.renderer._updateModel(3, 5);
    expect(f.original.mock.calls).toEqual([[3, 5]]);
    expect(f.renderer._clearModel).not.toHaveBeenCalled();
    expect(f.renderer._glyphRenderer.value.setAtlas).not.toHaveBeenCalled();
  });

  it("repairs all rows and uploads after every merge, including a merge in the repair pass", () => {
    const f = fixture();
    f.original.mockImplementationOnce(() => { f.merge(); }).mockImplementationOnce(() => { f.merge(); });
    f.renderer._updateModel(3, 5);
    expect(f.original.mock.calls).toEqual([[3, 5], [0, 51], [0, 51]]);
    expect(f.renderer._clearModel.mock.calls).toEqual([[true], [true]]);
    expect(f.renderer._glyphRenderer.value.setAtlas.mock.calls).toEqual([[f.renderer._charAtlas], [f.renderer._charAtlas]]);
    f.renderer._updateModel(8, 8);
    expect(f.renderer._clearModel).toHaveBeenCalledTimes(2);
  });

  it("handles a shared-atlas merge before this terminal renders", () => {
    const f = fixture();
    f.merge();
    f.renderer._updateModel(12, 12);
    expect(f.original.mock.calls).toEqual([[12, 12], [0, 51]]);
    expect(f.renderer._glyphRenderer.value.setAtlas).toHaveBeenCalledWith(f.renderer._charAtlas);
  });

  it("uses the current atlas and glyph renderer after context restoration", () => {
    const f = fixture();
    const oldGlyph = f.renderer._glyphRenderer.value;
    const glyph = { setAtlas: vi.fn() };
    f.renderer._glyphRenderer.value = glyph;
    f.renderer._charAtlas = {};
    f.original.mockImplementationOnce(() => { f.merge(); });
    f.renderer._updateModel(0, 51);
    expect(oldGlyph.setAtlas).not.toHaveBeenCalled();
    expect(glyph.setAtlas).toHaveBeenCalledWith(f.renderer._charAtlas);
  });

  it("unsubscribes and restores the exact wrapped renderer on loss/disposal", () => {
    const f = fixture();
    f.dispose();
    f.dispose();
    expect(f.removed.size).toBe(0);
    expect(f.renderer._updateModel).toBe(f.original);
    f.merge();
    f.renderer._updateModel(0, 0);
    expect(f.renderer._clearModel).not.toHaveBeenCalled();
  });
});
