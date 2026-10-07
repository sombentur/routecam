import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../../extension/js/core/route.js');
const P = require('../../extension/js/core/presets.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const route = (pts, over = {}) => {
  const r = R.defaultRoute();
  r.points = pts.map((p) => R.point(p[0], p[1], p[2], p[3]));
  r.timing = { start: 1, duration: 10, ease: 'none', easeStrength: 60, pauseEase: 60 };
  return Object.assign(r, over);
};
const curved = () => route([[0, 500, 0], [800, 300, 1500], [-400, 600, 3200], [900, 450, 5000], [200, 200, 7000]]);

test('auto tangents point along the neighbours and corners have none', () => {
  const keys = R.resolve([R.point(0, 0, 0), R.point(300, 0, 0), R.point(300, 0, 600, { type: 'corner' })], false);
  assert.deepEqual(keys[0].o, [100, 0, 0]);
  near(keys[1].o[0] / keys[1].o[2], 300 / 600, 1e-9, 'direction');
  near(R.len(keys[1].o), 200, 1e-9, 'out length is a third of the next chord');
  near(R.len(keys[1].i), 100, 1e-9, 'in length is a third of the previous chord');
  assert.deepEqual(keys[2].i, [0, 0, 0]);
});

test('closed routes repeat the first key', () => {
  const pts = [R.point(0, 0, 0), R.point(100, 0, 0), R.point(100, 0, 100), R.point(0, 0, 100)];
  const keys = R.pathKeys(pts, true);
  assert.equal(keys.length, 5);
  assert.deepEqual(keys[4].p, keys[0].p);
  near(R.len(keys[0].i), R.len(keys[0].o), 1e-9, 'closed route start is smooth');
});

test('arc-length parameterisation is uniform along a curved path', () => {
  const M = R.buildModel(curved());
  let prev = R.tablePoint(M.table, 0), min = Infinity, max = 0;
  for (let k = 1; k <= 400; k++) { const p = R.tablePoint(M.table, k / 400); const d = R.dist(prev, p); min = Math.min(min, d); max = Math.max(max, d); prev = p; }
  assert.ok(max / min < 1.02, `step ratio ${max / min}`);
  near(M.fr[0], 0, 1e-12); near(M.fr[M.fr.length - 1], 1, 1e-12);
  for (let k = 0; k < M.keys.length; k++) assert.ok(R.dist(R.tablePoint(M.table, M.fr[k]), M.keys[k].p) < 1e-6, 'path passes through key ' + k);
});

test('a quarter circle built from Bezier handles has the right length', () => {
  const k = 0.5522847498 * 1000;
  const keys = [{ p: [1000, 0, 0], i: [0, 0, 0], o: [0, 0, k] }, { p: [0, 0, 1000], i: [k, 0, 0], o: [0, 0, 0] }];
  near(R.buildTable(keys).total, Math.PI * 500, 1.0);
});

test('extrapolation continues straight past both ends; loops wrap', () => {
  const M = R.buildModel(route([[0, 0, 0, { type: 'corner' }], [0, 0, 1000, { type: 'corner' }]]));
  const p = R.pathAt(M.table, 1.25, false), q = R.pathAt(M.table, -0.5, false);
  near(p[2], 1250, 1e-6); near(q[2], -500, 1e-6);
  const L = R.buildModel(route([[0, 0, 0], [100, 0, 0], [100, 0, 100], [0, 0, 100]], { closed: true }));
  assert.ok(R.dist(R.pathAt(L.table, 1.1, true), R.pathAt(L.table, 0.1, true)) < 1e-9);
});

test('nearestU finds the closest point on the route', () => {
  const M = R.buildModel(curved());
  for (const u of [0.07, 0.33, 0.61, 0.93]) near(R.nearestU(M.table, R.tablePoint(M.table, u)), u, 2e-4);
});

test('constant speed with no pauses is two linear keys', () => {
  const r = curved(), M = R.buildModel(r);
  assert.equal(M.tm.keys.length, 2);
  assert.ok(M.tm.keys[0].linOut && M.tm.keys[1].linIn);
  for (const t of [1, 2.5, 6, 11]) near(R.evalKeys(M.tm.keys, t), (t - 1) * 10, 1e-6, 'progress at ' + t);
  near(R.evalKeys(M.tm.keys, 0), 0, 0); near(R.evalKeys(M.tm.keys, 20), 100, 0);
});

