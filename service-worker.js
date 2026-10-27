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
  prewarmMs: 600,
  autoYes: true,
  yesText: 'Yes',
  autoWindowMs: 3000,
  useSchedule: true,
  weekdayTime: '13:00:00.000',
  weekendTime: '10:00:00.000',
  autoSync: true
};

const K_SCHED = 'schedules';
const ALARM = 'burst-tick';
const WAKE = 'burst-at:';
const PREP_WAKE = 'burst-prep:';
const SHIELD_LEAD = 400;   // tell the page to go click-through this early
// Start the fire sequence this early. Everything before the final hand-off
// (storage, tab lookup, prewarm and shield round trips to a background tab) has
// to fit in here; at 250ms it sometimes did not, and the click went out late.
const FIRE_LEAD = 1500;
const CHUNK_LEAD = 150;    // hand a chunk over this early; the page spins the rest
                           // (a message to a hidden tab can take 60–90ms to land)
const PREWARM_MIN = 900;   // resolve targets + prime hover at least this early
const KEEPALIVE_MS = 20000;
const PREP_LEAD = 20000;   // inject the page script + measure the server clock this early
const K_ENABLED = 'enabledUrls';

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
  clicks: s.clicks, markers: s.markers, timeText: s.timeText, title: s.title, armedAt: s.armedAt,
  auto: !!s.auto, repeat: !!s.repeat, yesText: s.yesText, skew: s.skew, syncNote: s.syncNote
});

// Pages auto-Yes is switched on for. Survives restarts and extension updates,
// which both wipe the tab-keyed schedules: any tab showing one of these pages
// is armed again on its own.
const getEnabled = async () => (await chrome.storage.local.get(K_ENABLED))[K_ENABLED] || [];

async function setEnabled(urlKey, on) {
  const list = await getEnabled();
  const has = list.includes(urlKey);
  if (on && !has) await chrome.storage.local.set({ [K_ENABLED]: [...list, urlKey] });
  if (!on && has) await chrome.storage.local.set({ [K_ENABLED]: list.filter((u) => u !== urlKey) });
}

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
    for (const pre of [WAKE, PREP_WAKE]) {
      if (a.name.startsWith(pre) && !ids.includes(a.name.slice(pre.length))) await chrome.alarms.clear(a.name);
    }
  }

  // The early one is back in time for prep (page script + site-clock sync);
  // the late one still catches an eviction that happens after prep.
  for (const id of ids) {
    for (const [pre, lead] of [[PREP_WAKE, 30000], [WAKE, 5000]]) {
      const when = Math.max(Date.now() + 31000, all[id].targetMs - lead);
      if (when >= all[id].targetMs) continue;   // too close to matter; we are awake now
      const name = pre + id;
      const cur = await chrome.alarms.get(name);
      if (!cur || Math.abs(cur.scheduledTime - when) > 1000) chrome.alarms.create(name, { when });
    }
  }
}

// A zero-delay task that is not a timer. In a background browser the OS
// coalesces timers, and setTimeout was measured waking 60–90ms late; a
// MessageChannel hop is not subject to that, and still lets replies from the
// page through between hops.
function yieldNow() {
  return new Promise((r) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => { c.port1.close(); r(); };
    c.port2.postMessage(0);
  });
}

// Timers only for the long haul; the last 400ms is a cooperative spin, and the
// final 2ms a hard one.
async function waitUntil(t) {
  for (;;) {
    const left = t - Date.now();
    if (left <= 0) return;
    if (left > 2000) await sleep(left - 1500);
    else if (left > 400) await sleep(left - 300);
    else if (left > 2) await yieldNow();
    else { while (Date.now() < t) { /* spin the last few ms */ } return; }
  }
}

// Wait for a reply from the page, but never past `deadline`.
const within = (p, deadline) => Promise.race([p, waitUntil(deadline).then(() => null)]);

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

