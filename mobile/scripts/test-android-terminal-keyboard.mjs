// Native IME regression, using an isolated terminal (no Host or Session).
// Requires a running emulator with a debuggable AgentPort installed.
// Run: node mobile/scripts/test-android-terminal-keyboard.mjs [--immersive]
// Acknowledge Android's first-run fullscreen hint before the immersive check.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adb = process.env.ADB || 'adb';
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
assert.match(serial, /^emulator-\d+$/, 'Use an emulator, never a user phone');
const shell = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8' });
assert.match(shell('shell', 'dumpsys', 'package', 'com.agentport.mobile'), /\bDEBUGGABLE\b/, 'Install a debug APK first');
const pid = shell('shell', 'pidof', 'com.agentport.mobile').trim();
assert.match(pid, /^\d+$/, 'Open AgentPort before running this check');
const socket = `webview_devtools_remote_${pid}`;
assert.ok(shell('shell', 'cat', '/proc/net/unix').includes(`@${socket}\n`), 'AgentPort WebView debugging is unavailable');
const port = shell('forward', 'tcp:0', `localabstract:${socket}`).trim();
const dir = await mkdtemp(resolve(tmpdir(), 'agentport-android-ime-'));
let ws, originalUrl, call;
const pause = ms => new Promise(r => setTimeout(r, ms));
try {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
  const target = targets.find(t => t.type === 'page');
  assert.ok(target, 'No WebView page');
  originalUrl = target.url;
  if (/mInputShown=true/.test(shell('shell', 'dumpsys', 'input_method'))) {
    shell('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await pause(400);
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const result = JSON.parse(data);
    const entry = pending.get(result.id);
    if (!entry) return;
    pending.delete(result.id); clearTimeout(entry.timer);
    result.error ? entry.reject(result.error) : entry.resolve(result.result);
  };
  call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await build({
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {MobileTerminal} from './src/terminal/MobileTerminal';
      import './src/app/styles.css'; import './src/i18n';
      window.input = []; window.errors = [];
      window.addEventListener('error', event => window.errors.push(event.message));
      createRoot(document.getElementById('root')).render(<div className="app-shell"><div className="session-stage is-visible"><article className="session-workspace"><MobileTerminal
        showHeading={false} showProbeOutput={false} onInput={text => window.input.push(text)} /></article></div></div>);
    `, resolveDir: root, loader: 'tsx' },
    loader: { '.ttf': 'dataurl', '.otf': 'dataurl' }, bundle: true, jsx: 'automatic', target: 'chrome91',
    outfile: resolve(dir, 'fixture.js'),
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  });
  // Exercise IME insets with system bars hidden as well as the default mode.
  if (process.argv.includes('--immersive')) {
    await evaluate("window.__TAURI_INTERNALS__.invoke('mobile_set_terminal_immersive', { immersive: true })");
  }
  await call('Page.enable'); await call('Page.navigate', { url: 'about:blank' });
  await pause(300);
  await evaluate(`document.head.innerHTML='<meta name="viewport" content="width=device-width,initial-scale=1">';
    document.body.innerHTML='<div id="root"></div>';var style=document.createElement('style');
    style.textContent=${JSON.stringify(await readFile(resolve(dir, 'fixture.css'), 'utf8'))};document.head.append(style);`);
  await evaluate(await readFile(resolve(dir, 'fixture.js'), 'utf8'));
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const state = () => evaluate(`(() => {
    const button = document.querySelector('.mobile-terminal-show-keyboard');
    const keys = document.querySelector('.mobile-terminal-keys');
    return { height: visualViewport.height, dpr: devicePixelRatio, focused: document.activeElement?.className,
      rect: button.getBoundingClientRect().toJSON(), keys: keys.getBoundingClientRect().toJSON(),
      keysHidden: keys.hidden, keyboardHidden: button.hidden, input: window.input, errors: window.errors };
  })()`);
  const closed = await state();
  // Capture the native surface before tapping its measured DOM coordinates.
  await writeFile(resolve(dir, 'closed.png'), execFileSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p']));
  const tap = s => shell('shell', 'input', 'tap', String(Math.round((s.rect.x + s.rect.width / 2) * s.dpr)), String(Math.round((s.rect.y + s.rect.height / 2) * s.dpr)));
  const expectOpen = async () => {
    let opened;
    for (let i = 0; i < 50; i++) {
      await pause(100); opened = await state();
      if (closed.height - opened.height > 80 && !opened.keysHidden && opened.keyboardHidden && opened.keys.bottom <= opened.height + 1) break;
    }
    console.log(JSON.stringify({ closedHeight: closed.height, opened }, null, 2));
    const screenshot = execFileSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p']);
    await writeFile(resolve(dir, 'opened.png'), screenshot);
    if (process.env.AGENTPORT_TERMINAL_SCREENSHOT) await writeFile(process.env.AGENTPORT_TERMINAL_SCREENSHOT, screenshot);
    assert.match(opened.focused, /xterm-helper-textarea/);
    assert.match(shell('shell', 'dumpsys', 'input_method'), /mInputShown=true/,
      'Native IME is not visible; check fullscreen tutorial overlays or hardware keyboard configuration');
    assert.ok(closed.height - opened.height > 80, 'Native IME did not shrink the WebView viewport');
    assert.equal(opened.keysHidden, false);
    assert.ok(opened.keys.height >= 44 && opened.keys.bottom <= opened.height + 1, 'Shortcut row is covered by IME');
    assert.equal(opened.keyboardHidden, true);
    assert.deepEqual(opened.input, [], 'Opening IME sent terminal input');
    assert.deepEqual(opened.errors, [], 'Terminal fixture raised a runtime error');
  };
  tap(closed); await expectOpen();
  shell('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  let dismissed;
  for (let i = 0; i < 50; i++) {
    await pause(100); dismissed = await state();
    if (!dismissed.keyboardHidden && Math.abs(dismissed.height - closed.height) < 2) break;
  }
  assert.equal(dismissed.keyboardHidden, false, 'Entry did not return after IME dismissal');
  assert.ok(Math.abs(dismissed.height - closed.height) < 2, 'IME inset was not cleared');
  // Viewport resize precedes the native IME's hide animation; tap only once
  // the previously hidden entry has painted at its restored coordinates.
  await pause(400);
  tap(await state()); await expectOpen();
  console.log('PASS: native keyboard, shortcut row, dismissal and reopen');
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    if (/mInputShown=true/.test(shell('shell', 'dumpsys', 'input_method'))) shell('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    // Reloading the app restores its dashboard route and native chrome policy.
    if (originalUrl && call) await call('Page.navigate', { url: originalUrl }).catch(() => undefined);
    ws.close();
  }
  shell('forward', '--remove', `tcp:${port}`);
  await rm(dir, { recursive: true, force: true });
}
