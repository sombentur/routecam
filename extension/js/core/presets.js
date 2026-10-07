/*
 * Routecam - built-in route shapes and layer-animation presets (no DOM, no After Effects).
 * User presets saved from the panel use exactly the same shapes of object.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./route.js')); }
  else { root.RC = root.RC || {}; root.RC.presets = factory(root.RC.route); }
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  function pt(x, y, z, extra) { return R.point(Math.round(x), Math.round(y), Math.round(z), extra); }

  /**
   * Route shapes, sized from the composition.  D is the distance of After
   * Effects' default 50 mm camera, so shapes frame the comp plane sensibly.
   * Each returns { points, closed, aim?, target? }.
   */
  var shapes = [
    { id: 'scurve', name: 'S-curve fly-through', make: function (w, h) {
      var cx = w / 2, cy = h / 2, D = w * 50 / 36;
      return { closed: false, aim: { mode: 'ahead' }, points: [
        pt(cx - 0.32 * w, cy - 0.12 * h, -D), pt(cx + 0.26 * w, cy, -0.25 * D), pt(cx - 0.26 * w, cy + 0.04 * h, 0.7 * D),
        pt(cx + 0.22 * w, cy - 0.06 * h, 1.6 * D), pt(cx, cy - 0.2 * h, 2.5 * D)] };
    } },
    { id: 'push', name: 'Straight push-in', make: function (w, h) {
      var cx = w / 2, cy = h / 2, D = w * 50 / 36;
      return { closed: false, aim: { mode: 'ahead' }, points: [pt(cx, cy, -D, { type: 'corner' }), pt(cx, cy, -0.3 * D, { type: 'corner' })] };
    } },
    { id: 'arc', name: 'Arc around the centre', make: function (w, h) {
      var cx = w / 2, cy = h / 2, D = w * 50 / 36, pts = [], k, a;
      for (k = 0; k < 5; k++) { a = (-70 + k * 35) * Math.PI / 180; pts.push(pt(cx + D * Math.sin(a), cy - 0.08 * h, -D * Math.cos(a))); }
      return { closed: false, aim: { mode: 'path', targetLinked: true }, target: [pt(cx, cy, 0)], points: pts };
    } },
    { id: 'orbit', name: 'Full orbit (loop)', make: function (w, h) {
      var cx = w / 2, cy = h / 2, D = w * 50 / 36, pts = [], k, a;
      for (k = 0; k < 8; k++) { a = (180 + k * 45) * Math.PI / 180; pts.push(pt(cx + D * Math.sin(a), cy - 0.1 * h, D * Math.cos(a))); }
      return { closed: true, aim: { mode: 'path', targetLinked: true }, target: [pt(cx, cy, 0)], points: pts };
    } },
    { id: 'spiral', name: 'Spiral descent', make: function (w, h) {
      var cx = w / 2, cy = h / 2, D = w * 50 / 36, pts = [], k, a, f, n = 12;
      for (k = 0; k <= n; k++) { f = k / n; a = (180 + f * 630) * Math.PI / 180; pts.push(pt(cx + D * (1.25 - 0.55 * f) * Math.sin(a), cy - (0.75 - 0.75 * f) * h, D * (1.25 - 0.55 * f) * Math.cos(a))); }
      return { closed: false, aim: { mode: 'path', targetLinked: true }, target: [pt(cx, cy, 0)], points: pts };
    } },
    { id: 'crane', name: 'Crane up and over', make: function (w, h) {
      var cx = w / 2, cy = h / 2, D = w * 50 / 36;
      return { closed: false, aim: { mode: 'path', targetLinked: true }, target: [pt(cx, cy, 0)],
        points: [pt(cx, cy + 0.3 * h, -D), pt(cx, cy - 0.45 * h, -0.8 * D), pt(cx, cy - 1.0 * h, -0.2 * D)] };
    } },
    { id: 'slalom', name: 'Slalom through depth', make: function (w, h) {
      var cx = w / 2, cy = h / 2, D = w * 50 / 36, pts = [], k;
      for (k = 0; k < 7; k++) { pts.push(pt(cx + (k === 0 || k === 6 ? 0 : (k % 2 ? -1 : 1) * 0.16 * w), cy - (k === 0 ? 0.15 * h : 0), -D + k * 0.7 * D)); }
      return { closed: false, aim: { mode: 'ahead' }, points: pts };
    } }
  ];

  /**
   * Layer animation presets.  Offsets are added to the layer's own (rest)
   * values; "in" animates from the offset state to rest, "out" the reverse.
   *   pos [x, y, z] px (y is down)   rot [x, y, z] degrees   scale / opacity in %
   *   trigger: 'approach' (as the camera nears each layer), 'progress' (at a route %), 'time'
   */
  var anims = [
    { id: 'rise', name: 'Rise up', direction: 'in', pos: [0, 320, 0], rot: [0, 0, 0], scale: 100, opacity: 0, duration: 0.8, ease: 'out', overshoot: 0 },
    { id: 'rise-spin', name: 'Rise and turn', direction: 'in', pos: [0, 380, 0], rot: [0, 120, 0], scale: 70, opacity: 0, duration: 1.0, ease: 'out', overshoot: 0 },
    { id: 'drop', name: 'Drop in (bounce)', direction: 'in', pos: [0, -480, 0], rot: [0, 0, 0], scale: 100, opacity: 0, duration: 0.8, ease: 'back', overshoot: 8 },
    { id: 'fly-left', name: 'Fly in from left', direction: 'in', pos: [-700, 0, 0], rot: [0, -35, 0], scale: 100, opacity: 0, duration: 0.9, ease: 'out', overshoot: 0 },
    { id: 'fly-right', name: 'Fly in from right', direction: 'in', pos: [700, 0, 0], rot: [0, 35, 0], scale: 100, opacity: 0, duration: 0.9, ease: 'out', overshoot: 0 },
    { id: 'depth', name: 'Arrive from depth', direction: 'in', pos: [0, 0, 900], rot: [0, 0, 0], scale: 100, opacity: 0, duration: 1.0, ease: 'out', overshoot: 0 },
    { id: 'pop', name: 'Scale pop', direction: 'in', pos: [0, 0, 0], rot: [0, 0, 0], scale: 0, opacity: 100, duration: 0.6, ease: 'back', overshoot: 12 },
    { id: 'flip', name: 'Flip up', direction: 'in', pos: [0, 0, 0], rot: [-90, 0, 0], scale: 100, opacity: 0, duration: 0.8, ease: 'back', overshoot: 6 },
    { id: 'door', name: 'Door swing', direction: 'in', pos: [0, 0, 0], rot: [0, 90, 0], scale: 100, opacity: 0, duration: 0.9, ease: 'out', overshoot: 0 },
    { id: 'sink', name: 'Sink away (out)', direction: 'out', pos: [0, 420, 0], rot: [0, 0, 0], scale: 80, opacity: 0, duration: 0.8, ease: 'in', overshoot: 0 }
  ];
  var syncDefaults = { trigger: 'approach', startTime: 0, startPct: 10, stagger: 0.12, staggerPct: 6, lead: 14, span: 8, order: 'route' };

  function withDefaults(a) {
    var out = {}, k;
    for (k in syncDefaults) { out[k] = syncDefaults[k]; }
    for (k in a) { out[k] = a[k]; }
    out.pos = (a.pos || [0, 0, 0]).slice(); out.rot = (a.rot || [0, 0, 0]).slice();
    return out;
  }

  function seeded(seed) { var s = seed >>> 0 || 1; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

  /**
   * Work out when each layer animates.
   *   layers   [{ id, pos:[x,y,z], index }] in selection order
   *   returns  [{ id, startPct, spanPct, t0, t1 }]  (percentages are null for time-triggered animation)
   */
  function schedule(layers, anim, route, model) {
    var a = withDefaults(anim), keys = model.tm.keys, list = layers.slice(), rnd = seeded(7), out = [], i, L, sp, t0, t1;
    var haveRoute = !model.table.empty && model.table.total > 0;
    for (i = 0; i < list.length; i++) { list[i] = { id: list[i].id, pos: list[i].pos, index: list[i].index, sel: i, u: haveRoute ? R.nearestU(model.table, list[i].pos) : 0, r: rnd() }; }
    if (a.order === 'route') { list.sort(function (p, q) { return p.u - q.u || p.sel - q.sel; }); }
    else if (a.order === 'depth') { list.sort(function (p, q) { return p.pos[2] - q.pos[2] || p.sel - q.sel; }); }
    else if (a.order === 'index') { list.sort(function (p, q) { return p.index - q.index; }); }
    else if (a.order === 'random') { list.sort(function (p, q) { return p.r - q.r; }); }
    var flight = Math.max(model.tm.end - model.tm.start, 0.05);
    for (i = 0; i < list.length; i++) {
      L = list[i];
      if (a.trigger === 'time' || !haveRoute) {
        t0 = R.num(a.startTime, 0) + i * R.num(a.stagger, 0);
        out.push({ id: L.id, startPct: null, spanPct: null, t0: t0, t1: t0 + Math.max(R.num(a.duration, 0.8), 0.05) });
      } else {
        sp = Math.max(R.num(a.span, 8), 0.1);
        var st = a.trigger === 'approach' ? R.clamp(L.u * 100 - R.num(a.lead, 14), 0, 100 - sp) : R.clamp(R.num(a.startPct, 0) + i * R.num(a.staggerPct, 0), 0, 100 - sp);
        t0 = R.timeAtValue(keys, st); t1 = R.timeAtValue(keys, st + sp);
        if (t1 - t0 < 0.05) { t1 = t0 + Math.max(sp / 100 * flight, 0.05); }
        out.push({ id: L.id, startPct: st, spanPct: sp, t0: t0, t1: t1 });
      }
    }
    return out;
  }

  /** Route used by the sample composition: weaves between two rows of cards. */
  function sampleRoute() {
    var r = R.defaultRoute();
    r.points = [
      pt(960, 180, -2600), pt(770, 520, -300), pt(1170, 600, 1900),
      pt(750, 570, 4100, { pause: 0.7 }), pt(1160, 530, 6000, { speed: 1.5, focal: 24 }), pt(960, 250, 8300, { focal: 35 })
    ];
    r.points[0].focal = 30;
    r.timing = { start: 0.5, duration: 11, ease: 'both', easeStrength: 55, pauseEase: 65 };
    r.aim = { mode: 'ahead', lookAhead: 9, smooth: 3, layerId: 0, layerName: '', targetLinked: true };
    r.camera.focal = 30; r.camera.bank = 130; r.camera.maxBank = 22;
    return r;
  }

  return { shapes: shapes, anims: anims, syncDefaults: syncDefaults, withDefaults: withDefaults, schedule: schedule, sampleRoute: sampleRoute };
});
