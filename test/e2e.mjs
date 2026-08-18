// End-to-end check for Burst Clicker against a real Chrome.
//
//   node test/e2e.mjs              # every suite
//   node test/e2e.mjs input        # one suite: input | visible | hidden | multi
//
// Chrome 151 ignores --load-extension, so the extension is installed with the
// browser-level CDP command Extensions.loadUnpacked, which needs
// --enable-unsafe-extension-debugging and a dev-mode profile.
//
// Suites that must not have a debugger on the page (trusted mode uses
// chrome.debugger itself, and only one client may attach) are driven from the
// extension's service-worker target instead, calling its own top-level
// functions, and read results back out of document.title via /json/list.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// BURST_EXT_DIR lets the harness test a packaged copy instead of the repo, so the
// zip that gets shared is verified rather than assumed.
const EXT = process.env.BURST_EXT_DIR || join(HERE, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8099;
const CDP_PORT = 9333;
const url = (p) => `http://127.0.0.1:${PORT}/${p}`;
const PAGE_URL = url('page.html');
const only = process.argv[2];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n, w = 2) => String(n).padStart(w, '0');
const results = [];

function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const http = (path) => fetch(`http://127.0.0.1:${CDP_PORT}${path}`).then((r) => r.json());
const targetsOf = (type) => http('/json/list').then((l) => l.filter((t) => t.type === type));

class Client {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.events = []; }

  static async open(u) {
    const ws = new WebSocket(u);
    const c = new Client(ws);
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.waiting.has(m.id)) {
        const { resolve, reject } = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) c.events.push(m);
    });
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws error ' + u)), { once: true });
    });
    return c;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error(method + ' timed out')); }
      }, 30000);
    });
  }

  async eval(expression, contextId) {
    const r = await this.send('Runtime.evaluate', {
      expression, contextId, returnByValue: true, awaitPromise: true, userGesture: true
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' :: ' +
        (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails.exception || {})));
    }
    return r.result.value;
  }

  close() { try { this.ws.close(); } catch {} }
}

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() > end) throw new Error('timeout waiting for ' + label);
    await sleep(150);
  }
}

const timeIn = (seconds) => {
  const t = new Date(Date.now() + seconds * 1000);
  return {
    str: `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}.${pad(t.getMilliseconds(), 3)}`,
    epoch: t.getTime()
  };
};

const parseTitle = (t) => Object.fromEntries(t.split('|').map((s) => s.split(':')));

async function swClient(extId) {
  return waitFor(async () => {
    const t = (await targetsOf('service_worker')).find((x) => x.url.includes(extId));
    return t && t.webSocketDebuggerUrl ? Client.open(t.webSocketDebuggerUrl) : null;
  }, 15000, 'service worker target');
}

const titleOf = async (pageUrl) => {
  const p = (await targetsOf('page')).find((x) => x.url === pageUrl);
  return p ? p.title : null;
};

const waitTitle = (pageUrl, ms, label) => waitFor(async () => {
  const t = await titleOf(pageUrl);
  return t && t.startsWith('HITS:') && t !== 'HITS:0' ? t : null;
}, ms, label);

// ------------------------------------------------- 1: time input + defaults

