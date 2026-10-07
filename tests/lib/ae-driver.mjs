// Drives the real Routecam panel inside After Effects through CEP's
// remote-debugging port (Chrome DevTools Protocol). Windows + macOS paths are
// handled, but only Windows has been exercised.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8199;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function findAE() {
  if (process.platform === 'win32') {
    const base = 'C:\\Program Files\\Adobe';
    const dirs = readdirSync(base).filter((d) => /^Adobe After Effects \d{4}$/.test(d)).sort().reverse();
    for (const d of dirs) { const exe = join(base, d, 'Support Files', 'AfterFX.exe'); if (existsSync(exe)) return exe; }
  } else {
    const dirs = readdirSync('/Applications').filter((d) => /^Adobe After Effects \d{4}$/.test(d)).sort().reverse();
    for (const d of dirs) { const app = join('/Applications', d, `${d}.app`, 'Contents', 'MacOS', 'After Effects'); if (existsSync(app)) return app; }
  }
  throw new Error('After Effects is not installed in the default location.');
}

function aeWindowTitle() {
  if (process.platform !== 'win32') return 'unknown';
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command',
      '(Get-Process AfterFX -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1).MainWindowTitle'],
      { encoding: 'utf8' }).trim();
  } catch { return ''; }
}
function aeRunning() {
  if (process.platform !== 'win32') return false;
  try { return /AfterFX\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq AfterFX.exe'], { encoding: 'utf8' })); } catch { return false; }
}

async function targets() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
    const list = await r.json();
    return list.filter((t) => /index\.html/.test(t.url) && t.webSocketDebuggerUrl);
  } catch { return []; }
}

/** Make sure After Effects is running with the panel open; returns whether we started it. */
export async function ensurePanel() {
  if ((await targets()).length) return { started: false };
  const exe = findAE();
  let started = false;
  if (!aeRunning()) {
    log('Starting After Effects:', exe);
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
    started = true;
  }
  const t0 = Date.now();
  let windowAt = 0, asked = false;
  while (Date.now() - t0 < 300000) {
    await sleep(3000);
    if ((await targets()).length) { log('Panel is up after', Math.round((Date.now() - t0) / 1000), 's'); await sleep(1500); return { started }; }
    const title = aeWindowTitle();
    if (!windowAt && /After Effects/i.test(title)) { windowAt = Date.now(); log('After Effects window is open:', title); }
    // The panel reopens by itself if it was open last session. If it has not
    // appeared 20 s after the main window, open it through its menu command.
    if (windowAt && !asked && Date.now() - windowAt > 20000) {
      asked = true;
      const jsx = join(tmpdir(), 'routecam-open-panel.jsx');
      writeFileSync(jsx, 'var id = app.findMenuCommandId("Routecam"); if (id) { app.executeCommand(id); }');
      log('Opening the panel via Window > Extensions > Routecam');
      spawn(exe, ['-r', jsx], { detached: true, stdio: 'ignore' }).unref();
    }
  }
  throw new Error('The Routecam panel did not open in After Effects within 5 minutes. Is the extension installed (npm run install-extension)?');
}

export class Panel {
  static async connect() {
    const list = await targets();
    if (!list.length) throw new Error('Panel debug port is not responding.');
    const p = new Panel();
    p.ws = new WebSocket(list[0].webSocketDebuggerUrl);
    p.id = 0; p.pending = new Map();
    await new Promise((res, rej) => { p.ws.onopen = res; p.ws.onerror = () => rej(new Error('Could not connect to the panel debugger.')); });
    p.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && p.pending.has(m.id)) { const { res, rej } = p.pending.get(m.id); p.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    };
    return p;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  /** Evaluate an expression in the panel page (promises are awaited). */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('Panel error: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
    return r.result.value;
  }
  /** Run a function inside the panel with JSON-serialisable arguments. */
  run(fn, ...args) { return this.eval(`(${fn.toString()})(...${JSON.stringify(args)})`); }
  /** Run raw ExtendScript in After Effects and return its string result. */
  jsx(script) { return this.run((s) => RC.platform.evalScript(s), script); }
  async reload() {
    await this.send('Page.enable');
    await this.send('Page.reload', { ignoreCache: true });
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try { if (await this.eval('!!(window.RC && RC.app && RC.app.editor())')) { await sleep(800); return; } } catch { /* page still loading */ }
    }
    throw new Error('Panel did not finish loading after reload.');
  }
  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}
