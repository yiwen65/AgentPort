// Real DOM-renderer regression. Uses an isolated Chrome profile and local output,
// never a RemoteClient or user Session. Run: node mobile/scripts/test-terminal-touch.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(resolve(tmpdir(), 'agentport-touch-'));
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
      const open = Terminal.prototype.open;
      Terminal.prototype.open = function(...args) { window.term = this; return open.apply(this, args); };
      window.input = [];
      createRoot(document.getElementById('root')).render(<article className="session-workspace"><MobileTerminal
        showHeading={false} showProbeOutput={false} onInput={data => window.input.push(data)} /></article>);
      window.ready = async () => {
        while (!window.term) await new Promise(r => setTimeout(r, 20));
        await new Promise(r => term.write(Array.from({length: 200}, (_, i) => 'log '+i+' hello 中文').join('\\r\\n'), r));
        await new Promise(r => setTimeout(r, 200));
        return true;
      };
    `, resolveDir: root, loader: 'tsx' },
    outfile: resolve(dir, 'fixture.js'), bundle: true, minify: true, jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  server = createServer(async (req, res) => {
    const name = req.url === '/fixture.js' ? 'fixture.js' : req.url === '/fixture.css' ? 'fixture.css' : null;
    res.setHeader('Content-Type', name?.endsWith('.js') ? 'text/javascript' : name ? 'text/css' : 'text/html');
    res.end(name ? await readFile(resolve(dir, name)) : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${dir}/profile`, 'about:blank',
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
  const touch = (type, x, y) => call('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await call('Emulation.setTouchEmulationEnabled', { enabled: true });
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` });
  for (let i = 0; i < 100 && !await evaluate('Boolean(window.ready)'); i++) await wait(30);
  await evaluate('ready()');
  const before = await evaluate('term.buffer.active.viewportY');
  await touch('touchStart', 100, 300);
  for (let y = 320; y <= 600; y += 20) { await touch('touchMove', 100, y); await wait(20); }
  await touch('touchEnd'); await wait(250);
  const after = await evaluate('term.buffer.active.viewportY');
  assert.ok(before - after >= 15, `Swipe lost after renderer replacement: ${before} -> ${after}`);
  await touch('touchStart', 100, 300); await wait(650);
  await touch('touchMove', 200, 340); await touch('touchEnd'); await wait(100);
  const selection = await evaluate('term.getSelection()');
  assert.ok(selection.includes('hello 中文') && selection.includes('\n'), `Missing multiline selection: ${selection}`);
  assert.deepEqual(await evaluate('input'), [], 'Reading gestures must never send terminal input');
  assert.equal(await evaluate('document.activeElement === term.textarea'), false);
  await evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied = text; } } }); `);
  await wait(100);
  const anchor = await evaluate(`(() => {
    const menu = document.querySelector('.mobile-terminal-selection').getBoundingClientRect();
    const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
    const row = term.getSelectionPosition().start.y - term.buffer.active.viewportY;
    return { gap: screen.top + row * screen.height / term.rows - menu.bottom, left: menu.left, right: menu.right };
  })()`);
  assert.ok(Math.abs(anchor.gap - 8) < 2, `Menu is not anchored above selection: ${JSON.stringify(anchor)}`);
  assert.ok(anchor.left >= 0 && anchor.right <= 390, 'Menu exceeds viewport');
  const copyRect = await evaluate(`document.querySelector('.mobile-terminal-selection button').getBoundingClientRect().toJSON()`);
  await touch('touchStart', copyRect.x + copyRect.width / 2, copyRect.y + copyRect.height / 2);
  await touch('touchEnd'); await wait(200);
  assert.equal(await evaluate('copied'), selection);
  assert.equal(await evaluate('term.getSelection()'), '');
  await touch('touchStart', 100, 300); await wait(650); await touch('touchEnd'); await wait(100);
  const clearRect = await evaluate(`Array.from(document.querySelectorAll('.mobile-terminal-selection button')).find(b => b.textContent === 'Clear').getBoundingClientRect().toJSON()`);
  await touch('touchStart', clearRect.x + clearRect.width / 2, clearRect.y + clearRect.height / 2);
  await touch('touchEnd'); await wait(100);
  assert.equal(await evaluate('term.getSelection()'), '');
  assert.equal(await evaluate(`Boolean(document.querySelector('.mobile-terminal-selection'))`), false);
  assert.deepEqual(await evaluate('input'), [], 'Menu actions must never send terminal input');
  assert.equal(await evaluate('document.activeElement === term.textarea'), false, 'Menu must not open the keyboard');
  // Alternate-buffer TUIs still receive xterm's wheel protocol, not local history scrolling.
  await evaluate(`new Promise(r => term.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h', r))`);
  await touch('touchStart', 100, 300); await touch('touchMove', 100, 350); await touch('touchEnd');
  assert.ok((await evaluate('input.join("")')).includes('\x1b[<64;'), 'Mouse-reporting wheel route lost');
  console.log(JSON.stringify({ scroll: { before, after }, selection, copied: true, mouseReporting: true }));
} finally {
  ws?.close();
  if (chrome?.pid && chrome.exitCode === null) {
    const exited = new Promise(r => chrome.once('exit', r));
    chrome.kill('SIGTERM'); await exited;
  }
  if (server) await new Promise(r => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