async function testInput(sw) {
  console.log('\n[1] fixed-time input — defaults and parsing');

  const s = await sw.eval(`chrome.storage.local.get('settings').then(g => g.settings)`);
  check('default fire-at time is 1 pm', s.time === '13:00:00.000', s.time);

  // This tab was open before the extension existed — the state a user is in
  // right after installing. It must be usable without reloading the page.
  const fresh = await sw.eval(`(async () => {
    const t = (await chrome.tabs.query({})).find(t => t.url === '${PAGE_URL}');
    const ok = await ensureContentScript(t.id);
    const pong = await send(t.id, { type: 'ping' });
    return { ok, reachable: !!(pong && pong.ok) };
  })()`);
  check('a tab open before install is reachable without a reload',
    fresh.ok === true && fresh.reachable === true, JSON.stringify(fresh));

  const cases = [
    ['1pm', '13:00:00.000'], ['1 p.m.', '13:00:00.000'], ['1:05 PM', '13:05:00.000'],
    ['13:00', '13:00:00.000'], ['13:00:00.250', '13:00:00.250'], ['12am', '00:00:00.000'],
    ['12pm', '12:00:00.000'], ['9:30', '09:30:00.000'], ['23:59:59.999', '23:59:59.999']
  ];
  const got = await sw.eval(`(${JSON.stringify(cases)}).map(([i]) => BurstTime.canonical(i))`);
  const bad = cases.filter(([, want], i) => got[i] !== want).map(([i], k) => `${i}→${got[k]}`);
  check('accepts 12-hour and 24-hour input', bad.length === 0, bad.join(', ') || `${cases.length} forms`);

  const junk = await sw.eval(`['', 'noon', '25:00', '12:60', '13pm', 'abc'].map(v => BurstTime.canonical(v))`);
  check('rejects unreadable input', junk.every((v) => v === null), JSON.stringify(junk));

  // A typed time must resolve to one exact instant, never a duration.
  const resolved = await sw.eval(`(() => {
    const now = new Date(); now.setHours(9, 0, 0, 0);
    const at1pm = BurstTime.nextTarget('1pm', 0, now.getTime());
    const d = new Date(at1pm);
    return { h: d.getHours(), m: d.getMinutes(), s: d.getSeconds(), ms: d.getMilliseconds(),
             sameDay: d.getDate() === now.getDate() };
  })()`);
  check('1 pm resolves to exactly 13:00:00.000 today',
    resolved.h === 13 && resolved.m === 0 && resolved.s === 0 && resolved.ms === 0 && resolved.sameDay,
    JSON.stringify(resolved));

  const rolled = await sw.eval(`(() => {
    const now = new Date(); now.setHours(18, 0, 0, 0);
    const t = BurstTime.nextTarget('1pm', 0, now.getTime());
    return t - now.getTime();
  })()`);
  check('a time already past rolls to tomorrow', rolled === 19 * 3600000, `${rolled / 3600000}h out`);

  const offset = await sw.eval(`(() => {
    const now = new Date(); now.setHours(9, 0, 0, 0);
    return BurstTime.nextTarget('1pm', 0, now.getTime()) - BurstTime.nextTarget('1pm', -150, now.getTime());
  })()`);
  check('clock offset shifts the instant', offset === 150, `${offset}ms`);
}

// ------------------------------------------------- 2: visible tab, panel UI

