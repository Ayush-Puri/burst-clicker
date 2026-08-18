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
    trusted: false
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

  function syntheticClick(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return { ok: false, tag: 'nothing at ' + x + ',' + y };
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x + window.screenX, screenY: y + window.screenY,
      button: 0, detail: 1
    };
    const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: 0.5 };
    const fire = (Ctor, type, init) => el.dispatchEvent(new Ctor(type, init));

    fire(PointerEvent, 'pointerover', { ...ptr, buttons: 0 });
    fire(MouseEvent, 'mouseover', { ...base, buttons: 0 });
    fire(PointerEvent, 'pointermove', { ...ptr, buttons: 0 });
    fire(MouseEvent, 'mousemove', { ...base, buttons: 0 });
    fire(PointerEvent, 'pointerdown', { ...ptr, buttons: 1 });
    fire(MouseEvent, 'mousedown', { ...base, buttons: 1 });
    if (typeof el.focus === 'function') { try { el.focus({ preventScroll: true }); } catch {} }
    fire(PointerEvent, 'pointerup', { ...ptr, buttons: 0, pressure: 0 });
    fire(MouseEvent, 'mouseup', { ...base, buttons: 0 });
    const notCancelled = fire(MouseEvent, 'click', { ...base, buttons: 0 });
    return { ok: true, tag: describe(el), defaultPrevented: !notCancelled };
  }

  // Timers are throttled in hidden tabs; a synchronous spin is not. Chunks are
  // short by construction, so this never blocks the page for long.
  function spinUntil(t) {
    const cap = Date.now() + 1200;
    while (Date.now() < t && Date.now() < cap) { /* spin */ }
  }

  function runChunk(at, steps) {
    shield(true);
    if (Number.isFinite(at)) spinUntil(at);
    const sample = [];
    const base = performance.now();
    let count = 0;
    for (const s of steps) {
      const due = base + (s.dt || 0);
      while (performance.now() < due) { /* spin */ }
      const r = syntheticClick(s.x, s.y);
      if (sample.length < 12) sample.push(r);
      count++;
    }
    return { count, sample };
  }

  // ------------------------------------------------------------------ arming

  async function arm() {
    if (!markers.length) { status('Place at least one marker first', true); return; }
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
  `;

  let host, root, captureEl, panelEl, cdEl, subEl, stEl, mkWrap;
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
            <div class="row">
              <button data-a="place">◎ Place</button>
              <button data-a="clear">Clear</button>
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
      case 'test': testNow(); break;
      case 'arm': schedule ? disarm() : arm(); break;
    }
  }

  function onUIChange(e) {
    const k = e.target.dataset.k;
    if (!k) return;
    let v = e.target.type === 'number' ? num(e.target.value, DEFAULTS[k]) : e.target.value;
    if (k === 'time') v = BurstTime.canonical(v) || v;
    settings[k] = v;
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
    markers.push({ id: Date.now() + Math.random(), x: Math.round(e.clientX), y: Math.round(e.clientY) });
    saveMarkers();
    status(`${markers.length} marker${markers.length > 1 ? 's' : ''} placed`);
    render();
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
      el.className = 'mk' + (placeMode ? ' grab' : '');
      el.style.left = m.x + 'px';
      el.style.top = m.y + 'px';
      el.textContent = String(i + 1);
      markerDrag(el, m);
      mkWrap.appendChild(el);
    });

    for (const inp of root.querySelectorAll('[data-k]')) {
      if (root.activeElement === inp) continue;
      inp.value = settings[inp.dataset.k];
    }

    const btn = root.querySelector('[data-a="arm"]');
    btn.textContent = schedule ? 'Disarm' : 'Arm';
    btn.className = schedule ? 'd' : 'p';
    root.querySelector('[data-a="place"]').classList.toggle('on', placeMode);
    root.querySelector('[data-a="test"]').disabled = !!schedule;
    stEl.textContent = statusMsg;
    stEl.className = 'st' + (statusErr ? ' err' : '');
    tickCountdown();
  }

  function tickCountdown() {
    if (!cdEl) return;
    if (schedule) {
      cdEl.classList.remove('idle');
      cdEl.textContent = fmtDelta(schedule.targetMs - Date.now());
      subEl.textContent = `${BurstTime.describe(schedule.targetMs)} · ${schedule.clicks} clicks · ${schedule.trusted ? 'trusted' : 'synthetic'}`;
    } else {
      cdEl.classList.add('idle');
      cdEl.textContent = fmtClock(Date.now());
      const t = BurstTime.nextTarget(settings.time, settings.offsetMs);
      subEl.textContent = !markers.length
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
          schedule, settings, plan: planSize()
        });
        return true;

      case 'schedule':
        schedule = msg.schedule || null;
        if (schedule) { movePanelClear(); startKeepalive(); } else stopKeepalive();
        render();
        reply({ ok: true });
        return true;

      case 'panel': setPanel(msg.on === undefined ? !panelOpen : msg.on); reply({ ok: true }); return true;
      case 'place': setPlaceMode(msg.on === undefined ? !placeMode : msg.on); setPanel(true); reply({ ok: true }); return true;
      case 'clear': clearMarkers(); reply({ ok: true }); return true;

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
  })();
})();
