// End-to-end check for Burst Clicker against a real Chrome.
//
//   node test/e2e.mjs              # every suite
//   node test/e2e.mjs input        # one suite: input | visible | anchor | hidden | multi | evict
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
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8099;
const CDP_PORT = 9333;
const url = (p) => `http://127.0.0.1:${PORT}/${p}`;
const PAGE_URL = url('page.html');
const DIALOG_URL = url('dialog.html');
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

  // This suite drives placed markers, not the auto-Yes default.
  await page.eval(`chrome.storage.local.get('settings').then(g =>
    chrome.storage.local.set({ settings: { ...g.settings, autoYes: false } }))`, ctxId);
  await sleep(200);

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
    settings: { autoYes: false, useSchedule: false, time: '${armAt.str}', offsetMs: 0, startDelayMs: 0, burstCount: 2,
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
      autoYes: false, useSchedule: false, time, offsetMs: 0, startDelayMs: 0, burstCount: count, burstIntervalMs: 10,
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
    settings: { autoYes: false, useSchedule: false, time: '${armAt.str}', offsetMs: 0, startDelayMs: 0, burstCount: 2,
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

// ------------------------------------------------- 6: locked markers

async function attachTo(extId, pageUrl) {
  const target = await waitFor(async () =>
    (await targetsOf('page')).find((t) => t.url === pageUrl), 20000, 'target ' + pageUrl);
  const page = await Client.open(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.reload', { ignoreCache: true });
  await waitFor(() => page.events.some((e) => e.method === 'Page.loadEventFired'), 20000, 'page load');
  await sleep(900);
  await page.send('Runtime.disable');
  page.events.length = 0;
  await page.send('Runtime.enable');
  const ctx = await waitFor(() => {
    const evs = page.events.filter((e) => e.method === 'Runtime.executionContextCreated'
      && e.params.context.origin === `chrome-extension://${extId}`);
    return evs.length ? evs[evs.length - 1].params.context : null;
  }, 20000, 'content-script world');
  return { page, ctxId: ctx.id };
}

const cfgFor = (timeStr, extra) => JSON.stringify({
  autoYes: false, useSchedule: false, time: timeStr, offsetMs: 0, startDelayMs: 0, burstCount: 4, burstIntervalMs: 25,
  pattern: 'roundrobin', sustainMs: 0, sustainGapMs: 100, trusted: false,
  lockToElement: true, stopOnHit: true, prewarmMs: 600, ...extra
});

// The real case this was built for: a confirm dialog that is centred, may move,
// and disappears the moment the click lands.
async function testAnchor(sw, extId) {
  console.log('\n[6] markers locked to an element — a dialog that moves, one click that lands');

  const tabId = await sw.eval(
    `chrome.tabs.create({ url: '` + DIALOG_URL + `', active: true }).then(t => t.id)`);
  await sleep(1200);
  const { page, ctxId } = await attachTo(extId, DIALOG_URL);

  const armAt = timeIn(7);
  await sw.eval(`chrome.storage.local.set({ settings: ${cfgFor(armAt.str)} })`);
  await sleep(400);

  const placed = await page.eval(`(() => {
    const r = document.getElementById('yes').getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const sr = document.getElementById('burst-clicker-root').shadowRoot;
    sr.querySelector('[data-a="place"]').click();
    sr.querySelector('.capture').dispatchEvent(new PointerEvent('pointerdown',
      { clientX: x, clientY: y, bubbles: true, cancelable: true }));
    sr.querySelector('[data-a="place"]').click();
    return { x, y };
  })()`);

  const key = 'markers:' + DIALOG_URL;
  const mk = (await page.eval(`chrome.storage.local.get('${key}')`, ctxId))[key];
  const anchor = mk && mk[0] && mk[0].anchor;
  check('the marker locks onto the button under it',
    !!anchor && anchor.tag === 'button' && anchor.text === 'Yes',
    anchor ? `<${anchor.tag}> "${anchor.text}" via ${anchor.sel}` : 'no anchor stored');

  const res = await sw.eval(`arm(${tabId})`);
  check('armed the dialog tab', !!(res && res.ok), JSON.stringify(res && res.error));
  const sch = await sw.eval(`getSchedules().then(a => a[${tabId}])`);
  check('stop-on-hit splits the burst into one click per chunk',
    !!sch && sch.stopOnHit === true && sch.chunks.length === sch.clicks,
    sch && `${sch.chunks.length} chunks for ${sch.clicks} clicks`);

  // Move the dialog AFTER arming: the coordinates are resolved at fire time.
  await page.eval(`window.__shift(150, 60)`);

  console.log(`      waiting ${Math.round(armAt.epoch - Date.now() + 1800)}ms for the burst…`);
  await sleep(Math.max(0, armAt.epoch - Date.now() + 1800));

  const hits = await page.eval('window.__hits');
  const bg = await page.eval('window.__bg');
  check('the moved button still got clicked', hits.length >= 1, `${hits.length} hits`);
  if (hits.length) {
    check('the click landed inside the button, not on its old pixel', hits[0].inside === true,
      `click at ${hits[0].x},${hits[0].y} · marker was dropped at ${placed.x},${placed.y}`);
    check('the marker followed the dialog', Math.abs(hits[0].x - placed.x) > 40,
      `moved ${Math.abs(hits[0].x - placed.x)}px`);
    const drift = hits[0].wall - armAt.epoch;
    const tr = (await page.eval(`chrome.storage.local.get('lastrun:${DIALOG_URL}')`, ctxId))['lastrun:' + DIALOG_URL];
    check('first click within 50ms of the instant', Math.abs(drift) < 50,
      `wall-clock drift ${drift}ms · perf-clock ${(hits[0].t - armAt.epoch).toFixed(1)}ms · ${JSON.stringify(tr && { timing: tr.timing, stages: tr.stages })}`);
  }
  check('one successful click ended the burst', hits.length === 1, `${hits.length} of 4 planned`);
  check('no retry leaked onto the page behind the closed dialog', bg === 0, `${bg} background clicks`);

  const runKey = 'lastrun:' + DIALOG_URL;
  const run = (await page.eval(`chrome.storage.local.get('${runKey}')`, ctxId))[runKey];
  check('the run is logged as a deliberate early stop',
    !!run && run.clicks === 1 && /stopped early/.test(run.note || ''),
    run && `${run.clicks}/${run.planned} · ${run.note}`);
  check('the click is reported against the button it hit',
    !!run && (run.sample || []).some((s) => /yes/i.test(s.tag || '')),
    run && JSON.stringify((run.sample || [])[0]));

  // Control: the same move with the lock off is exactly the miss this prevents.
  const armB = timeIn(6);
  await page.eval(`window.__reopen()`);
  await sw.eval(`chrome.storage.local.remove(['${key}', '${runKey}'])`);
  await sw.eval(`chrome.storage.local.set({ settings: ${cfgFor(armB.str, { lockToElement: false, burstCount: 1 })} })`);
  await sleep(400);
  await page.eval(`(() => {
    const r = document.getElementById('yes').getBoundingClientRect();
    const sr = document.getElementById('burst-clicker-root').shadowRoot;
    sr.querySelector('[data-a="place"]').click();
    sr.querySelector('.capture').dispatchEvent(new PointerEvent('pointerdown',
      { clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2),
        bubbles: true, cancelable: true }));
    sr.querySelector('[data-a="place"]').click();
  })()`);
  const plain = (await page.eval(`chrome.storage.local.get('${key}')`, ctxId))[key];
  check('with the lock off the marker is a bare coordinate', !!(plain && plain[0] && !plain[0].anchor));
  await sw.eval(`arm(${tabId})`);
  await page.eval(`window.__shift(260, 0)`);
  await sleep(Math.max(0, armB.epoch - Date.now() + 1500));
  const missed = await page.eval('window.__hits');
  const missBg = await page.eval('window.__bg');
  check('a fixed coordinate misses the dialog once it moves',
    missed.length === 0 && missBg > 0, `${missed.length} hits, ${missBg} background clicks`);

  page.close();
  await sw.eval(`chrome.tabs.remove(${tabId}).catch(() => {})`);
  await sw.eval(`chrome.storage.local.remove(['${key}', '${runKey}'])`);
}

// ------------------------------------------------- 8: auto-Yes, no markers

// No marker is ever placed: the page is scanned for "Yes" at the instant. Run
// in a background tab, synthetic and trusted, plus a Yes that only appears
// after the instant, which must be clicked the moment it exists — once.
async function testAutoYes(sw) {
  console.log('\n[8] auto-click "Yes" — no markers, weekday/weekend schedule');

  const rule = await sw.eval(`(() => {
    const at = (d, h, mi = 0) => new Date(2026, 9, d, h, mi).getTime();   // Oct 2026
    const f = (ms) => { const d = new Date(ms); return d.getDay() + '@' + d.getHours() + ':' + d.getMinutes(); };
    return [
      f(BurstTime.nextScheduled('13:00', '10:00', 0, at(21, 9))),       // Wed 9am  -> Wed 13:00
      f(BurstTime.nextScheduled('13:00', '10:00', 0, at(23, 13, 30))), // Fri 1:30 -> Sat 10:00
      f(BurstTime.nextScheduled('13:00', '10:00', 0, at(25, 11)))       // Sun 11am -> Mon 13:00
    ];
  })()`);
  check('schedule: 1 pm on weekdays, 10 am on weekends', rule.join() === '3@13:0,6@10:0,1@13:0', rule.join());

  // Earlier suites overwrite stored settings, so read what a fresh install gets.
  const defaults = await sw.eval(`DEFAULTS`);
  check('auto-Yes and the schedule are on by default',
    defaults && defaults.autoYes === true && defaults.useSchedule === true &&
    defaults.weekdayTime === '13:00:00.000' && defaults.weekendTime === '10:00:00.000',
    defaults && `${defaults.autoYes}/${defaults.useSchedule} ${defaults.weekdayTime} ${defaults.weekendTime}`);

  const mKey = 'markers:' + DIALOG_URL;
  const rKey = 'lastrun:' + DIALOG_URL;
  const fKey = 'firedBase:' + DIALOG_URL;
  const cfg = (str, extra) => cfgFor(str, { autoYes: true, yesText: 'Yes', autoWindowMs: 3000, autoSync: false, ...extra });

  for (const trusted of [false, true]) {
    const label = trusted ? 'trusted' : 'synthetic';
    const tabId = await sw.eval(
      `chrome.tabs.create({ url: '` + DIALOG_URL + `', active: false }).then(t => t.id)`);
    await sleep(1500);
    const inMain = (body) => sw.eval(`chrome.scripting.executeScript({
      target: { tabId: ${tabId} }, world: 'MAIN', func: () => (${body})
    }).then(r => r[0].result)`);

    await sw.eval(`chrome.storage.local.remove(['${mKey}', '${rKey}', '${fKey}', 'enabledUrls'])`);
    const armAt = timeIn(6);
    await sw.eval(`chrome.storage.local.set({ settings: ${cfg(armAt.str, { trusted })} })`);
    const res = await sw.eval(`arm(${tabId})`);
    check(`[${label}] armed with no markers placed`, !!(res && res.ok), JSON.stringify(res && res.error));
    // Move the dialog after arming: nothing about the button is known in advance.
    await inMain(`window.__shift(120, 40)`);

    if (!trusted) {
      // The page shows which Yes it found: a ring over the button, following it.
      await sleep(900);
      const pv = await inMain(`(() => {
        const sr = document.getElementById('burst-clicker-root').shadowRoot;
        const ring = sr.querySelector('.pv-ring'), tag = sr.querySelector('.pv-tag');
        const a = ring.getBoundingClientRect(), b = document.getElementById('yes').getBoundingClientRect();
        return { shown: getComputedStyle(ring).display !== 'none', tag: tag.textContent,
          covers: a.left <= b.left && a.top <= b.top && a.right >= b.right && a.bottom >= b.bottom };
      })()`);
      check('[preview] the Yes it will click is ringed on the page', pv.shown && pv.covers, pv.tag);
    }

    await sleep(Math.max(0, armAt.epoch - Date.now() + 1800));
    const hits = await inMain('window.__hits');
    const bg = await inMain('window.__bg');
    check(`[${label}] found and clicked Yes exactly once`, hits.length === 1, `${hits.length} hits`);
    if (hits.length) {
      // wall = the page's Date.now() in the click handler: the clock "1 pm" is
      // read from. timeOrigin + timeStamp can drift from it by tens of ms.
      const drift = hits[0].wall - armAt.epoch;
      const run = await sw.eval(`chrome.storage.local.get('${rKey}').then(g => g['${rKey}'] || null)`);
      check(`[${label}] click within 50ms of the instant`, Math.abs(drift) < 50,
        `wall-clock drift ${drift}ms · perf-clock ${(hits[0].t - armAt.epoch).toFixed(1)}ms · timing ${JSON.stringify(run && run.timing)}`);
      check(`[${label}] tab was in the background`, hits[0].vis === 'hidden', hits[0].vis);
      check(`[${label}] click landed inside the Yes button`, hits[0].inside === true, `${hits[0].x},${hits[0].y}`);
      if (trusted) check(`[${label}] the click was trusted input`, hits[0].trusted === true);
    }
    check(`[${label}] nothing behind the dialog was clicked`, bg === 0, `${bg} background clicks`);

    if (!trusted) {
      // Turned on once, it stays on: armed again for the next day by itself.
      const next = await sw.eval(`getSchedules().then(a => a[${tabId}] || null)`);
      check('[daily] re-armed itself for the same time tomorrow',
        !!next && next.repeat === true && Math.abs(next.targetMs - armAt.epoch - 86400000) < 2000,
        next ? `next in ${((next.targetMs - Date.now()) / 3600000).toFixed(2)}h` : 'no schedule');
      const enabled = await sw.eval(`chrome.storage.local.get('enabledUrls').then(g => g.enabledUrls || [])`);
      check('[daily] the page is remembered as enabled', enabled.includes(DIALOG_URL), JSON.stringify(enabled));

      // Clicking Yes often navigates away; an auto-Yes tab stays on.
      await sw.eval(`chrome.tabs.update(${tabId}, { url: '${PAGE_URL}' })`);
      await sleep(1500);
      const kept = await sw.eval(`getSchedules().then(a => a[${tabId}] || null)`);
      check('[daily] still on after the tab navigated to another page', !!kept && kept.urlKey === DIALOG_URL,
        kept ? kept.urlKey : 'dropped');

      // Restart / reopen: any tab that shows the enabled page arms itself.
      const other = await sw.eval(`chrome.tabs.create({ url: '${DIALOG_URL}', active: false }).then(t => t.id)`);
      await sleep(2000);
      const auto = await sw.eval(`getSchedules().then(a => a[${other}] || null)`);
      check('[daily] reopening the page arms the new tab with no clicks', !!auto && auto.auto === true,
        auto ? new Date(auto.targetMs).toString().slice(0, 24) : 'not armed');
      await sw.eval(`mutate(a => { for (const k of Object.keys(a)) delete a[k]; }).then(() => restoreEnabled())`);
      const restored = await sw.eval(`getSchedules().then(a => [!!a[${other}], Object.keys(a).length])`);
      check('[daily] after a restart wipes schedules, enabled tabs are re-armed', restored[0] === true,
        JSON.stringify(restored));

      // Turning it off is sticky: the page is forgotten.
      await sw.eval(`disable(${other})`);
      const after = await sw.eval(`chrome.storage.local.get('enabledUrls').then(g => g.enabledUrls || [])`);
      check('[daily] turning it off forgets the page', !after.includes(DIALOG_URL), JSON.stringify(after));
      await sw.eval(`chrome.tabs.remove(${other}).catch(() => {})`);
    }
    await sw.eval(`chrome.tabs.remove(${tabId}).catch(() => {})`);
    await sleep(400);
  }

  // A Yes that does not exist at the instant: keep looking, click on arrival.
  const tabId = await sw.eval(
    `chrome.tabs.create({ url: '` + DIALOG_URL + `', active: true }).then(t => t.id)`);
  await sleep(1500);
  const inMain = (body) => sw.eval(`chrome.scripting.executeScript({
    target: { tabId: ${tabId} }, world: 'MAIN', func: () => (${body})
  }).then(r => r[0].result)`);
  await inMain(`(document.getElementById('modal').remove(), true)`);
  await sw.eval(`chrome.storage.local.remove(['${fKey}', 'enabledUrls'])`);
  const armAt = timeIn(5);
  await sw.eval(`chrome.storage.local.set({ settings: ${cfg(armAt.str)} })`);
  const res = await sw.eval(`arm(${tabId})`);
  check('[late] armed while there is no Yes on the page', !!(res && res.ok), JSON.stringify(res && res.error));
  await sleep(900);
  const miss = await inMain(`(() => {
    const sr = document.getElementById('burst-clicker-root').shadowRoot;
    const tag = sr.querySelector('.pv-tag');
    return { shown: getComputedStyle(tag).display !== 'none', miss: tag.classList.contains('miss'), text: tag.textContent };
  })()`);
  check('[preview] with no Yes on screen it says so', miss.shown && miss.miss, miss.text);
  await sleep(Math.max(0, armAt.epoch - Date.now() + 400));
  const opened = await inMain(`(window.__reopen(), performance.timeOrigin + performance.now())`);
  await sleep(1500);
  const hits = await inMain('window.__hits');
  check('[late] the Yes that appeared after the instant was clicked once', hits.length === 1, `${hits.length} hits`);
  if (hits.length) {
    const lag = hits[0].t - opened;
    check('[late] clicked within 50ms of it appearing', lag >= 0 && lag < 50, `${lag.toFixed(1)}ms after it appeared`);
  }
  check('[late] nothing behind the dialog was clicked', (await inMain('window.__bg')) === 0);

  await sw.eval(`chrome.tabs.remove(${tabId}).catch(() => {})`);

  // The site's clock decides who was first. Serve a page whose clock runs
  // 700ms ahead: the click must go out on the site's instant, 700ms early here.
  const SKEW = 700;
  const sTab = await sw.eval(
    `chrome.tabs.create({ url: '` + DIALOG_URL + `?skew=${SKEW}', active: false }).then(t => t.id)`);
  await sleep(1500);
  const inS = (body) => sw.eval(`chrome.scripting.executeScript({
    target: { tabId: ${sTab} }, world: 'MAIN', func: () => (${body})
  }).then(r => r[0].result)`);
  await sw.eval(`chrome.storage.local.remove(['${fKey}', 'enabledUrls'])`);
  const syncAt = timeIn(12);
  await sw.eval(`chrome.storage.local.set({ settings: ${cfg(syncAt.str, { autoSync: true })} })`);
  const sres = await sw.eval(`arm(${sTab})`);
  check('[sync] armed against a site whose clock is 700ms ahead', !!(sres && sres.ok), JSON.stringify(sres && sres.error));
  // Read before the worker takes the schedule out to fire it (1.5s ahead).
  await sleep(Math.max(0, syncAt.epoch - Date.now() - 3000));
  const synced = await sw.eval(`getSchedules().then(a => a[${sTab}] || null)`);
  check('[sync] measured the site clock before the instant',
    !!synced && /^site clock/.test(synced.syncNote || '') && Math.abs((synced.skew || 0) - SKEW) <= 30,
    synced ? synced.syncNote : 'no schedule');
  await sleep(Math.max(0, syncAt.epoch - Date.now() + 1200));
  const sh = await inS('window.__hits');
  check('[sync] clicked once', sh.length === 1, `${sh.length} hits`);
  if (sh.length) {
    const vsSite = sh[0].wall - (syncAt.epoch - SKEW);
    check('[sync] the click landed on the site\'s instant (within 30ms)', Math.abs(vsSite) <= 30,
      `${vsSite.toFixed(1)}ms vs the site's ${syncAt.str}, ${sh[0].wall - syncAt.epoch}ms vs this machine`);
  }
  const nextS = await sw.eval(`getSchedules().then(a => a[${sTab}] || null)`);
  check('[sync] fired early, yet did not re-arm for the same instant', !!nextS && nextS.targetMs - Date.now() > 3600000,
    nextS ? `next in ${((nextS.targetMs - Date.now()) / 3600000).toFixed(1)}h` : 'none');

  await sw.eval(`chrome.tabs.remove(${sTab}).catch(() => {})`);
  await sw.eval(`chrome.storage.local.remove(['${mKey}', '${rKey}', '${fKey}', 'enabledUrls'])`);

  // The real morning: 6 lead pages open in background tabs, each with its own
  // Yes, one of them disabled until the instant. One click turns them all on;
  // all six must land on the same instant.
  const N = 6;
  const tabs = [];
  for (let i = 0; i < N; i++) {
    tabs.push(await sw.eval(`chrome.tabs.create({ url: '${DIALOG_URL}?lead=${i}', active: false }).then(t => t.id)`));
  }
  await sleep(2500);
  const inTab = (id, body) => sw.eval(`chrome.scripting.executeScript({
    target: { tabId: ${id} }, world: 'MAIN', func: () => (${body})
  }).then(r => r[0].result)`);
  await inTab(tabs[N - 1], `(document.getElementById('yes').disabled = true, true)`);

  const multiAt = timeIn(9);
  await sw.eval(`chrome.storage.local.set({ settings: ${cfg(multiAt.str)} })`);
  const all = await sw.eval(`armAllWithYes()`);
  check(`[multi] one click turned on all ${N} tabs with a Yes`, all.armed === N, JSON.stringify(all));
  check('[multi] a tab without a Yes was left off', all.noYes >= 1, `${all.noYes} left off`);

  await sleep(1500);
  const dis = await inTab(tabs[N - 1], `(() => {
    const sr = document.getElementById('burst-clicker-root').shadowRoot;
    return sr.querySelector('.pv-tag').textContent;
  })()`);
  check('[multi] a disabled Yes is shown as found-but-waiting', /disabled/.test(dis), dis);

  // Enable it 150ms after the instant, as a site would at 1 pm.
  await sleep(Math.max(0, multiAt.epoch - Date.now() + 150));
  const enabledAt = await inTab(tabs[N - 1], `(document.getElementById('yes').disabled = false, Date.now())`);
  await sleep(2500);

  const drifts = [];
  let ok = 0;
  for (let i = 0; i < N; i++) {
    const h = await inTab(tabs[i], 'window.__hits');
    if (h.length === 1) ok++;
    if (h.length) drifts.push(i === N - 1 ? h[0].wall - enabledAt : h[0].wall - multiAt.epoch);
  }
  check(`[multi] every tab clicked its Yes exactly once`, ok === N, `${ok}/${N}`);
  const onTime = drifts.slice(0, N - 1);
  check('[multi] the five enabled ones all within 30ms of the instant', onTime.length === N - 1 && onTime.every((d) => Math.abs(d) <= 30),
    `drifts ${onTime.join(', ')}ms`);
  check('[multi] the disabled one was clicked as soon as it enabled', drifts.length === N && drifts[N - 1] >= 0 && drifts[N - 1] < 50,
    `${drifts[N - 1]}ms after it enabled`);

  for (const id of tabs) await sw.eval(`chrome.tabs.remove(${id}).catch(() => {})`);
  await sw.eval(`chrome.storage.local.remove(['${mKey}', '${rKey}', '${fKey}', 'enabledUrls'])`);
}

// ------------------------------------------------- 7: locked + trusted + hidden

// The hardest combination: a background tab, real trusted input dispatched by
// the worker at viewport coordinates, and a target that moves and then vanishes.
// No page client here — trusted mode needs chrome.debugger to itself.
async function testAnchorTrusted(sw) {
  console.log('\n[7] locked marker + trusted clicks + hidden tab');

  const mKey = 'markers:' + DIALOG_URL;
  const rKey = 'lastrun:' + DIALOG_URL;

  const tabId = await sw.eval(
    `chrome.tabs.create({ url: '` + DIALOG_URL + `', active: false }).then(t => t.id)`);
  await sleep(1500);

  const inMain = (body) => sw.eval(`chrome.scripting.executeScript({
    target: { tabId: ${tabId} }, world: 'MAIN', func: () => (${body})
  }).then(r => r[0].result)`);

  const box = await inMain(`(() => { const r = document.getElementById('yes').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  check('found the dialog button in the background tab', !!(box && box.w > 0), JSON.stringify(box));

  const armAt = timeIn(8);
  const marker = JSON.stringify([{
    id: 1, x: box.x, y: box.y,
    anchor: { sel: '#yes', tag: 'button', text: 'Yes', w: box.w, h: box.h, rx: 0.5, ry: 0.5 }
  }]);
  await sw.eval(`chrome.storage.local.set({
    settings: ${cfgFor(armAt.str, { trusted: true, burstCount: 3, burstIntervalMs: 40 })},
    ${JSON.stringify(mKey)}: ${marker}
  })`);

  const res = await sw.eval(`arm(${tabId})`);
  check('armed the hidden tab in trusted mode', !!(res && res.ok), JSON.stringify(res && res.error));

  // Move it after arming, as a real dialog would move on a resize.
  await inMain('window.__shift(120, 80)');

  console.log(`      waiting ${Math.round(armAt.epoch - Date.now() + 2200)}ms for the burst…`);
  await sleep(Math.max(0, armAt.epoch - Date.now() + 2200));

  const t = parseTitle(await waitTitle(DIALOG_URL, 8000, 'trusted click on the moved dialog'));
  check('the moved button was hit by real input', +t.HITS === 1 && +t.TR === 1, JSON.stringify(t));
  check('it was hidden when it fired', t.V === 'hidden', t.V);
  check('the two spare clicks never reached the page behind it', +t.BG === 0, `BG=${t.BG}`);
  const drift = +t.T0 - armAt.epoch;
  check('trusted click within 50ms of the instant', Math.abs(drift) < 50, `drift ${drift}ms`);

  const run = await sw.eval(`chrome.storage.local.get(${JSON.stringify(rKey)}).then(g => g[${JSON.stringify(rKey)}])`);
  check('the trusted run stopped itself after the hit',
    !!run && run.clicks === 1 && /stopped/.test((run.note || '') + (run.sample || []).map((x) => x.tag).join('')),
    run && `${run.clicks}/${run.planned} · ${run.engine} · ${run.note}`);

  // Phase 2: the dialog is not even on screen when the burst is prepared — it
  // opens, moved, a few hundred ms before the instant. Only a late re-resolve
  // can hit it.
  const lateAt = timeIn(9);
  await sw.eval(`chrome.storage.local.set({
    settings: ${cfgFor(lateAt.str, { trusted: true, burstCount: 3, burstIntervalMs: 40 })},
    ${JSON.stringify(mKey)}: ${marker}
  })`);
  const res2 = await sw.eval(`arm(${tabId})`);
  check('armed with no dialog on screen at all', !!(res2 && res2.ok), JSON.stringify(res2 && res2.error));

  await sleep(Math.max(0, lateAt.epoch - 450 - Date.now()));
  const opened = await inMain('(() => { const ok = window.__reopen(); window.__shift(120, 80); return ok; })()');
  check('the dialog opened late, after the burst was already prepared', opened === true, String(opened));

  await sleep(Math.max(0, lateAt.epoch - Date.now() + 2200));
  const t2 = parseTitle(await waitTitle(DIALOG_URL, 8000, 'trusted click on the late dialog'));
  check('the late dialog was still hit on the instant', +t2.HITS === 1 && +t2.TR === 1, JSON.stringify(t2));
  check('nothing was clicked behind the late dialog', +t2.BG === 0, `BG=${t2.BG}`);
  const lateDrift = +t2.T0 - lateAt.epoch;
  check('late dialog click within 50ms of the instant', Math.abs(lateDrift) < 50, `drift ${lateDrift}ms`);

  await sw.eval(`chrome.tabs.remove(${tabId}).catch(() => {})`);
  await sw.eval(`chrome.storage.local.remove([${JSON.stringify(mKey)}, ${JSON.stringify(rKey)}])`);
}

// ------------------------------------------------- harness

async function main() {
  const server = createServer((req, res) => {
    const file = req.url.startsWith('/dialog') ? 'dialog.html' : 'page.html';
    // ?skew=N plays a site whose clock runs N ms ahead of this machine.
    const skew = +(new URL(req.url, 'http://x').searchParams.get('skew') || 0);
    if (skew) res.setHeader('Date', new Date(Date.now() + skew).toUTCString());
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(readFileSync(join(HERE, file)));
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

    if (!only || only === 'anchor') { await testAnchor(sw, extId); await testAnchorTrusted(sw); }
    if (only === 'trusted-anchor') await testAnchorTrusted(sw);
    if (!only || only === 'auto') await testAutoYes(sw);
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
