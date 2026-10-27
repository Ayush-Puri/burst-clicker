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

const $ = (id) => document.getElementById(id);
const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let tabId = null;
let state = null;      // this tab's content-script state
let rows = [];         // every armed tab
let settings = { ...DEFAULTS };
let alive = false;

function status(msg, err = false) {
  $('status').textContent = msg || '';
  $('status').className = 'status' + (err ? ' err' : '');
}

const toTab = async (type, extra = {}) => {
  try { return await chrome.tabs.sendMessage(tabId, { type, ...extra }); }
  catch { alive = false; return null; }
};
const toWorker = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

async function refresh() {
  let [st, list] = await Promise.all([
    toTab('state'),
    toWorker({ type: 'list' })
  ]);

  // A tab that was already open when the extension was installed has no content
  // script yet. Inject it rather than telling the user the page is unsupported.
  if (!(st && st.ok) && tabId != null) {
    const ready = await toWorker({ type: 'ensure', tabId });
    if (ready && ready.ok) st = await toTab('state');
  }

  alive = !!(st && st.ok);
  if (st && st.ok) {
    state = st;
    settings = { ...DEFAULTS, ...(st.settings || {}) };
    fillInputs();
    const got = await chrome.storage.local.get('lastrun:' + st.url);
    renderLastRun(got['lastrun:' + st.url]);
  } else {
    const got = await chrome.storage.local.get('settings');
    settings = { ...DEFAULTS, ...(got.settings || {}) };
    fillInputs();
  }

  rows = (list && list.rows) || [];
  paint();
}

function fillInputs() {
  for (const el of document.querySelectorAll('[data-k]')) {
    const k = el.dataset.k;
    if (document.activeElement === el) continue;
    if (el.type === 'checkbox') el.checked = !!settings[k];
    else el.value = settings[k];
  }
}

function renderLastRun(run) {
  const box = $('lastrun');
  if (!run) { box.classList.add('hidden'); return; }
  const lines = [
    `last run  ${BurstTime.fmtClock(run.at)}  (${run.reason})`,
    `${run.clicks}/${run.planned} clicks · ${run.elapsed}ms · ${run.engine}`,
    ...(run.note ? [run.note] : []),
    ...(run.sample || []).map((s, i) =>
      `${String(i + 1).padStart(2, '0')}  ${s.ok ? '✓' : '✗'} ${s.tag}${s.defaultPrevented ? ' [handled]' : ''}`)
  ];
  box.textContent = lines.join('\n');
  box.classList.remove('hidden');
}

function mine() {
  return rows.find((r) => r.tabId === tabId) || null;
}

function paint() {
  $('clock').textContent = BurstTime.fmtClock(Date.now());
  $('unsupported').classList.toggle('hidden', alive);

  const sch = mine();
  const markers = (state && state.markers) || 0;
  $('mcount').textContent = markers;
  $('acount').textContent = rows.length;
  $('dot').className = 'dot' + (rows.length ? ' armed' : '');

  const cd = $('countdown');
  const sub = $('sub');
  if (sch) {
    cd.classList.remove('idle');
    cd.textContent = BurstTime.fmtDelta(sch.targetMs - Date.now());
    sub.textContent = `this tab fires ${BurstTime.describe(sch.targetMs)} · ${sch.auto ? 'auto-click Yes' : sch.clicks + ' clicks'}${sch.repeat ? ' · repeats every day' : ''} · ${sch.trusted ? 'trusted' : 'synthetic'}`
      + (sch.syncNote ? `\n${sch.syncNote}` : '');
  } else {
    cd.classList.add('idle');
    cd.textContent = BurstTime.fmtClock(Date.now());
    const t = BurstTime.targetFor(settings);
    const auto = settings.autoYes !== false;
    sub.textContent = !alive ? `${rows.length} other tab${rows.length === 1 ? '' : 's'} armed`
      : auto ? (t ? `auto-click "${settings.yesText}" · would fire ${BurstTime.describe(t)}` : 'cannot read the schedule times')
      : !markers ? 'no markers yet — hit Place markers, then click the page'
      : t ? `${markers} marker${markers === 1 ? '' : 's'} · ${BurstPlan.size(markers, settings)} clicks · would fire ${BurstTime.describe(t)}`
          : `cannot read "${settings.time}" — try 1:00 pm or 13:00:00`;
  }
  // Is there a Yes for it to click? The page also rings it in green while on.
  if (alive && state && state.yesFound != null) {
    sub.textContent += state.yesFound
      ? `\n✓ "${settings.yesText}" button found on this page`
      : `\n✗ no "${settings.yesText}" button on screen right now`;
  }

  const arm = $('arm');
  const auto = settings.autoYes !== false;
  arm.textContent = sch ? (sch.repeat ? 'Turn off for this tab' : 'Disarm this tab')
    : auto ? 'Turn on for this tab' : 'Arm this tab';
  arm.className = 'b ' + (sch ? 'danger' : 'primary');
  arm.disabled = !alive && !sch;
  $('test').disabled = !alive || !!sch;
  for (const id of ['place', 'panel', 'clear']) $(id).disabled = !alive;
  $('armAll').hidden = settings.autoYes === false;
  $('place').classList.toggle('on', !!(state && state.placeMode));
  $('time').disabled = settings.useSchedule !== false;

  paintArmed();
}

