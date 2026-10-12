// Real browser touch/layout integration with the production App and xterm.
// The RemoteClient is a deterministic fixture; no user Session or credentials.
// Run: node mobile/scripts/test-session-files.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(resolve(tmpdir(), 'agentport-files-'));
const evidence = process.env.AGENTPORT_FILES_SCREENSHOTS;
let chrome, server, ws;
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  await build({
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {App} from './src/app/App'; import {Terminal} from '@xterm/xterm';
      import {i18n} from './src/i18n'; import './src/app/styles.css';
      i18n.changeLanguage('en-US');
      const nativeOpen = Terminal.prototype.open;
      Terminal.prototype.open = function(...args) { window.term = this; return nativeOpen.apply(this,args); };
      const listeners = new Set(); window.calls = []; window.rootLoads = 0;
      const session = {id:'fixture-session',projectId:'p',presetId:'preset',title:'File browser fixture',cwd:'/fixture/project',lifecycle:'running',resumePrecision:'exact',adapterType:'pi',transport:'pty',permissionMode:'native',hostAlive:true,createdAt:'2026-10-12',updatedAt:'2026-10-12'};
      const emit = (eventType,payload={}) => listeners.forEach(fn=>fn({subscriptionId:'attachment',eventType,payload:{sessionId:session.id,...payload}}));
      const client = {
        listHostProfiles: async()=>[{id:'fixture-host',name:'Fixture Mac',connectionState:'connected'}],
        onConnectionState: async()=>async()=>{}, connect:async()=>{}, disconnect:async()=>{},
        subscribe:async(_host,_topics,listener)=>{listeners.add(listener);return async()=>listeners.delete(listener)},
        request: async(host,method,params)=>{
          window.calls.push({host,method,params});
          if(method==='project.list') return [{id:'p',name:'Project fixture',rootPath:session.cwd,pinned:false,sortOrder:0}];
          if(method==='session.list') return [session];
          if(method==='agent.preferences') return {revision:1,agentOrder:[],agentHidden:[]};
          if(method==='agent.supported') return [];
          if(method==='attention.poll') return {events:[]};
          if(method==='session.attach') {
            setTimeout(()=>{emit('output',{dataBase64:btoa(Array.from({length:100},(_,i)=>'terminal line '+i+' hello world').join('\\r\\n'))});emit('replay_done');},100);
            return {attachmentId:'attachment',sessionId:session.id,childAlive:true,runId:'run',runOrdinal:1,features:[]};
          }
          if(method==='session.control') return {accepted:true,terminalGeometry:{cols:params.cols,rows:params.rows,revision:1,sourceKind:'mobile'}};
          if(method==='session.files.list') {
            const entries = params.path==='.' ? [{name:'src',path:'src',isDir:true},{name:'README.md',path:'README.md',isDir:false},...Array.from({length:40},(_,i)=>({name:'document-'+String(i).padStart(2,'0')+'.txt',path:'document-'+i+'.txt',isDir:false}))] : [{name:'main.ts',path:'src/main.ts',isDir:false}];
            if(params.path==='.') window.rootLoads++;
            return {rootPath:session.cwd,path:params.path,entries,truncated:false};
          }
          if(method==='session.files.read') return {rootPath:session.cwd,path:params.path,content:params.path.endsWith('.md')?'# Project overview\\n\\nRead-only Markdown with a [source link](src/main.ts).\\n\\n![blocked image](https://invalid.example/image.png)':'const greeting = "'+ 'long line '.repeat(30) +'";\\nexport { greeting };',sizeBytes:400,truncated:false};
          return {};
        }
      };
      window.downloadCalls = []; window.downloadPolls = 0;
      const download = {jobId:'fixture-download',profileId:'fixture-host',sessionId:session.id,path:'README.md',name:'README.md',totalBytes:1048576,receivedBytes:262144,state:'downloading'};
      const downloadClient = {
        available:()=>true,
        start:async(source)=>{window.downloadCalls.push({method:'start',source});window.downloadPolls=0;download.state='downloading';return {...download}},
        poll:async()=>{if(++window.downloadPolls>=2){download.state='ready';download.receivedBytes=download.totalBytes}return {...download}},
        cancel:async()=>{download.state='cancelled';return {...download}},
        save:async()=>{window.downloadCalls.push({method:'save'});download.state='saved';return {...download}},
        discard:async()=>{window.downloadCalls.push({method:'discard'})},
      };
      createRoot(document.getElementById('root')).render(<App client={client} hostAuthClient={{}} downloadClient={downloadClient} />);
    `, resolveDir: root, loader: 'tsx' },
    loader: { '.ttf': 'dataurl', '.otf': 'dataurl', '.svg': 'text', '.png': 'dataurl' }, outfile: resolve(dir, 'fixture.js'), bundle: true,
    minify: true, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  });
  server = createServer(async(req,res)=>{
    const name = req.url==='/fixture.js'?'fixture.js':req.url==='/fixture.css'?'fixture.css':null;
    res.setHeader('Content-Type',name?.endsWith('.js')?'text/javascript':name?'text/css':'text/html');
    res.end(name?await readFile(resolve(dir,name)):'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
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
    const box=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await call('Input.dispatchMouseEvent',{type:'mousePressed',...box,button:'left',clickCount:1});
    await call('Input.dispatchMouseEvent',{type:'mouseReleased',...box,button:'left',clickCount:1});await wait(80);
  };
  const touch=(type,x,y)=>call('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});
  const swipe=async(x,y,toX,toY)=>{await touch('touchStart',x,y);for(let i=1;i<=6;i++){await touch('touchMove',x+(toX-x)*i/6,y+(toY-y)*i/6);await wait(20)}await touch('touchEnd');await wait(300)};
  const screenshot=async name=>{if(!evidence)return;await mkdir(evidence,{recursive:true});const {data}=await call('Page.captureScreenshot',{format:'png'});await writeFile(resolve(evidence,name+'.png'),Buffer.from(data,'base64'))};
  await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await call('Emulation.setTouchEmulationEnabled',{enabled:true});
  await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});
  await until(`Boolean(document.querySelector('[data-session-id="fixture-session"]'))`);
  await click('[data-session-id="fixture-session"]');await until(`Boolean(window.term?.element) && document.querySelector('.session-workspace')?.dataset.connectionState==='live'`);await wait(300);
  await evaluate(`window.originalTerminal=term;window.originalNode=term.element;term.scrollLines(-15);window.readingY=term.buffer.active.viewportY; true`);
  await swipe(290,300,90,302);await until(`document.querySelector('.app-shell').dataset.page==='files' && document.querySelector('.files-row')`);
  await screenshot('mobile-file-tree-dark');
  assert.equal(await evaluate(`document.querySelector('.session-stage').hasAttribute('inert')`),true);
  await click('.files-row');await until(`Array.from(document.querySelectorAll('.files-row')).some(e=>e.textContent.includes('main.ts'))`);
  await click('.files-list .files-list .files-row');await until(`Boolean(document.querySelector('.files-source'))`);
  await screenshot('mobile-code-preview');
  const rect=await evaluate(`(()=>{const r=document.querySelector('.files-source').getBoundingClientRect();return {y:r.y+25}})()`);
  await swipe(300,rect.y,80,rect.y);
  assert.ok(await evaluate(`document.querySelector('.files-source').scrollLeft`)>0,'Code must support native horizontal touch scroll');
  assert.equal(await evaluate(`document.querySelector('.app-shell').dataset.page`),'files');
  await click('.files-preview-page .files-header button');
  assert.equal(await evaluate(`document.querySelector('.files-row').getAttribute('aria-expanded')`),'true');
  // Reading/scrolling a tree must not navigate, and its position survives preview.
  await swipe(190,650,190,400);
  const scroll=await evaluate(`document.querySelector('.files-tree-scroll').scrollTop`);
  assert.ok(scroll>0,'Tree should scroll vertically');
  await wait(500);
  await evaluate(`document.querySelector('.files-tree-scroll').scrollTop=0`);
  await wait(100);
  await evaluate(`Array.from(document.querySelectorAll('.files-row')).find(e=>e.textContent.includes('README.md')).scrollIntoView({block:'center'}); true`);
  await wait(100);
  const readme=await evaluate(`Array.from(document.querySelectorAll('.files-row')).find(e=>e.textContent.includes('README.md')).getBoundingClientRect().y`);
  await touch('touchStart',180,readme+20);await touch('touchEnd');await until(`Boolean(document.querySelector('.files-markdown h1'))`);
  assert.equal(await evaluate(`document.querySelector('.files-markdown h1').textContent`),'Project overview');
  assert.equal(await evaluate(`document.querySelectorAll('.files-markdown img, .files-markdown iframe, .files-markdown script').length`),0);
  await screenshot('mobile-markdown-preview');
  await click('.files-preview-page .files-header button');
  await swipe(80,350,290,352);await until(`document.querySelector('.app-shell').dataset.page==='terminal'`);
  assert.equal(await evaluate(`term===originalTerminal && term.element===originalNode`),true,'Terminal must remain mounted');
  assert.equal(await evaluate(`term.buffer.active.viewportY`),await evaluate('readingY'),'Return must retain terminal reading position');
  assert.equal(await evaluate(`calls.filter(c=>c.method==='session.attach').length`),1);
  assert.equal(await evaluate(`calls.filter(c=>c.method==='session.detach').length`),0);
  await swipe(290,300,90,302);await until(`rootLoads>=2`);
  assert.equal(await evaluate(`document.querySelector('.files-row').getAttribute('aria-expanded')`),'true');
  // Narrow/light and landscape renders cover long paths and controls, not OS keyboard behavior.
  await click('.files-tree-page .files-header button');
  await swipe(80,300,290,300);await until(`document.querySelector('.app-shell').dataset.page==='list'`);
  await wait(250);
  await click('[aria-label="Settings"]');
  await until(`Boolean(document.querySelector('[aria-labelledby="interface-mode-label"]'))`);
  await click('[aria-labelledby="interface-mode-label"] label:has(input[value="light"])');
  assert.equal(await evaluate(`document.documentElement.dataset.appTheme`),'light');
  await click('[aria-label="Close"]');
  await wait(250);
  await swipe(290,300,80,300);await until(`document.querySelector('.app-shell').dataset.page==='terminal'`);
  await click('.terminal-chrome-reveal');await click('.session-workspace-header [aria-label="Project files"]');
  await until(`document.querySelector('.app-shell').dataset.page==='files'`);
  await call('Emulation.setDeviceMetricsOverride',{width:320,height:640,deviceScaleFactor:1,mobile:true});await wait(150);await screenshot('mobile-file-tree-light-narrow');
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,'No root horizontal overflow');
  await call('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:1,mobile:true});await wait(150);await screenshot('mobile-file-tree-landscape');
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate(`document.querySelector('[aria-label="File actions for README.md"]').scrollIntoView({block:'center'});true`);
  await wait(100);
  await click('[aria-label="File actions for README.md"]');
  await until(`Boolean(document.querySelector('.files-operation-button'))`);
  await screenshot('download-file-actions');
  await click('.files-operation-button');
  await until(`Boolean(document.querySelector('.file-download-banner'))`);
  await screenshot('download-progress');
  await click('.files-tree-page .files-header button');
  assert.equal(await evaluate(`document.querySelector('.app-shell').dataset.page`),'terminal');
  assert.equal(await evaluate(`document.querySelector('.file-download-banner').textContent.includes('README.md')`),true);
  await until(`Array.from(document.querySelectorAll('.file-download-controls button')).some(e=>e.textContent==='Save As…')`);
  await screenshot('download-ready-terminal');
  await click('.file-download-controls button');
  await until(`document.querySelector('.file-download-banner').textContent.includes('Saved to the selected location')`);
  assert.equal(await evaluate(`downloadCalls.filter(c=>c.method==='start').length`),1);
  assert.equal(await evaluate(`calls.filter(c=>c.method==='session.detach').length`),0);
  console.log('PASS: real App/xterm touch navigation, native code pan, tree scroll/expansion, Markdown safety, retained terminal, download actions/progress across pages and light/narrow/landscape renders. Fixture transport/exporter; NOT native save or device proof.');
} finally {
  ws?.close(); if(chrome && chrome.exitCode===null){chrome.kill('SIGTERM');await new Promise(r=>chrome.once('exit',r))}
  if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});
}