test('easing starts and ends at rest and stays monotonic', () => {
  const r = curved(); r.timing.ease = 'both'; r.timing.easeStrength = 80;
  const M = R.buildModel(r);
  assert.ok(R.evalKeys(M.tm.keys, 1.5) < 2, 'slow start');
  assert.ok(R.evalKeys(M.tm.keys, 10.5) > 98, 'slow finish');
  near(R.evalKeys(M.tm.keys, 6), 50, 1e-6, 'symmetric');
  let prev = -1;
  for (let t = 1; t <= 11; t += 0.01) { const v = R.evalKeys(M.tm.keys, t); assert.ok(v >= prev - 1e-9); prev = v; }
});

test('pauses hold the camera exactly on the control point for the requested time', () => {
  const r = curved(); r.points[2].pause = 1.5; r.timing.pauseEase = 60;
  const M = R.buildModel(r), tm = M.tm;
  near(tm.depart[2] - tm.arrive[2], 1.5, 1e-9);
  near(tm.arrive[4], 11, 1e-9, 'total duration is unchanged');
  for (const t of [tm.arrive[2], tm.arrive[2] + 0.7, tm.depart[2]]) near(R.evalKeys(tm.keys, t), M.fr[2] * 100, 1e-6);
  const cam = R.solve(r, M, tm.arrive[2] + 0.5, { compW: 1920 });
  assert.ok(R.dist(cam.pos, [r.points[2].x, r.points[2].y, r.points[2].z]) < 1e-3);
  assert.equal(tm.keys.filter((k) => k.pt === 2).length, 2);
});

test('segment speed multipliers change travel time in proportion', () => {
  const r = route([[0, 0, 0, { type: 'corner' }], [0, 0, 1000, { type: 'corner', speed: 2 }], [0, 0, 2000, { type: 'corner' }]]);
  const tm = R.buildModel(r).tm;
  near((tm.arrive[1] - tm.depart[0]) / (tm.arrive[2] - tm.depart[1]), 2, 1e-9, 'second leg is twice as fast');
  near(tm.arrive[2], 11, 1e-9);
});

test('progress never runs backwards for random routes, pauses and speeds', () => {
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let it = 0; it < 60; it++) {
    const n = 2 + Math.floor(rnd() * 7), pts = [];
    for (let k = 0; k < n; k++) pts.push([rnd() * 4000 - 2000, rnd() * 1000, k * 600 + rnd() * 500, { pause: rnd() < 0.3 ? rnd() * 2 : 0, speed: rnd() < 0.5 ? 0.2 + rnd() * 4 : 1 }]);
    const r = route(pts); r.timing.ease = ['none', 'start', 'end', 'both'][it % 4]; r.timing.easeStrength = 1 + rnd() * 99; r.timing.pauseEase = rnd() * 100;
    const M = R.buildModel(r); let prev = -1;
    for (let k = 1; k < M.tm.keys.length; k++) assert.ok(M.tm.keys[k].t > M.tm.keys[k - 1].t - 1e-9, 'key times increase');
    for (let t = 0.9; t <= 11.1; t += 0.02) { const v = R.evalKeys(M.tm.keys, t); assert.ok(v >= prev - 1e-7, `iteration ${it} t=${t}: ${v} < ${prev}`); assert.ok(v >= -1e-7 && v <= 100 + 1e-7); prev = v; }
    near(R.evalKeys(M.tm.keys, 11), 100, 1e-6);
  }
});

test('timeAtValue inverts the progress curve', () => {
  const r = curved(); r.timing.ease = 'both'; r.points[1].pause = 1; r.points[3].speed = 3;
  const keys = R.buildModel(r).tm.keys;
  for (const v of [3, 20, 47.5, 80, 99]) near(R.evalKeys(keys, R.timeAtValue(keys, v)), v, 1e-5);
});

test('per-point roll and focal length become keys at arrival times', () => {
  const r = curved(); r.points[0].roll = 0; r.points[2].roll = 20; r.points[4].focal = 80; r.camera.focal = 35;
  const M = R.buildModel(r);
  assert.deepEqual(M.rollKeys.map((k) => k.v), [0, 20]);
  near(M.rollKeys[1].t, M.tm.arrive[2], 1e-12);
  near(R.solve(r, M, M.tm.arrive[2], {}).roll, 20, 1e-9);
  near(R.solve(r, M, (M.tm.arrive[0] + M.tm.arrive[2]) / 2, {}).roll, 10, 1e-9);
  near(R.solve(r, M, 5, { compW: 1920 }).focal, 80, 1e-9, 'a single key holds');
  near(R.solve(r, M, 5, { compW: 1920 }).zoom, 1920 * 80 / 36, 1e-6);
});

