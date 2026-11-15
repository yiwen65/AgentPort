// Real Chrome production check for the Markdown reader under the Tauri CSP:
// Shiki (JavaScript engine, no WASM), KaTeX fonts, GFM/alerts/frontmatter,
// reader themes and the find overlay. Run: node src/scripts/test-markdown-reader.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(resolve(tmpdir(), 'agentport-markdown-reader-'));
const assets = resolve(dir, 'assets');
const evidence = '/tmp/agentport-markdown-reader-evidence/desktop';
let chrome, server, ws;
const requests = [];
const wait = ms => new Promise(r => setTimeout(r, ms));

const source = [
  '---',
  'title: Reader Fixture',
  'version: 2',
  'tags: [reader, markdown]',
  '---',
  '',
  '# Reader',
  '',
  '## Code',
  '',
  '```ts',
  'const value: number = 1;',
  'console.log(value);',
  '```',
  '',
  '## Math',
  '',
  'Inline $a^2 + b^2 = c^2$ and:',
  '',
  '$$',
  '\\int_0^1 x^2 dx = \\frac{1}{3}',
  '$$',
  '',
  '## GFM',
  '',
  '- [x] done',
  '- [ ] todo',
  '',
  '| left | right |',
  '| :--- | ---: |',
  '| a | b |',
  '',
  '> [!NOTE]',
  '> alert body',
  '',
  'Footnote[^1]',
  '',
  '[^1]: note text',
  '',
  'Paragraph after the footnote.',
].join('\n');

