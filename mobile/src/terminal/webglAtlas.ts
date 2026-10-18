import type { Terminal } from "@xterm/xterm";
import type { WebglAddon } from "@xterm/addon-webgl";

/** xterm 5.5 / addon-webgl 0.18 compatibility seam; covered by the real-WebGL
 * regression. A merge can move glyphs DURING _updateModel, after earlier cells
 * copied their UVs. Page versions are also not unique across page identities,
 * so shifted/replaced canvases can incorrectly skip their GPU texture upload.
 * Repair both before GlyphRenderer.render submits the frame, not on a later
 * refresh (which fixes only the UVs) or by resizing the local/remote buffer. */
export function installWebglAtlasRepair(terminal: Terminal, addon: WebglAddon): () => void {
  type Atlas = object;
  const renderer = (terminal as unknown as {
    _core: { _renderService: { _renderer: { value: {
      _charAtlas: Atlas;
      _glyphRenderer: { value: { setAtlas(atlas: Atlas): void } };
      _clearModel(clearGlyphs: boolean): void;
      _updateModel(start: number, end: number): void;
    } } } };
  })._core._renderService._renderer.value;
  const updateModel = renderer._updateModel;
  let atlasMoved = false;
  // Implemented by 0.18, but omitted from its published .d.ts.
  const removed = (addon as WebglAddon & {
    onRemoveTextureAtlasCanvas: WebglAddon["onAddTextureAtlasCanvas"];
  }).onRemoveTextureAtlasCanvas(() => { atlasMoved = true; });
  renderer._updateModel = function(start, end) {
    updateModel.call(this, start, end);
    // A full rebuild can itself add glyphs from previously unchanged rows and
    // cause another merge. Reach a stable atlas before the first GPU draw.
    while (atlasMoved) {
      atlasMoved = false;
      this._clearModel(true);
      this._glyphRenderer.value.setAtlas(this._charAtlas);
      updateModel.call(this, 0, terminal.rows - 1);
    }
  };
  return () => {
    removed.dispose();
    renderer._updateModel = updateModel;
  };
}
