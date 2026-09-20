// The worker owns every schedule and every clock. Page timers are throttled to
// 1/second in hidden tabs (1/minute after five minutes), so a background tab can
// never be trusted to time its own burst — the worker times it and drives the
// tab, which is why an armed tab does not need to be active or on screen.
importScripts('lib/time.js', 'lib/plan.js');

const DEFAULTS = {
  time: '13:00:00.000',
  offsetMs: 0,
  startDelayMs: 0,
  burstCount: 5,
  burstIntervalMs: 20,
  pattern: 'roundrobin',
  sustainMs: 0,
  sustainGapMs: 100,
  trusted: false,
  lockToElement: true,
  stopOnHit: true,
  prewarmMs: 600
};

const K_SCHED = 'schedules';
const ALARM = 'burst-tick';
const WAKE = 'burst-at:';
const SHIELD_LEAD = 250;   // tell the page to go click-through this early
const CHUNK_LEAD = 60;     // hand a chunk over this early; the page spins the rest
const PREWARM_MIN = 300;   // resolve targets + prime hover at least this early
const KEEPALIVE_MS = 20000;

const attached = new Set();
let loopRunning = false;
let keepAliveTimer = null;
let inFlight = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function keyOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin + u.pathname;
  } catch { return null; }
}

// ---------------------------------------------------------------- storage

let ioChain = Promise.resolve();

function mutate(fn) {
  const run = async () => {
    const got = await chrome.storage.local.get(K_SCHED);
    const all = got[K_SCHED] || {};
    const out = await fn(all);
    await chrome.storage.local.set({ [K_SCHED]: all });
    return out;
  };
  const p = ioChain.then(run, run);
  ioChain = p.then(() => {}, () => {});
  return p;
}

const getSchedules = async () => (await chrome.storage.local.get(K_SCHED))[K_SCHED] || {};

const pub = (s) => s && ({
  tabId: s.tabId, urlKey: s.urlKey, targetMs: s.targetMs, trusted: s.trusted,
  clicks: s.clicks, markers: s.markers, timeText: s.timeText, title: s.title, armedAt: s.armedAt
});

// ---------------------------------------------------------------- lifetime

// Chrome 110+ resets the worker's 30s idle timer whenever the extension calls an
// API, so a heartbeat keeps us alive for as long as something is pending.
function syncKeepAlive(active) {
  if (active && !keepAliveTimer) {
    keepAliveTimer = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, KEEPALIVE_MS);
  } else if (!active && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// Two layers of revival, because a heartbeat alone can wake us after the target:
// a 1/minute tick, plus a one-shot per schedule five seconds before its instant
// so the worker is back in time to do the precise wait itself.
async function ensureAlarms() {
  const all = await getSchedules();
  const ids = Object.keys(all);

  if (ids.length) {
    if (!(await chrome.alarms.get(ALARM))) chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  } else {
    await chrome.alarms.clear(ALARM);
  }

  for (const a of await chrome.alarms.getAll()) {
    if (a.name.startsWith(WAKE) && !ids.includes(a.name.slice(WAKE.length))) await chrome.alarms.clear(a.name);
  }

  for (const id of ids) {
    const when = Math.max(Date.now() + 31000, all[id].targetMs - 5000);
    if (when >= all[id].targetMs) continue;   // too close to matter; we are awake now
    const name = WAKE + id;
    const cur = await chrome.alarms.get(name);
    if (!cur || Math.abs(cur.scheduledTime - when) > 1000) chrome.alarms.create(name, { when });
  }
}

async function waitUntil(t) {
  for (;;) {
    const left = t - Date.now();
    if (left <= 0) return;
    if (left > 2000) await sleep(left - 1500);
    else if (left > 200) await sleep(left - 150);
    else if (left > 8) await sleep(left - 6);
    else { while (Date.now() < t) { /* spin the last few ms */ } return; }
  }
}

// ---------------------------------------------------------------- debugger

async function attach(tabId) {
  if (attached.has(tabId)) return { ok: true, already: true };
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached.add(tabId);
    return { ok: true };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/already attached/i.test(msg)) { attached.add(tabId); return { ok: true, already: true }; }
    return { ok: false, error: msg };
  }
}

async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch {}
}

// ---------------------------------------------------------------- content script

async function send(tabId, msg) {
  try { return await chrome.tabs.sendMessage(tabId, msg); } catch { return null; }
}

// A page that was already open when the extension loaded has no content script.
async function ensureContentScript(tabId) {
  if (await send(tabId, { type: 'ping' })) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/time.js', 'lib/plan.js', 'content/content.js']
    });
  } catch { return false; }
  return !!(await send(tabId, { type: 'ping' }));
}

const notifyTab = (tabId, schedule) => send(tabId, { type: 'schedule', schedule: schedule || null });

// ---------------------------------------------------------------- arm / disarm

