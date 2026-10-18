// Production components in real Chrome. Native/RPC adapter is a deterministic
// fixture: this proves rendering/gestures, not native transport or phone behavior.
// Run: node mobile/scripts/test-file-tree-images.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(resolve(tmpdir(), 'agentport-file-images-'));
const evidence = process.env.AGENTPORT_FILE_IMAGES_SCREENSHOTS || '/tmp/agentport-file-tree-images-evidence';
const gif = 'R0lGODlhDAAIAIEAAPAoHgAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAEgAAACwAAAAADAAIAAAIEgABCBxIsKDBgwgTKlzIsGHBgAAh+QQBEgABACwAAAAADAAIAIEUUPAAAAAAAAAAAAAIEgABCBxIsKDBgwgTKlzIsGHBgAA7';
const webp = 'UklGRogAAABXRUJQVlA4WAoAAAACAAAACwAABwAAQU5JTQYAAAAAAAAAAABBTk1GKgAAAAAAAAAAAAsAAAcAALQAAAJWUDhMEQAAAC8LwAEAB1CUwtej/4GI6H8AAEFOTUYqAAAAAAAAAAAACwAABwAAtAAAAFZQOEwRAAAALwvAAQAHUKhSFL7/gYjofwAA';
let chrome, server, ws;
const requests = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {SessionFiles} from './src/features/files/SessionFiles'; import {i18n} from './src/i18n'; import {getAppThemeVariables} from './src/app/appAppearance'; import './src/app/styles.css';
    window.theme=mode=>{document.documentElement.dataset.appTheme=mode;Object.entries(getAppThemeVariables(mode)).forEach(([key,value])=>document.documentElement.style.setProperty(key,value));};window.theme('dark');
    i18n.changeLanguage('en-US'); window.calls=[]; window.images=[]; window.revoked=[];
    const nativeURL=URL.createObjectURL.bind(URL), revoke=URL.revokeObjectURL.bind(URL);
    URL.createObjectURL=blob=>{window.images.push(blob);return nativeURL(blob)};
    URL.revokeObjectURL=url=>{window.revoked.push(url);revoke(url)};
    const names=['a.svg','b.gif','c.webp','d.png','e.jpg','failure.gif','late.gif'];
    let connection; window.disconnect=()=>connection({profileId:'host',state:'disconnected'});
    const client={listHostProfiles:async()=>[{id:'host',connectionState:'connected'}],onConnectionState:async fn=>{connection=fn;return async()=>{}},request:async(_host,method,params)=>{
      window.calls.push({method,params});
      return {rootPath:'/fixture/project',path:params.path,truncated:false,entries:params.path==='.'?[{name:'images',path:'images',isDir:true},...Array.from({length:60},(_,i)=>({name:'text-'+i+'.txt',path:'text-'+i+'.txt',isDir:false}))]:names.map(name=>({name,path:'images/'+name,isDir:false}))};
    }};
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><script>window.badImage=true</script><image href="/secret.png"/><animate attributeName="x"/><style>@import url(/secret.css);</style><rect x="10" y="10" width="220" height="100" fill="#4080c0"><animateColor attributeName="fill" values="red;blue" dur="1s" repeatCount="indefinite"/></rect><text x="20" y="70">Safe SVG</text></svg>';
    const canvas=document.createElement('canvas');canvas.width=12;canvas.height=8;canvas.getContext('2d').fillRect(0,0,12,8);
    let failed=false;
    const images={scope:'host:session',local:async(path,options)=>{
      window.calls.push({method:'image.local',path,limits:options.animationLimits});
      if(path.endsWith('failure.gif')&&!failed){failed=true;throw {code:'animation_limit'}}
      if(path.endsWith('late.gif'))return new Promise(resolve=>window.finishLate=()=>resolve({mime:'image/gif',width:12,height:8,contentBase64:'${gif}'}));
      const mime=path.endsWith('.svg')?'image/svg+xml':path.endsWith('.webp')?'image/webp':path.endsWith('.png')?'image/png':path.endsWith('.jpg')?'image/jpeg':'image/gif';
      return {mime,width:mime.includes('svg')?240:12,height:mime.includes('svg')?120:8,contentBase64:mime.includes('svg')?btoa(svg):mime.includes('webp')?'${webp}':mime.includes('png')||mime.includes('jpeg')?canvas.toDataURL(mime).split(',')[1]:'${gif}'};
    },remote:async()=>{throw Error('No remote requests allowed')}};
    const open={hostProfileId:'host',session:{id:'session',cwd:'/fixture/project'}};
    createRoot(document.getElementById('root')).render(<SessionFiles open={open} client={client} imageClient={images} active onBack={()=>{window.wentToTerminal=true}}/>);
  `, resolveDir: root, loader: 'tsx' }, loader: { '.ttf': 'dataurl', '.otf': 'dataurl' }, outfile: resolve(dir, 'fixture.js'), bundle: true, minify: true, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  server = createServer(async (req, res) => {
    requests.push(req.url);
    const name = req.url === '/fixture.js' ? 'fixture.js' : req.url === '/fixture.css' ? 'fixture.css' : null;
    res.setHeader('Content-Security-Policy', "img-src 'self' blob:; connect-src 'self'; object-src 'none'");
    res.setHeader('Content-Type', name?.endsWith('.js') ? 'text/javascript' : name ? 'text/css' : 'text/html');
    res.end(name ? await readFile(resolve(dir, name)) : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root" style="height:100dvh"></div><script src="fixture.js"></script>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${dir}/profile`,'about:blank'], { stdio: ['ignore','ignore','pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = ''; const timer = setTimeout(() => reject(Error('Chrome startup timeout')), 15000);
    chrome.once('error', e => { clearTimeout(timer); reject(e); });
    chrome.stderr.on('data', bytes => { stderr += bytes; const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const targets = await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`).then(r => r.json());
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => { ws.onopen = r; });
  let seq = 0; const pending = new Map();
  ws.onmessage = ({data}) => { const value=JSON.parse(data); const entry=pending.get(value.id); if (!entry) return; pending.delete(value.id); clearTimeout(entry.timer); value.error ? entry.reject(value.error) : entry.resolve(value.result); };
  const call = (method, params={}) => new Promise((resolve,reject) => { const id=++seq; const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params})); });
  const evaluate = async expression => { const value=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}); if(value.exceptionDetails) throw Error(JSON.stringify(value.exceptionDetails)); return value.result.value; };
  const until = async expression => { for(let i=0;i<100;i++){if(await evaluate(`Boolean(${expression})`))return;await wait(50);} throw Error('Timed out: '+expression+' '+await evaluate('document.body.innerText')); };
  const click = async expression => {
    const box=await evaluate(`(()=>{const e=${expression};if(!e)throw Error('missing control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await call('Input.dispatchMouseEvent',{type:'mousePressed',...box,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',...box,button:'left',clickCount:1});await wait(100);
  };
  const selector = s => `document.querySelector(${JSON.stringify(s)})`;
  const row = name => `Array.from(document.querySelectorAll('.files-row')).find(e=>e.textContent.trim()===${JSON.stringify(name)})`;
  const control = async name => {
    if(await evaluate(`document.querySelector('.files-preview-page .files-header').hidden`))await click(selector('.files-preview-page .files-chrome-reveal'));
    await click(`Array.from(document.querySelectorAll('.files-preview-page button')).find(e=>e.getAttribute('aria-label')===${JSON.stringify(name)}||e.textContent===${JSON.stringify(name)})`);
  };
  const screenshot = async (name, clip) => { await mkdir(evidence,{recursive:true}); const {data}=await call('Page.captureScreenshot',{format:'png',...(clip?{clip}: {})});await writeFile(resolve(evidence,name+'.png'),Buffer.from(data,'base64'));return data; };
  const back = async () => { await control('File tree');await until(`document.querySelector('.files-page-viewport').dataset.previewVisible==='false'`);await wait(250); };
  const openImage = async name => { await click(row(name));await until(`document.querySelector('.file-image-content img')?.complete && document.querySelector('.file-image-content img').naturalWidth>0`);await wait(250); };
  const touch = (type,points=[]) => call('Input.dispatchTouchEvent',{type,touchPoints:points});
  await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await call('Emulation.setTouchEmulationEnabled',{enabled:true});
  await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});await until(`document.querySelector('.files-row')`);await click(row('images'));await until(`document.querySelectorAll('.files-row').length>65`);
  await openImage('a.svg');
  assert.equal(await evaluate(`window.calls.some(c=>c.method==='session.files.read')`),false);
  assert.equal(await evaluate(`window.calls.filter(c=>c.method==='image.local').every(c=>c.limits)`),true);
  assert.equal(await evaluate('window.badImage===true'),false);
  assert.doesNotMatch(await evaluate('window.images[0].text()'),/script|secret|animate/);
  const bounds=await evaluate(`(()=>{const p=document.querySelector('.file-image-content').getBoundingClientRect(),i=document.querySelector('.file-image-content img').getBoundingClientRect();return{width:p.width,height:p.height,top:p.top,imageWidth:i.width,imageHeight:i.height,body:document.documentElement.scrollWidth}})()`);
  assert.equal(bounds.width,390);assert.equal(bounds.height,800);assert.equal(bounds.top,44);assert.equal(bounds.body,390);
  await screenshot('svg-dark');
  await control('Zoom in');assert.match(await evaluate(`document.querySelector('.file-image-content img').style.transform`),/scale\(1.5\)/);
  await touch('touchStart',[{x:110,y:400},{x:220,y:400}]);await touch('touchMove',[{x:80,y:400},{x:250,y:400}]);await touch('touchEnd');
  const pinched=await evaluate(`document.querySelector('.file-image-content img').style.transform`);assert.ok(Number(pinched.match(/scale\(([^)]+)\)/)[1])>1.5,pinched);
  await touch('touchStart',[{x:150,y:400}]);await touch('touchMove',[{x:270,y:410}]);await touch('touchEnd');
  assert.equal(await evaluate(`document.querySelector('.files-page-viewport').dataset.previewVisible`),'true');assert.equal(await evaluate('!!window.wentToTerminal'),false);
  const calls=await evaluate(`window.calls.filter(c=>c.method==='image.local').length`);
  await control('More file actions');await click(`Array.from(document.querySelectorAll('.file-image-backgrounds button')).find(e=>e.textContent==='Dark')`);
  assert.equal(await evaluate(`document.querySelector('.file-image-content').dataset.imageBackground`),'dark');assert.equal(await evaluate(`window.calls.filter(c=>c.method==='image.local').length`),calls);
  await control('Fit to window');await screenshot('svg-controls');await back();
  assert.equal(await evaluate('window.revoked.length'),1);assert.equal(await evaluate(`document.querySelector('.files-row').getAttribute('aria-expanded')`),'true');
  // Real animation evidence: sample the rendered viewport, not drawImage's first frame.
  for(const name of ['b.gif','c.webp']) {
    await openImage(name);await screenshot(name);const samples=new Set();for(let i=0;i<6;i++){samples.add(await screenshot(name+'-'+i,{x:190,y:440,width:8,height:8,scale:1}));await wait(100);}assert.ok(samples.size>1,name+' center pixels should animate in the actual renderer');await back();
  }
  for(const name of ['d.png','e.jpg']){await openImage(name);await back();}
  await click(row('failure.gif'));await until(`document.querySelector('[role=alert]')`);assert.match(await evaluate(`document.querySelector('[role=alert]').textContent`),/frame or cumulative canvas budget/);
  await click(`Array.from(document.querySelectorAll('.file-image-content button')).find(e=>e.textContent==='Retry image')`);await until(`document.querySelector('.file-image-content img')?.naturalWidth>0`);await back();
  const before=await evaluate('window.images.length');await click(row('late.gif'));await until('window.finishLate');await back();await evaluate('window.finishLate()');await wait(100);assert.equal(await evaluate('window.images.length'),before);
  await evaluate(`document.querySelector('.files-tree-scroll').scrollTop=200`);const scroll=await evaluate(`document.querySelector('.files-tree-scroll').scrollTop`);assert.ok(scroll>0);
  // Reopening an offscreen row must not destroy the retained tree scroller.
  await evaluate(`document.querySelector('.files-row[aria-label="a.svg File"]').click()`);await until(`document.querySelector('.file-image-content img')?.naturalWidth>0`);await back();assert.equal(await evaluate(`document.querySelector('.files-tree-scroll').scrollTop`),scroll);
  await call('Emulation.setDeviceMetricsOverride',{width:320,height:568,deviceScaleFactor:1,mobile:true});await evaluate(`window.theme('light')`);await openImage('a.svg');await screenshot('svg-light-narrow');
  assert.equal(await evaluate('document.documentElement.scrollWidth'),320);
  await evaluate('window.disconnect()');await until(`!document.querySelector('.file-image-content img')`);await screenshot('offline');
  assert.ok(!requests.some(path=>/secret|https:/.test(path)),JSON.stringify(requests));
  console.log(JSON.stringify({passed:true,formats:['SVG','GIF','animated WebP','PNG','JPEG'],checks:['fit/fullscreen','pinch/drag/no-navigation','transparent-background','budget/retry','late-result','tree-state','disconnect','dark/light/narrow','SVG safety'],evidence,nativeTransport:'mocked; not native-device proof'},null,2));
} finally {
  ws?.close();
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise(r => chrome.once('exit', r));
    chrome.kill('SIGTERM');
    await exited;
  }
  if (server) await new Promise(r => server.close(r));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