// opts.urlKey: keep an auto-Yes tab tied to the page it was enabled on, even
// after clicking Yes navigated it somewhere else.
async function arm(tabId, override, opts = {}) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, error: 'that tab is gone' };
  if (!keyOf(tab.url)) return { ok: false, error: 'this kind of page cannot be clicked' };
  const urlKey = opts.urlKey || keyOf(tab.url);

  const got = await chrome.storage.local.get(['settings', 'markers:' + urlKey, 'firedBase:' + urlKey]);
  const settings = { ...DEFAULTS, ...(got.settings || {}), ...(override || {}) };
  const auto = settings.autoYes !== false;

  // Auto-Yes needs no markers: the page is scanned for the button at fire time.
  // The one virtual marker only gives the plan something to hang its clicks on.
  const markers = auto ? [{ x: -1, y: -1, auto: true }] : (got['markers:' + urlKey] || []);
  if (!markers.length) return { ok: false, error: 'place a marker on this page first' };

  // Never the instant that just fired: with the site's clock ahead, the click
  // goes out before the local 1 pm, and re-arming then would pick 1 pm again.
  const floor = auto && !(override && override.oneShot) ? (got['firedBase:' + urlKey] || 0) + 60000 : 0;
  const targetMs = BurstTime.targetFor(settings, Math.max(Date.now(), floor));
  if (targetMs == null) return { ok: false, error: `cannot read the time "${settings.time}"` };
  const offsetMs = Number.isFinite(+settings.offsetMs) ? +settings.offsetMs : 0;

  // Auto mode is a short retry window rather than a fixed burst: click the
  // instant a Yes exists, and stop on the first click that lands.
  const gap = 10;
  const planSettings = auto
    ? { ...settings, pattern: 'roundrobin', burstIntervalMs: gap, sustainMs: 0,
        burstCount: Math.max(1, Math.min(500, Math.ceil((+settings.autoWindowMs || 3000) / gap))) }
    : settings;
  const plan = BurstPlan.build(markers, planSettings);
  if (!plan.length) return { ok: false, error: 'nothing to click' };

  // Stop-on-hit needs the page to run its own click handler between our clicks,
  // and a chunk is one uninterruptible page task — so hand them over one by one.
  const stopOnHit = auto || (settings.stopOnHit !== false && markers.some((m) => m && m.anchor));
  const sch = {
    tabId, urlKey, targetMs, timeText: auto || settings.useSchedule !== false ? 'schedule' : settings.time,
    trusted: !!settings.trusted, clicks: plan.length, markers: markers.length,
    chunks: BurstPlan.chunk(plan, stopOnHit), span: BurstPlan.span(plan),
    stopOnHit, auto, yesText: String(settings.yesText || 'Yes').trim().toLowerCase(),
    // Auto-Yes keeps going: after each fire the tab is armed for the next
    // weekday/weekend instant. The instant is re-aligned to the site's own
    // clock shortly before each fire (prep), replacing the manual offset.
    repeat: auto && !(override && override.oneShot),
    baseMs: targetMs - offsetMs, offsetMs, autoSync: auto && settings.autoSync !== false, prepped: false,
    prewarmMs: Math.max(PREWARM_MIN, +settings.prewarmMs || 0),
    armedAt: Date.now(), title: tab.title || tab.url
  };

  // Auto-Yes tolerates a page that is not loaded yet (a tab restored after a
  // restart): the script is injected again during prep, before the instant.
  const ready = await ensureContentScript(tabId);
  if (!ready && !sch.trusted && !auto) return { ok: false, error: 'cannot reach this page — reload it and try again' };

  await mutate((all) => { all[tabId] = sch; });
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  if (sch.trusted) {
    const a = await attach(tabId);
    if (!a.ok) {
      await mutate((all) => { delete all[tabId]; });
      return { ok: false, error: 'trusted mode needs the debugger: ' + a.error };
    }
  }
  if (sch.repeat) await setEnabled(urlKey, true);
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

// What the person asked for: stop this tab, and stop re-arming its page.
async function disable(tabId) {
  const all = await getSchedules();
  if (all[tabId]) await setEnabled(all[tabId].urlKey, false);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const key = tab && keyOf(tab.url);
  if (key) await setEnabled(key, false);
  return disarm(tabId);
}

async function disarmAll() {
  const all = await getSchedules();
  const ids = Object.keys(all);
  for (const id of ids) await disable(+id);
  await chrome.storage.local.set({ [K_ENABLED]: [] });
  return { ok: true, count: ids.length };
}

// One click for many lead pages: turn on every open tab that shows a Yes
// (enabled or not yet) and is not already on.
async function armAllWithYes() {
  const got = await chrome.storage.local.get('settings');
  const want = String({ ...DEFAULTS, ...(got.settings || {}) }.yesText || 'Yes').trim().toLowerCase();
  const all = await getSchedules();
  const out = { ok: true, armed: 0, already: 0, noYes: 0 };
  for (const t of await chrome.tabs.query({})) {
    if (t.id == null || !keyOf(t.url)) continue;
    if (all[t.id]) { out.already++; continue; }
    const r = (await ensureContentScript(t.id)) ? await send(t.id, { type: 'hasYes', want }) : null;
    if (!(r && r.found)) { out.noYes++; continue; }
    const res = await arm(t.id);
    if (res.ok) out.armed++; else out.noYes++;
  }
  return out;
}