async function arm(tabId, override) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, error: 'that tab is gone' };
  const urlKey = keyOf(tab.url);
  if (!urlKey) return { ok: false, error: 'this kind of page cannot be clicked' };

  const got = await chrome.storage.local.get(['settings', 'markers:' + urlKey]);
  const settings = { ...DEFAULTS, ...(got.settings || {}), ...(override || {}) };
  const markers = got['markers:' + urlKey] || [];
  if (!markers.length) return { ok: false, error: 'place a marker on this page first' };

  const targetMs = BurstTime.nextTarget(settings.time, settings.offsetMs);
  if (targetMs == null) return { ok: false, error: `cannot read the time "${settings.time}"` };

  const plan = BurstPlan.build(markers, settings);
  if (!plan.length) return { ok: false, error: 'nothing to click' };

  // Stop-on-hit needs the page to run its own click handler between our clicks,
  // and a chunk is one uninterruptible page task — so hand them over one by one.
  const stopOnHit = settings.stopOnHit !== false && markers.some((m) => m && m.anchor);
  const sch = {
    tabId, urlKey, targetMs, timeText: settings.time,
    trusted: !!settings.trusted, clicks: plan.length, markers: markers.length,
    chunks: BurstPlan.chunk(plan, stopOnHit), span: BurstPlan.span(plan),
    stopOnHit, prewarmMs: Math.max(PREWARM_MIN, +settings.prewarmMs || 0),
    armedAt: Date.now(), title: tab.title || tab.url
  };

  const ready = await ensureContentScript(tabId);
  if (!ready && !sch.trusted) return { ok: false, error: 'cannot reach this page — reload it and try again' };

  await mutate((all) => { all[tabId] = sch; });
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  if (sch.trusted) {
    const a = await attach(tabId);
    if (!a.ok) {
      await mutate((all) => { delete all[tabId]; });
      return { ok: false, error: 'trusted mode needs the debugger: ' + a.error };
    }
  }
  await ensureAlarms();
  notifyTab(tabId, pub(sch));
  runLoop();
  return { ok: true, schedule: pub(sch) };
}

async function disarm(tabId) {
  const had = await mutate((all) => {
    const h = !!all[tabId];
    delete all[tabId];
    return h;
  });
  chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
  await detach(tabId);
  await ensureAlarms();
  notifyTab(tabId, null);
  syncKeepAlive(Object.keys(await getSchedules()).length > 0 || inFlight > 0);
  return { ok: true, was: had };
}

async function disarmAll() {
  const all = await getSchedules();
  const ids = Object.keys(all);
  for (const id of ids) await disarm(+id);
  return { ok: true, count: ids.length };
}

// ---------------------------------------------------------------- firing

async function fire(tabId, sch, reason) {
  inFlight++;
  syncKeepAlive(true);
  const started = Date.now();
  let fired = 0;
  let sample = [];
  let engine = sch.trusted ? 'trusted (CDP)' : 'synthetic';
  let note = '';

  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || keyOf(tab.url) !== sch.urlKey) {
      note = 'skipped — the tab navigated away from the page the markers belong to';
    } else {
      // Everything that can be done before the instant is done before it: the
      // page resolves each marker to its element, caches it and sends the hover
      // half of the click, so T costs one press/release/click and nothing else.
      await waitUntil(sch.targetMs - (sch.prewarmMs || PREWARM_MIN));
      const pre = await send(tabId, { type: 'burstPrewarm' });
      if (pre && pre.points) applyPoints(sch, pre.points);

      await waitUntil(sch.targetMs - SHIELD_LEAD);
      // Awaited: the page must be click-through before any real input lands.
      await send(tabId, { type: 'burstStart', clicks: sch.clicks, engine });

      let out;
      if (sch.trusted) {
        const a = await attach(tabId);
        if (a.ok) {
          out = await fireTrusted(tabId, sch);
        } else {
          engine = 'synthetic (trusted unavailable)';
          note = a.error;
          out = await fireSynthetic(tabId, sch);
        }
      } else {
        out = await fireSynthetic(tabId, sch);
      }
      fired = out.n;
      sample = out.sample;
      if (out.stopped) note = note || 'stopped early — the target was gone after the click';
    }
  } catch (e) {
    note = String((e && e.message) || e);
  }

  const record = {
    at: started, reason, engine, note, sample,
    clicks: fired, planned: sch.clicks,
    elapsed: Date.now() - started,
    targetMs: sch.targetMs, tabTitle: sch.title
  };
  await chrome.storage.local.set({ ['lastrun:' + sch.urlKey]: record });

  send(tabId, { type: 'burstEnd', record });
  await detach(tabId);
  chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
  notifyTab(tabId, null);

  inFlight--;
  syncKeepAlive(Object.keys(await getSchedules()).length > 0 || inFlight > 0);
  return record;
}

