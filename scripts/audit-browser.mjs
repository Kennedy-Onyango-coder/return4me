// Local, synthetic-data browser audit. No application server or live providers are used.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const root = process.cwd();
const stage = message => console.log(`[audit] ${message}`);
setTimeout(() => {
  console.error('[audit] timed out');
  process.exit(124);
}, 120000).unref();
const source = fs.readFileSync(path.join(root, 'src/db/database.ts'), 'utf8');
const seed = source.slice(source.indexOf('const list = ['), source.indexOf('// Derives Recovery Fee Engine inputs'));
const categories = [...seed.matchAll(/id: "([^"]+)",[\s\S]*?name_en: "([^"]+)",[\s\S]*?name_sw: "([^"]+)",[\s\S]*?total_fee: (\d+),[\s\S]*?is_sensitive_document: (true|false)/g)]
  .map((m) => ({ id: m[1], name_en: m[2], name_sw: m[3], total_fee: +m[4], is_sensitive_document: m[5] === 'true' }));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    const responses = {
      '/api/categories': categories, '/api/regions': ['Nairobi'],
      '/api/stats': { activeAgentsCount: 0 }, '/api/items/search': [],
      '/api/dev/test-mode': { testModeEnabled: false },
    };
    if (url.pathname === '/api/claims/lookup') {
      let body = ''; req.on('data', chunk => body += chunk);
      req.on('end', () => setTimeout(() => {
        const ok = JSON.parse(body).claimId === 'AUDIT-OK';
        res.statusCode = ok ? 200 : 404;
        res.end(JSON.stringify(ok ? { claim: { id: 'AUDIT-OK', status: 'pending_verification' }, item: { category_id: 'national-id' }, agent: null } : { error: 'Synthetic claim not found' }));
      }, 500));
      return;
    }
    res.end(JSON.stringify(responses[url.pathname] ?? {})); return;
  }
  let file = path.join(root, 'dist', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(path.join(root, 'dist'))) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file)) file = path.join(root, 'dist/index.html');
  res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.jpg': 'image/jpeg', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
stage('starting synthetic server');
await new Promise(resolve => server.listen(4179, '127.0.0.1', resolve));
stage('synthetic server listening');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'return4me-audit-'));
const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9229',
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
edge.on('error', error => console.error(`[audit] Edge launch failed: ${error.message}`));
stage('Edge launched');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws;
try {
  let pages;
  for (let i = 0; i < 30; i++) {
    try { pages = await (await fetch('http://127.0.0.1:9229/json')).json(); break; } catch { await sleep(300); }
  }
  if (!pages) throw new Error('Edge DevTools unavailable');
  stage('DevTools endpoint available');
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  stage('DevTools websocket connected');
  let id = 0; const pending = new Map(); const errors = [];
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) { const p = pending.get(message.id); pending.delete(message.id); message.error ? p.reject(message.error) : p.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    const timeout = setTimeout(() => { pending.delete(next); reject(new Error(`${method} timed out`)); }, 10000);
    pending.set(next, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
    ws.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async expression => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await call('Runtime.enable'); await call('Page.enable');
  stage('Runtime and Page domains enabled');
  await call('Network.enable');
  stage('Network domain enabled');
  await call('Network.setBlockedURLs', { urls: ['https://*', 'http://*.com/*'] });
  stage('External network blocked');
  await call('Page.navigate', { url: 'http://127.0.0.1:4179/' }); await sleep(1800);
  stage('Application page loaded');
  stage('Checking application mount');
  if (!await evaluate(`typeof window.setView === 'function'`)) {
    console.log(JSON.stringify({ errors, body: await evaluate('document.body.innerText'), html: await evaluate('document.head.innerHTML') }, null, 2));
    throw new Error('Application failed to mount');
  }
  const results = { synthetic: true, categories: categories.length, errors, surfaces: [], modal: [] };
  for (const width of [320, 360, 375, 390, 414, 768, 1024, 1280, 1366, 1440, 1920]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
    for (const view of ['home', 'owner', 'finder', 'agent', 'admin']) {
      await evaluate(`window.setView(${JSON.stringify(view)})`); await sleep(500);
      results.surfaces.push(await evaluate(`({width:innerWidth,view:${JSON.stringify(view)},scrollWidth:document.documentElement.scrollWidth,headings:[...document.querySelectorAll('h1,h2')].map(e=>e.textContent),buttons:[...document.querySelectorAll('button')].filter(e=>e.getClientRects().length&&e.getBoundingClientRect().height<24).length})`));
    }
  }
  for (const width of [390, 1366]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
    await evaluate(`window.setView('owner')`); await sleep(600);
    for (let cycle = 0; cycle < 3; cycle++) {
      const clicked = await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Track My')); if(!b) return false; b.click(); return true})()`);
      if (!clicked) throw new Error('Track My Claim button not found');
      await sleep(250);
      const snapshot = await evaluate(`(()=>{const d=document.querySelector('[role=dialog]');const overlay=d.parentElement;const r=d.getBoundingClientRect();const o=overlay.getBoundingClientRect();const ancestors=[];for(let e=overlay;e;e=e.parentElement){const s=getComputedStyle(e);if(s.transform!=='none'||s.filter!=='none'||s.perspective!=='none')ancestors.push({tag:e.tagName,class:e.className,transform:s.transform,filter:s.filter,perspective:s.perspective})}return {width:${width},cycle:${cycle},top:r.top,bottom:r.bottom,height:r.height,overlayTop:o.top,overlayBottom:o.bottom,overlayHeight:o.height,viewport:innerHeight,focus:document.activeElement.id,overflow:document.body.style.overflow,ancestors};})()`);
      await evaluate(`(()=>{const d=document.querySelector('[role=dialog]');const b=d.querySelectorAll('button');b[b.length-1].focus()})()`);
      await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      snapshot.tabWrap = await evaluate(`document.activeElement.getAttribute('aria-label')`);
      if (cycle === 0) {
        await evaluate(`(()=>{const set=(id,value)=>{const el=document.getElementById(id);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))};set('track-claim-id','AUDIT-MISSING');set('track-phone','0712345678');[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.includes('Look Up')).click()})()`);
        await sleep(800);
        snapshot.failedLookup = await evaluate(`document.querySelector('[role=dialog] .bg-red-50')?.textContent.trim() || null`);
        await evaluate(`(()=>{const set=(id,value)=>{const el=document.getElementById(id);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))};set('track-claim-id','AUDIT-OK');set('track-phone','0712345678');[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.includes('Look Up')).click()})()`);
        await sleep(800);
        snapshot.successfulLookup = await evaluate(`document.querySelector('[role=dialog] .bg-stone-50')?.textContent.includes('Pending Verification') || false`);
      }
      await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(100);
      snapshot.closed = await evaluate(`!document.querySelector('[role=dialog]')`);
      snapshot.restored = await evaluate(`document.activeElement.textContent.includes('Track My')`);
      results.modal.push(snapshot);
    }
  }
  fs.writeFileSync(path.join(root, 'docs/browser-audit-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  ws?.close(); edge.kill(); server.close();
}