async function restoreEnabled() {
  const urls = await getEnabled();
  if (!urls.length) return;
  const all = await getSchedules();
  for (const t of await chrome.tabs.query({})) {
    if (t.id != null && !all[t.id] && urls.includes(keyOf(t.url))) await arm(t.id).catch(() => {});
  }
}

// ---------------------------------------------------------------- server clock

// One HEAD request: the server's Date header (whole seconds only) and the
// local midpoint of the round trip, when the server most likely stamped it.
let probeSeq = 0;

async function probe(url) {
  // A unique URL per probe: Chrome holds identical in-flight requests behind
  // one another, which would skew the timing of the parallel probes.
  const u = new URL(url);
  u.hash = '';
  u.searchParams.set('_bc', `${Date.now().toString(36)}${(++probeSeq).toString(36)}`);
  const t0 = Date.now();
  try {
    const r = await fetch(u.href, { method: 'HEAD', cache: 'no-store', credentials: 'omit' });
    const t1 = Date.now();
    const d = Date.parse(r.headers.get('date') || '');
    return Number.isFinite(d) ? { sec: d, mid: (t0 + t1) / 2, rtt: t1 - t0 } : null;
  } catch { return null; }
}

// The site's clock is the one that decides who was first, but it only says
// which second it is. Find the local instant its second ticks over, then aim a
// few probes at each of the next ticks to narrow that bracket to a few ms.
// Returns how far the server is ahead of this machine, or null.
async function measureSkew(url) {
  let prev = await probe(url);
  if (!prev) return null;
  let lo = null, hi = null, S = null;
  for (let i = 0; i < 40 && S == null; i++) {
    await sleep(40);
    const cur = await probe(url);
    if (!cur) return null;
    if (cur.sec > prev.sec) { lo = prev.mid; hi = cur.mid; S = cur.sec; }
    prev = cur;
  }
  if (S == null) return null;

  let rtt = prev.rtt;
  for (let k = 1, good = 0; k <= 6 && good < 3 && hi - lo > 4; k++) {
    const a = lo + 1000 * k, b = hi + 1000 * k, tick = S + 1000 * k;
    const shots = [];
    for (let j = 0; j < 5; j++) {
      const aim = a + ((b - a) * j) / 4;
      shots.push(waitUntil(aim - rtt / 2).then(() => probe(url)));
    }
    const got = (await Promise.all(shots)).filter(Boolean);
    if (!got.length) break;
    let before = -Infinity, after = Infinity;
    for (const g of got) {
      if (g.sec < tick) before = Math.max(before, g.mid);
      else after = Math.min(after, g.mid);
    }
    const nlo = Math.max(a, before), nhi = Math.min(b, after);
    // Contradictory samples (a slow reply overtaken by a fast one): drop this
    // round and try the next tick rather than guess.
    if (!(nlo < nhi)) continue;
    lo = nlo - 1000 * k;
    hi = nhi - 1000 * k;
    good++;
    rtt = got.map((g) => g.rtt).sort((x, y) => x - y)[got.length >> 1];
  }
  return { skew: Math.round(S - (lo + hi) / 2), within: Math.ceil((hi - lo) / 2) };
}

// ~20s before the instant: make sure the page script is there (the tab may
// have reloaded or navigated since arming) and line the instant up with the
// site's clock. Only ever moves the target of the schedule it was started for.
async function prep(tabId, sch) {
  await ensureContentScript(tabId);
  if (!sch.autoSync) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !keyOf(tab.url)) return;

  const m = (await measureSkew(tab.url)) || (await measureSkew(tab.url));
  let targetMs = null, note;
  if (!m) note = 'site clock unreadable — kept the manual offset';
  else if (m.within > 25 || Math.abs(m.skew) > 10000) note = `site clock too noisy (±${m.within}ms) — kept the manual offset`;
  else {
    // Inside the measurement error a skew is noise; do not chase it.
    const skew = Math.abs(m.skew) <= m.within ? 0 : m.skew;
    targetMs = sch.baseMs - skew;
    note = `site clock ${m.skew >= 0 ? '+' : ''}${m.skew}ms (±${m.within}) vs this computer`;
    if (targetMs < Date.now() + 1000) { targetMs = null; note += ' — too late to apply'; }
  }
  const upd = await mutate((all) => {
    const cur = all[tabId];
    if (!cur || cur.armedAt !== sch.armedAt) return null;
    if (targetMs != null) cur.targetMs = targetMs;
    cur.skew = m ? m.skew : null;
    cur.syncNote = note;
    return cur;
  });
  if (upd) { await ensureAlarms(); notifyTab(tabId, pub(upd)); }
}