// The page just told us where each marker's element actually is now. Trusted
// clicks are dispatched at viewport coordinates by us, so they need the update;
// synthetic clicks re-resolve in the page anyway.
function applyPoints(sch, points) {
  const by = new Map(points.map((p) => [p.i, p]));
  for (const c of sch.chunks) {
    for (const s of c.steps) {
      const p = by.get(s.i);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) { s.x = p.x; s.y = p.y; }
    }
  }
}

async function fireTrusted(tabId, sch) {
  const pending = [];
  const dispatch = (params) => {
    pending.push(chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', params).catch(() => {}));
  };
  const click = (x, y) => {
    dispatch({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    dispatch({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    dispatch({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  };

  const steps = [];
  for (const c of sch.chunks) for (const s of c.steps) steps.push({ ...s, at: sch.targetMs + c.t + s.dt });

  // Park the cursor on the first target now, so the instant only carries the
  // press and the release.
  if (steps.length) dispatch({ type: 'mouseMoved', x: steps[0].x, y: steps[0].y, button: 'none', buttons: 0 });

  // A trusted click goes to whatever pixel we name, so the first one gets its
  // coordinates refreshed as late as we can afford. That is what catches a
  // dialog which only opened in the last second.
  if (sch.stopOnHit && steps.length && steps[0].at - Date.now() > 70) {
    await waitUntil(steps[0].at - 60);
    const g = await Promise.race([send(tabId, { type: 'guard', i: steps[0].i }), sleep(40).then(() => null)]);
    if (g && g.ok && g.present && Number.isFinite(g.x) && (g.x !== steps[0].x || g.y !== steps[0].y)) {
      steps[0].x = g.x;
      steps[0].y = g.y;
      dispatch({ type: 'mouseMoved', x: g.x, y: g.y, button: 'none', buttons: 0 });
    }
  }

  let n = 0;
  let stopped = false;
  let at = steps.length ? { x: steps[0].x, y: steps[0].y } : null;

  for (let k = 0; k < steps.length; k++) {
    const s = steps[k];
    await waitUntil(s.at);
    if (!at || at.x !== s.x || at.y !== s.y) dispatch({ type: 'mouseMoved', x: s.x, y: s.y, button: 'none', buttons: 0 });
    dispatch({ type: 'mousePressed', x: s.x, y: s.y, button: 'left', buttons: 1, clickCount: 1 });
    dispatch({ type: 'mouseReleased', x: s.x, y: s.y, button: 'left', buttons: 0, clickCount: 1 });
    at = { x: s.x, y: s.y };
    n++;

    const next = steps[k + 1];
    if (!sch.stopOnHit || !next) continue;
    // Ask the page, in the gap, whether the target is still there. A trusted
    // click lands on whatever is under the pixel, so a retry after the dialog
    // has closed would hit the page behind it.
    const budget = Math.max(0, Math.min(40, next.at - Date.now() - 8));
    const g = await Promise.race([send(tabId, { type: 'guard', i: next.i }), sleep(budget).then(() => null)]);
    if (g && g.ok) {
      if (!g.present) { stopped = true; break; }
      if (Number.isFinite(g.x)) { next.x = g.x; next.y = g.y; }
    }
  }

  await Promise.all(pending);
  return {
    n, stopped,
    sample: [{ ok: true, tag: `CDP dispatched ${n} trusted click${n === 1 ? '' : 's'}${stopped ? ' — stopped, target gone' : ''}` }]
  };
}

async function fireSynthetic(tabId, sch) {
  let n = 0;
  let stopped = false;
  const sample = [];
  for (const c of sch.chunks) {
    const at = sch.targetMs + c.t;
    await waitUntil(at - CHUNK_LEAD);
    // The page spins the last few ms and between clicks: hidden-tab timers are
    // too coarse, but a synchronous spin is not throttled.
    const res = await send(tabId, { type: 'burstChunk', at, steps: c.steps });
    if (res && res.count) n += res.count;
    if (res && res.sample) for (const s of res.sample) if (sample.length < 12) sample.push(s);
    // The page saw its own target disappear: the click landed, stop here rather
    // than firing the rest into whatever took its place.
    if (res && res.hit) { stopped = true; break; }
  }
  return { n, stopped, sample };
}

// ---------------------------------------------------------------- scheduler

async function prune() {
  const all = await getSchedules();
  const ids = Object.keys(all);
  if (!ids.length) return;
  const tabs = await chrome.tabs.query({});
  const live = new Map(tabs.map((t) => [String(t.id), t]));
  const dead = [];
  for (const id of ids) {
    const t = live.get(id);
    if (!t || keyOf(t.url) !== all[id].urlKey) dead.push(id);
  }
  if (dead.length) {
    await mutate((s) => { for (const id of dead) delete s[id]; });
    for (const id of dead) { detach(+id); }
  }
}

async function runLoop() {
  if (loopRunning) return;
  loopRunning = true;
  try {
    for (;;) {
      await prune();
      const all = await getSchedules();
      const ids = Object.keys(all);
      if (!ids.length) {
        syncKeepAlive(inFlight > 0);
        await ensureAlarms();
        return;
      }
      syncKeepAlive(true);

      const nextT = Math.min(...ids.map((id) => all[id].targetMs));
      await waitUntil(nextT - SHIELD_LEAD);

      const fresh = await getSchedules();
      const due = Object.keys(fresh).filter((id) => fresh[id].targetMs - Date.now() <= SHIELD_LEAD + 10);
      if (due.length) {
        // Remove first, then fire without awaiting: a long sustain on one tab
        // must not delay another tab's target.
        await mutate((s) => { for (const id of due) delete s[id]; });
        for (const id of due) fire(+id, fresh[id], 'scheduled').catch(() => {});
        await ensureAlarms();
      }
      await sleep(5);
    }
  } finally {
    loopRunning = false;
  }
}

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const senderTab = sender.tab && sender.tab.id;

  (async () => {
    switch (msg && msg.type) {
      case 'ping':
        return reply({ ok: true, now: Date.now() });

      case 'arm':
        return reply(await arm(msg.tabId != null ? msg.tabId : senderTab, msg.override));

      case 'disarm':
        return reply(await disarm(msg.tabId != null ? msg.tabId : senderTab));

      case 'disarmAll':
        return reply(await disarmAll());

      case 'testNow': {
        const tabId = msg.tabId != null ? msg.tabId : senderTab;
        const res = await arm(tabId, { time: BurstTime.fmtClock(Date.now() + 900), offsetMs: 0 });
        return reply(res);
      }

      // Tabs open before the extension was installed have no content script;
      // the popup calls this before deciding a page cannot be clicked.
      case 'ensure': {
        const tabId = msg.tabId != null ? msg.tabId : senderTab;
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab || !keyOf(tab.url)) return reply({ ok: false, error: 'not a clickable page' });
        return reply({ ok: await ensureContentScript(tabId) });
      }

      case 'mySchedule': {
        const all = await getSchedules();
        return reply({ ok: true, schedule: pub(all[msg.tabId != null ? msg.tabId : senderTab]) });
      }

      case 'list': {
        const all = await getSchedules();
        const tabs = await chrome.tabs.query({});
        const byId = new Map(tabs.map((t) => [String(t.id), t]));
        const rows = Object.keys(all).map((id) => ({
          ...pub(all[id]),
          title: (byId.get(id) || {}).title || all[id].title,
          active: !!(byId.get(id) || {}).active,
          windowId: (byId.get(id) || {}).windowId
        })).sort((a, b) => a.targetMs - b.targetMs);
        return reply({ ok: true, rows, now: Date.now() });
      }

      case 'cdp.attach':
        return reply(await attach(msg.tabId != null ? msg.tabId : senderTab));

      case 'cdp.detach':
        await detach(msg.tabId != null ? msg.tabId : senderTab);
        return reply({ ok: true });

      default:
        return reply({ ok: false, error: 'unknown message ' + (msg && msg.type) });
    }
  })();

  return true;
});

// An armed page holds a port open; harmless, but it also nudges us awake.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'burst-armed') return;
  port.onMessage.addListener(() => {});
});

// ---------------------------------------------------------------- events

chrome.runtime.onInstalled.addListener(async () => {
  const got = await chrome.storage.local.get('settings');
  if (!got.settings) await chrome.storage.local.set({ settings: { ...DEFAULTS } });
  else await chrome.storage.local.set({ settings: { ...DEFAULTS, ...got.settings } });
  await mutate((all) => { for (const k of Object.keys(all)) delete all[k]; });
  await ensureAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
  // Tab ids do not survive a browser restart.
  await mutate((all) => { for (const k of Object.keys(all)) delete all[k]; });
  await ensureAlarms();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM || a.name.startsWith(WAKE)) runLoop();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  attached.delete(tabId);
  const had = await mutate((all) => {
    const h = !!all[tabId];
    delete all[tabId];
    return h;
  });
  if (had) await ensureAlarms();
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  const all = await getSchedules();
  const sch = all[tabId];
  if (sch && keyOf(info.url) !== sch.urlKey) {
    await disarm(tabId);
  }
});

chrome.commands.onCommand.addListener(async (cmd) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  if (cmd === 'toggle-arm') {
    const all = await getSchedules();
    if (all[tab.id]) await disarm(tab.id);
    else await arm(tab.id);
    return;
  }
  const type = cmd === 'toggle-panel' ? 'panel' : cmd === 'toggle-place' ? 'place' : null;
  if (type) await send(tab.id, { type });
});

// Resume after a worker restart.
runLoop();