async function testVisible(page, ctxId) {
  console.log('\n[2] visible tab — driving the in-page panel');

  const armAt = timeIn(6);
  const MARKERS = [{ x: 140, y: 150 }, { x: 400, y: 290 }];
  const PER = 3;

  const setup = await page.eval(`(() => {
    const sr = document.getElementById('burst-clicker-root').shadowRoot;
    const set = (k, v) => { const i = sr.querySelector('[data-k="' + k + '"]');
      i.value = v; i.dispatchEvent(new Event('change', { bubbles: true })); };
    sr.querySelector('[data-a="place"]').click();
    const cap = sr.querySelector('.capture');
    const engaged = getComputedStyle(cap).display !== 'none';
    for (const m of ${JSON.stringify(MARKERS)}) {
      cap.dispatchEvent(new PointerEvent('pointerdown',
        { clientX: m.x, clientY: m.y, bubbles: true, cancelable: true }));
    }
    set('burstCount', ${PER});
    set('burstIntervalMs', 15);
    set('offsetMs', 0);
    set('time', '${armAt.str}');
    sr.querySelector('[data-a="place"]').click();
    return { engaged, markers: sr.querySelectorAll('.mk').length };
  })()`);
  check('place mode shows the capture overlay', setup.engaged === true);
  check('clicking the page drops markers', setup.markers === 2, `rendered ${setup.markers}`);

  const armed = await page.eval(`(() => {
    const sr = document.getElementById('burst-clicker-root').shadowRoot;
    sr.querySelector('[data-a="arm"]').click();
    return new Promise(r => setTimeout(() => r({
      label: sr.querySelector('[data-a="arm"]').textContent,
      countdown: sr.querySelector('.cd').textContent,
      sub: sr.querySelector('.sub').textContent
    }), 500));
  })()`);
  check('arm button flips to Disarm', armed.label === 'Disarm', armed.label);
  check('countdown is ticking down', /^00:00:0[0-5]\./.test(armed.countdown), armed.countdown);
  check('panel shows the resolved instant and click count',
    armed.sub.includes('6 clicks') && armed.sub.includes('today'), armed.sub);

  const sch = (await page.eval(`chrome.runtime.sendMessage({ type: 'mySchedule' })`, ctxId)).schedule;
  check('worker holds the schedule for this tab', !!sch);
  check('target stored to the exact millisecond', sch && sch.targetMs === armAt.epoch,
    sch && `${sch.targetMs} vs ${armAt.epoch}`);

  console.log(`      waiting ${Math.round(armAt.epoch - Date.now() + 1500)}ms for the burst…`);
  await sleep(armAt.epoch - Date.now() + 1500);

  const hits = await page.eval('window.__hits');
  const expected = MARKERS.length * PER;
  check(`fired all ${expected} clicks`, hits.length === expected, `got ${hits.length}`);
  if (hits.length) {
    const drift = hits[0].t - armAt.epoch;
    check('first click within 50ms of the target instant', Math.abs(drift) < 50, `drift ${drift.toFixed(1)}ms`);
    check('the tab was on screen for this one', hits[0].vis === 'visible', hits[0].vis);
    const a = hits.filter((h) => h.which === 'a').length;
    const b = hits.filter((h) => h.which === 'b').length;
    check('both markers hit the right number of times', a === PER && b === PER, `A=${a} B=${b}`);
    check('round-robin order across markers', hits.map((h) => h.which).join('') === 'ab'.repeat(PER),
      hits.map((h) => h.which).join(''));
    const span = hits[hits.length - 1].t - hits[0].t;
    check('burst span matches the 15ms gap', span > 40 && span < 250, `${span.toFixed(0)}ms`);
    check('clicks landed on the marker coordinates',
      hits.every((h) => (h.x === 140 && h.y === 150) || (h.x === 400 && h.y === 290)));
  }

  const after = await page.eval(`chrome.runtime.sendMessage({ type: 'mySchedule' })`, ctxId);
  check('schedule cleared after firing', !after.schedule);

  const run = (await page.eval(`chrome.storage.local.get('lastrun:${PAGE_URL}')`, ctxId))[`lastrun:${PAGE_URL}`];
  check('run logged with the elements it hit', !!run && run.clicks === expected && (run.sample || []).length > 0,
    run && `${run.engine} ${run.clicks}/${run.planned}, ${run.sample.length} sampled`);

  await page.eval(`chrome.storage.local.remove(['markers:${PAGE_URL}', 'lastrun:${PAGE_URL}'])`, ctxId);
}

// ------------------------------------------------- 3: hidden tab, trusted

async function testHidden(sw) {
  console.log('\n[3] background tab — trusted clicks while another tab is on screen');

  const tabId = await sw.eval(
    `chrome.tabs.query({}).then(ts => (ts.find(t => t.url === '${PAGE_URL}') || {}).id)`);
  await sw.eval(`chrome.tabs.reload(${tabId})`);
  await sleep(2000);

  // Put a different tab on screen so the target is genuinely hidden.
  const otherId = await sw.eval(
    `chrome.tabs.create({ url: '${url('other.html')}', active: true }).then(t => t.id)`);
  await sleep(1500);
  const activeIsOther = await sw.eval(
    `chrome.tabs.query({ active: true, currentWindow: true }).then(ts => ts[0].id === ${otherId})`);
  check('a different tab is on screen', activeIsOther === true);

  const armAt = timeIn(7);
  await sw.eval(`chrome.storage.local.set({
    settings: { time: '${armAt.str}', offsetMs: 0, startDelayMs: 0, burstCount: 2,
                burstIntervalMs: 20, pattern: 'roundrobin', sustainMs: 0,
                sustainGapMs: 100, trusted: true },
    'markers:${PAGE_URL}': [{ id: 1, x: 140, y: 150 }, { id: 2, x: 400, y: 290 }]
  })`);
  const res = await sw.eval(`arm(${tabId})`);
  check('armed the background tab', !!(res && res.ok), JSON.stringify(res && res.error));

  const guarded = await sw.eval(`chrome.tabs.get(${tabId}).then(t => t.autoDiscardable === false)`);
  check('tab protected from Memory Saver discard', guarded === true);

  const attached = await sw.eval(
    `chrome.debugger.getTargets().then(ts => !!(ts.find(t => t.tabId === ${tabId}) || {}).attached)`);
  check('debugger attached at arm time', attached === true);

  console.log(`      waiting ${Math.round(armAt.epoch - Date.now() + 2000)}ms for the burst…`);
  await sleep(armAt.epoch - Date.now() + 2000);

  const f = parseTitle(await waitTitle(PAGE_URL, 8000, 'clicks in the hidden tab'));
  check('the tab really was hidden when it fired', f.V === 'hidden', `visibility=${f.V}`);
  check('fired 4 clicks (2 markers x 2)', +f.HITS === 4, JSON.stringify(f));
  check('every click was real trusted input', +f.TR === 4, `trusted ${f.TR}/${f.HITS}`);
  check('both markers hit', +f.A === 2 && +f.B === 2, `A=${f.A} B=${f.B}`);
  const drift = +f.T0 - armAt.epoch;
  check('first click within 50ms of the target instant', Math.abs(drift) < 50, `drift ${drift}ms`);

  const detached = await sw.eval(
    `chrome.debugger.getTargets().then(ts => !(ts.find(t => t.tabId === ${tabId}) || {}).attached)`);
  check('debugger detached after the burst', detached === true);
  const released = await sw.eval(`chrome.tabs.get(${tabId}).then(t => t.autoDiscardable === true)`);
  check('discard protection released after the burst', released === true);

  await sw.eval(`chrome.tabs.remove(${otherId})`);
}

