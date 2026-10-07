/*
 * Routecam - route maths (no DOM, no After Effects).
 *
 * Everything the panel previews is computed here, and the expressions written
 * by host/index.jsx mirror the same formulas, so the panel preview and the
 * After Effects result agree (tests/ae-e2e.mjs compares them numerically).
 *
 * Coordinates are After Effects composition space: X right, Y DOWN, Z into the
 * screen.  "Elevation" in the UI is (comp height / 2 - y); "depth" is z.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.RC = root.RC || {}; root.RC.route = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SAMPLES = 64;          // arc-length samples per Bezier segment
  var EPS_U = 0.002;         // finite-difference step used to extrapolate past the ends (same in the expressions)
  var BANK_WINDOW = 0.03;    // route fraction either side used to measure the turn (same in the expressions)
  var FILM = 36;             // After Effects' default film size (mm), measured horizontally
  var THIRD = 100 / 3;

  /* ------------------------------------------------------------ vectors */

  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function mul(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function dist(a, b) { return len(sub(a, b)); }
  function norm(a) { var l = len(a); return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0]; }
  function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function num(v, fallback) { v = parseFloat(v); return isFinite(v) ? v : fallback; }
  function hasValue(v) { return v !== null && v !== undefined && v !== '' && isFinite(+v); }

  /* -------------------------------------------------------------- model */

  function point(x, y, z, extra) {
    var p = { x: x, y: y, z: z, type: 'auto', i: [0, 0, 0], o: [0, 0, 0], pause: 0, speed: 1, roll: null, focal: null };
    if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) { p[k] = extra[k]; } } }
    return p;
  }

  function defaultRoute() {
    return {
      version: 1,
      closed: false,
      points: [],
      target: { points: [] },
      timing: { start: 0, duration: 8, ease: 'both', easeStrength: 60, pauseEase: 60 },
      aim: { mode: 'ahead', lookAhead: 8, smooth: 3, layerId: 0, layerName: '', targetLinked: true },
      camera: { focal: 35, roll: 0, bank: 100, maxBank: 25, dof: false, fstop: 2.8, focusMode: 'aim', focusLayerId: 0, focusLayerName: '', focusDistance: 1500, blur: 100 }
    };
  }

  /** Fill in anything missing (older saved routes, hand-edited presets). */
  function normalize(r) {
    var d = defaultRoute(), k, g, groups = ['timing', 'aim', 'camera'];
    r = r || {};
    var out = { version: 1, closed: !!r.closed, points: [], target: { points: [] } };
    function fixPoints(list) {
      var res = [], i, s, p;
      for (i = 0; i < (list || []).length; i++) {
        s = list[i];
        p = point(num(s.x, 0), num(s.y, 0), num(s.z, 0));
        p.type = (s.type === 'bezier' || s.type === 'corner') ? s.type : 'auto';
        if (s.i && s.i.length === 3) { p.i = [num(s.i[0], 0), num(s.i[1], 0), num(s.i[2], 0)]; }
        if (s.o && s.o.length === 3) { p.o = [num(s.o[0], 0), num(s.o[1], 0), num(s.o[2], 0)]; }
        p.broken = !!s.broken;
        p.pause = Math.max(0, num(s.pause, 0));
        p.speed = clamp(num(s.speed, 1), 0.05, 20);
        p.roll = hasValue(s.roll) ? +s.roll : null;
        p.focal = hasValue(s.focal) ? +s.focal : null;
        res.push(p);
      }
      return res;
    }
    out.points = fixPoints(r.points);
    out.target.points = fixPoints(r.target && r.target.points);
    for (g = 0; g < groups.length; g++) {
      out[groups[g]] = {};
      for (k in d[groups[g]]) { out[groups[g]][k] = (r[groups[g]] && r[groups[g]][k] !== undefined) ? r[groups[g]][k] : d[groups[g]][k]; }
    }
    return out;
  }

  function pos(p) { return [p.x, p.y, p.z]; }

  /**
   * Turn editor points into Bezier keys { p, i, o } (tangents relative to p,
   * exactly what After Effects calls spatial tangents).
   *   corner  no handles (straight lines)
   *   auto    direction follows the neighbours, handle length = 1/3 of each neighbouring chord
   *   bezier  the stored handles
   */
  function resolve(points, closed) {
    var n = points.length, out = [], k, p, prev, next, dir;
    for (k = 0; k < n; k++) {
      p = points[k];
      prev = k > 0 ? points[k - 1] : (closed && n > 2 ? points[n - 1] : null);
      next = k < n - 1 ? points[k + 1] : (closed && n > 2 ? points[0] : null);
      if (p.type === 'corner') { out.push({ p: pos(p), i: [0, 0, 0], o: [0, 0, 0] }); }
      else if (p.type === 'bezier') { out.push({ p: pos(p), i: p.i.slice(), o: p.o.slice() }); }
      else if (prev && next) {
        dir = norm(sub(pos(next), pos(prev)));
        out.push({ p: pos(p), i: mul(dir, -dist(pos(p), pos(prev)) / 3), o: mul(dir, dist(pos(next), pos(p)) / 3) });
      }
      else if (next) { out.push({ p: pos(p), i: [0, 0, 0], o: mul(sub(pos(next), pos(p)), 1 / 3) }); }
      else if (prev) { out.push({ p: pos(p), i: mul(sub(pos(prev), pos(p)), 1 / 3), o: [0, 0, 0] }); }
      else { out.push({ p: pos(p), i: [0, 0, 0], o: [0, 0, 0] }); }
    }
    return out;
  }

  /** Keys as written to After Effects: a closed route repeats its first key at the end. */
  function pathKeys(points, closed) {
    var keys = resolve(points, closed);
    if (closed && keys.length > 2) { keys.push({ p: keys[0].p.slice(), i: keys[0].i.slice(), o: keys[0].o.slice() }); }
    return keys;
  }

  /* --------------------------------------------------------- arc length */

  function bez(b0, b1, b2, b3, t) {
    var u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return [a * b0[0] + b * b1[0] + c * b2[0] + d * b3[0], a * b0[1] + b * b1[1] + c * b2[1] + d * b3[1], a * b0[2] + b * b1[2] + c * b2[2] + d * b3[2]];
  }

  function buildTable(keys) {
    var segs = [], cum = [0], pts = [], total = 0, j, s, q, prev, cur;
    if (!keys || !keys.length) { return { empty: true, segs: [], cum: [0], total: 0, count: 0 }; }
    for (j = 0; j < keys.length - 1; j++) {
      segs.push([keys[j].p, add(keys[j].p, keys[j].o), add(keys[j + 1].p, keys[j + 1].i), keys[j + 1].p]);
    }
    pts.push(keys[0].p);
    for (j = 0; j < segs.length; j++) {
      s = segs[j]; prev = s[0];
      for (q = 1; q <= SAMPLES; q++) {
        cur = bez(s[0], s[1], s[2], s[3], q / SAMPLES);
        total += dist(prev, cur); cum.push(total); pts.push(cur); prev = cur;
      }
    }
    return { empty: false, single: keys[0].p, segs: segs, cum: cum, pts: pts, total: total, count: keys.length };
  }

  /** Point at arc-length fraction u (0..1). */
  function tablePoint(tb, u) {
    if (tb.empty) { return [0, 0, 0]; }
    if (!tb.segs.length || tb.total <= 0) { return tb.single.slice(); }
    // Distance is linear between neighbouring samples, so interpolate positions (not the Bezier
    // parameter): exact on straight lines, well under a pixel on curves.
    var target = clamp(u, 0, 1) * tb.total, lo = 0, hi = tb.cum.length - 1, mid, span;
    while (hi - lo > 1) { mid = (lo + hi) >> 1; if (tb.cum[mid] <= target) { lo = mid; } else { hi = mid; } }
    span = tb.cum[hi] - tb.cum[lo];
    return lerp(tb.pts[lo], tb.pts[hi], span > 0 ? (target - tb.cum[lo]) / span : 0);
  }

  /** Arc-length fraction at which the path passes key k. */
  function keyFraction(tb, k) {
    if (tb.total <= 0) { return tb.count > 1 ? k / (tb.count - 1) : 0; }
    return tb.cum[Math.min(k * SAMPLES, tb.cum.length - 1)] / tb.total;
  }
  function fractions(tb) { var out = [], k; for (k = 0; k < tb.count; k++) { out.push(keyFraction(tb, k)); } return out; }

  /**
   * Position at route fraction u.  Past either end the path is continued in a
   * straight line (so a look-ahead target never collapses onto the camera);
   * closed routes wrap instead.  Mirrors onPath() in the expressions.
   */
  function pathAt(tb, u, loop) {
    var a, b;
    if (tb.empty) { return [0, 0, 0]; }
    if (!tb.segs.length || tb.total <= 0) { return tb.single.slice(); }
    if (loop) { if (u < 0 || u > 1) { u = u - Math.floor(u); } return tablePoint(tb, u); }
    if (u > 1) { a = tablePoint(tb, 1); b = tablePoint(tb, 1 - EPS_U); return add(a, mul(sub(a, b), (u - 1) / EPS_U)); }
    if (u < 0) { a = tablePoint(tb, 0); b = tablePoint(tb, EPS_U); return add(a, mul(sub(a, b), -u / EPS_U)); }
    return tablePoint(tb, u);
  }

  /** Route fraction closest to a world position (used to trigger layers as the camera approaches). */
  function nearestU(tb, p) {
    if (tb.empty || tb.total <= 0) { return 0; }
    var steps = Math.max(200, tb.segs.length * 60), best = 0, bestD = Infinity, k, d, u, lo, hi, m1, m2, it;
    for (k = 0; k <= steps; k++) { u = k / steps; d = dist(tablePoint(tb, u), p); if (d < bestD) { bestD = d; best = u; } }
    lo = Math.max(0, best - 1 / steps); hi = Math.min(1, best + 1 / steps);
    for (it = 0; it < 24; it++) {
      m1 = lo + (hi - lo) / 3; m2 = hi - (hi - lo) / 3;
      if (dist(tablePoint(tb, m1), p) < dist(tablePoint(tb, m2), p)) { hi = m2; } else { lo = m1; }
    }
    return (lo + hi) / 2;
  }

  /* -------------------------------------------------------------- timing */

  /**
   * Build the "Route Progress" keyframes (value 0..100 against comp time).
   *   fr      route fraction of every path key
   * Constant speed with no pauses is two keys.  Extra keys appear only where a
   * pause or a speed change needs them.  Each key carries After Effects style
   * temporal ease: speed in %/s and influence in %.
   */
  function timing(route, fr) {
    var pts = route.points, T = route.timing, m = fr.length, n = pts.length;
    var start = num(T.start, 0), dur = Math.max(num(T.duration, 1), 0.05), k, j;
    if (m < 2 || !n) { return { keys: [{ t: start, v: 0, pt: 0, i: { s: 0, f: THIRD }, o: { s: 0, f: THIRD } }], arrive: [start], depart: [start], start: start, end: start + dur }; }
    function meta(q) { return pts[q % n]; }

    var pause = [], sumPause = 0, pz;
    for (k = 0; k < m; k++) {
      pz = Math.max(0, num(meta(k).pause, 0));
      if (route.closed && k === m - 1) { pz = 0; }          // the repeated first point pauses at the start only
      pause.push(pz); sumPause += pz;
    }
    if (sumPause > dur * 0.9) { for (k = 0; k < m; k++) { pause[k] *= dur * 0.9 / sumPause; } sumPause = dur * 0.9; }

    var move = dur - sumPause, raw = [], sumRaw = 0, spd = [], w, r;
    for (k = 0; k < m - 1; k++) {
      w = clamp(num(meta(k).speed, 1), 0.05, 20); spd.push(w);
      r = Math.max(fr[k + 1] - fr[k], 1e-7) / w; raw.push(r); sumRaw += r;
    }
    var arrive = [start], depart = [];
    for (k = 0; k < m; k++) {
      depart.push(arrive[k] + pause[k]);
      if (k < m - 1) { arrive.push(depart[k] + move * raw[k] / sumRaw); }
    }

    var nodes = [0];
    for (k = 1; k < m - 1; k++) { if (pause[k] > 0 || spd[k - 1] !== spd[k]) { nodes.push(k); } }
    nodes.push(m - 1);

    var spans = [], a, b;
    for (j = 0; j < nodes.length - 1; j++) {
      a = nodes[j]; b = nodes[j + 1];
      spans.push({ t0: depart[a], t1: arrive[b], v0: fr[a] * 100, v1: fr[b] * 100 });
      spans[j].sec = (spans[j].v1 - spans[j].v0) / Math.max(spans[j].t1 - spans[j].t0, 1e-9);
    }

    var E = clamp(num(T.easeStrength, 60), 0.1, 100), PE = clamp(num(T.pauseEase, 60), 0, 100);
    var easeStart = T.ease === 'start' || T.ease === 'both', easeEnd = T.ease === 'end' || T.ease === 'both';
    // outE[j] leaves node j (start of span j); inE[j] arrives at node j (end of span j-1)
    var outE = [], inE = [], sa, sb, ms;
    for (j = 0; j < nodes.length; j++) {
      k = nodes[j]; sa = j > 0 ? spans[j - 1].sec : 0; sb = j < spans.length ? spans[j].sec : 0;
      if (j === 0) {
        inE.push({ s: 0, f: THIRD });
        outE.push(easeStart ? { s: 0, f: E } : (pause[k] > 0 && PE > 0.1 ? { s: 0, f: PE } : { s: sb, f: THIRD }));
      } else if (j === nodes.length - 1) {
        inE.push(easeEnd ? { s: 0, f: E } : (pause[k] > 0 && PE > 0.1 ? { s: 0, f: PE } : { s: sa, f: THIRD }));
        outE.push({ s: 0, f: THIRD });
      } else if (pause[k] > 0) {
        inE.push(PE > 0.1 ? { s: 0, f: PE } : { s: sa, f: THIRD });
        outE.push(PE > 0.1 ? { s: 0, f: PE } : { s: sb, f: THIRD });
      } else {
        ms = Math.min((sa + sb) / 2, 3 * Math.min(sa, sb));      // blend speeds without overshooting
        inE.push({ s: ms, f: THIRD }); outE.push({ s: ms, f: THIRD });
      }
    }
    // Keep every span monotonic (the camera must never run backwards).
    var sp, dt, dv, ha, hb, f, lin = [];
    for (j = 0; j < spans.length; j++) {
      sp = spans[j]; dt = sp.t1 - sp.t0; dv = sp.v1 - sp.v0;
      ha = outE[j].s * outE[j].f / 100 * dt; hb = inE[j + 1].s * inE[j + 1].f / 100 * dt;
      if (ha + hb > dv && ha + hb > 0) { f = dv / (ha + hb); outE[j].s *= f; inE[j + 1].s *= f; }
      lin.push(Math.abs(outE[j].s - sp.sec) <= 1e-9 * Math.abs(sp.sec) + 1e-12 && Math.abs(inE[j + 1].s - sp.sec) <= 1e-9 * Math.abs(sp.sec) + 1e-12 &&
               Math.abs(outE[j].f - THIRD) < 1e-9 && Math.abs(inE[j + 1].f - THIRD) < 1e-9);
    }

    var keys = [], key;
    for (j = 0; j < nodes.length; j++) {
      k = nodes[j];
      key = { t: arrive[k], v: fr[k] * 100, pt: k, i: inE[j], o: outE[j], linIn: j > 0 && lin[j - 1], linOut: j < spans.length && lin[j] };
      if (pause[k] > 0) {
        keys.push({ t: arrive[k], v: key.v, pt: k, i: key.i, o: { s: 0, f: THIRD }, linIn: key.linIn, linOut: true });
        keys.push({ t: depart[k], v: key.v, pt: k, i: { s: 0, f: THIRD }, o: key.o, linIn: true, linOut: key.linOut });
      } else { keys.push(key); }
    }
    return { keys: keys, arrive: arrive, depart: depart, start: start, end: start + dur };
  }

  /** Evaluate a keyed 1-D value the way After Effects does (Bezier speed/influence handles). */
  function evalKeys(keys, t) {
    var n = keys.length, lo, hi, mid, a, b, dt, x1, x2, y1, y2, s0, s1, it, x, u;
    if (!n) { return 0; }
    if (t <= keys[0].t) { return keys[0].v; }
    if (t >= keys[n - 1].t) { return keys[n - 1].v; }
    lo = 0; hi = n - 1;
    while (hi - lo > 1) { mid = (lo + hi) >> 1; if (keys[mid].t <= t) { lo = mid; } else { hi = mid; } }
    a = keys[lo]; b = keys[hi]; dt = b.t - a.t;
    if (dt <= 0 || a.v === b.v) { return a.v; }
    x1 = a.t + a.o.f / 100 * dt; x2 = b.t - b.i.f / 100 * dt;
    y1 = a.v + a.o.s * a.o.f / 100 * dt; y2 = b.v - b.i.s * b.i.f / 100 * dt;
    s0 = 0; s1 = 1;
    for (it = 0; it < 50; it++) {
      u = (s0 + s1) / 2;
      x = (1 - u) * (1 - u) * (1 - u) * a.t + 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u * b.t;
      if (x < t) { s0 = u; } else { s1 = u; }
    }
    u = (s0 + s1) / 2;
    return (1 - u) * (1 - u) * (1 - u) * a.v + 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u * b.v;
  }

  /** First time at which the keyed value reaches v (values never decrease). */
  function timeAtValue(keys, v) {
    var n = keys.length, j, lo, hi, mid, it;
    if (!n || v <= keys[0].v) { return n ? keys[0].t : 0; }
    if (v >= keys[n - 1].v) {
      for (j = 0; j < n; j++) { if (keys[j].v >= keys[n - 1].v) { return keys[j].t; } }
      return keys[n - 1].t;
    }
    for (j = 0; j < n - 1; j++) {
      if (v >= keys[j].v && v <= keys[j + 1].v && keys[j + 1].v > keys[j].v) {
        lo = keys[j].t; hi = keys[j + 1].t;
        for (it = 0; it < 50; it++) { mid = (lo + hi) / 2; if (evalKeys(keys, mid) < v) { lo = mid; } else { hi = mid; } }
        return (lo + hi) / 2;
      }
    }
    return keys[n - 1].t;
  }

  /** Per-point values (roll, focal length) become keys at the moment the camera reaches each point. */
  function scalarKeys(route, tm, field, count) {
    var out = [], k, v, n = route.points.length;
    if (!n) { return out; }
    for (k = 0; k < count; k++) {
      v = route.points[k % n][field];
      if (hasValue(v)) { out.push({ t: tm.arrive[k], v: +v }); }
    }
    return out;
  }
  /** Easy-ease between scalar keys (zero speed, 33.3% influence = smoothstep). */
  function evalScalar(keys, t, base) {
    var n = keys.length, j, u;
    if (!n) { return base; }
    if (t <= keys[0].t) { return keys[0].v; }
    if (t >= keys[n - 1].t) { return keys[n - 1].v; }
    for (j = 0; j < n - 1; j++) {
      if (t >= keys[j].t && t <= keys[j + 1].t) {
        u = (t - keys[j].t) / Math.max(keys[j + 1].t - keys[j].t, 1e-9);
        return keys[j].v + (keys[j + 1].v - keys[j].v) * (3 * u * u - 2 * u * u * u);
      }
    }
    return keys[n - 1].v;
  }

  /* -------------------------------------------------------------- camera */

  /** Everything derived from a route, built once per edit. */
  function buildModel(route) {
    var keys = pathKeys(route.points, route.closed), table = buildTable(keys), fr = fractions(table);
    var tm = timing(route, fr);
    var tkeys = pathKeys(route.target.points, false), ttable = buildTable(tkeys);
    return {
      keys: keys, table: table, fr: fr, tm: tm,
      rollKeys: scalarKeys(route, tm, 'roll', keys.length),
      focalKeys: scalarKeys(route, tm, 'focal', keys.length),
      tkeys: tkeys, ttable: ttable, tfr: fractions(ttable)
    };
  }

  function wrapPi(a) { if (a > Math.PI) { a -= 2 * Math.PI; } if (a < -Math.PI) { a += 2 * Math.PI; } return a; }

  /** Signed banking angle (degrees) at route fraction u. Mirrors the Z Rotation expression. */
  function bankAt(route, M, u) {
    var amt = num(route.camera.bank, 0) / 100, mx = Math.abs(num(route.camera.maxBank, 0));
    if (!amt || M.table.total <= 0) { return 0; }
    var A = pathAt(M.table, u - BANK_WINDOW, route.closed), C = pathAt(M.table, u, route.closed), B = pathAt(M.table, u + BANK_WINDOW, route.closed);
    var ax = C[0] - A[0], az = C[2] - A[2], bx = B[0] - C[0], bz = B[2] - C[2];
    if (ax * ax + az * az < 1e-6 || bx * bx + bz * bz < 1e-6) { return 0; }
    var dh = wrapPi(Math.atan2(bx, bz) - Math.atan2(ax, az));
    return clamp(dh * 180 / Math.PI * amt, -mx, mx);
  }

  /**
   * Camera state at comp time t.
   *   env.compW                 composition width (focal length -> zoom)
   *   env.layerPos(id)          world position of a layer, or null
   *   env.manualPoi             point of interest to use in manual aim mode
   */
  function solve(route, M, t, env) {
    env = env || {};
    var u = clamp(evalKeys(M.tm.keys, t) / 100, 0, 1);
    var p = pathAt(M.table, u, route.closed), aim = route.aim, poi = null, k, n, la, sm, s, tu;
    if (aim.mode === 'layer' && env.layerPos) { poi = env.layerPos(aim.layerId); }
    else if (aim.mode === 'path' && !M.ttable.empty) {
      tu = aim.targetLinked !== false ? u : clamp((t - M.tm.start) / Math.max(M.tm.end - M.tm.start, 1e-6), 0, 1);
      poi = pathAt(M.ttable, tu, false);
    }
    else if (aim.mode === 'manual') { poi = env.manualPoi || null; }
    if (!poi) {
      la = Math.max(num(aim.lookAhead, 8) / 100, 0.001);
      sm = Math.min(Math.max(num(aim.smooth, 0) / 100, 0), la * 0.9);
      n = sm > 0 ? 5 : 1; s = [0, 0, 0];
      for (k = 0; k < n; k++) { s = add(s, pathAt(M.table, u + la + (n > 1 ? (k / (n - 1) - 0.5) * 2 * sm : 0), route.closed)); }
      poi = mul(s, 1 / n);
    }
    var roll = evalScalar(M.rollKeys, t, num(route.camera.roll, 0));
    var bank = bankAt(route, M, u);
    var focal = Math.max(evalScalar(M.focalKeys, t, num(route.camera.focal, 35)), 1);
    return { t: t, u: u, pos: p, poi: poi, roll: roll, bank: bank, rotZ: roll + bank, focal: focal, zoom: (env.compW || 1920) * focal / FILM, focus: dist(p, poi) };
  }

  /** Camera axes for a two-node After Effects camera (X right, Y down, Z forward), with roll about the view axis. */
  function cameraBasis(cam) {
    var f = norm(sub(cam.poi, cam.pos)), r, d, th, c, s;
    if (len(f) === 0) { f = [0, 0, 1]; }
    r = norm(cross([0, 1, 0], f));
    if (len(r) === 0) { r = [1, 0, 0]; }
    d = cross(f, r);
    th = (cam.rotZ || 0) * Math.PI / 180; c = Math.cos(th); s = Math.sin(th);
    return { r: add(mul(r, c), mul(d, s)), d: add(mul(r, -s), mul(d, c)), f: f };
  }
  /** World point -> camera space [x, y, depth]. */
  function toCamera(cam, basis, w) { var v = sub(w, cam.pos); return [dot(v, basis.r), dot(v, basis.d), dot(v, basis.f)]; }
  /** World point -> composition pixels (what layer.toComp() returns in After Effects), or null behind the camera. */
  function project(cam, basis, w, compW, compH) {
    var c = toCamera(cam, basis, w);
    if (c[2] <= 1e-6) { return null; }
    return [compW / 2 + cam.zoom * c[0] / c[2], compH / 2 + cam.zoom * c[1] / c[2], c[2]];
  }

  /* --------------------------------------------------------- path tools */

  /** Ramer-Douglas-Peucker on [x, y] samples (freehand sketch -> a few control points). */
  function simplify(pts, tol) {
    if (pts.length < 3) { return pts.slice(); }
    var keep = [], stack = [[0, pts.length - 1]], seg, a, b, i, d, dx, dy, l2, t, px, py, maxD, idx;
    for (i = 0; i < pts.length; i++) { keep.push(false); }
    keep[0] = keep[pts.length - 1] = true;
    while (stack.length) {
      seg = stack.pop(); a = pts[seg[0]]; b = pts[seg[1]]; maxD = 0; idx = -1;
      dx = b[0] - a[0]; dy = b[1] - a[1]; l2 = dx * dx + dy * dy;
      for (i = seg[0] + 1; i < seg[1]; i++) {
        t = l2 > 0 ? clamp(((pts[i][0] - a[0]) * dx + (pts[i][1] - a[1]) * dy) / l2, 0, 1) : 0;
        px = a[0] + dx * t - pts[i][0]; py = a[1] + dy * t - pts[i][1];
        d = Math.sqrt(px * px + py * py);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (idx >= 0 && maxD > tol) { keep[idx] = true; stack.push([seg[0], idx]); stack.push([idx, seg[1]]); }
    }
    var out = [];
    for (i = 0; i < pts.length; i++) { if (keep[i]) { out.push(pts[i]); } }
    return out;
  }

  /** Drop points that sit on top of their predecessor (zero-length segments break timing). */
  function dedupe(points) {
    var out = [], i;
    for (i = 0; i < points.length; i++) {
      if (!out.length || dist(pos(points[i]), pos(out[out.length - 1])) > 0.01) { out.push(points[i]); }
    }
    return out;
  }

  return {
    SAMPLES: SAMPLES, EPS_U: EPS_U, BANK_WINDOW: BANK_WINDOW, FILM: FILM,
    add: add, sub: sub, mul: mul, dot: dot, cross: cross, len: len, dist: dist, norm: norm, lerp: lerp, clamp: clamp, num: num, hasValue: hasValue,
    point: point, defaultRoute: defaultRoute, normalize: normalize, pos: pos,
    resolve: resolve, pathKeys: pathKeys, bez: bez, buildTable: buildTable, tablePoint: tablePoint, keyFraction: keyFraction, fractions: fractions,
    pathAt: pathAt, nearestU: nearestU, timing: timing, evalKeys: evalKeys, timeAtValue: timeAtValue, scalarKeys: scalarKeys, evalScalar: evalScalar,
    buildModel: buildModel, bankAt: bankAt, solve: solve, cameraBasis: cameraBasis, toCamera: toCamera, project: project,
    simplify: simplify, dedupe: dedupe
  };
});