// Settings stay editable while a tab is armed: an armed schedule is a snapshot,
// so edits only affect the next tab you arm. Each armed row shows its own time.
let armedSig = '';

function paintArmed() {
  const box = $('armedList');
  $('disarmAll').disabled = !rows.length;
  $('armedHint').classList.toggle('hidden', rows.length > 0);

  const sig = rows.map((r) => `${r.tabId}:${r.targetMs}:${r.clicks}:${r.auto}:${r.title}`).join('|');
  if (sig !== armedSig) {
    armedSig = sig;
    box.innerHTML = rows.length ? rows.map((r) => `
      <div class="arow${r.tabId === tabId ? ' me' : ''}">
        <div class="acd">--:--:--.---</div>
        <div class="ameta">
          <div class="atitle">${esc(r.title || r.urlKey)}</div>
          <div class="awhen">${BurstTime.describe(r.targetMs)} · ${r.auto ? 'auto-click Yes' : `${r.clicks} clicks · ${r.markers} marker${r.markers === 1 ? '' : 's'}`}${r.trusted ? ' · trusted' : ''}</div>
        </div>
        <button class="ax" data-disarm="${r.tabId}" title="Disarm">✕</button>
      </div>`).join('') : '<div class="empty">nothing armed</div>';
  }

  const cds = box.querySelectorAll('.acd');
  rows.forEach((r, i) => { if (cds[i]) cds[i].textContent = BurstTime.fmtDelta(r.targetMs - Date.now()); });
}

document.addEventListener('input', async (e) => {
  const k = e.target.dataset && e.target.dataset.k;
  if (!k) return;
  settings[k] = e.target.type === 'checkbox' ? e.target.checked
    : e.target.type === 'number' ? num(e.target.value, DEFAULTS[k])
    : e.target.value;
  await chrome.storage.local.set({ settings });
  if (k === 'trusted') {
    const res = await toWorker(settings.trusted ? { type: 'cdp.attach', tabId } : { type: 'cdp.detach', tabId });
    status(settings.trusted
      ? (res && res.ok ? 'Debugger attached — place markers now' : 'Attach failed: ' + ((res && res.error) || '?'))
      : 'Debugger detached', settings.trusted && !(res && res.ok));
  }
  paint();
});

// Normalise the typed time only when the field is committed, so it never fights
// you mid-keystroke.
document.addEventListener('change', async (e) => {
  const key = e.target.dataset && e.target.dataset.k;
  if (key === 'weekdayTime' || key === 'weekendTime') {
    const c = BurstTime.canonical(e.target.value);
    if (!c) { status(`Cannot read "${e.target.value}" — try 1:00 pm or 13:00`, true); return; }
    settings[key] = c;
    await chrome.storage.local.set({ settings });
    fillInputs();
    paint();
    return;
  }
  if (key !== 'time') return;
  const canon = BurstTime.canonical(e.target.value);
  if (!canon) { status(`Cannot read "${e.target.value}" — try 1:00 pm, 13:00, or 13:00:00.250`, true); return; }
  settings.time = canon;
  await chrome.storage.local.set({ settings });
  fillInputs();
  status(`Set for ${BurstTime.describe(BurstTime.nextTarget(canon, settings.offsetMs))}`);
  paint();
});