// ------------------------------------------------- 4: several tabs at once

async function testMulti(sw) {
  console.log('\n[4] several tabs at once — all hidden, one shared instant');

  const A = url('a.html');
  const B = url('b.html');
  const C = url('c.html');

  const ids = await sw.eval(`(async () => {
    const mk = u => chrome.tabs.create({ url: u, active: false }).then(t => t.id);
    const a = await mk('${A}'), b = await mk('${B}');
    const c = await chrome.tabs.create({ url: '${C}', active: true }).then(t => t.id);
    return { a, b, c };
  })()`);
  await sleep(2500);

  const base = timeIn(9);
  const later = { str: null, epoch: base.epoch + 1500 };
  const d = new Date(later.epoch);
  later.str = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

  // Each tab is armed from its own snapshot, so the two schedules differ.
  const armed = await sw.eval(`(async () => {
    const cfg = (time, count) => ({
      time, offsetMs: 0, startDelayMs: 0, burstCount: count, burstIntervalMs: 10,
      pattern: 'roundrobin', sustainMs: 0, sustainGapMs: 100, trusted: false
    });
    await chrome.storage.local.set({
      'markers:${A}': [{ id: 1, x: 140, y: 150 }],
      'markers:${B}': [{ id: 1, x: 140, y: 150 }, { id: 2, x: 400, y: 290 }]
    });
    await chrome.storage.local.set({ settings: cfg('${base.str}', 3) });
    const ra = await arm(${ids.a});
    await chrome.storage.local.set({ settings: cfg('${later.str}', 1) });
    const rb = await arm(${ids.b});
    const all = await getSchedules();
    return { ra, rb, count: Object.keys(all).length,
             ta: (all[${ids.a}] || {}).targetMs, tb: (all[${ids.b}] || {}).targetMs };
  })()`);

  check('both tabs armed at once', armed.count === 2, `${armed.count} schedules`);
  check('each tab kept its own instant',
    armed.ta === base.epoch && armed.tb === later.epoch,
    `A=${armed.ta - base.epoch}ms off, B=${armed.tb - later.epoch}ms off`);
  check('each tab kept its own click count',
    armed.ra.schedule.clicks === 3 && armed.rb.schedule.clicks === 2,
    `A=${armed.ra.schedule.clicks} B=${armed.rb.schedule.clicks}`);

  const activeIsC = await sw.eval(
    `chrome.tabs.query({ active: true, currentWindow: true }).then(ts => ts[0].id === ${ids.c})`);
  check('neither armed tab is on screen', activeIsC === true);

  console.log(`      waiting ${Math.round(later.epoch - Date.now() + 2500)}ms for both bursts…`);
  await sleep(later.epoch - Date.now() + 2500);

  const fa = parseTitle(await waitTitle(A, 8000, 'clicks in tab A'));
  const fb = parseTitle(await waitTitle(B, 8000, 'clicks in tab B'));

  check('tab A fired while hidden', fa.V === 'hidden' && +fa.HITS === 3, JSON.stringify(fa));
  check('tab B fired while hidden', fb.V === 'hidden' && +fb.HITS === 2, JSON.stringify(fb));
  const da = +fa.T0 - base.epoch;
  const db = +fb.T0 - later.epoch;
  check('tab A hit its own instant', Math.abs(da) < 50, `drift ${da}ms`);
  check('tab B hit its own instant', Math.abs(db) < 50, `drift ${db}ms`);
  check('the two bursts stayed 1.5s apart', Math.abs((+fb.T0 - +fa.T0) - 1500) < 60,
    `${+fb.T0 - +fa.T0}ms apart`);
  check('tab B hit both of its markers', +fb.A === 1 && +fb.B === 1, `A=${fb.A} B=${fb.B}`);

  const left = await sw.eval(`getSchedules().then(s => Object.keys(s).length)`);
  check('all schedules cleared afterwards', left === 0, `${left} left`);

  const gone = await sw.eval(`(async () => {
    await chrome.storage.local.set({ 'markers:${A}': [{ id: 1, x: 140, y: 150 }] });
    const r = await arm(${ids.a});
    await chrome.tabs.remove(${ids.a});
    await new Promise(x => setTimeout(x, 600));
    const all = await getSchedules();
    return { armed: !!(r && r.ok), left: Object.keys(all).length };
  })()`);
  check('closing a tab drops its schedule', gone.armed && gone.left === 0, JSON.stringify(gone));

  await sw.eval(`chrome.tabs.remove([${ids.b}, ${ids.c}]).catch(() => {})`);
}