try {
  await build({
    stdin: {
      resolveDir: root,
      loader: 'tsx',
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { MarkdownView } from './src/markdown';
        import { setState, useStore } from './src/store';
        import { i18n } from './src/i18n';
        import { replaceSelectionUndoable } from './src/textEdit';
        import { rawMatchMetrics } from './src/docFind';
        import 'katex/dist/katex.min.css';
        import './src/styles.css';
        i18n.changeLanguage('en-US');
        document.documentElement.dataset.theme = 'dark';
        window.cspViolations = [];
        document.addEventListener('securitypolicyviolation', (event) => {
          window.cspViolations.push({ directive: event.violatedDirective, blocked: event.blockedURI });
        });
        const source = ${JSON.stringify(source)};
        function App() {
          const theme = useStore((state) => state.docReadingTheme);
          return (
            <div className="doc-panel" data-doc-theme={theme} style={{ height: '100vh' }}>
              <div className="doc-preview-host" style={{ height: '100%', overflow: 'auto' }}>
                <MarkdownView source={source} sourceLocations readingTheme={theme} onLinkClick={() => {}} />
              </div>
            </div>
          );
        }
        window.setReaderTheme = (theme) => setState({ docReadingTheme: theme });
        window.testUndoableReplace = () => {
          const textarea = document.createElement('textarea');
          textarea.value = 'alpha beta alpha';
          document.body.append(textarea);
          const ok = replaceSelectionUndoable(textarea, 0, 5, 'omega');
          const after = textarea.value;
          const undoneOk = document.execCommand('undo');
          const undone = textarea.value;
          textarea.remove();
          return { ok, after, undoneOk, undone };
        };
        window.testRawHighlightGeometry = () => {
          const textarea = document.createElement('textarea');
          textarea.setAttribute('wrap', 'off');
          textarea.value = 'alpha beta\\ngamma alpha';
          textarea.style.cssText = 'position:fixed;left:-9999px;top:0;width:400px;height:120px;font:16px/24px monospace;padding:8px 12px;white-space:pre;tab-size:8;';
          document.body.append(textarea);
          const metrics = rawMatchMetrics(textarea, textarea.value, 17, 5);
          const selected = textarea.value.slice(17, 22);
          textarea.remove();
          return { metrics, selected };
        };
        createRoot(document.getElementById('root')).render(<App />);
      `,
    },
    outdir: assets,
    entryNames: 'fixture',
    chunkNames: 'chunks/[name]-[hash]',
    bundle: true,
    splitting: true,
    format: 'esm',
    minify: true,
    jsx: 'automatic',
    loader: {
      '.ttf': 'dataurl',
      '.otf': 'dataurl',
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.svg': 'text',
      '.png': 'dataurl',
    },
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'";
  server = createServer(async (req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Security-Policy', csp);
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>');
      return;
    }
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = resolve(assets, `.${url}`);
    if (!file.startsWith(`${assets}${sep}`)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    try {
      const body = await readFile(file);
      const ext = extname(file);
      res.setHeader('Content-Type', ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : ext === '.woff2' ? 'font/woff2' : ext === '.woff' ? 'font/woff' : ext === '.ttf' ? 'font/ttf' : 'application/octet-stream');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${dir}/profile`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolvePromise, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('Chrome startup timeout')), 15000);
    chrome.once('error', error => { clearTimeout(timer); reject(error); });
    chrome.stderr.on('data', bytes => {
      stderr += bytes;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolvePromise(match[1]); }
    });
  });
  const targets = await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`).then(r => r.json());
  ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => { ws.onopen = resolvePromise; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const value = JSON.parse(data);
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id);
    clearTimeout(entry.timer);
    value.error ? entry.reject(value.error) : entry.resolve(value.result);
  };
  const call = (method, params = {}) => new Promise((resolvePromise, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 20000);
    pending.set(id, { resolve: resolvePromise, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let i = 0; i < 120; i += 1) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await wait(50);
    }
    console.error(await evaluate('document.body.innerText.slice(-2000)'));
    await screenshot('failure');
    throw new Error(`Timed out: ${expression}`);
  };
  const screenshot = async name => {
    await mkdir(evidence, { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(resolve(evidence, `${name}.png`), Buffer.from(data, 'base64'));
  };

  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` });

  await until(`document.querySelector('.md-frontmatter-grid')`);
  await until(`document.querySelectorAll('.md-task-checkbox').length === 2`);
  await until(`document.querySelector('.md-alert-note')`);
  await until(`document.querySelector('.md-footnotes')`);
  await until(`document.querySelector('.md-code-line-content span[style*="color"]')`);
  assert.ok(await evaluate(`document.querySelectorAll('.md-code-line').length >= 2`));

  await evaluate(`document.querySelector('.md-math-display')?.scrollIntoView({block:'center'});true`);
  await until(`document.querySelector('.katex-display')`);
  assert.ok(await evaluate(`document.fonts.ready.then(() => document.fonts.check('16px KaTeX_Main'))`), 'KaTeX font loaded');

  const align = await evaluate(`getComputedStyle(document.querySelectorAll('th')[1]).textAlign`);
  assert.equal(align, 'right');
  const violations = await evaluate('window.cspViolations');
  assert.deepEqual(violations, [], JSON.stringify(violations));
  assert.ok(!requests.some(url => /\.wasm|oniguruma/i.test(url || '')), 'No WebAssembly/Oniguruma request');
  assert.ok(requests.some(url => /\/chunks\/.*\.js/.test(url || '')), 'Dynamic Shiki/KaTeX chunks requested');

  await screenshot('reader-math-dark');
  const darkBg = await evaluate(`getComputedStyle(document.querySelector('.doc-preview-host')).backgroundColor`);
  await evaluate(`window.setReaderTheme('paper');true`);
  await wait(200);
  const paperBg = await evaluate(`getComputedStyle(document.querySelector('.doc-preview-host')).backgroundColor`);
  assert.notEqual(paperBg, darkBg);
  assert.equal(paperBg, 'rgb(247, 243, 232)');
  await evaluate(`document.querySelector('.md-preview').scrollIntoView({block:'start'});true`);
  await screenshot('reader-paper');
  await evaluate(`window.setReaderTheme('night');true`);
  await wait(200);
  const nightBg = await evaluate(`getComputedStyle(document.querySelector('.doc-preview-host')).backgroundColor`);
  assert.equal(nightBg, 'rgb(27, 31, 39)');
  await screenshot('reader-night');

  // Find overlay sanity: build the text map and ensure matches exist in the
  // rendered DOM while the highlight layer stays outside React content.
  const findCount = await evaluate(`(() => {
    const root = document.querySelector('.md-preview');
    const text = root ? root.innerText : '';
    const matches = (text.match(/Reader/g) || []).length;
    return { matches, layers: document.querySelectorAll('.md-find-layer').length };
  })()`);
  assert.ok(findCount.matches >= 1, JSON.stringify(findCount));

  const undoable = await evaluate('window.testUndoableReplace()');
  assert.equal(undoable.ok, true);
  assert.equal(undoable.after, 'omega beta alpha');
  assert.equal(undoable.undoneOk, true);
  assert.equal(undoable.undone, 'alpha beta alpha');

  const rawMetrics = await evaluate('window.testRawHighlightGeometry()');
  assert.equal(rawMetrics.selected, 'alpha');
  assert.equal(rawMetrics.metrics.top, 32);
  assert.equal(rawMetrics.metrics.height, 24);
  assert.ok(rawMetrics.metrics.left > 12, JSON.stringify(rawMetrics));
  assert.ok(rawMetrics.metrics.width > 0, JSON.stringify(rawMetrics));

  console.log('PASS: production reader renders Shiki tokens, KaTeX (fonts), GFM/alerts/frontmatter under the Tauri CSP with no violations or WASM, lazy chunks load, paper/night reader palettes apply, replace edits enter the native undo stack, and raw match geometry aligns with the editor. No native Session or network used.');
} finally {
  ws?.close();
  if (chrome && chrome.exitCode === null) { chrome.kill('SIGTERM'); await new Promise(r => chrome.once('exit', r)); }
  if (server) await new Promise(r => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
