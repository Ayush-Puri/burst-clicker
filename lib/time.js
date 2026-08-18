// Shared clock parsing for the popup and the in-page panel. Both must agree on
// what a typed time means, or the countdown would show one instant and the burst
// would fire at another.
var BurstTime = (() => {
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  // Accepts: 13, 13:00, 13:00:00, 13:00:00.250, 1pm, 1 p.m., 1:05 PM, 12am.
  // A bare hour with no am/pm is read as 24-hour.
  function parse(str) {
    let s = String(str == null ? '' : str).trim().toLowerCase();
    if (!s) return null;

    let mer = null;
    const m = /\s*([ap])\.?\s*m\.?$/.exec(s);
    if (m) { mer = m[1]; s = s.slice(0, m.index).trim(); }

    const t = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(?:[.,](\d{1,3}))?$/.exec(s);
    if (!t) return null;

    let h = +t[1];
    const mi = t[2] ? +t[2] : 0;
    const sec = t[3] ? +t[3] : 0;
    const ms = t[4] ? +String(t[4]).padEnd(3, '0') : 0;

    if (mer) {
      if (h < 1 || h > 12) return null;
      h = mer === 'p' ? (h % 12) + 12 : h % 12;
    } else if (h > 23) {
      return null;
    }
    if (mi > 59 || sec > 59) return null;
    return { h, mi, s: sec, ms };
  }

  const canonical = (str) => {
    const t = parse(str);
    return t ? `${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}.${pad(t.ms, 3)}` : null;
  };

  // The next occurrence of that wall-clock instant, as an absolute epoch ms.
  // Rolls to tomorrow when the time has already passed today.
  function nextTarget(str, offsetMs, now) {
    const t = parse(str);
    if (!t) return null;
    const base = now === undefined ? Date.now() : now;
    const d = new Date(base);
    d.setHours(t.h, t.mi, t.s, t.ms);
    let target = d.getTime() + (Number.isFinite(+offsetMs) ? +offsetMs : 0);
    if (target <= base) target += 86400000;
    return target;
  }

  function fmtClock(ms) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }

  function fmtDelta(ms) {
    if (!(ms > 0)) return '00:00:00.000';
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}` +
           `:${pad(Math.floor((ms % 60000) / 1000))}.${pad(Math.floor(ms % 1000), 3)}`;
  }

  // "13:00:00.000 today" / "…tomorrow" — so a typed time can be eyeballed.
  function describe(targetMs, now) {
    const base = now === undefined ? Date.now() : now;
    const day = new Date(base).getDate() === new Date(targetMs).getDate() ? 'today' : 'tomorrow';
    return `${fmtClock(targetMs)} ${day}`;
  }

  return { parse, canonical, nextTarget, fmtClock, fmtDelta, describe, pad };
})();
