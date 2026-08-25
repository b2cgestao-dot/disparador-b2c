// Navegador real (Chrome headless) via CDP com o WebSocket nativo do Node 22.
// Sem dependencias externas. Usado pelos testes do front.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];
export function findChrome() {
  return process.env.CHROME_BIN || CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

export async function launchBrowser() {
  const bin = findChrome();
  if (!bin) throw new Error('Chrome/Chromium nao encontrado (defina CHROME_BIN)');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'disparador-chrome-'));
  const proc = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d) => { buf += d.toString(); const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); };
    proc.stderr.on('data', onData); proc.stdout.on('data', onData);
    proc.on('exit', (c) => reject(new Error(`chrome saiu (${c}): ${buf}`)));
    setTimeout(() => reject(new Error('timeout esperando o chrome: ' + buf)), 20000);
  });
  const httpBase = wsUrl.replace(/^ws:\/\/([^/]+).*/, 'http://$1');
  return {
    proc, profile, httpBase,
    async newPage() {
      const r = await fetch(`${httpBase}/json/new?about:blank`, { method: 'PUT' });
      const info = await r.json();
      const page = new Page(info.webSocketDebuggerUrl);
      await page.connect();
      return page;
    },
    async close() {
      try { proc.kill('SIGKILL'); } catch {}
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

export class Page {
  constructor(wsUrl) {
    this.wsUrl = wsUrl; this.seq = 0; this.pending = new Map(); this.listeners = [];
    this.errors = []; this.logs = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', async () => {
        this.on((msg) => this.#track(msg));
        await this.send('Runtime.enable'); await this.send('Log.enable'); await this.send('Page.enable'); await this.send('Network.enable');
        resolve(this);
      });
      this.ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || e))));
      this.ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id) {
          const p = this.pending.get(msg.id); this.pending.delete(msg.id);
          if (!p) return;
          msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
        } else for (const l of this.listeners) l(msg);
      });
    });
  }
  #track(msg) {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.errors.push({ kind: 'exception', text: d.exception?.description || d.text, url: d.url });
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      this.logs.push({ type: msg.params.type, text });
      if (msg.params.type === 'error') this.errors.push({ kind: 'console.error', text });
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      this.logs.push({ type: e.level, text: e.text, url: e.url });
      if (e.level === 'error') this.errors.push({ kind: 'log', text: e.text, url: e.url });
    } else if (msg.method === 'Network.loadingFailed') {
      // requests cancelados (ERR_ABORTED) nao sao erro da pagina
      if (!msg.params.canceled && msg.params.errorText !== 'net::ERR_ABORTED') {
        this.errors.push({ kind: 'network', text: msg.params.errorText, requestId: msg.params.requestId });
      }
    }
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq; this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(fn) { this.listeners.push(fn); }
  waitEvent(method, { timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout esperando ' + method)), timeout);
      const l = (msg) => { if (msg.method === method) { clearTimeout(t); this.listeners = this.listeners.filter((x) => x !== l); resolve(msg.params); } };
      this.on(l);
    });
  }
  async goto(url) {
    const load = this.waitEvent('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await load;
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async waitFor(expression, { timeout = 15000, interval = 100, label } = {}) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < timeout) {
      try { last = await this.eval(expression); if (last) return last; } catch (e) { last = e.message; }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`timeout esperando ${label || expression} (ultimo: ${JSON.stringify(last)})`);
  }
  async type(selector, text) {
    await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  }
  async click(selector) {
    await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('nao achei ' + ${JSON.stringify(selector)}); el.click(); return true; })()`);
  }
  async visible(selector) {
    return this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; if (el.closest('[hidden]')) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`);
  }
  async close() { try { this.ws.close(); } catch {} }
}