// ---------------------------------------------------------------- firing

async function fire(tabId, sch, reason) {
  inFlight++;
  syncKeepAlive(true);
  const started = Date.now();
  if (sch.repeat) await chrome.storage.local.set({ ['firedBase:' + sch.urlKey]: sch.baseMs });
  let fired = 0;
  let sample = [];
  let engine = sch.trusted ? 'trusted (CDP)' : 'synthetic';
  let note = '';
  let timing = null;   // how far ahead of the instant the first chunk was sent / reached the page
  const stages = {};   // ms still left before the instant at each step — negative = late

  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || (sch.auto ? !keyOf(tab.url) : keyOf(tab.url) !== sch.urlKey)) {
      note = sch.auto ? 'skipped — the tab is not showing a web page'
        : 'skipped — the tab navigated away from the page the markers belong to';
    } else {
      // Everything that can be done before the instant is done before it: the
      // page resolves each marker to its element, caches it and sends the hover
      // half of the click, so T costs one press/release/click and nothing else.
      stages.begin = sch.targetMs - Date.now();
      await waitUntil(sch.targetMs - (sch.prewarmMs || PREWARM_MIN));
      const pre = await send(tabId, { type: 'burstPrewarm', auto: sch.auto ? sch.yesText : null });
      stages.prewarmed = sch.targetMs - Date.now();
      if (pre && pre.points) applyPoints(sch, pre.points);

      await waitUntil(sch.targetMs - SHIELD_LEAD);
      // Awaited: the page must be click-through before any real input lands.
      await send(tabId, { type: 'burstStart', clicks: sch.clicks, engine });
      stages.shielded = sch.targetMs - Date.now();

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
      timing = out.lead;
      if (out.stopped) note = note || 'stopped early — the target was gone after the click';
    }
  } catch (e) {
    note = String((e && e.message) || e);
  }

  const record = {
    at: started, reason, engine, note, sample,
    clicks: fired, planned: sch.clicks,
    elapsed: Date.now() - started,
    targetMs: sch.targetMs, tabTitle: sch.title, syncNote: sch.syncNote || '', timing, stages
  };
  await chrome.storage.local.set({ ['lastrun:' + sch.urlKey]: record });

  send(tabId, { type: 'burstEnd', record });
  await detach(tabId);
  chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
  notifyTab(tabId, null);

  // Auto-Yes never needs re-arming: queue the next weekday/weekend instant.
  if (sch.repeat && (await chrome.tabs.get(tabId).catch(() => null))) {
    const again = await arm(tabId, null, { urlKey: sch.urlKey });
    if (!again.ok) {
      record.note = (record.note ? record.note + ' · ' : '') + 'could not re-arm: ' + again.error;
      await chrome.storage.local.set({ ['lastrun:' + sch.urlKey]: record });
    }
  }

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
  const known = (s) => s.x >= 0 && s.y >= 0;

  // Park the cursor on the first target now, so the instant only carries the
  // press and the release.
  if (steps.length && known(steps[0])) dispatch({ type: 'mouseMoved', x: steps[0].x, y: steps[0].y, button: 'none', buttons: 0 });

  // A trusted click goes to whatever pixel we name, so the first one gets its
  // coordinates refreshed as late as we can afford. That is what catches a
  // dialog which only opened in the last second.
  if (sch.stopOnHit && steps.length && steps[0].at - Date.now() > 160) {
    await waitUntil(steps[0].at - 150);
    const g = await within(send(tabId, { type: 'guard', i: steps[0].i }), steps[0].at - 10);
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
    // Auto-Yes: no Yes on the page yet. Look again in each gap and click the
    // moment one shows up; never press at the placeholder coordinates.
    if (sch.auto && !known(s)) {
      const g = await within(send(tabId, { type: 'guard', i: s.i }), Date.now() + 15);
      if (!(g && g.ok && g.present && Number.isFinite(g.x) && g.x >= 0)) continue;
      for (let j = k; j < steps.length; j++) { steps[j].x = g.x; steps[j].y = g.y; }
    }
    if (!at || at.x !== s.x || at.y !== s.y) dispatch({ type: 'mouseMoved', x: s.x, y: s.y, button: 'none', buttons: 0 });
    dispatch({ type: 'mousePressed', x: s.x, y: s.y, button: 'left', buttons: 1, clickCount: 1 });
    dispatch({ type: 'mouseReleased', x: s.x, y: s.y, button: 'left', buttons: 0, clickCount: 1 });
    at = { x: s.x, y: s.y };
    n++;
    if (sch.auto) break;   // one lead, one click — never a second

    const next = steps[k + 1];
    if (!sch.stopOnHit || !next) continue;
    // Ask the page, in the gap, whether the target is still there. A trusted
    // click lands on whatever is under the pixel, so a retry after the dialog
    // has closed would hit the page behind it.
    const budget = Math.max(0, Math.min(40, next.at - Date.now() - 8));
    const g = await within(send(tabId, { type: 'guard', i: next.i }), Date.now() + budget);
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
  let lead = null;
  let n = 0;
  let stopped = false;
  const sample = [];
  for (const c of sch.chunks) {
    const at = sch.targetMs + c.t;
    await waitUntil(at - CHUNK_LEAD);
    // The page spins the last few ms and between clicks: hidden-tab timers are
    // too coarse, but a synchronous spin is not throttled.
    const sentLead = at - Date.now();
    const res = await send(tabId, { type: 'burstChunk', at, steps: c.steps });
    if (res && lead == null) lead = { sent: sentLead, arrived: res.lead };
    if (res && res.count) n += res.count;
    if (res && res.sample) for (const s of res.sample) if (sample.length < 12) sample.push(s);
    // The page saw its own target disappear: the click landed, stop here rather
    // than firing the rest into whatever took its place.
    if (res && res.hit) { stopped = true; break; }
  }
  return { n, stopped, sample, lead };
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
    if (!t || (all[id].auto ? !keyOf(t.url) : keyOf(t.url) !== all[id].urlKey)) dead.push(id);
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

      // Wake at least once a second to re-read the schedules: a tab armed for an
      // earlier instant while we sleep towards a later one must not be missed.
      const soon = ids.filter((id) => !all[id].prepped && all[id].targetMs - Date.now() < PREP_LEAD);
      if (soon.length) {
        await mutate((s) => { for (const id of soon) if (s[id]) s[id].prepped = true; });
        for (const id of soon) prep(+id, all[id]).catch(() => {});
      }

      const nextT = Math.min(...ids.map((id) => all[id].targetMs));
      // Plain timers here: being late by a timer's slack only eats into FIRE_LEAD.
      await sleep(Math.max(0, Math.min(nextT - FIRE_LEAD - Date.now(), 1000)));

      const fresh = await getSchedules();
      const due = Object.keys(fresh).filter((id) => fresh[id].targetMs - Date.now() <= FIRE_LEAD + 10);
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
        return reply(await disable(msg.tabId != null ? msg.tabId : senderTab));

      case 'armAllYes':
        return reply(await armAllWithYes());

      case 'disarmAll':
        return reply(await disarmAll());

      case 'testNow': {
        const tabId = msg.tabId != null ? msg.tabId : senderTab;
        const res = await arm(tabId, { time: BurstTime.fmtClock(Date.now() + 900), offsetMs: 0, useSchedule: false, oneShot: true, autoSync: false });
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
  await restoreEnabled();
});