test('look-ahead aims further along the route and banking leans into the turn', () => {
  const straight = route([[0, 0, 0, { type: 'corner' }], [0, 0, 4000, { type: 'corner' }]]);
  straight.aim.lookAhead = 10; straight.aim.smooth = 0;
  let M = R.buildModel(straight), cam = R.solve(straight, M, 6, { compW: 1920 });
  near(cam.pos[2], 2000, 1e-6); near(cam.poi[2], 2400, 1e-6); near(cam.bank, 0, 1e-9);
  cam = R.solve(straight, M, 11, { compW: 1920 });
  near(cam.poi[2] - cam.pos[2], 400, 1e-3, 'target stays ahead at the end of the route');

  const right = route([[0, 0, 0], [0, 0, 2000], [2000, 0, 2000]]);   // heading +Z then turning towards +X (right)
  right.camera.bank = 100; right.camera.maxBank = 45;
  M = R.buildModel(right);
  assert.ok(R.bankAt(right, M, 0.5) > 1, 'right turn banks positive');
  const left = route([[0, 0, 0], [0, 0, 2000], [-2000, 0, 2000]]);
  left.camera.bank = 100; left.camera.maxBank = 45;
  assert.ok(R.bankAt(left, R.buildModel(left), 0.5) < -1, 'left turn banks negative');
  right.camera.maxBank = 2;
  near(R.bankAt(right, M, 0.5), 2, 1e-9, 'clamped to max bank');
});

test('projection matches a two-node camera', () => {
  const cam = { pos: [960, 540, -2000], poi: [960, 540, 0], rotZ: 0, zoom: 2000 };
  let b = R.cameraBasis(cam);
  assert.deepEqual(R.project(cam, b, [960, 540, 0], 1920, 1080).slice(0, 2), [960, 540]);
  let p = R.project(cam, b, [1160, 640, 0], 1920, 1080);
  near(p[0], 1160, 1e-9); near(p[1], 640, 1e-9);
  assert.equal(R.project(cam, b, [960, 540, -3000], 1920, 1080), null);
  cam.rotZ = 90; b = R.cameraBasis(cam);                // camera rolled clockwise: the picture turns anticlockwise
  p = R.project(cam, b, [1160, 540, 0], 1920, 1080);
  near(p[0], 960, 1e-9); near(p[1], 340, 1e-9);
});

test('freehand simplification keeps corners and drops straight runs', () => {
  const pts = [];
  for (let x = 0; x <= 100; x += 2) pts.push([x, 0]);
  for (let y = 2; y <= 100; y += 2) pts.push([100, y]);
  assert.deepEqual(R.simplify(pts, 1), [[0, 0], [100, 0], [100, 100]]);
});

test('normalize repairs partial or older saved routes', () => {
  const r = R.normalize({ points: [{ x: '10', y: 5, z: 1, speed: 99, roll: '' }], timing: { duration: 4 } });
  assert.equal(r.points[0].x, 10); assert.equal(r.points[0].speed, 20); assert.equal(r.points[0].roll, null);
  assert.equal(r.timing.duration, 4); assert.equal(r.timing.ease, 'both'); assert.equal(r.aim.mode, 'ahead');
});

test('layer schedule: approach trigger follows the route, time trigger staggers', () => {
  const r = curved(), M = R.buildModel(r);
  const layers = [0.8, 0.3, 0.55].map((u, i) => ({ id: i + 1, index: i + 1, pos: R.add(R.tablePoint(M.table, u), [150, 0, 0]) }));
  const s = P.schedule(layers, Object.assign({}, P.anims[0], { trigger: 'approach', lead: 10, span: 5, order: 'route' }), r, M);
  assert.deepEqual(s.map((x) => x.id), [2, 3, 1]);
  assert.ok(Math.abs(s[0].startPct - 20) < 1.5 && s[0].spanPct === 5);
  assert.ok(s[0].t0 < s[0].t1 && s[0].t1 < s[1].t1);
  const t = P.schedule(layers, Object.assign({}, P.anims[0], { trigger: 'time', startTime: 2, stagger: 0.25, duration: 1, order: 'selection' }), r, M);
  assert.deepEqual(t.map((x) => [x.id, x.t0, x.t1, x.startPct]), [[1, 2, 3, null], [2, 2.25, 3.25, null], [3, 2.5, 3.5, null]]);
});

test('every built-in shape produces a usable route', () => {
  for (const s of P.shapes) {
    const made = s.make(1920, 1080), r = R.defaultRoute();
    r.points = made.points; r.closed = made.closed; if (made.target) r.target.points = made.target;
    const M = R.buildModel(R.normalize(r));
    assert.ok(M.table.total > 500, s.id + ' has length');
    assert.ok(M.tm.keys.length >= 2, s.id + ' has timing');
  }
});
