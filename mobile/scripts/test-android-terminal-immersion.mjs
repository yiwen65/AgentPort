// Real Android system-bar regression at the route's native command seam.
// Open a debuggable AgentPort on an emulator, then run this script (adb on PATH).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const adb = process.env.ADB || 'adb';
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
assert.match(serial, /^emulator-\d+$/, 'Use an emulator, not a user phone');
const run = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8' });
assert.match(run('shell', 'dumpsys', 'package', 'com.agentport.mobile'), /\bDEBUGGABLE\b/);
const pid = run('shell', 'pidof', 'com.agentport.mobile').trim();
assert.match(pid, /^\d+$/, 'Open AgentPort first');
const port = run('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws, invoke;
try {
  // The debug socket appears before a cold-started WebView accepts requests.
  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()); }
    catch { /* Still starting. Read-only retry, no native mutation yet. */ }
    if (targets?.some(target => target.type === 'page' && /^https?:/.test(target.url))) break;
    await pause(100);
  }
  const target = targets?.find(target => target.type === 'page' && /^https?:/.test(target.url));
  assert.ok(target, 'No AgentPort WebView');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const result = JSON.parse(data), entry = pending.get(result.id);
    if (!entry) return;
    pending.delete(result.id); clearTimeout(entry.timer);
    result.error ? entry.reject(result.error) : entry.resolve(result.result);
  };
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  // Let the dashboard mount effects submit their initial native policy before
  // this test takes ownership of the same command seam.
  const ready = await call('Runtime.evaluate', {
    expression: `(async () => {
      for (let i = 0; i < 50 && !document.querySelector('.app-shell'); i++) await new Promise(r => setTimeout(r, 100));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return !!document.querySelector('.app-shell');
    })()`, awaitPromise: true, returnByValue: true,
  });
  assert.equal(ready.result?.value, true, 'App route did not mount');
  invoke = async immersive => {
    const result = await call('Runtime.evaluate', {
      expression: `window.__TAURI_INTERNALS__.invoke('mobile_set_terminal_immersive', { immersive: ${immersive} })`,
      awaitPromise: true, returnByValue: true,
    });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  };
  const bars = () => {
    // Modern Android may expose navigation as Taskbar instead of NavigationBar.
    const display = run('shell', 'dumpsys', 'window', 'displays');
    const source = type => display.match(new RegExp(`InsetsSource[^\\n]*type=${type}[^\\n]* visible=(true|false)`))?.[1];
    const status = source('statusBars'), navigation = source('navigationBars');
    if (status !== undefined && navigation !== undefined) return { status: status === 'true', navigation: navigation === 'true' };
    const windows = run('shell', 'dumpsys', 'window', 'windows').split(/\n  Window #\d+/);
    const visible = name => {
      const block = windows.find(block => new RegExp(`Window\\{[^}\\n]* ${name}\\}`).test(block));
      assert.ok(block, `Missing ${name} window`);
      const match = block.match(/\bisVisible=(true|false)/);
      assert.ok(match, `Missing ${name} visibility`);
      return match[1] === 'true';
    };
    return { status: visible('StatusBar'), navigation: visible('NavigationBar[0-9]*') };
  };
  const expectBars = async visible => {
    let actual;
    for (let i = 0; i < 40; i++) {
      actual = bars();
      if (actual.status === visible && actual.navigation === visible) break;
      await pause(100);
    }
    console.log({ expectedVisible: visible, ...actual });
    assert.deepEqual(actual, { status: visible, navigation: visible });
  };
  await invoke(false); await expectBars(true);
  // Both terminal and file routes submit true; repeated entry is idempotent.
  await invoke(true); await expectBars(false);
  await invoke(true); await expectBars(false);
  if (process.env.AGENTPORT_IMMERSION_SCREENSHOT) {
    await writeFile(process.env.AGENTPORT_IMMERSION_SCREENSHOT, execFileSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p']));
  }
  run('shell', 'input', 'keyevent', 'KEYCODE_HOME'); await pause(300);
  run('shell', 'am', 'start', '-n', 'com.agentport.mobile/.MainActivity'); await pause(500);
  await expectBars(false);
  await invoke(false); await expectBars(true);
  console.log('PASS: immersive entry/reentry, foreground restoration, dashboard exit');
} finally {
  if (ws?.readyState === WebSocket.OPEN) { if (invoke) await invoke(false).catch(() => undefined); ws.close(); }
  run('forward', '--remove', `tcp:${port}`);
}
