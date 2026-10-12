// Real Chrome + production MobileTerminal fixture; no SSH credentials or user sessions.
// Run: AGENTPORT_TERMINAL_SCREENSHOTS=/tmp/terminal-evidence node mobile/scripts/test-generic-terminal.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(resolve(tmpdir(), 'agentport-generic-terminal-'));
const evidence = process.env.AGENTPORT_TERMINAL_SCREENSHOTS;
let chrome, server, ws;
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  await build({
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {GenericTerminalWorkspace} from './src/features/generic-terminal/GenericTerminal';
      import {HostManager} from './src/features/hosts-auth/HostManager';
      import {useApplyAppAppearance,useAppAppearance} from './src/app/appAppearance';
      import {useMobileTerminalAppearance} from './src/terminal/terminalAppearance';
      function Appearance({children}){useApplyAppAppearance();const [,app]=useAppAppearance();const [,terminal]=useMobileTerminalAppearance();window.changeFixtureTheme=mode=>{app(mode);terminal({mode})};return children}
      import {Terminal} from '@xterm/xterm'; import {i18n} from './src/i18n'; import './src/app/styles.css';
      i18n.changeLanguage('en-US');
      const open=Terminal.prototype.open;Terminal.prototype.open=function(...args){window.term=this;return open.apply(this,args)};
      window.calls=[];window.connections=new Map();window.moshFails=true;window.didClose=false;
      window.records=[{id:'first',profileId:'fixture',name:'Persistent work',tmuxSession:'agentport_mobile_fixture_first',createdAt:'1'}];
      let ordinal=0;
      const client={
        list:async profileId=>{calls.push(['list',profileId]);return [...records]},
        create:async request=>{calls.push(['create',request]);const r={id:'new-'+ ++ordinal,profileId:request.profileId,name:request.name,tmuxSession:'agentport_mobile_fixture_'+ordinal,createdAt:'2'};records.push(r);return r},
        connect:async request=>{calls.push(['connect',request]);if(request.transport==='mosh'&&moshFails)throw {code:'mosh_start_failed',message:'Fixture UDP unavailable'};const connectionId='connection-'+ ++ordinal;connections.set(connectionId,{running:true,chunks:[Array.from(new TextEncoder().encode('\\x1b[2J\\x1b[HConnected to tmux\\r\\n中文 terminal\\r\\n$ '))]});return {connectionId}},
        input:async request=>{calls.push(['input',request]);connections.get(request.connectionId).chunks.push(Array.from(new TextEncoder().encode(request.data)))},
        resize:async request=>{calls.push(['resize',request])},
        poll:async id=>{const c=connections.get(id);if(!c)throw {code:'terminal_disconnected'};return {data:c.chunks.shift()||[],running:c.running}},
        disconnect:async id=>{calls.push(['disconnect',id]);connections.delete(id)},
        end:async id=>{calls.push(['end',id]);records=records.filter(r=>r.id!==id)}
      };
      const reactRoot=createRoot(document.getElementById('root'));
      reactRoot.render(<Appearance><GenericTerminalWorkspace profileId='fixture' hostName='Ordinary Linux — no AgentPort' client={client} authClient={{}} onClose={()=>{window.didClose=true}}/></Appearance>);
      const profile={id:'fixture',name:'Ordinary Linux',hostname:'fixture.invalid',port:22,username:'test',preferredTransport:'ssh',authentication:'password',credentialId:'cred_fixture',enabled:true,sortOrder:0};
      window.showHostManager=()=>reactRoot.render(<Appearance><HostManager remoteClient={{listHostProfiles:async()=>[{...profile,connectionState:'disconnected'},{...profile,id:'jump',name:'Bastion',connectionState:'disconnected'},{...profile,id:'relay',name:'Relay',preferredTransport:'relay',connectionState:'disconnected'}],onConnectionState:async()=>async()=>{}}} authClient={{getProfile:async()=>profile,saveProfile:async p=>{window.savedProfile=p;return {...p,id:'fixture'}}}} onOpenTerminal={()=>{}}/></Appearance>);
    `, resolveDir: root, loader: 'tsx' },
    loader: { '.ttf': 'dataurl', '.otf': 'dataurl', '.svg': 'text', '.png': 'dataurl' }, outfile: resolve(dir, 'fixture.js'), bundle: true,
    minify: true, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  });
  server=createServer(async(req,res)=>{
    const name=req.url==='/fixture.js'?'fixture.js':req.url==='/fixture.css'?'fixture.css':null;
    res.setHeader('Content-Type',name?.endsWith('.js')?'text/javascript':name?'text/css':'text/html');
    res.end(name?await readFile(resolve(dir,name)):'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  chrome=spawn(process.env.CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${dir}/profile`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  const endpoint=await new Promise((resolve,reject)=>{
    let stderr='';const timer=setTimeout(()=>reject(new Error('Chrome startup timeout')),15000);
    chrome.once('error',error=>{clearTimeout(timer);reject(error)});
    chrome.stderr.on('data',bytes=>{stderr+=bytes;const m=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1])}});
  });
  const targets=await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`).then(r=>r.json());
  ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(r=>{ws.onopen=r});
  let seq=0;const pending=new Map();
  ws.onmessage=({data})=>{const value=JSON.parse(data);const entry=pending.get(value.id);if(!entry)return;pending.delete(value.id);clearTimeout(entry.timer);value.error?entry.reject(value.error):entry.resolve(value.result)};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timeout'))},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value};
  const screenshot=async name=>{if(!evidence)return;await mkdir(evidence,{recursive:true});const {data}=await call('Page.captureScreenshot',{format:'png'});await writeFile(resolve(evidence,name+'.png'),Buffer.from(data,'base64'))};
  const until=async expression=>{for(let i=0;i<100;i++){if(await evaluate(`Boolean(${expression})`))return;await wait(50)}console.error(await evaluate('document.body.innerText'));await screenshot('failure');throw new Error('Timed out: '+expression)};
  const click=async selector=>{
    const box=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('missing selector');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await call('Input.dispatchMouseEvent',{type:'mousePressed',...box,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',...box,button:'left',clickCount:1});await wait(80);
  };
  const select=async value=>evaluate(`(()=>{const e=document.querySelector('.generic-terminal-transport');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));return e.value})()`);
  await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});
  await until(`document.querySelector('[data-terminal-id="first"]')`);
  await screenshot('records-dark');
  await click('[data-terminal-id="first"] button');await until(`document.querySelector('.generic-terminal-status')?.textContent.toLowerCase().includes('connected')`);
  await until(`term.buffer.active.getLine(1)?.translateToString().includes('中文')`);
  assert.equal(await evaluate(`calls.some(c=>c[0]==='create')`),false,'Restore must not create a session');
  assert.ok(await evaluate(`calls.filter(c=>c[0]==='resize').length`)>0,'Real xterm geometry must reach native adapter');
  await evaluate(`term.input('printf hello\\r');true`);await until(`calls.some(c=>c[0]==='input'&&c[1].data==='printf hello\\r')`);
  await screenshot('ssh-terminal-dark');
  await click('.generic-terminal-close');await until(`document.querySelector('.generic-terminal-list')&&calls.some(c=>c[0]==='disconnect')`);
  assert.equal(await evaluate(`records.length`),1);assert.equal(await evaluate(`calls.some(c=>c[0]==='end')`),false,'Close must detach, not end');
  await select('mosh');await click('[data-terminal-id="first"] button');await until(`document.querySelector('.generic-terminal-fallback')`);await screenshot('mosh-explicit-fallback');
  const count=await evaluate(`calls.filter(c=>c[0]==='connect').length`);await wait(200);assert.equal(await evaluate(`calls.filter(c=>c[0]==='connect').length`),count,'Must not silently fall back');
  await click('.generic-terminal-fallback');await until(`document.querySelector('.generic-terminal-status')?.textContent.toLowerCase().includes('connected')`);
  assert.equal(await evaluate(`calls.filter(c=>c[0]==='connect').at(-1)[1].terminalId`),'first');assert.equal(await evaluate(`calls.filter(c=>c[0]==='connect').at(-1)[1].transport`),'ssh');
  await call('Emulation.setDeviceMetricsOverride',{width:320,height:568,deviceScaleFactor:1,mobile:true});await wait(200);
  assert.ok(await evaluate(`document.documentElement.scrollWidth<=320`),'Small viewport must not overflow horizontally');await screenshot('ssh-small-viewport');
  await evaluate(`changeFixtureTheme('light');true`);await until(`document.documentElement.dataset.appTheme==='light'`);await screenshot('ssh-terminal-light');
  await click('.generic-terminal-close');await until(`document.querySelector('.generic-terminal-list')`);
  await click('.generic-terminal-end');await until(`document.querySelector('[role="dialog"]')`);assert.equal(await evaluate(`calls.some(c=>c[0]==='end')`),false,'End must wait for confirmation');
  await screenshot('end-confirm');await click('[role="dialog"] .danger-button');await until(`records.length===0&&!document.querySelector('[role="dialog"]')`);
  await click('.generic-terminal-create input');await call('Input.insertText',{text:'Second task'});await click('.generic-terminal-create button');
  await until(`calls.some(c=>c[0]==='create'&&c[1].name==='Second task')&&document.querySelector('.generic-terminal-status')?.textContent.toLowerCase().includes('connected')`);
  assert.equal(await evaluate(`calls.filter(c=>c[0]==='create').length`),1,'Explicit create runs once');
  await click('.generic-terminal-close');await until(`document.querySelector('.generic-terminal-back')`);await click('.generic-terminal-back');await until('didClose');
  await evaluate(`changeFixtureTheme('dark');showHostManager();true`);await until(`document.querySelector('.host-row')&&document.documentElement.dataset.appTheme==='dark'`);
  assert.ok(await evaluate(`document.documentElement.scrollWidth<=320`),'Host dual-entry actions must fit narrow viewport');
  await screenshot('host-dual-entry-narrow');await click('.host-row .host-card');await until(`document.querySelector('.form-grid select:nth-of-type(1)')||document.querySelector('.form-grid input[type="number"]')`);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.form-grid select')).at(-1).options.length`),2,'Jump picker excludes self and Relay');
  await evaluate(`(()=>{const selects=document.querySelectorAll('.form-grid select');const jump=selects[selects.length-1];jump.value='jump';jump.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await evaluate(`Array.from(document.querySelectorAll('.form-grid select')).at(-1).scrollIntoView({block:'center'});true`);await screenshot('host-network-options');await click('.modal-actions .primary-button');await until('savedProfile');
  assert.equal(await evaluate('savedProfile.jump.hostProfileId'),'jump');
  console.log('PASS real Chrome/xterm: byte output, input, geometry, tmux restore/no recreate, detach, explicit Mosh fallback, end confirmation, create, host dual-entry/jump settings, dark/light and 320px layout');
  console.log('Fixture transport only: native SSH/Mosh and real-device network behavior are NOT verified by this script.');
} finally {
  ws?.close();if(chrome){const exited=new Promise(r=>chrome.once('exit',r));chrome.kill();await Promise.race([exited,wait(5000)])}if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});
}