// ------------------------------------------------- 5: worker eviction

// Arming hours ahead means the worker is certain to be evicted while waiting.
// It must come back on its own and still hit the instant.
async function testEviction(browser, extId) {
  console.log('\n[5] survives the service worker being evicted mid-wait');

  const D = url('d.html');
  let sw = await swClient(extId);
  const tabId = await sw.eval(`chrome.tabs.create({ url: '${D}', active: false }).then(t => t.id)`);
  await sleep(2000);

  const armAt = timeIn(45);
  await sw.eval(`chrome.storage.local.set({
    settings: { time: '${armAt.str}', offsetMs: 0, startDelayMs: 0, burstCount: 2,
                burstIntervalMs: 15, pattern: 'roundrobin', sustainMs: 0,
                sustainGapMs: 100, trusted: false },
    'markers:${D}': [{ id: 1, x: 140, y: 150 }]
  })`);
  const res = await sw.eval(`arm(${tabId})`);
  check('armed 45s out', !!(res && res.ok), JSON.stringify(res && res.error));

  const alarms = await sw.eval(`chrome.alarms.getAll().then(as => as.map(a =>
    ({ name: a.name, inMs: Math.round(a.scheduledTime - Date.now()) })))`);
  check('heartbeat alarm registered', alarms.some((a) => a.name === 'burst-tick'), JSON.stringify(alarms));
  const wake = alarms.find((a) => a.name === 'burst-at:' + tabId);
  check('wake-up alarm set ~5s before the instant',
    !!wake && Math.abs(wake.inMs - (armAt.epoch - 5000 - Date.now())) < 1500,
    wake ? `${wake.inMs}ms out, target ${armAt.epoch - Date.now()}ms out` : 'missing');

  // Kill it late: the 1/minute heartbeat cannot fire again before the target, so
  // only the wake-up alarm can rescue this schedule.
  await sleep(Math.max(0, armAt.epoch - 8000 - Date.now()));
  const swTarget = (await targetsOf('service_worker')).find((t) => t.url.includes(extId));
  sw.close();
  let killed = false;
  try {
    await browser.send('Target.closeTarget', { targetId: swTarget.id });
    killed = true;
  } catch {
    try { await browser.send('ServiceWorker.stopAllWorkers'); killed = true; } catch {}
  }
  check('worker terminated for the test', killed);

  const gone = await waitFor(async () => {
    const t = (await targetsOf('service_worker')).find((x) => x.url.includes(extId));
    return t ? null : true;
  }, 10000, 'worker to disappear').catch(() => false);
  check('worker is actually gone', gone === true);

  const killedAt = Date.now();
  const back = await waitFor(async () => {
    const t = (await targetsOf('service_worker')).find((x) => x.url.includes(extId));
    return t || null;
  }, 90000, 'worker to come back on its own');
  check('worker revived on its own, before the target',
    !!back && Date.now() < armAt.epoch,
    `revived ${Date.now() - killedAt}ms after the kill, ${armAt.epoch - Date.now()}ms before the target`);

  console.log(`      waiting ${Math.round(armAt.epoch - Date.now() + 3000)}ms for the burst…`);
  await sleep(Math.max(0, armAt.epoch - Date.now() + 3000));

  const f = parseTitle(await waitTitle(D, 10000, 'clicks after eviction'));
  check('fired after the eviction', +f.HITS === 2, JSON.stringify(f));
  check('still hidden when it fired', f.V === 'hidden', f.V);
  const drift = +f.T0 - armAt.epoch;
  check('first click still within 50ms of the instant', Math.abs(drift) < 50, `drift ${drift}ms`);

  sw = await swClient(extId);
  await sw.eval(`chrome.tabs.remove(${tabId}).catch(() => {})`);
  sw.close();
}