document.addEventListener('click', async (e) => {
  const t = e.target;

  if (t.dataset && t.dataset.disarm) {
    await toWorker({ type: 'disarm', tabId: +t.dataset.disarm });
    await refresh();
    status('Disarmed');
    return;
  }

  if (t.dataset && (t.dataset.in || t.dataset.at)) {
    settings.time = t.dataset.at
      ? t.dataset.at
      : BurstTime.fmtClock(Date.now() + +t.dataset.in * 1000);
    settings.offsetMs = 0;
    settings.useSchedule = false;   // a quick-set time is a one-off, not the weekly rule
    await chrome.storage.local.set({ settings });
    fillInputs();
    paint();
    status(`Set for ${BurstTime.describe(BurstTime.nextTarget(settings.time, 0))}`);
    return;
  }

  switch (t.id) {
    // One tap back to the rule: 1 pm Mon–Fri, 10 am Sat–Sun. The clock offset is
    // kept — it is a property of the server, not of the schedule. An armed tab is
    // re-armed so its countdown picks up the fresh instant.
    case 'reset': {
      settings.useSchedule = true;
      settings.weekdayTime = DEFAULTS.weekdayTime;
      settings.weekendTime = DEFAULTS.weekendTime;
      await chrome.storage.local.set({ settings });
      fillInputs();
      let msg = `Reset — next fire ${BurstTime.describe(BurstTime.targetFor(settings))}`;
      if (mine()) {
        await toWorker({ type: 'disarm', tabId });
        const res = await toWorker({ type: 'arm', tabId });
        msg = res && res.ok ? `Reset and re-armed for ${BurstTime.describe(res.schedule.targetMs)}` : ((res && res.error) || 'could not re-arm');
      }
      await refresh();
      status(msg);
      break;
    }
    case 'sync': {
      status('Sampling the server clock — watch the in-page panel…');
      await toTab('sync');
      setTimeout(async () => { await refresh(); status(`Offset now ${settings.offsetMs}ms`); }, 2600);
      break;
    }
    case 'single': {
      settings.burstCount = 1;
      settings.startDelayMs = 0;
      await chrome.storage.local.set({ settings });
      fillInputs();
      paint();
      status('Single click at the instant — no retries');
      break;
    }
    case 'place': await toTab('place'); await refresh(); status('Place mode — click the page'); break;
    case 'panel': await toTab('panel'); await refresh(); break;
    case 'clear': await toTab('clear'); await refresh(); status('Markers cleared'); break;
    case 'test': {
      const res = await toWorker({ type: 'testNow', tabId });
      status(res && res.ok ? 'Test burst in ~1s…' : (res && res.error) || 'could not test', !(res && res.ok));
      setTimeout(refresh, 1600);
      break;
    }
    case 'arm': {
      const sch = mine();
      const res = await toWorker(sch ? { type: 'disarm', tabId } : { type: 'arm', tabId });
      await refresh();
      if (sch) status('Disarmed');
      else if (res && res.ok) status(res.schedule.repeat
        ? `On — clicks Yes at ${BurstTime.describe(res.schedule.targetMs)}, then every weekday 1 pm / weekend 10 am. Leave the tab open.`
        : `Armed for ${BurstTime.describe(res.schedule.targetMs)} — the tab can go to the background`);
      else status((res && res.error) || 'could not arm', true);
      break;
    }
    case 'armAll': {
      status('Looking for a Yes in every open tab…');
      const res = await toWorker({ type: 'armAllYes' });
      await refresh();
      if (!res || !res.ok) { status('could not turn tabs on', true); break; }
      status(`Turned on ${res.armed} tab${res.armed === 1 ? '' : 's'}`
        + (res.already ? ` · ${res.already} already on` : '')
        + (res.noYes ? ` · ${res.noYes} without a Yes left off` : ''), !res.armed && !res.already);
      break;
    }
    case 'disarmAll': {
      const res = await toWorker({ type: 'disarmAll' });
      await refresh();
      status(`Disarmed ${(res && res.count) || 0} tab${(res && res.count) === 1 ? '' : 's'}`);
      break;
    }
  }
});

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) tabId = tab.id;
  const got = await chrome.storage.local.get('settings');
  settings = { ...DEFAULTS, ...(got.settings || {}) };
  fillInputs();
  await refresh();
  setInterval(paint, 47);
  setInterval(refresh, 1200);
})();
