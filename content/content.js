(() => {
  if (window.__burstClickerLoaded) return;
  window.__burstClickerLoaded = true;

  const HOST_ID = 'burst-clicker-root';
  const URL_KEY = location.origin + location.pathname;
  const K_MARKERS = 'markers:' + URL_KEY;
  const K_LASTRUN = 'lastrun:' + URL_KEY;
  const K_SETTINGS = 'settings';

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

  let settings = { ...DEFAULTS };
  let markers = [];
  let schedule = null;       // owned by the worker; we only display it
  let placeMode = false;
  let panelOpen = false;
  let keepalivePort = null;

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  const fmtClock = (ms) => BurstTime.fmtClock(ms);
  const fmtDelta = (ms) => BurstTime.fmtDelta(ms);

  const ask = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

  // ------------------------------------------------------------------ storage

  async function loadAll() {
    const got = await chrome.storage.local.get([K_SETTINGS, K_MARKERS]);
    settings = { ...DEFAULTS, ...(got[K_SETTINGS] || {}) };
    markers = Array.isArray(got[K_MARKERS]) ? got[K_MARKERS] : [];
  }

  const saveMarkers = () => chrome.storage.local.set({ [K_MARKERS]: markers });
  const saveSettings = () => chrome.storage.local.set({ [K_SETTINGS]: settings });

  const planSize = () => BurstPlan.size(markers.length, settings);

  // ------------------------------------------------------------------- clicks

  function describe(el) {
    if (!el) return 'nothing';
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    const txt = (el.textContent || '').trim().slice(0, 24);
    return `${el.tagName.toLowerCase()}${id}${cls}${txt ? ` "${txt}"` : ''}`;
  }

  // Our own overlay sits on top of the page, so a raw elementFromPoint during
  // place mode would always answer "the Burst Clicker layer".
  function elementUnder(x, y) {
    const prev = host ? host.style.display : null;
    if (host) host.style.display = 'none';
    let el = null;
    try { el = document.elementFromPoint(x, y); } catch {}
    if (host) host.style.display = prev || '';
    return el;
  }

  const textOf = (el) => (el ? (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) : '');

  function isVisible(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && +st.opacity > 0.01;
  }

  function cssPath(el) {
    const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/[^\w-]/g, '\\$&'));
    const parts = [];
    let node = el;
    for (let d = 0; node && node.nodeType === 1 && d < 6; d++) {
      if (node.id) {
        let unique = false;
        try { unique = document.querySelectorAll('#' + esc(node.id)).length === 1; } catch {}
        if (unique) { parts.unshift('#' + esc(node.id)); break; }
      }
      let sel = node.tagName.toLowerCase();
      const cls = (typeof node.className === 'string' ? node.className : '').trim()
        .split(/\s+/).filter((c) => c && c.length < 40 && !/^(hover|active|focus|focused|selected)$/i.test(c))
        .slice(0, 3);
      if (cls.length) sel += '.' + cls.map(esc).join('.');
      const parent = node.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  const CLICKABLE = 'button, a, [role="button"], input[type="submit"], input[type="button"], [onclick]';

  // What the marker is really pointing at: the button, not the label inside it.
  // Stored with the click point as a ratio of the box, so the marker follows
  // that element when the dialog re-centres or the window is resized.
  function anchorFor(el, x, y) {
    if (!el || el.nodeType !== 1) return null;
    const hit = el.closest(CLICKABLE) || el;
    const r = hit.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      sel: cssPath(hit), tag: hit.tagName.toLowerCase(), text: textOf(hit),
      w: Math.round(r.width), h: Math.round(r.height),
      rx: clamp((x - r.left) / r.width, 0, 1),
      ry: clamp((y - r.top) / r.height, 0, 1)
    };
  }

  function byText(a) {
    if (!a.text) return null;
    let best = null, score = Infinity;
    let list = [];
    try { list = document.querySelectorAll((a.tag ? a.tag + ',' : '') + CLICKABLE); } catch { return null; }
    for (const el of list) {
      if (textOf(el) !== a.text || !isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      const s = Math.abs(r.width - a.w) + Math.abs(r.height - a.h);
      if (s < score) { best = el; score = s; }
    }
    return best;
  }

  // Auto-Yes: set at prewarm to the (lower-case) label to hunt for. While set, one
  // virtual marker stands in for every placed one and resolves by scanning the page.
  let autoYes = null;
  const AUTO_MARKER = { x: -1, y: -1, auto: true };
  const markerAt = (i) => (autoYes ? AUTO_MARKER : markers[i]);
  const markerList = () => (autoYes ? [AUTO_MARKER] : markers);

  const YES_FAST = 'button, a, [role="button"], [role="option"], [role="radio"], input[type="submit"], ' +
                   'input[type="button"], [onclick], label';
  const YES_WIDE = 'span, div, li, td, p';

  function yesMatch(el, want) {
    const raw = el.tagName === 'INPUT' ? (el.value || '') : (el.textContent || '');
    return raw.trim().replace(/\s+/g, ' ').toLowerCase().replace(/[.!]+$/, '') === want;
  }

  // The first visible, enabled element whose whole label is the word. Buttons and
  // links are tried first; plain spans/divs only if there is no real control.
  // Several matches (one per lead): the top-most, then left-most, wins.
  // anyState: also accept a disabled Yes — for the preview, which should say
  // "found, waiting for it to enable" rather than "not found".
  function findYes(want = autoYes, anyState = false) {
    if (!want) return null;
    for (const sel of [YES_FAST, YES_WIDE]) {
      let list;
      try { list = [...document.querySelectorAll(sel)]; } catch { continue; }
      const hits = list.filter((el) =>
        !(host && host.contains(el)) &&
        (anyState || (!el.disabled && el.getAttribute('aria-disabled') !== 'true')) &&
        isVisible(el) && yesMatch(el, want));
      // A wrapper that merely contains the real "Yes" control is not a second hit.
      const inner = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
      if (!inner.length) continue;
      let best = null, bt = Infinity, bl = Infinity;
      for (const el of inner) {
        const r = el.getBoundingClientRect();
        if (r.top < bt - 2 || (Math.abs(r.top - bt) <= 2 && r.left < bl)) { best = el; bt = r.top; bl = r.left; }
      }
      return best;
    }
    return null;
  }

  function centreOf(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  // Selector first (exact), then the same visible text — a re-rendered dialog
  // usually keeps its label even when generated class names change.
  function resolveAnchor(m) {
    if (m && m.auto) {
      const el = findYes();
      return el ? { el, ...centreOf(el) } : null;
    }
    const a = m && m.anchor;
    if (!a) return null;
    let el = null;
    try { if (a.sel) el = document.querySelector(a.sel); } catch {}
    if (!isVisible(el) || (a.text && textOf(el) !== a.text)) el = byText(a) || (isVisible(el) ? el : null);
    if (!isVisible(el)) return null;
    return { el, ...pointIn(el, a, m) };
  }

  function pointIn(el, a, m) {
    const r = el.getBoundingClientRect();
    let x = Math.round(clamp(r.left + a.rx * r.width, r.left + 1, r.right - 1));
    let y = Math.round(clamp(r.top + a.ry * r.height, r.top + 1, r.bottom - 1));
    // Nothing moved: keep the exact pixel the user placed.
    if (m && Math.abs(x - m.x) <= 2 && Math.abs(y - m.y) <= 2) { x = m.x; y = m.y; }
    return { x, y };
  }

  // Resolved targets, primed ahead of the instant so that at T there is no
  // hit-test, no hover work and no layout read left to do.
  const warm = new Map();
  let burstRun = { clicks: 0 };

  function pointFor(step) {
    const i = step && step.i;
    const m = i != null ? markerAt(i) || null : null;
    const w = warm.get(i);
    if (w && isVisible(w.el)) {
      if (m && m.auto) return { el: w.el, ...centreOf(w.el), primed: true };
      const a = m && m.anchor;
      return a ? { el: w.el, ...pointIn(w.el, a, m), primed: true } : { el: w.el, x: w.x, y: w.y, primed: true };
    }
    if (m && m.auto) {
      const got = resolveAnchor(m);
      if (got) { warm.set(i, got); return { ...got, primed: false }; }
      // No Yes yet: keep looking until one shows up. Once a click has landed, the
      // lead is taken and the burst is over.
      return burstRun.clicks ? { missing: true } : { wait: true };
    }
    if (m && m.anchor) {
      const got = resolveAnchor(m);
      if (got) { warm.set(i, got); return { ...got, primed: false }; }
      // The anchor is gone. After a click has landed that means the dialog
      // closed — the burst is done. Before any click it means the page is not
      // in the expected state, so fall back to the pixel the marker was placed on.
      return burstRun.clicks ? { missing: true } : { el: null, x: step.x, y: step.y, primed: false };
    }
    return { el: null, x: step.x, y: step.y, primed: false };
  }

  const evBase = (x, y) => ({
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: x, clientY: y, screenX: x + window.screenX, screenY: y + window.screenY,
    button: 0, detail: 1
  });
  const evPtr = (base) => ({ ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: 0.5 });

  function primeHover(el, x, y) {
    if (!el || !el.isConnected) return;
    const base = evBase(x, y);
    const ptr = evPtr(base);
    try {
      el.dispatchEvent(new PointerEvent('pointerover', { ...ptr, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mouseover', { ...base, buttons: 0 }));
      el.dispatchEvent(new PointerEvent('pointermove', { ...ptr, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mousemove', { ...base, buttons: 0 }));
    } catch {}
  }

  // primed = the hover half of the sequence already went out before the instant,
  // so only press → release → click is left to do at T.
  function syntheticClick(x, y, el, primed) {
    let target = el && el.isConnected ? el : document.elementFromPoint(x, y);
    if (target && host && host.contains(target)) target = elementUnder(x, y);
    if (!target) return { ok: false, tag: 'nothing at ' + x + ',' + y };
    const base = evBase(x, y);
    const ptr = evPtr(base);
    const fire = (Ctor, type, init) => target.dispatchEvent(new Ctor(type, init));

    if (!primed) {
      fire(PointerEvent, 'pointerover', { ...ptr, buttons: 0 });
      fire(MouseEvent, 'mouseover', { ...base, buttons: 0 });
      fire(PointerEvent, 'pointermove', { ...ptr, buttons: 0 });
      fire(MouseEvent, 'mousemove', { ...base, buttons: 0 });
    }
    fire(PointerEvent, 'pointerdown', { ...ptr, buttons: 1 });
    fire(MouseEvent, 'mousedown', { ...base, buttons: 1 });
    if (typeof target.focus === 'function') { try { target.focus({ preventScroll: true }); } catch {} }
    fire(PointerEvent, 'pointerup', { ...ptr, buttons: 0, pressure: 0 });
    fire(MouseEvent, 'mouseup', { ...base, buttons: 0 });
    const notCancelled = fire(MouseEvent, 'click', { ...base, buttons: 0 });
    return { ok: true, tag: describe(target), defaultPrevented: !notCancelled };
  }

  // Resolve every marker, cache the element, and send the hover events now, so
  // the instant itself costs one press/release/click and nothing else.
  function prewarm() {
    warm.clear();
    burstRun = { clicks: 0 };
    shield(true);
    const points = [];
    markerList().forEach((m, i) => {
      const got = m.anchor || m.auto ? resolveAnchor(m) : null;
      const x = got ? got.x : m.x;
      const y = got ? got.y : m.y;
      const el = got ? got.el : elementUnder(x, y);
      // A locked marker whose element is not there yet must not cache whatever
      // happens to be under its pixel — the check at fire time would then aim
      // at that instead of the dialog that opens in the last moment.
      if (el && (got || !(m.anchor || m.auto))) warm.set(i, { el, x, y });
      primeHover(el, x, y);
      points.push({ i, x, y, anchored: !!got, tag: describe(el) });
    });
    return points;
  }

  // Cheap live check used between clicks: is the target still there, and where?
  function guard(i) {
    if (i == null) return { present: true };
    const m = markerAt(i);
    if (!m) return { present: false };
    if (m.auto) {
      const w = warm.get(i);
      if (w && isVisible(w.el)) return { present: true, ...centreOf(w.el) };
      const got = resolveAnchor(m);
      if (got) { warm.set(i, got); return { present: true, x: got.x, y: got.y }; }
      return { present: false };
    }
    if (!m.anchor) return { present: true, x: m.x, y: m.y };
    const w = warm.get(i);
    if (w && isVisible(w.el)) return { present: true, ...pointIn(w.el, m.anchor, m) };
    const got = resolveAnchor(m);
    if (got) { warm.set(i, got); return { present: true, x: got.x, y: got.y }; }
    return { present: false };
  }

  // Timers are throttled in hidden tabs; a synchronous spin is not. Chunks are
  // short by construction, so this never blocks the page for long.
  function spinUntil(t) {
    const cap = Date.now() + 1200;
    while (Date.now() < t && Date.now() < cap) { /* spin */ }
  }

  function runChunk(at, steps) {
    shield(true);
    // How early the chunk arrived: below zero means the click was already late.
    const lead = Number.isFinite(at) ? at - Date.now() : null;
    if (Number.isFinite(at)) spinUntil(at);
    const sample = [];
    const base = performance.now();
    let count = 0;
    let hit = false;
    for (const s of steps) {
      const due = base + (s.dt || 0);
      while (performance.now() < due) { /* spin */ }
      const pt = pointFor(s);
      if (pt.missing) { hit = true; break; }
      if (pt.wait) continue;
      const r = syntheticClick(pt.x, pt.y, pt.el, pt.primed);
      burstRun.clicks++;
      if (sample.length < 12) sample.push(r);
      count++;
      if (autoYes) { hit = true; break; }   // one lead, one click — never a second
    }
    return { count, sample, hit, lead };
  }

  // ------------------------------------------------------------------ arming

  async function arm() {
    if (!markers.length && settings.autoYes === false) { status('Place at least one marker first', true); return; }
    const res = await ask({ type: 'arm' });
    if (!res || !res.ok) { status((res && res.error) || 'could not arm', true); return; }
    schedule = res.schedule;
    startKeepalive();
    status(`Armed for ${BurstTime.describe(schedule.targetMs)} — this tab can go to the background`);
    render();
  }

  async function disarm() {
    await ask({ type: 'disarm' });
    schedule = null;
    stopKeepalive();
    status('Disarmed');
    render();
  }

  async function testNow() {
    const res = await ask({ type: 'testNow' });
    if (!res || !res.ok) { status((res && res.error) || 'could not test', true); return; }
    schedule = res.schedule;
    status('Test burst in ~1s…');
    render();
  }

  // The instant that matters is the SERVER's 1 pm, not this laptop's. The Date
  // response header only has second resolution, so we sample until it ticks over
  // and bracket the moment the server crossed a second; that brackets the skew
  // to the sampling gap. The result is written to offsetMs.
  async function syncClock() {
    const GAP = 100;
    const MAX = 14;
    status('Sampling the server clock…');
    let prevSec = null, prevAt = null;
    for (let i = 0; i < MAX; i++) {
      const t0 = Date.now();
      let hdr = null;
      try {
        const res = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
        hdr = res.headers.get('date');
      } catch {}
      const t1 = Date.now();
      if (!hdr) { status('no Date header from this server — offset left alone', true); return; }
      const sec = Date.parse(hdr);
      const mid = (t0 + t1) / 2;
      if (prevSec != null && sec !== prevSec) {
        // The server crossed into `sec` somewhere between prevAt and mid.
        const localAtFlip = (prevAt + mid) / 2;
        const skew = Math.round(sec - localAtFlip);          // server ahead of us by this much
        const uncertainty = Math.round((mid - prevAt) / 2);
        settings.offsetMs = -skew;                            // fire that much earlier
        saveSettings();
        status(`Server clock is ${skew >= 0 ? '+' : ''}${skew}ms vs this Mac (±${uncertainty}) · offset set to ${-skew}ms`);
        render();
        return;
      }
      prevSec = sec; prevAt = mid;
      await new Promise((r) => setTimeout(r, GAP));
    }
    status('could not catch the server second ticking over — try again', true);
  }

  function startKeepalive() {
    stopKeepalive();
    try {
      keepalivePort = chrome.runtime.connect({ name: 'burst-armed' });
      keepalivePort.onDisconnect.addListener(() => { keepalivePort = null; });
    } catch {}
  }

  function stopKeepalive() {
    if (keepalivePort) { try { keepalivePort.disconnect(); } catch {} }
    keepalivePort = null;
  }

  // ---------------------------------------------------------------------- UI

  const STYLE = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
             font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .capture { position: absolute; inset: 0; pointer-events: none; cursor: crosshair;
               background: rgba(56,189,248,.06); box-shadow: inset 0 0 0 2px rgba(56,189,248,.55); display: none; }
    .capture.on { display: block; pointer-events: auto; }
    .mk { position: absolute; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%;
          border: 2px solid #f43f5e; background: rgba(244,63,94,.16); box-sizing: border-box;
          display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 11px;
          text-shadow: 0 1px 2px #000; pointer-events: none; }
    .mk::after { content: ''; position: absolute; width: 4px; height: 4px; border-radius: 50%; background: #f43f5e; }
    .mk.grab { pointer-events: auto; cursor: grab; }
    .panel { position: absolute; width: 272px; background: #0f172a; color: #e2e8f0;
             border: 1px solid #1e293b; border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,.5);
             pointer-events: auto; overflow: hidden; display: none; }
    .panel.on { display: block; }
    .hd { display: flex; align-items: center; gap: 6px; padding: 7px 9px; background: #131f36;
          cursor: move; user-select: none; border-bottom: 1px solid #1e293b; }
    .hd b { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #7dd3fc; flex: 1; }
    .x { cursor: pointer; color: #64748b; padding: 0 3px; font-size: 14px; line-height: 1; }
    .x:hover { color: #f43f5e; }
    .bd { padding: 9px; display: grid; gap: 7px; }
    .cd { font: 700 20px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center;
          padding: 6px 0 2px; color: #22d3ee; }
    .cd.idle { color: #475569; }
    .sub { text-align: center; font-size: 10px; color: #64748b; margin-top: -4px; }
    .row { display: flex; gap: 6px; align-items: center; }
    label { font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; }
    input, select { background: #060b16; color: #e2e8f0; border: 1px solid #24334c; border-radius: 5px;
                    padding: 4px 6px; font: 12px ui-monospace, Menlo, monospace; width: 100%; box-sizing: border-box; }
    input:focus, select:focus { outline: none; border-color: #38bdf8; }
    .f { flex: 1; display: grid; gap: 2px; }
    button { border: 1px solid #24334c; background: #1a2740; color: #e2e8f0; border-radius: 6px;
             padding: 5px 8px; font-size: 11px; font-weight: 600; cursor: pointer; flex: 1; }
    button:hover { border-color: #38bdf8; }
    button.p { background: #0e7490; border-color: #0e7490; }
    button.d { background: #7f1d1d; border-color: #7f1d1d; }
    button.on { background: #b45309; border-color: #b45309; }
    button[disabled] { opacity: .45; cursor: default; }
    .st { font-size: 10px; color: #94a3b8; min-height: 13px; text-align: center; }
    .st.err { color: #fb7185; }
    .hint { font-size: 10px; color: #475569; text-align: center; }
    .opts { gap: 10px; justify-content: center; }
    .ck { display: flex; align-items: center; gap: 4px; font-size: 10px; color: #94a3b8;
          text-transform: none; letter-spacing: 0; cursor: pointer; }
    .ck input { width: 12px; height: 12px; margin: 0; accent-color: #0e7490; }
    .mk.lock { border-color: #22c55e; background: rgba(34,197,94,.16); }
    .mk.lock::after { background: #22c55e; }
    .pv-ring { position: absolute; display: none; box-sizing: border-box; border: 3px solid #22c55e;
               border-radius: 8px; box-shadow: 0 0 0 4px rgba(34,197,94,.25), 0 0 18px rgba(34,197,94,.55);
               pointer-events: none; animation: pv 1.4s ease-in-out infinite; }
    @keyframes pv { 50% { box-shadow: 0 0 0 8px rgba(34,197,94,.12), 0 0 26px rgba(34,197,94,.7); } }
    .pv-tag { position: absolute; display: none; white-space: nowrap; pointer-events: none;
              background: #14532d; color: #dcfce7; border: 1px solid #22c55e; border-radius: 6px;
              padding: 3px 7px; font: 600 11px/1.3 -apple-system, BlinkMacSystemFont, sans-serif;
              box-shadow: 0 4px 14px rgba(0,0,0,.35); }
    .pv-ring.wait { border-color: #f59e0b; box-shadow: 0 0 0 4px rgba(245,158,11,.25); }
    .pv-tag.miss { background: #713f12; color: #fef3c7; border-color: #f59e0b; }
  `;

  let host, root, captureEl, panelEl, cdEl, subEl, stEl, mkWrap, pvRing, pvTag;

  // Auto-Yes preview: while this tab is on, ring the Yes that would be clicked
  // right now, so you can see it was found. Purely visual and click-through.
  let pvFound = null;
  function updatePreview() {
    if (!pvRing) return;
    const on = schedule && schedule.auto;
    const want = on ? schedule.yesText || 'yes' : null;
    const live = on ? findYes(want) : null;
    const el = live || (on ? findYes(want, true) : null);
    pvFound = on ? !!el : null;
    if (!on) { pvRing.style.display = pvTag.style.display = 'none'; return; }
    const when = BurstTime.describe(schedule.targetMs);
    if (el) {
      const r = el.getBoundingClientRect();
      pvRing.classList.toggle('wait', !live);
      Object.assign(pvRing.style, { display: 'block', left: r.left - 5 + 'px', top: r.top - 5 + 'px',
        width: r.width + 10 + 'px', height: r.height + 10 + 'px' });
      pvTag.className = 'pv-tag' + (live ? '' : ' miss');
      pvTag.textContent = live ? `✓ Burst Clicker will click this · ${when}`
        : `Found, but disabled right now — will click it the moment it enables · ${when}`;
      pvTag.style.display = 'block';
      const above = r.top - 30 > 0;
      pvTag.style.left = Math.max(4, Math.min(r.left - 5, innerWidth - pvTag.offsetWidth - 4)) + 'px';
      pvTag.style.top = (above ? r.top - 30 : r.bottom + 9) + 'px';
      pvTag.style.right = 'auto';
    } else {
      pvRing.style.display = 'none';
      pvTag.className = 'pv-tag miss';
      pvTag.textContent = `No "${settings.yesText || 'Yes'}" button on screen right now — at ${when} it will keep looking for it`;
      Object.assign(pvTag.style, { display: 'block', left: 'auto', right: '12px', top: '12px' });
    }
  }
  let panelPos = { x: 16, y: 16 };
  let statusMsg = '';
  let statusErr = false;

  function status(msg, err = false) {
    statusMsg = msg;
    statusErr = err;
    if (stEl) { stEl.textContent = msg; stEl.className = 'st' + (err ? ' err' : ''); }
  }

  function buildUI() {
    host = document.createElement('div');
    host.id = HOST_ID;
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${STYLE}</style>
      <div class="layer">
        <div class="capture"></div>
        <div class="marks"></div>
        <div class="pv-ring"></div>
        <div class="pv-tag"></div>
        <div class="panel">
          <div class="hd"><b>Burst Clicker</b><span class="x" data-a="close">✕</span></div>
          <div class="bd">
            <div class="cd idle">--:--:--.---</div>
            <div class="sub"></div>
            <div class="row">
              <div class="f"><label>Fire at</label><input data-k="time" placeholder="1:00 pm"></div>
              <div class="f" style="max-width:76px"><label>Offset ms</label><input data-k="offsetMs" type="number"></div>
            </div>
            <div class="row">
              <div class="f"><label>Clicks / marker</label><input data-k="burstCount" type="number" min="1"></div>
              <div class="f"><label>Gap ms</label><input data-k="burstIntervalMs" type="number" min="0"></div>
            </div>
            <div class="row opts">
              <label class="ck"><input type="checkbox" data-k="lockToElement"> lock to element</label>
              <label class="ck"><input type="checkbox" data-k="stopOnHit"> stop on hit</label>
            </div>
            <div class="row">
              <button data-a="place">◎ Place</button>
              <button data-a="clear">Clear</button>
              <button data-a="sync">⟳ Sync</button>
              <button data-a="test">Test</button>
            </div>
            <div class="row"><button class="p" data-a="arm">Arm</button></div>
            <div class="st"></div>
            <div class="hint">⌥⇧P place · ⌥⇧A arm · ⌥⇧M panel</div>
          </div>
        </div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);

    captureEl = root.querySelector('.capture');
    mkWrap = root.querySelector('.marks');
    pvRing = root.querySelector('.pv-ring');
    pvTag = root.querySelector('.pv-tag');
    panelEl = root.querySelector('.panel');
    cdEl = root.querySelector('.cd');
    subEl = root.querySelector('.sub');
    stEl = root.querySelector('.st');

    captureEl.addEventListener('pointerdown', onPlacePointer, true);
    root.addEventListener('click', onUIClick);
    root.addEventListener('change', onUIChange);
    root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && e.target.dataset.k) onUIChange({ target: e.target });
    });
    root.querySelector('.hd').addEventListener('pointerdown', onPanelDrag);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && placeMode) { setPlaceMode(false); e.stopPropagation(); }
    }, true);
  }

  function onUIClick(e) {
    const a = e.target.closest('[data-a]');
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    switch (a.dataset.a) {
      case 'close': setPanel(false); break;
      case 'place': setPlaceMode(!placeMode); break;
      case 'clear': clearMarkers(); break;
      case 'sync': syncClock(); break;
      case 'test': testNow(); break;
      case 'arm': schedule ? disarm() : arm(); break;
    }
  }

  function onUIChange(e) {
    const k = e.target.dataset.k;
    if (!k) return;
    let v = e.target.type === 'checkbox' ? !!e.target.checked
      : e.target.type === 'number' ? num(e.target.value, DEFAULTS[k])
      : e.target.value;
    if (k === 'time') v = BurstTime.canonical(v) || v;
    settings[k] = v;
    // A time typed here is a one-off, so it replaces the weekday/weekend rule.
    if (k === 'time') settings.useSchedule = false;
    saveSettings();
    if (schedule) status('This tab is already armed — disarm to change its time', true);
    render();
  }

  function clearMarkers() {
    markers = [];
    saveMarkers();
    if (schedule) disarm();
    status('Markers cleared');
    render();
  }

  function onPlacePointer(e) {
    if (!placeMode) return;
    e.preventDefault();
    e.stopPropagation();
    markers.push(makeMarker(Math.round(e.clientX), Math.round(e.clientY)));
    saveMarkers();
    const m = markers[markers.length - 1];
    status(m.anchor
      ? `Marker ${markers.length} locked to <${m.anchor.tag}>${m.anchor.text ? ' "' + m.anchor.text.slice(0, 20) + '"' : ''}`
      : `${markers.length} marker${markers.length > 1 ? 's' : ''} placed`);
    render();
  }

  function makeMarker(x, y) {
    const m = { id: Date.now() + Math.random(), x, y };
    if (settings.lockToElement !== false) {
      const a = anchorFor(elementUnder(x, y), x, y);
      if (a) m.anchor = a;
    }
    return m;
  }

  function onPanelDrag(e) {
    if (e.target.dataset.a) return;
    e.preventDefault();
    const sx = e.clientX - panelPos.x;
    const sy = e.clientY - panelPos.y;
    const move = (ev) => {
      panelPos.x = clamp(ev.clientX - sx, 0, innerWidth - 60);
      panelPos.y = clamp(ev.clientY - sy, 0, innerHeight - 30);
      placePanel();
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  const placePanel = () => { panelEl.style.left = panelPos.x + 'px'; panelEl.style.top = panelPos.y + 'px'; };

  // Our own panel must never eat a click aimed at the page underneath it.
  function shield(on) {
    if (!panelEl) return;
    panelEl.style.pointerEvents = on ? 'none' : '';
    panelEl.style.opacity = on ? '0.55' : '';
  }

  function movePanelClear() {
    if (!panelEl || !markers.length || !panelOpen) return;
    const pad = 12;
    const r = panelEl.getBoundingClientRect();
    const w = r.width || 272;
    const h = r.height || 300;
    const covers = (x, y) => markers.some((m) => m.x >= x - 6 && m.x <= x + w + 6 && m.y >= y - 6 && m.y <= y + h + 6);
    if (!covers(panelPos.x, panelPos.y)) return;
    for (const [x, y] of [[innerWidth - w - pad, pad], [pad, innerHeight - h - pad],
                          [innerWidth - w - pad, innerHeight - h - pad], [pad, pad]]) {
      if (x < 0 || y < 0) continue;
      if (!covers(x, y)) { panelPos.x = x; panelPos.y = y; placePanel(); return; }
    }
  }

  function markerDrag(el, m) {
    el.addEventListener('pointerdown', (e) => {
      if (!placeMode) return;
      e.preventDefault();
      e.stopPropagation();
      const move = (ev) => {
        m.x = Math.round(ev.clientX);
        m.y = Math.round(ev.clientY);
        el.style.left = m.x + 'px';
        el.style.top = m.y + 'px';
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        delete m.anchor;
        if (settings.lockToElement !== false) {
          const a = anchorFor(elementUnder(m.x, m.y), m.x, m.y);
          if (a) m.anchor = a;
        }
        saveMarkers();
        if (schedule) { status('Markers moved — re-arm to use the new spots', true); disarm(); }
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    }, true);
    el.addEventListener('contextmenu', (e) => {
      if (!placeMode) return;
      e.preventDefault();
      e.stopPropagation();
      markers = markers.filter((x) => x !== m);
      saveMarkers();
      if (schedule) disarm();
      render();
    }, true);
  }

  function render() {
    if (!host) return;
    captureEl.classList.toggle('on', placeMode);
    panelEl.classList.toggle('on', panelOpen);
    placePanel();

    mkWrap.textContent = '';
    markers.forEach((m, i) => {
      const el = document.createElement('div');
      el.className = 'mk' + (placeMode ? ' grab' : '') + (m.anchor ? ' lock' : '');
      el.style.left = m.x + 'px';
      el.style.top = m.y + 'px';
      el.title = m.anchor ? `locked to <${m.anchor.tag}> ${m.anchor.text}` : 'fixed spot';
      el.textContent = String(i + 1);
      markerDrag(el, m);
      mkWrap.appendChild(el);
    });
    followAnchors();

    for (const inp of root.querySelectorAll('[data-k]')) {
      if (root.activeElement === inp) continue;
      if (inp.type === 'checkbox') inp.checked = settings[inp.dataset.k] !== false;
      else inp.value = settings[inp.dataset.k];
    }

    const btn = root.querySelector('[data-a="arm"]');
    btn.textContent = schedule ? (schedule.repeat ? 'Turn off' : 'Disarm')
      : settings.autoYes !== false ? 'Turn on' : 'Arm';
    btn.className = schedule ? 'd' : 'p';
    root.querySelector('[data-a="place"]').classList.toggle('on', placeMode);
    root.querySelector('[data-a="test"]').disabled = !!schedule;
    stEl.textContent = statusMsg;
    stEl.className = 'st' + (statusErr ? ' err' : '');
    tickCountdown();
  }

  // An anchored marker is drawn where its element is now, not where it was
  // dropped, so you can see it still sitting on the button.
  let followTick = 0;
  function followAnchors() {
    if (!mkWrap || !markers.some((m) => m.anchor)) return;
    const dots = mkWrap.children;
    markers.forEach((m, i) => {
      const dot = dots[i];
      if (!dot || !m.anchor || placeMode) return;
      const got = resolveAnchor(m);
      if (!got) { dot.style.opacity = '.35'; return; }
      dot.style.opacity = '';
      dot.style.left = got.x + 'px';
      dot.style.top = got.y + 'px';
    });
  }

  function tickCountdown() {
    if (!cdEl) return;
    if (++followTick % 5 === 0 && (panelOpen || placeMode)) followAnchors();
    if (schedule) {
      cdEl.classList.remove('idle');
      cdEl.textContent = fmtDelta(schedule.targetMs - Date.now());
      subEl.textContent = `${BurstTime.describe(schedule.targetMs)} · ${schedule.auto ? 'auto-click Yes' : schedule.clicks + ' clicks'}${schedule.repeat ? ' · daily' : ''} · ${schedule.trusted ? 'trusted' : 'synthetic'}`;
    } else {
      cdEl.classList.add('idle');
      cdEl.textContent = fmtClock(Date.now());
      const t = BurstTime.targetFor(settings);
      subEl.textContent = settings.autoYes !== false
        ? (t ? `auto-click "${settings.yesText}" · would fire ${BurstTime.describe(t)}` : 'cannot read the schedule')
        : !markers.length
        ? 'no markers — hit Place, then click the page'
        : t ? `${markers.length} marker${markers.length === 1 ? '' : 's'} · ${planSize()} clicks · would fire ${BurstTime.describe(t)}`
            : `cannot read "${settings.time}"`;
    }
  }

  function setPlaceMode(on) {
    placeMode = !!on;
    status(placeMode ? 'Click the page to drop markers · drag to move · right-click to delete · Esc to exit' : '');
    render();
  }

  function setPanel(on) {
    panelOpen = !!on;
    render();
  }

  // ----------------------------------------------------------------- wiring

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg && msg.type) {
      case 'ping':
        reply({ ok: true, url: URL_KEY });
        return true;

      case 'state':
        reply({
          ok: true, url: URL_KEY, markers: markers.length, panelOpen, placeMode,
          schedule, settings, plan: planSize(),
          // Would auto-Yes find a button here right now? Asked by the popup, on or off.
          yesFound: settings.autoYes !== false ? !!findYes(String(settings.yesText || 'Yes').trim().toLowerCase(), true) : null
        });
        return true;

      case 'schedule':
        schedule = msg.schedule || null;
        if (schedule) { movePanelClear(); startKeepalive(); } else stopKeepalive();
        render();
        updatePreview();
        reply({ ok: true });
        return true;

      case 'panel': setPanel(msg.on === undefined ? !panelOpen : msg.on); reply({ ok: true }); return true;
      case 'place': setPlaceMode(msg.on === undefined ? !placeMode : msg.on); setPanel(true); reply({ ok: true }); return true;
      case 'clear': clearMarkers(); reply({ ok: true }); return true;

      case 'burstPrewarm': {
        autoYes = msg.auto || null;
        setPlaceMode(false);
        shield(true);
        reply({ ok: true, points: prewarm() });
        return true;
      }

      case 'sync':
        syncClock();
        reply({ ok: true });
        return true;

      case 'hasYes':
        reply({ ok: true, found: !!findYes(msg.want, true) });
        return true;

      case 'guard':
        reply({ ok: true, ...guard(msg.i) });
        return true;

      case 'burstStart':
        setPlaceMode(false);
        shield(true);
        status(`Firing ${msg.clicks} clicks…`);
        reply({ ok: true });
        return true;

      case 'burstChunk': {
        const r = runChunk(msg.at, msg.steps || []);
        reply({ ok: true, ...r });
        return true;
      }

      case 'burstEnd':
        shield(false);
        warm.clear();
        burstRun = { clicks: 0 };
        autoYes = null;
        schedule = null;
        stopKeepalive();
        status(msg.record
          ? `Done — ${msg.record.clicks}/${msg.record.planned} clicks${msg.record.note ? ' · ' + msg.record.note : ''}`
          : 'Done');
        render();
        reply({ ok: true });
        return true;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[K_SETTINGS]) {
      settings = { ...DEFAULTS, ...(changes[K_SETTINGS].newValue || {}) };
      render();
    }
    if (changes[K_MARKERS]) {
      markers = changes[K_MARKERS].newValue || [];
      render();
    }
  });

  addEventListener('resize', () => { panelPos.x = clamp(panelPos.x, 0, innerWidth - 60); render(); });

  (async function init() {
    await loadAll();
    buildUI();
    const res = await ask({ type: 'mySchedule' });
    schedule = (res && res.schedule) || null;
    if (schedule) {
      panelOpen = true;
      startKeepalive();
      status(`Still armed for ${BurstTime.describe(schedule.targetMs)}`);
    }
    render();
    setInterval(tickCountdown, 47);
    setInterval(updatePreview, 400);   // own timer: hidden tabs run timers ~1/s at best
  })();
})();