// ------------------------------------------------- harness

async function main() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(readFileSync(join(HERE, 'page.html')));
  }).listen(PORT);

  const profile = mkdtempSync(join(tmpdir(), 'burst-e2e-'));
  mkdirSync(join(profile, 'Default'), { recursive: true });
  writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({
    extensions: { ui: { developer_mode: true } },
    profile: { exit_type: 'Normal', exited_cleanly: true }
  }));

  const chrome = spawn(CHROME, [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-allow-origins=*',
    '--headless=new',
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--enable-unsafe-extension-debugging', '--silent-debugger-extension-api',
    '--window-size=900,700',
    PAGE_URL
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d; });

  let page = null;
  let sw = null;
  try {
    const version = await waitFor(() => http('/json/version'), 20000, 'devtools endpoint');
    const browser = await Client.open(version.webSocketDebuggerUrl);
    const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT });
    check('unpacked extension installed', !!extId, extId);
    await sleep(1500);

    sw = await swClient(extId);
    check('service worker running', !!sw);

    if (!only || only === 'input') await testInput(sw);

    if (!only || only === 'visible') {
      const target = await waitFor(async () =>
        (await targetsOf('page')).find((t) => t.url === PAGE_URL), 20000, 'test page target');
      page = await Client.open(target.webSocketDebuggerUrl);
      await page.send('Runtime.enable');
      await page.send('Page.enable');
      await page.send('Page.reload', { ignoreCache: true });
      await waitFor(() => page.events.some((e) => e.method === 'Page.loadEventFired'), 20000, 'page load');
      await sleep(900);

      // Re-enable Runtime so only live contexts are replayed; the install-time
      // injection leaves a stale one in the event log otherwise.
      await page.send('Runtime.disable');
      page.events.length = 0;
      await page.send('Runtime.enable');
      const ctx = await waitFor(() => {
        const evs = page.events.filter((e) => e.method === 'Runtime.executionContextCreated'
          && e.params.context.origin === `chrome-extension://${extId}`);
        return evs.length ? evs[evs.length - 1].params.context : null;
      }, 20000, 'content-script isolated world');
      check('content script injected into the page', ctx.name === 'Burst Clicker', ctx.name);

      await testVisible(page, ctx.id);
      page.close();
      page = null;
      await sleep(700);
    }

    if (!only || only === 'hidden') await testHidden(sw);
    if (!only || only === 'multi') await testMulti(sw);
    if (!only || only === 'evict') {
      if (sw) { sw.close(); sw = null; }
      await testEviction(browser, extId);
    }
  } catch (e) {
    check('harness completed', false, e.message);
    if (chromeErr.trim()) {
      const noise = /allocator|DEPRECATED|XNNPACK|profraw|DevTools listening|registration_request|task_policy/;
      const lines = chromeErr.trim().split('\n').filter((l) => l.trim() && !noise.test(l));
      if (lines.length) console.log('\nchrome stderr:\n' + lines.slice(-12).join('\n'));
    }
  } finally {
    if (page) page.close();
    if (sw) sw.close();
    chrome.kill('SIGKILL');
    server.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main();
