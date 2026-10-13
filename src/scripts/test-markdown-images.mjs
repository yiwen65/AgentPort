// Real Chrome production MarkdownView, ImageSession, sanitizer and viewer.
// Native transport/validation/DNS/TLS adapter mocked; no user Session or credentials.
// Run: node src/scripts/test-markdown-images.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(resolve(tmpdir(), 'agentport-desktop-images-'));
const evidence = '/tmp/agentport-markdown-images-evidence/desktop';
let chrome, server, ws;
const requests = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  await build({stdin:{contents:`
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {MarkdownView} from './src/markdown'; import {MarkdownImageSession} from './src/markdownImages';
    import {i18n} from './src/i18n'; import './src/styles.css';
    i18n.changeLanguage('en-US'); document.documentElement.dataset.theme='dark';
    window.imageCalls=[];window.imageBlobs=[];window.revokedImages=[];window.links=[];
    const create=URL.createObjectURL.bind(URL), revoke=URL.revokeObjectURL.bind(URL);
    URL.createObjectURL=blob=>{window.imageBlobs.push(blob);return create(blob)};
    URL.revokeObjectURL=url=>{window.revokedImages.push(url);revoke(url)};
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300"><script>window.imageExecuted=true</script><foreignObject><div>unsafe</div></foreignObject><image href="/image-secret.png"/><style>rect{fill:url(/image-paint.svg)}</style><rect width="600" height="300" fill="#4080c0"/><text x="30" y="150">Production static SVG</text></svg>';
    const svgData={mime:'image/svg+xml',width:600,height:300,contentBase64:btoa(svg)};
    const pngData={mime:'image/png',width:1,height:1,contentBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='};
    const streams=new Map();let failed=false;
    const transport={
      open:async(root,path)=>{window.imageCalls.push({kind:'local',root,path});if(path.endsWith('retry.svg')&&!failed){failed=true;throw new Error('fixture first failure')}const data=path.endsWith('.png')?pngData:svgData;streams.set(path,data);return {downloadId:path,sizeBytes:atob(data.contentBase64).length,chunkBytes:262144}},
      chunk:async(id,offset)=>({offset,contentBase64:streams.get(id).contentBase64,eof:true}),finish:async()=>{},close:async()=>{},validate:async contentBase64=>contentBase64===pngData.contentBase64?pngData:svgData,
      fetch:async url=>{window.imageCalls.push({kind:'remote',url});if(url.endsWith('late.svg'))await new Promise(r=>window.finishLate=r);return svgData}
    };
    const context={path:'/fixture/project/README.md',rootPath:'/fixture/project',device:{kind:'local'}};
    window.session=new MarkdownImageSession(context,transport);window.transport=transport;window.context=context;
    const source=${JSON.stringify("# Images\n\n![local SVG](images/local.svg)\n\n![reference PNG][pixel]\n\n[pixel]: images/pixel.png\n\n[![wrapped SVG](images/local.svg)](https://example.com/link)\n\n![retry SVG](images/retry.svg)\n\n![remote SVG](https://example.com/image.svg)\n\nReading paragraph 0 retains scroll.\n\nReading paragraph 1 retains scroll.\n\nReading paragraph 2 retains scroll.\n\nReading paragraph 3 retains scroll.\n\nReading paragraph 4 retains scroll.\n\nReading paragraph 5 retains scroll.\n\nReading paragraph 6 retains scroll.\n\nReading paragraph 7 retains scroll.\n\nReading paragraph 8 retains scroll.\n\nReading paragraph 9 retains scroll.\n\nReading paragraph 10 retains scroll.\n\nReading paragraph 11 retains scroll.\n\nReading paragraph 12 retains scroll.\n\nReading paragraph 13 retains scroll.\n\nReading paragraph 14 retains scroll.\n\nReading paragraph 15 retains scroll.\n\nReading paragraph 16 retains scroll.\n\nReading paragraph 17 retains scroll.\n\nReading paragraph 18 retains scroll.\n\nReading paragraph 19 retains scroll.\n\nReading paragraph 20 retains scroll.\n\nReading paragraph 21 retains scroll.\n\nReading paragraph 22 retains scroll.\n\nReading paragraph 23 retains scroll.\n\nReading paragraph 24 retains scroll.\n\nReading paragraph 25 retains scroll.\n\nReading paragraph 26 retains scroll.\n\nReading paragraph 27 retains scroll.\n\nReading paragraph 28 retains scroll.\n\nReading paragraph 29 retains scroll.")};
    const root=createRoot(document.getElementById('root'));
    window.renderDocument=(session=window.session)=>root.render(<MarkdownView source={source} imageSession={session} onLinkClick={href=>window.links.push(href)}/>);
    window.newDocument=()=>{window.session.dispose();window.session=new MarkdownImageSession({...context,path:'/fixture/project/SECOND.md'},transport);window.renderDocument()};
    window.checkLate=async()=>{const late=new MarkdownImageSession(context,transport);late.allowRemote();const loading=late.load('https://example.com/late.svg');while(!window.finishLate)await new Promise(r=>setTimeout(r,5));const before=window.imageBlobs.length;late.dispose();window.finishLate();await loading;return {before,after:window.imageBlobs.length,status:late.snapshot('https://example.com/late.svg').status}};
    window.renderDocument();
  `,resolveDir:root,loader:'tsx'},outfile:resolve(dir,'fixture.js'),bundle:true,minify:true,jsx:'automatic',loader:{'.ttf':'dataurl','.otf':'dataurl','.svg':'text','.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"'}});
  server = createServer(async(req,res)=>{
    requests.push(req.url);
    const name = req.url==='/fixture.js'?'fixture.js':req.url==='/fixture.css'?'fixture.css':null;
    res.setHeader('Content-Security-Policy', "img-src 'self' blob: data:; connect-src 'self'; object-src 'none'");
    res.setHeader('Content-Type',name?.endsWith('.js')?'text/javascript':name?'text/css':'text/html');
    res.end(name?await readFile(resolve(dir,name)):'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><style>#root{overflow:auto}</style><div id="root"></div><script src="fixture.js"></script>');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${dir}/profile`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  const endpoint = await new Promise((resolve,reject)=>{
    let stderr=''; const timer=setTimeout(()=>reject(new Error('Chrome startup timeout')),15000);
    chrome.once('error',error=>{clearTimeout(timer);reject(error)});
    chrome.stderr.on('data',bytes=>{stderr+=bytes;const match=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1])}});
  });
  const targets=await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`).then(r=>r.json());
  ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl); await new Promise(r=>{ws.onopen=r});
  let seq=0; const pending=new Map();
  ws.onmessage=({data})=>{const value=JSON.parse(data);const entry=pending.get(value.id);if(!entry)return;pending.delete(value.id);clearTimeout(entry.timer);value.error?entry.reject(value.error):entry.resolve(value.result)};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timeout'))},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value};
  const until=async expression=>{for(let i=0;i<100;i++){if(await evaluate(`Boolean(${expression})`))return;await wait(50)}console.error(await evaluate('document.body.innerText.slice(-2500)'));await screenshot('failure');throw new Error('Timed out: '+expression)};
  const click=async selector=>{
    if (/files-header|files-more-button/.test(selector) && await evaluate(`document.querySelector(${JSON.stringify(selector)})?.closest('.files-header')?.hidden`)) {
      const page=selector.includes('preview')?'.files-preview-page':'.files-tree-page';
      await click(page+' .files-chrome-reveal');
    }
    const box=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await call('Input.dispatchMouseEvent',{type:'mousePressed',...box,button:'left',clickCount:1});
    await call('Input.dispatchMouseEvent',{type:'mouseReleased',...box,button:'left',clickCount:1});await wait(80);
  };
  const clickText=async(selector,label)=>{
    const box=await evaluate(`(()=>{const e=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!e)throw new Error('missing action '+${JSON.stringify(label)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await call('Input.dispatchMouseEvent',{type:'mousePressed',...box,button:'left',clickCount:1});
    await call('Input.dispatchMouseEvent',{type:'mouseReleased',...box,button:'left',clickCount:1});await wait(100);
  };
  const touch=(type,x,y)=>call('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});
  const swipe=async(x,y,toX,toY)=>{await touch('touchStart',x,y);for(let i=1;i<=6;i++){await touch('touchMove',x+(toX-x)*i/6,y+(toY-y)*i/6);await wait(20)}await touch('touchEnd');await wait(300)};
  const settledScroll=async selector=>{
    let last=await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollLeft`),stable=0;
    for(let i=0;i<40;i++){await wait(50);const now=await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollLeft`);stable=now===last?stable+1:0;if(stable>=3)return now;last=now}throw new Error('Native horizontal momentum did not settle');
  };
  const screenshot=async name=>{if(!evidence)return;await mkdir(evidence,{recursive:true});const {data}=await call('Page.captureScreenshot',{format:'png'});await writeFile(resolve(evidence,name+'.png'),Buffer.from(data,'base64'))};

  await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:960,height:800,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});
  await until(`document.querySelector('img[alt="local SVG"]')?.naturalWidth>0`);
  assert.equal(await evaluate(`imageCalls.filter(c=>c.kind==='remote').length`),0);
  await click('.md-image-consent button');await until(`document.querySelector('img[alt="remote SVG"]')?.naturalWidth>0`);
  assert.equal(await evaluate(`imageCalls.filter(c=>c.kind==='remote').length`),1,'One grant loads current document');
  await click('.md-image-placeholder button');await until(`document.querySelector('img[alt="retry SVG"]')?.naturalWidth>0`);
  await until(`document.querySelector('img[alt="reference PNG"]')?.naturalWidth===1`);
  const geometry=await evaluate(`Array.from(document.querySelectorAll('.md-image-open img')).map(e=>({alt:e.alt,src:e.src,nw:e.naturalWidth,nh:e.naturalHeight,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height}))`);
  assert.ok(geometry.every(g=>g.src.startsWith('blob:')&&g.nw>0&&Math.abs(g.w/g.h-g.nw/g.nh)<0.01),JSON.stringify(geometry));
  assert.equal(await evaluate(`imageCalls.filter(c=>c.kind==='local'&&c.path==='images/local.svg').length`),1,'Inline/wrapped source shares document cache');
  await evaluate(`document.querySelector('img[alt="wrapped SVG"]').scrollIntoView({block:'center'});true`);await wait(100);
  const scroll=await evaluate(`document.getElementById('root').scrollTop`);
  assert.ok(scroll>0,'Viewer opens at a nonzero document reading position');
  await click('.md-image-open:has(img[alt="wrapped SVG"])');await until(`document.querySelector('.md-image-viewer-stage img')?.naturalWidth>0`);
  assert.deepEqual(await evaluate(`links`),[],'Wrapped image opens viewer, not outbound link');
  await click('[aria-label="Zoom in"]');
  const before=await evaluate(`document.querySelector('.md-image-viewer-stage img').style.transform`);
  await call('Input.dispatchMouseEvent',{type:'mousePressed',x:300,y:400,button:'left',clickCount:1});
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:380,y:440,button:'left',buttons:1});
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:380,y:440,button:'left',clickCount:1});await wait(100);
  assert.notEqual(await evaluate(`document.querySelector('.md-image-viewer-stage img').style.transform`),before);
  await screenshot('desktop-viewer-dark');await click('[aria-label="Close image viewer"]');await until(`!document.querySelector('.md-image-viewer')`);
  assert.equal(await evaluate(`document.getElementById('root').scrollTop`),scroll);assert.equal(await evaluate(`document.activeElement.className`),'md-image-open');
  const clean=await evaluate(`Promise.all(imageBlobs.filter(b=>b.type==='image/svg+xml').map(b=>b.text()))`);
  assert.ok(clean.length);assert.ok(clean.every(s=>!/<(?:script|foreignObject|image|style)\b|image-secret|image-paint/.test(s)),JSON.stringify(clean));
  assert.equal(await evaluate(`Boolean(window.imageExecuted)`),false);assert.ok(!requests.some(url=>/image-secret|image-paint/.test(url)));
  await evaluate(`document.getElementById('root').scrollTop=0;true`);await screenshot('desktop-images-dark');
  const late=await evaluate(`checkLate()`);assert.equal(late.after,late.before);assert.equal(late.status,'idle');
  const oldRemote=await evaluate(`imageCalls.filter(c=>c.kind==='remote').length`);const revoked=await evaluate(`revokedImages.length`);
  await evaluate(`newDocument();true`);await until(`document.querySelector('.md-image-consent') && document.querySelector('img[alt="local SVG"]')?.naturalWidth>0`);
  assert.equal(await evaluate(`imageCalls.filter(c=>c.kind==='remote').length`),oldRemote);assert.ok(await evaluate(`revokedImages.length`)>revoked);
  await call('Emulation.setDeviceMetricsOverride',{width:320,height:640,deviceScaleFactor:1,mobile:false});await evaluate(`document.documentElement.dataset.theme='light';document.getElementById('root').scrollTop=0;true`);await wait(200);
  assert.equal(await evaluate(`document.documentElement.scrollWidth>innerWidth || document.getElementById('root').scrollWidth>document.getElementById('root').clientWidth`),false,'No root/document horizontal overflow at 320px');
  await screenshot('desktop-images-light-narrow');
  console.log('PASS: production desktop MarkdownView/ImageSession blob SVG+PNG decoding, reference/wrapped images, consent per document, retry, aspect-fit, viewer zoom/drag, close scroll/focus, dispose revocation and late completion, static SVG scrub and no fixture image requests; dark/light narrow. Native transport/validation/DNS/TLS mocked, NOT native proof.');
} finally {
  ws?.close();if(chrome&&chrome.exitCode===null){chrome.kill('SIGTERM');await new Promise(r=>chrome.once('exit',r))}
  if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});
}