chrome.runtime.onStartup.addListener(async () => {
  // Tab ids do not survive a browser restart; enabled pages are re-armed.
  await mutate((all) => { for (const k of Object.keys(all)) delete all[k]; });
  await ensureAlarms();
  await restoreEnabled();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM || a.name.startsWith(WAKE) || a.name.startsWith(PREP_WAKE)) runLoop();
});

chrome.tabs.onRemoved.addListener(async (tabId, info) => {
  attached.delete(tabId);
  const had = await mutate((all) => {
    const h = all[tabId] || null;
    delete all[tabId];
    return h;
  });
  // Closing the tab is switching it off; quitting the browser is not.
  if (had && had.repeat && !(info && info.isWindowClosing)) await setEnabled(had.urlKey, false);
  if (had) await ensureAlarms();
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  const all = await getSchedules();
  const sch = all[tabId];
  if (info.url && sch && !sch.auto && keyOf(info.url) !== sch.urlKey) {
    await disarm(tabId);
    return;
  }
  // A tab that (re)opens an enabled page arms itself — after a restart, or
  // when the page is opened again in a new tab.
  if (info.status === 'complete' && !sch && tab && (await getEnabled()).includes(keyOf(tab.url))) {
    await arm(tabId);
  }
});

chrome.commands.onCommand.addListener(async (cmd) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  if (cmd === 'toggle-arm') {
    const all = await getSchedules();
    if (all[tab.id]) await disable(tab.id);
    else await arm(tab.id);
    return;
  }
  const type = cmd === 'toggle-panel' ? 'panel' : cmd === 'toggle-place' ? 'place' : null;
  if (type) await send(tab.id, { type });
});

// Resume after a worker restart.
runLoop();
