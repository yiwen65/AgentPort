// Real WebGL atlas regression at phone DPR. No RemoteClient or user Session.
// Run: node mobile/scripts/test-terminal-webgl.mjs (requires local Chrome).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(resolve(tmpdir(), 'agentport-webgl-'));
let chrome, server, ws;
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  await build({
    stdin: { contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {Terminal} from '@xterm/xterm';
      import {MobileTerminal} from './src/terminal/MobileTerminal';
      import './src/app/styles.css';
      import './src/i18n';
      const open = Terminal.prototype.open;
      Terminal.prototype.open = function(...args) { window.term = this; return open.apply(this, args); };
      window.input = [];
      window.sizes = [];
      function Fixture() {
        return <div className="app-shell"><div className="session-stage is-visible"><article className="session-workspace"><MobileTerminal
          showHeading={false} showProbeOutput={false} onInput={data => window.input.push(data)}
          onResize={(cols, rows) => window.sizes.push({cols, rows})} /></article></div></div>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
      window.ready = async () => {
        while (!window.term) await new Promise(r => setTimeout(r, 20));
        await new Promise(r => term.write(Array.from({length: 200}, (_, i) => 'log '+i+' hello 中文').join('\\r\\n'), r));
        await new Promise(r => setTimeout(r, 200));
        return true;
      };
    `, resolveDir: root, loader: 'tsx' },
    loader: { '.ttf': 'dataurl', '.otf': 'dataurl' },
    outfile: resolve(dir, 'fixture.js'), bundle: true, minify: true, jsx: 'automatic',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  server = createServer(async (req, res) => {
    const name = req.url === '/fixture.js' ? 'fixture.js' : req.url === '/fixture.css' ? 'fixture.css' : null;
    res.setHeader('Content-Type', name?.endsWith('.js') ? 'text/javascript' : name ? 'text/css' : 'text/html');
    res.end(name ? await readFile(resolve(dir, name)) : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--force-device-scale-factor=3', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${dir}/profile`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('Chrome startup timeout')), 15000);
    chrome.once('error', error => { clearTimeout(timer); reject(error); });
    chrome.stderr.on('data', bytes => {
      stderr += bytes;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const targets = await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`).then(r => r.json());
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const value = JSON.parse(data);
    if (!value.id) return;
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id); clearTimeout(entry.timer);
    value.error ? entry.reject(value.error) : entry.resolve(value.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call('Page.enable');
  const portraitMetrics = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } };
  await call('Emulation.setDeviceMetricsOverride', portraitMetrics);
  await call('Emulation.setTouchEmulationEnabled', { enabled: true });
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` });
  for (let i = 0; i < 100 && !await evaluate('Boolean(window.ready)'); i++) await wait(30);
  await evaluate('ready()');

  const geometry = await evaluate(`(() => {
    term.options.cursorBlink = false;
    window.renderer = term._core._renderService._renderer.value;
    if (!renderer._glyphRenderer) throw new Error('WebGL renderer is required');
    window.audit = { staleTextures: 0, staleCells: 0, merges: 0, frames: 0, examples: [] };
    const glyph = renderer._glyphRenderer.value;
    const uploaded = new Map();
    const cells = new Map();
    const bind = glyph._bindAtlasPageTexture;
    glyph._bindAtlasPageTexture = function(gl, atlas, i) {
      const result = bind.call(this, gl, atlas, i);
      uploaded.set(i, atlas.pages[i].canvas);
      return result;
    };
    const update = glyph.updateCell;
    glyph.updateCell = function(x, y, code, bg, fg, ext, chars, width, lastBg) {
      const result = update.apply(this, arguments);
      if (code && width) cells.set(y * term.cols + x, this._atlas.getRasterizedGlyph(code, bg, fg, ext, false));
      else cells.delete(y * term.cols + x);
      return result;
    };
    const paint = glyph.render;
    glyph.render = function(model) {
      const result = paint.call(this, model);
      audit.frames++;
      this._atlas.pages.forEach((page, i) => {
        if (uploaded.get(i) !== page.canvas) {
          audit.staleTextures++;
          if (audit.examples.length < 5) audit.examples.push({ kind:'texture', i, version:page.version });
        }
      });
      for (const [index, g] of cells) {
        const v = this._vertices.attributes;
        if (v[index*11 + 4] !== g.texturePage
          || Math.abs(v[index*11 + 5] - g.texturePositionClipSpace.x) > 1e-6
          || Math.abs(v[index*11 + 6] - g.texturePositionClipSpace.y) > 1e-6
          || Math.abs(v[index*11 + 7] - g.sizeClipSpace.x) > 1e-6
          || Math.abs(v[index*11 + 8] - g.sizeClipSpace.y) > 1e-6) {
          audit.staleCells++;
          if (audit.examples.length < 5) audit.examples.push({ kind:'cell', index, page:v[index*11+4], expectedPage:g.texturePage, y:v[index*11+6], expectedY:g.texturePositionClipSpace.y });
        }
      }
      return result;
    };
    renderer.onRemoveTextureAtlasCanvas(() => audit.merges++);
    renderer._refreshCharAtlas();
    return {cols:term.cols, rows:term.rows, maxPages:renderer._charAtlas.constructor.maxAtlasPages};
  })()`);
  assert.ok(geometry.maxPages >= 4 && geometry.maxPages <= 32, 'Unexpected WebGL texture-unit budget');
  const initialSizes = await evaluate('sizes.length');
  for (let batch = 0; batch < 12; batch++) {
    const result = await evaluate(`(async () => {
      const batch = ${batch};
      const text = '\\x1b[?2026h\\x1b[H' + Array.from({length:term.rows-1}, (_, y) =>
        Array.from({length:Math.floor(term.cols/2)}, (_, x) => String.fromCodePoint(0x4e00 + (batch*1500+y*30+x)%20000)).join('')
      ).join('\\r\\n') + '\\x1b[?2026l';
      await new Promise(r => term.write(text, r));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {...audit, pages:renderer._charAtlas.pages.map(p => ({width:p.canvas.width,version:p.version}))};
    })()`);
    assert.equal(result.staleTextures, 0, `Batch ${batch}: atlas canvas changed without GPU upload: ${JSON.stringify(result)}`);
    assert.equal(result.staleCells, 0, `Batch ${batch}: stale glyph UVs submitted to GPU: ${JSON.stringify(result)}`);
  }
  assert.ok(await evaluate('audit.merges') >= 12, 'Workload did not exercise repeated atlas merges');
  // Hold and release a single-row content update under DEC 2026. The unit
  // regression separately covers a partial-model pass that triggers a merge.
  const frames = await evaluate('audit.frames');
  await evaluate(`new Promise(r => term.write('\\x1b[?2026h\\x1b[H局部更新中文 glyphs', r))`);
  await wait(80);
  assert.equal(await evaluate('audit.frames'), frames, 'Synchronized output painted before its end marker');
  await evaluate(`new Promise(r => term.write('\\x1b[?2026l', r))`);
  await wait(80);
  assert.equal(await evaluate('audit.staleTextures + audit.staleCells'), 0);
  assert.equal(await evaluate('sizes.length'), initialSizes, 'Atlas repair must not publish remote resize');
  assert.deepEqual(await evaluate('input'), [], 'Atlas repair must not send terminal input');
  const before = await call('Page.captureScreenshot', {format:'png'});
  if (process.env.AGENTPORT_TERMINAL_SCREENSHOT) {
    await writeFile(process.env.AGENTPORT_TERMINAL_SCREENSHOT, Buffer.from(before.data, 'base64'));
  }
  // Resizing used to be the only cure: a healthy renderer must already have
  // identical pixels, without changing a single cell in xterm's buffer.
  await evaluate(`(async () => {
    renderer.handleResize(term.cols, term.rows); term.refresh(0, term.rows-1);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  })()`);
  const after = await call('Page.captureScreenshot', {format:'png'});
  assert.ok(before.data === after.data, 'Same-grid resize changed pixels: the pre-resize frame was not correct');
  console.log('PASS: WebGL atlas merges, GPU uploads/UVs, synchronized redraw, resize-free pixel equality', {geometry, ...await evaluate('({merges:audit.merges,frames:audit.frames})')});
} finally {
  ws?.close();
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise(r => chrome.once('exit', r));
    chrome.kill('SIGTERM');
    await exited;
  }
  server?.closeAllConnections();
  if (server) await new Promise(r => server.close(r));
  await rm(dir, {recursive:true,force:true,maxRetries:5});
}
