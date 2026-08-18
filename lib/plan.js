// Shared burst-plan maths. The worker builds the real plan; the popup and panel
// use size() for the "N clicks" readout without materialising it.
var BurstPlan = (() => {
  const MAX_CLICKS = 5000;

  // A hidden tab cannot use timers for sub-second gaps, so the page spins
  // between the clicks of one chunk. Chunks are kept short so that spin never
  // blocks the page for long; the worker's own clock spaces the chunks.
  const CHUNK_MS = 250;
  const CHUNK_MAX = 200;

  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const perMarker = (s) => clamp(Math.round(num(s.burstCount, 1)), 1, 500);

  function build(markers, s) {
    if (!markers || !markers.length) return [];
    const gap = Math.max(0, num(s.burstIntervalMs, 20));
    const n = perMarker(s);
    const start = Math.max(0, num(s.startDelayMs, 0));
    const plan = [];
    let t = start;

    const round = () => {
      if (s.pattern === 'permarker') {
        for (const m of markers) for (let i = 0; i < n; i++) { plan.push({ x: m.x, y: m.y, t }); t += gap; }
      } else {
        for (let i = 0; i < n; i++) for (const m of markers) { plan.push({ x: m.x, y: m.y, t }); t += gap; }
      }
    };

    round();
    const sustain = Math.max(0, num(s.sustainMs, 0));
    const sgap = Math.max(0, num(s.sustainGapMs, 100));
    while (sustain > 0 && t - start < sustain && plan.length < MAX_CLICKS) { t += sgap; round(); }
    return plan.slice(0, MAX_CLICKS);
  }

  function size(markerCount, s) {
    if (!markerCount) return 0;
    const per = markerCount * perMarker(s);
    const gap = Math.max(0, num(s.burstIntervalMs, 0));
    const sustain = Math.max(0, num(s.sustainMs, 0));
    const sgap = Math.max(0, num(s.sustainGapMs, 100));
    if (sustain <= 0) return Math.min(per, MAX_CLICKS);
    let total = per, t = per * gap;
    while (t < sustain && total < MAX_CLICKS) { t += sgap + per * gap; total += per; }
    return Math.min(total, MAX_CLICKS);
  }

  function chunk(plan) {
    const out = [];
    for (const step of plan) {
      const last = out[out.length - 1];
      if (last && step.t - last.t <= CHUNK_MS && last.steps.length < CHUNK_MAX) {
        last.steps.push({ x: step.x, y: step.y, dt: step.t - last.t });
      } else {
        out.push({ t: step.t, steps: [{ x: step.x, y: step.y, dt: 0 }] });
      }
    }
    return out;
  }

  const span = (plan) => (plan.length ? plan[plan.length - 1].t : 0);

  return { build, size, chunk, span, MAX_CLICKS, CHUNK_MS };
})();
