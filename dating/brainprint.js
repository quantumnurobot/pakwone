/*
 * brainprint.js - browser port of src/brainprint (protocol, simulator,
 * preprocessing, dual-bootstrap analysis). Exposes a global `BP` and,
 * under Node, module.exports for tests.
 */
(function (root) {
  "use strict";

  var VERSION = "brainprint-js 0.1.0";
  var KINDS = ["probe", "target", "irrelevant"];
  var DEFAULTS = {
    repetitions: 30, stimulusMs: 300, isiMs: 3000, epochPreMs: 200, epochPostMs: 1200,
    fs: 250, rejectUv: 100, nBoot: 1000,
    presentThreshold: 0.9, absentThreshold: 0.3,
    corrWindow: [300, 900], ampWindow: [300, 700], minTrials: 5
  };

  // ---------- random numbers ----------
  function rng(seed) {
    var a = (seed >>> 0) || 1;
    var r = function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    r.normal = function () {
      var u = 0, v = 0;
      while (u === 0) u = r();
      while (v === 0) v = r();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    r.int = function (n) { return Math.floor(r() * n); };
    return r;
  }

  // ---------- protocol ----------
  function validateProtocol(p) {
    var errors = [];
    var lists = { probe: p.probes || [], target: p.targets || [], irrelevant: p.irrelevants || [] };
    KINDS.forEach(function (k) { if (!lists[k].length) errors.push("Add at least one " + k + "."); });
    var all = lists.probe.concat(lists.target, lists.irrelevant).map(function (s) { return s.toLowerCase(); });
    var seen = {}, dups = [];
    all.forEach(function (s) { if (seen[s]) dups.push(s); seen[s] = 1; });
    if (dups.length) errors.push("Each item must be unique across all lists. Repeated: " + dups.join(", ") + ".");
    if (lists.irrelevant.length < 2 * lists.probe.length)
      errors.push("Add more irrelevants: you need at least " + 2 * lists.probe.length + " (twice the number of probes).");
    if (!(p.repetitions >= 5)) errors.push("Use at least 5 repetitions per item.");
    return errors;
  }

  function stimuli(p) {
    var out = [];
    p.probes.forEach(function (t) { out.push({ text: t, kind: "probe" }); });
    p.targets.forEach(function (t) { out.push({ text: t, kind: "target" }); });
    p.irrelevants.forEach(function (t) { out.push({ text: t, kind: "irrelevant" }); });
    return out;
  }

  /** Randomised order, each item `repetitions` times, no immediate repeats. */
  function buildSequence(p, seed) {
    var r = rng(seed), base = stimuli(p), pool = [];
    for (var i = 0; i < p.repetitions; i++) pool = pool.concat(base);
    function shuffle() {
      for (var j = pool.length - 1; j > 0; j--) { var k = r.int(j + 1), t = pool[j]; pool[j] = pool[k]; pool[k] = t; }
    }
    function ok() { for (var j = 1; j < pool.length; j++) if (pool[j].text === pool[j - 1].text) return false; return true; }
    for (var tries = 0; tries < 100; tries++) { shuffle(); if (ok()) return pool; }
    for (var a = 1; a < pool.length; a++) {
      if (pool[a].text !== pool[a - 1].text) continue;
      for (var b = a + 1; b < pool.length; b++) {
        if (pool[b].text !== pool[a - 1].text && (b + 1 >= pool.length || pool[a].text !== pool[b + 1].text)) {
          var t2 = pool[a]; pool[a] = pool[b]; pool[b] = t2; break;
        }
      }
    }
    return pool;
  }

  // ---------- simulator ----------
  function timeAxis(o) {
    var dt = 1000 / o.fs, out = [];
    for (var t = -o.epochPreMs; t < o.epochPostMs - 1e-9; t += dt) out.push(t);
    return out;
  }

  // Paul Kellet's pink-noise filter, rescaled to the requested standard deviation.
  function pinkNoise(r, n, sd) {
    var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, x = new Array(n), m = 0, s = 0, i;
    for (i = 0; i < n + 200; i++) {
      var w = r.normal();
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      var v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
      if (i >= 200) x[i - 200] = v;
    }
    for (i = 0; i < n; i++) m += x[i];
    m /= n;
    for (i = 0; i < n; i++) s += (x[i] - m) * (x[i] - m);
    s = Math.sqrt(s / n) || 1;
    for (i = 0; i < n; i++) x[i] = (x[i] - m) / s * sd;
    return x;
  }

  /**
   * One simulated single-trial epoch at Pz. Recognised stimuli (targets, and
   * probes when the simulated subject knows them) carry a P300-like bump.
   * `blinkRate` adds occasional large eye-blink artifacts.
   */
  function simulateEpoch(kind, sim, o, r, times) {
    var recognised = kind === "target" || (kind === "probe" && sim.knowsProbe);
    return simulateResponse(recognised ? 1 : 0, sim, r, times);
  }

  /** Simulated epoch whose P300 is `gain` (0..1) times the subject's full response. */
  function simulateResponse(gain, sim, r, times) {
    var amp = gain > 0 ? gain * sim.p300Uv * (0.6 + 0.8 * r()) : 0;
    var lat = 450 + r.normal() * 40;
    var noise = pinkNoise(r, times.length, sim.noiseUv);
    var blink = r() < (sim.blinkRate || 0) ? { at: -100 + r() * 1100, h: 120 + r() * 80 } : null;
    return times.map(function (t, i) {
      var v = amp * Math.exp(-0.5 * Math.pow((t - lat) / 120, 2)) + noise[i];
      if (blink) v += blink.h * Math.exp(-0.5 * Math.pow((t - blink.at) / 60, 2));
      return v;
    });
  }

  // ---------- preprocessing ----------
  // RBJ biquad coefficients (Q = 1/sqrt2 gives a Butterworth section).
  function biquad(type, fc, fs) {
    var w = 2 * Math.PI * fc / fs, cw = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2), b;
    if (type === "lp") b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2];
    else b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2];
    var a0 = 1 + al;
    return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: -2 * cw / a0, a2: (1 - al) / a0 };
  }
  function runBiquad(c, x) {
    var y = new Array(x.length), x1 = x[0], x2 = x[0], y1 = x[0], y2 = x[0];
    if (c.b0 + c.b1 + c.b2 < 0.5) { y1 = 0; y2 = 0; } // high-pass settles at zero
    for (var i = 0; i < x.length; i++) {
      var v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }
  /** Zero-phase band-pass (forward and backward), with reflected padding. */
  function bandpass(x, fs, lo, hi) {
    var pad = Math.min(x.length - 1, Math.round(fs * 0.5)), ext = [], i;
    for (i = pad; i > 0; i--) ext.push(2 * x[0] - x[i]);
    ext = ext.concat(x);
    for (i = 1; i <= pad; i++) ext.push(2 * x[x.length - 1] - x[x.length - 1 - i]);
    var hp = biquad("hp", lo, fs), lp = biquad("lp", hi, fs);
    var f = runBiquad(lp, runBiquad(hp, ext));
    f = runBiquad(lp, runBiquad(hp, f.reverse())).reverse();
    return f.slice(pad, pad + x.length);
  }

  function preprocess(epochs, times, o) {
    var clean = [], keep = [];
    epochs.forEach(function (e) {
      var f = bandpass(e, o.fs, o.hpHz || 0.1, o.lpHz || 8), s = 0, n = 0, i;
      for (i = 0; i < times.length; i++) if (times[i] < 0) { s += f[i]; n++; }
      var base = n ? s / n : 0, lo = Infinity, hi = -Infinity;
      for (i = 0; i < f.length; i++) { f[i] -= base; if (f[i] < lo) lo = f[i]; if (f[i] > hi) hi = f[i]; }
      var ok = hi - lo < o.rejectUv;
      keep.push(ok);
      if (ok) clean.push(f);
    });
    return { clean: clean, keep: keep };
  }

  // ---------- analysis ----------
  function mean(rows) {
    var n = rows[0].length, m = new Array(n).fill(0);
    rows.forEach(function (r) { for (var i = 0; i < n; i++) m[i] += r[i]; });
    for (var i = 0; i < n; i++) m[i] /= rows.length;
    return m;
  }
  function resampleMean(r, rows) {
    var n = rows[0].length, m = new Array(n).fill(0), k = rows.length;
    for (var j = 0; j < k; j++) { var row = rows[r.int(k)]; for (var i = 0; i < n; i++) m[i] += row[i]; }
    for (var i2 = 0; i2 < n; i2++) m[i2] /= k;
    return m;
  }
  function corr(a, b, idx) {
    var ma = 0, mb = 0, n = idx.length, i;
    for (i = 0; i < n; i++) { ma += a[idx[i]]; mb += b[idx[i]]; }
    ma /= n; mb /= n;
    var sab = 0, saa = 0, sbb = 0;
    for (i = 0; i < n; i++) { var da = a[idx[i]] - ma, db = b[idx[i]] - mb; sab += da * db; saa += da * da; sbb += db * db; }
    return sab / Math.sqrt(saa * sbb || 1);
  }
  function windowIdx(times, w) { var out = []; times.forEach(function (t, i) { if (t >= w[0] && t <= w[1]) out.push(i); }); return out; }
  function winMean(x, idx) { var s = 0; idx.forEach(function (i) { s += x[i]; }); return s / idx.length; }

  /**
   * Classify a session. Information present needs BOTH bootstrap supports to
   * reach presentThreshold; absent needs both at or below absentThreshold;
   * anything else is indeterminate.
   */
  function analyse(epochs, labels, times, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {}), r = rng(o.seed || 1);
    var groups = { probe: [], target: [], irrelevant: [] };
    labels.forEach(function (l, i) { if (groups[l]) groups[l].push(epochs[i]); });
    var n = {};
    KINDS.forEach(function (k) { n[k] = groups[k].length; });
    var short = KINDS.filter(function (k) { return n[k] < o.minTrials; });
    if (short.length) {
      return { verdict: "invalid", reason: "Too few clean trials for: " + short.join(", ") + " (need " + o.minTrials + " each).", nTrials: n };
    }
    var cw = windowIdx(times, o.corrWindow), aw = windowIdx(times, o.ampWindow), cWins = 0, aWins = 0;
    var ampDiffs = [];
    for (var b = 0; b < o.nBoot; b++) {
      var p = resampleMean(r, groups.probe), t = resampleMean(r, groups.target), ir = resampleMean(r, groups.irrelevant);
      if (corr(p, t, cw) > corr(p, ir, cw)) cWins++;
      var d = winMean(p, aw) - winMean(ir, aw);
      ampDiffs.push(d);
      if (d > 0) aWins++;
    }
    var cs = cWins / o.nBoot, as = aWins / o.nBoot, verdict;
    if (Math.min(cs, as) >= o.presentThreshold) verdict = "information_present";
    else if (Math.max(cs, as) <= o.absentThreshold) verdict = "information_absent";
    else verdict = "indeterminate";
    return {
      verdict: verdict, correlationSupport: cs, amplitudeSupport: as, nTrials: n,
      erp: { probe: mean(groups.probe), target: mean(groups.target), irrelevant: mean(groups.irrelevant) },
      ampDiffs: ampDiffs, thresholds: { present: o.presentThreshold, absent: o.absentThreshold },
      windows: { corr: o.corrWindow, amp: o.ampWindow }, nBoot: o.nBoot, version: VERSION
    };
  }

  // ---------- attention ranking (used by the dating app) ----------
  /**
   * Rank stimuli by how strongly each one drew a P300, relative to all the
   * others shown in the same stream. For each item, bootstrap the mean
   * amplitude in the amplitude window and compare it with the pooled mean of
   * every other item ("leave one out"). `support` is the share of resamples in
   * which the item's response was larger. `index` scales the difference by
   * the subject's calibrated full response (target minus standard), so 1.0
   * means "as strong as recognising your own name".
   */
  function analyseAttention(epochs, ids, times, opts) {
    var o = Object.assign({}, DEFAULTS, { nBoot: 1000, weak: 0.9 }, opts || {}), r = rng(o.seed || 3);
    var aw = windowIdx(times, o.ampWindow), groups = {}, order = [];
    var amps = epochs.map(function (e) { return winMean(e, aw); });
    ids.forEach(function (id, i) { if (!groups[id]) { groups[id] = []; order.push(id); } groups[id].push(amps[i]); });
    // Every item is tested, so correct for multiple comparisons (Bonferroni).
    if (o.strong == null) o.strong = 1 - 0.05 / Math.max(1, order.length);
    var scale = o.calibrationUv > 0 ? o.calibrationUv : null;
    function boot(arr) { var s = 0; for (var k = 0; k < arr.length; k++) s += arr[r.int(arr.length)]; return s / arr.length; }
    function avg(arr) { return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length; }
    var out = order.map(function (id) {
      var mine = groups[id], rest = [];
      order.forEach(function (o2) { if (o2 !== id) rest = rest.concat(groups[o2]); });
      var wins = 0;
      for (var b = 0; b < o.nBoot; b++) if (boot(mine) > boot(rest)) wins++;
      var diff = avg(mine) - avg(rest), support = wins / o.nBoot;
      return { id: id, n: mine.length, support: support, diffUv: diff, index: scale ? diff / scale : null,
        level: mine.length < o.minTrials ? "too_few" : support >= o.strong ? "strong" : support >= o.weak ? "some" : "none" };
    });
    out.sort(function (a, b) { return b.support - a.support || b.diffUv - a.diffUv; });
    return { items: out, thresholds: { strong: o.strong, weak: o.weak }, nBoot: o.nBoot, window: o.ampWindow, version: VERSION };
  }

  /**
   * Calibration from a classic oddball block (a target the subject attends to,
   * among standards). Returns the target-minus-standard amplitude and whether
   * the response is reliable enough to use.
   */
  function calibrate(epochs, labels, times, opts) {
    var o = Object.assign({}, DEFAULTS, { nBoot: 500 }, opts || {}), r = rng(o.seed || 5);
    var aw = windowIdx(times, o.ampWindow), t = [], s = [];
    epochs.forEach(function (e, i) { (labels[i] === "target" ? t : s).push(winMean(e, aw)); });
    if (t.length < o.minTrials || s.length < o.minTrials) return { ok: false, reason: "too_few", nTarget: t.length, nStandard: s.length };
    function boot(arr) { var x = 0; for (var k = 0; k < arr.length; k++) x += arr[r.int(arr.length)]; return x / arr.length; }
    var wins = 0;
    for (var b = 0; b < o.nBoot; b++) if (boot(t) > boot(s)) wins++;
    var avg = function (a) { return a.reduce(function (p, q) { return p + q; }, 0) / a.length; };
    var amp = avg(t) - avg(s), support = wins / o.nBoot;
    var ok = support >= 0.99 && amp >= 2;
    return { ok: ok, amplitudeUv: amp, support: support, nTarget: t.length, nStandard: s.length, reason: ok ? null : "weak" };
  }

  // ---------- CSV import ----------
  /**
   * Epoched CSV: one row per trial, `class,stimulus,v1,...,vN` (µV). Header
   * row optional. All rows must have the same number of samples.
   */
  function parseEpochCsv(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
    var rows = [], labels = [], words = [], width = null, errors = [];
    lines.forEach(function (line, i) {
      var cells = line.split(",").map(function (c) { return c.trim(); });
      var kind = (cells[0] || "").toLowerCase();
      if (i === 0 && KINDS.indexOf(kind) < 0) return; // header
      if (KINDS.indexOf(kind) < 0) { errors.push("Row " + (i + 1) + ": class must be probe, target or irrelevant."); return; }
      var vals = cells.slice(2).map(Number);
      if (vals.some(isNaN)) { errors.push("Row " + (i + 1) + ": sample values must be numbers."); return; }
      if (width === null) width = vals.length;
      if (vals.length !== width) { errors.push("Row " + (i + 1) + ": expected " + width + " samples, found " + vals.length + "."); return; }
      rows.push(vals); labels.push(kind); words.push(cells[1] || "");
    });
    if (!rows.length && !errors.length) errors.push("No trial rows found.");
    return { epochs: rows, labels: labels, words: words, samples: width, errors: errors.slice(0, 5) };
  }

  var api = {
    VERSION: VERSION, KINDS: KINDS, DEFAULTS: DEFAULTS, rng: rng,
    validateProtocol: validateProtocol, buildSequence: buildSequence, timeAxis: timeAxis,
    simulateEpoch: simulateEpoch, simulateResponse: simulateResponse, analyseAttention: analyseAttention, calibrate: calibrate, bandpass: bandpass, preprocess: preprocess,
    analyse: analyse, parseEpochCsv: parseEpochCsv
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BP = api;
})(typeof self !== "undefined" ? self : this);
