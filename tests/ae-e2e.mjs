// End-to-end tests that run the real panel inside After Effects.
//   node tests/ae-e2e.mjs            start AE if needed, run, quit AE if we started it
//   node tests/ae-e2e.mjs --keep     leave After Effects open afterwards
//   node tests/ae-e2e.mjs --reset    DISCARD the open project first (throwaway sessions only)
// Needs an EMPTY, unsaved project (it refuses to touch a project that has items).
// The last stage builds the sample composition in a fresh project and saves
// samples/routecam-sample-flight.aep plus rendered frames in docs/screenshots.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensurePanel, Panel, log, ROOT } from './lib/ae-driver.mjs';

const require = createRequire(import.meta.url);
const R = require('../extension/js/core/route.js');
const P = require('../extension/js/core/presets.js');
const SC = require('../extension/js/preview.js');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '  -> ' + detail : ''));
}
const fx = (n, d = 3) => Number(n).toFixed(d);
const q = (s) => JSON.stringify(s);
const fwd = (p) => p.replace(/\\/g, '/');

const { started } = await ensurePanel();
const panel = await Panel.connect();
const jsxPath = fwd(join(ROOT, 'extension', 'host', 'index.jsx'));
const shots = join(ROOT, 'docs', 'screenshots');
mkdirSync(shots, { recursive: true });

// ---------------------------------------------------------------- helpers
const host = (fn, args) => panel.run((f, a) => RC.platform.host(f, a), fn, args || {});
const jsx = (s) => panel.jsx(s);
const mkComp = async (name, dur = 12) => +(await jsx(`(function () { var c = app.project.items.addComp(${q(name)}, 1920, 1080, 1, ${dur}, 30); c.openInViewer(); return c.id; })()`));
const openComp = (id) => jsx(`app.project.itemByID(${id}).openInViewer(); "ok"`);
/** Evaluate a JavaScript expression in After Effects' expression engine (returns its string value). */
const aeExpr = (compId, body) => jsx(`(function () { var c = app.project.itemByID(${compId}), tl = c.layers.addText("x"), r;
  try { var d = tl.property("ADBE Text Properties").property("ADBE Text Document"); d.expression = ${q(body)}; r = d.expressionError ? "ERR:" + d.expressionError : d.value.text; }
  catch (e) { r = "ERR:" + e.message; } tl.remove(); return r; })()`);
const vecs = (text) => String(text).split('|').map((s) => s.split(',').map(Number));
/** Apply a route through the real panel code path. */
const applyRoute = (route) => panel.run(async (r) => {
  document.getElementById('live').checked = false;
  await RC.app.refresh({ force: true });
  RC.app.setRoute(r);
  const res = await RC.app.applyToAE();
  return { res, msg: document.getElementById('msg').textContent, comp: RC.app.state.compId, linked: RC.app.state.linked, dirty: RC.app.state.dirty };
}, route);
const sampleRig = async (compId, times) => (await host('sampleRig', { compId, times })).samples;
const exprErrors = (compId, times) => jsx(`(function () { var c = app.project.itemByID(${compId}), errs = [], n = 0, times = ${q(times)};
  function walk(g, L) { for (var i = 1; i <= g.numProperties; i++) { var p = g.property(i);
    if (p.propertyType === PropertyType.PROPERTY) { if (p.canSetExpression && p.expression !== "" && p.expressionEnabled) { n++;
        for (var k = 0; k < times.length; k++) { try { p.valueAtTime(times[k], false); } catch (e) { errs.push(L.name + "/" + p.name + ": " + e.message); } }
        if (p.expressionError) { errs.push(L.name + "/" + p.name + ": " + p.expressionError); } } }
    else { walk(p, L); } } }
  for (var i = 1; i <= c.numLayers; i++) { walk(c.layer(i), c.layer(i)); }
  return n + "|" + errs.join(" ## "); })()`);
const undoAE = () => jsx('app.executeCommand(16); "ok"');
const redoAE = () => jsx('app.executeCommand(2035); "ok"');

function testRoute() {
  const r = R.defaultRoute();
  r.points = [R.point(960, 200, -2400, { focal: 28 }), R.point(500, 520, -200), R.point(1400, 620, 1800, { pause: 0.8 }),
              R.point(600, 480, 3900, { speed: 1.8, roll: 12 }), R.point(1300, 380, 5600), R.point(960, 220, 7600, { focal: 50, roll: 0 })];
  r.timing = { start: 0.5, duration: 10, ease: 'both', easeStrength: 60, pauseEase: 60 };
  r.aim = { mode: 'ahead', lookAhead: 8, smooth: 3, layerId: 0, layerName: '', targetLinked: true };
  r.camera.bank = 120; r.camera.maxBank = 25; r.camera.focal = 35;
  return r;
}
/** Compare After Effects' rig with the panel's own solver at many times. */
function compare(route, samples, env) {
  const rr = R.normalize(route), M = R.buildModel(rr);
  let pos = 0, poi = 0, rot = 0, zoom = 0, prog = 0;
  for (const s of samples) {
    const c = R.solve(rr, M, s.t, Object.assign({ compW: 1920 }, env || {}));
    pos = Math.max(pos, R.dist(c.pos, s.pos)); poi = Math.max(poi, R.dist(c.poi, s.poi));
    rot = Math.max(rot, Math.abs(c.rotZ - s.rotZ)); zoom = Math.max(zoom, Math.abs(c.zoom - s.zoom)); prog = Math.max(prog, Math.abs(c.u * 100 - Math.min(Math.max(s.progress, 0), 100)));
  }
  return { pos, poi, rot, zoom, prog, M };
}
const times = (a, b, n) => Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));

try {
  // ------------------------------------------------------------- 0. setup
  if (process.argv.includes('--reset')) { await jsx('app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); app.newProject(); "ok"'); }
  const proj = await jsx('app.project.numItems + "|" + (app.project.file ? "saved" : "unsaved")');
  if (proj !== '0|unsaved' && !process.argv.includes('--force')) {
    throw new Error(`After Effects has a project open (${proj}). These tests create comps, so they only run in an empty, unsaved project.`);
  }
  const loaded = await jsx(`var __rcLoad = "ok"; try { $.evalFile(${q(jsxPath)}); } catch (e) { __rcLoad = "line " + e.line + ": " + e.message; } __rcLoad;`);
  if (loaded !== 'ok') throw new Error('host/index.jsx failed to load in After Effects: ' + loaded);
  await panel.reload();
  const env = await panel.run(async () => ({ inAE: RC.platform.inAE, node: RC.platform.hasNode, ping: await RC.platform.host('ping'), ua: navigator.userAgent }));
  check('panel runs inside After Effects with Node enabled', env.inAE && env.node, `AE ${env.ping.version}, ${/AdobeCEP\/[\d.]+/.exec(env.ua)}, ${/Chrome\/[\d.]+/.exec(env.ua)}`);

  // ------------------------------------------- 1. coordinate conventions
  const conv = await mkComp('RC Conventions');
  await jsx(`(function () { var c = app.project.itemByID(${conv});
    var p = c.layers.addSolid([1, 0, 0], "Probe", 400, 200, 1); p.threeDLayer = true;
    var t = p.property("ADBE Transform Group");
    t.property("ADBE Position").setValue([500, 300, 200]); t.property("ADBE Scale").setValue([120, 80, 100]);
    t.property("ADBE Orientation").setValue([10, 20, 30]); t.property("ADBE Rotate X").setValue(30); t.property("ADBE Rotate Y").setValue(40); t.property("ADBE Rotate Z").setValue(50);
    var k = c.layers.addSolid([0, 1, 0], "Kid", 100, 100, 1); k.threeDLayer = true; k.parent = p;
    k.property("ADBE Transform Group").property("ADBE Position").setValue([50, 60, 70]); k.property("ADBE Transform Group").property("ADBE Rotate Y").setValue(25);
    var n = c.layers.addNull(); n.name = "Pt"; n.threeDLayer = true; n.property("ADBE Transform Group").property("ADBE Position").setValue([1200, 700, 400]);
    var cam = c.layers.addCamera("Cam", [960, 540]); var ct = cam.property("ADBE Transform Group");
    ct.property("ADBE Position").setValue([300, 200, -1500]); ct.property("ADBE Anchor Point").setValue([960, 540, 0]); ct.property("ADBE Rotate Z").setValue(25);
    cam.property("ADBE Camera Options Group").property("ADBE Camera Zoom").setValue(1800);
    return "ok"; })()`);
  let ctx = await host('getContext', { compId: conv });
  const byName = Object.fromEntries(ctx.layers.map((l) => [l.name, l])), byId = SC.index(ctx.layers);
  for (const name of ['Probe', 'Kid']) {
    const L = byName[name], w = L.rect[2], h = L.rect[3];
    const ae = vecs(await aeExpr(conv, `var L = thisComp.layer(${q(name)}); [L.toWorld([0,0,0]), L.toWorld([${w},0,0]), L.toWorld([${w},${h},0]), L.toWorld([0,${h},0])].join("|")`));
    const mine = SC.corners(L, byId);
    const err = Math.max(...mine.map((c, i) => R.dist(c, ae[i])));
    check(`layer transform maths matches toWorld() for "${name}"${name === 'Kid' ? ' (parented)' : ''}`, err < 0.01, `max corner error ${fx(err, 4)} px`);
  }
  {
    const cam = { pos: byName.Cam.pos, poi: byName.Cam.poi, rotZ: 25, zoom: 1800 }, b = R.cameraBasis(cam);
    const ae = vecs(await aeExpr(conv, `[thisComp.layer("Pt").toComp([0,0,0]), thisComp.layer("Cam").toWorldVec([1,0,0]), thisComp.layer("Cam").toWorldVec([0,0,1])].join("|")`));
    const mine = R.project(cam, b, [1200, 700, 400], 1920, 1080);
    check('camera projection matches toComp() (two-node camera with roll)', Math.hypot(mine[0] - ae[0][0], mine[1] - ae[0][1]) < 0.05, `panel ${fx(mine[0], 2)},${fx(mine[1], 2)}  AE ${fx(ae[0][0], 2)},${fx(ae[0][1], 2)}`);
    check('camera axes match (right vector under positive roll, forward vector)', R.dist(b.r, ae[1]) < 1e-4 && R.dist(b.f, ae[2]) < 1e-4, `right ${ae[1].map((v) => fx(v)).join(',')} (y > 0: right side dips, i.e. banks right)`);
  }

  // ------------------------------------------------ 2. route -> camera rig
  const flight = await mkComp('RC Flight');
  let route = testRoute();
  let applied = await applyRoute(route);
  check('apply route: rig created in the active composition', applied.res && applied.res.created && applied.comp === flight && applied.linked && !applied.dirty, applied.msg);
  ctx = await host('getContext', { compId: flight });
  const rigLayers = ctx.layers.filter((l) => l.rig).map((l) => l.name);
  check('rig layers: controller, camera and route path', ['RC Controller', 'RC Camera', 'RC Route Path'].every((n) => rigLayers.includes(n)), rigLayers.join(', '));
  const pathInfo = await jsx(`(function () { var c = app.project.itemByID(${flight}), p = c.layer("RC Route Path").property("ADBE Transform Group").property("ADBE Position"), rov = 0, lin = 0, k;
    for (k = 1; k <= p.numKeys; k++) { if (p.keyRoving(k)) { rov++; } }
    var ctl = c.layer("RC Controller"), fxn = ctl.property("ADBE Effect Parade").numProperties, pr = ctl.property("ADBE Effect Parade").property("Route Progress").property(1);
    var cam = c.layer("RC Camera"), ex = 0, names = ["ADBE Position", "ADBE Anchor Point", "ADBE Rotate Z"];
    for (k = 0; k < names.length; k++) { if (cam.property("ADBE Transform Group").property(names[k]).expressionEnabled) { ex++; } }
    return [p.numKeys, rov, fxn, pr.numKeys, ex, ctl.comment.length, cam.autoOrient === AutoOrientType.CAMERA_OR_POINT_OF_INTEREST].join("|"); })()`);
  const [nKeys, nRove, nFx, nProg, nExpr, commentLen, twoNode] = pathInfo.split('|');
  check('route is a native motion path: one key per point, interior keys roving', +nKeys === 6 && +nRove === 4, `${nKeys} keys, ${nRove} roving`);
  let cmp = compare(route, [], {});
  check('timing lives in editable Route Progress keyframes', +nProg === cmp.M.tm.keys.length && +nFx === 15, `${nProg} progress keys (pause + speed change + ends), ${nFx} controls on the controller`);
  check('camera is two-node and expression-driven', +nExpr === 3 && twoNode === 'true');
  const frErr = Math.max(...applied.res.fractions.map((f, i) => Math.abs(f - cmp.M.fr[i])));
  check('After Effects roving agrees with the panel\'s arc-length maths', frErr < 5e-4, `max fraction difference ${frErr.toExponential(2)}`);

  let tt = times(0, 11.5, 47);
  let samples = await sampleRig(flight, tt);
  cmp = compare(route, samples);
  check('camera position matches the preview solver along the whole flight', cmp.pos < 2.0, `max ${fx(cmp.pos)} px over ${samples.length} samples (route ${fx(cmp.M.table.total, 0)} px long)`);
  check('look-ahead point of interest matches', cmp.poi < 3.0, `max ${fx(cmp.poi)} px`);
  check('roll + banking matches', cmp.rot < 0.25, `max ${fx(cmp.rot)} deg`);
  check('focal length keys drive the zoom', cmp.zoom < 0.5, `max ${fx(cmp.zoom)} px`);
  check('Route Progress follows the eased, paused, variable-speed timing', cmp.prog < 0.05, `max ${fx(cmp.prog, 4)} %`);
  {
    const M = cmp.M, tA = M.tm.arrive[2], held = await sampleRig(flight, [tA, tA + 0.4, tA + 0.8]);
    const p2 = [route.points[2].x, route.points[2].y, route.points[2].z];
    check('pause holds the camera exactly on its control point', Math.max(...held.map((s) => R.dist(s.pos, p2))) < 0.5, held.map((s) => fx(R.dist(s.pos, p2))).join(' / ') + ' px');
    const banks = samples.map((s) => s.rotZ);
    check('banking is active and stays within Max Bank (+ roll)', Math.max(...banks) > 3 && Math.min(...banks) < -3 && Math.max(...banks.map(Math.abs)) <= 25 + 12 + 0.01, `range ${fx(Math.min(...banks), 1)} .. ${fx(Math.max(...banks), 1)} deg`);
  }
  let errs = await exprErrors(flight, [0, 3, 6, 9, 11.9]);
  check('no expression errors on the rig', /^\d+\|$/.test(errs), errs);

  // constant speed: equal time steps cover equal distances
  route = testRoute(); route.points.forEach((p) => { p.pause = 0; p.speed = 1; }); route.timing.ease = 'none';
  applied = await applyRoute(route);
  samples = await sampleRig(flight, times(0.5, 10.5, 41));
  {
    const steps = samples.slice(1).map((s, i) => R.dist(s.pos, samples[i].pos));
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    // chords are slightly shorter than arcs on bends, so compare against a tolerance rather than exact equality
    check('constant-speed travel: speed along the curve is uniform', Math.max(...steps) / Math.min(...steps) < 1.03, `step min ${fx(Math.min(...steps), 1)} / max ${fx(Math.max(...steps), 1)} px (mean ${fx(mean, 1)})`);
    const keys = await jsx(`app.project.itemByID(${flight}).layer("RC Controller").property("ADBE Effect Parade").property("Route Progress").property(1).numKeys`);
    check('constant speed needs only two progress keyframes', +keys === 2, keys + ' keys');
  }

  // ----------------------------------------------------------- 3. aiming
  const heroId = +(await jsx(`(function () { var c = app.project.itemByID(${flight}), s = c.layers.addSolid([1, 0.8, 0.2], "Hero", 300, 300, 1); s.threeDLayer = true;
    s.property("ADBE Transform Group").property("ADBE Position").setValue([1500, 300, 3000]); s.moveToEnd(); return s.id; })()`));
  route = testRoute(); route.aim.mode = 'layer'; route.aim.layerId = heroId; route.aim.layerName = 'Hero';
  route.camera.dof = true; route.camera.fstop = 2.8; route.camera.focusMode = 'aim';
  applied = await applyRoute(route);
  samples = await sampleRig(flight, times(0.5, 10.5, 9));
  check('track a 3D layer: point of interest sits on the layer', Math.max(...samples.map((s) => R.dist(s.poi, [1500, 300, 3000]))) < 0.01, 'Hero at 1500,300,3000');
  {
    const dof = await jsx(`app.project.itemByID(${flight}).layer("RC Camera").property("ADBE Camera Options Group").property("ADBE Camera Depth of Field").value`);
    const focusErr = Math.max(...samples.map((s) => Math.abs(s.focus - R.dist(s.pos, s.poi))));
    const apErr = Math.max(...samples.map((s) => Math.abs(s.aperture - (s.zoom * 36 / 1920) / 2.8 * 72 / 25.4)));
    check('depth of field: on, focus locked to the aim target, aperture from F-stop', +dof === 1 && focusErr < 0.01 && apErr < 0.01, `focus error ${fx(focusErr, 4)} px, aperture ${fx(samples[0].aperture, 2)} px at f/2.8`);
  }
  route = testRoute(); route.aim.mode = 'path'; route.aim.targetLinked = true;
  route.target.points = [R.point(200, 700, 1000), R.point(1700, 500, 4000), R.point(960, 300, 9000)];
  applied = await applyRoute(route);
  samples = await sampleRig(flight, tt);
  cmp = compare(route, samples);
  check('independent target path: camera looks along the second path', cmp.poi < 2.0 && cmp.pos < 2.0, `poi max ${fx(cmp.poi)} px`);
  route.target.points = [R.point(960, 540, 3000)];
  applied = await applyRoute(route);
  samples = await sampleRig(flight, [1, 5, 9]);
  check('single-point target path is a fixed target', Math.max(...samples.map((s) => R.dist(s.poi, [960, 540, 3000]))) < 0.01);
  errs = await exprErrors(flight, [0, 3, 6, 9, 11.9]);
  check('no expression errors after switching aim modes', /^\d+\|$/.test(errs), errs);

  // closed loop
  const loop = await mkComp('RC Loop');
  route = R.defaultRoute(); const orbit = P.shapes.find((s) => s.id === 'orbit').make(1920, 1080);
  route.points = orbit.points; route.closed = true; route.target.points = orbit.target; route.aim.mode = 'path';
  route.timing = { start: 0, duration: 10, ease: 'none', easeStrength: 60, pauseEase: 60 }; route.camera.bank = 0;
  applied = await applyRoute(route);
  samples = await sampleRig(loop, times(0, 10, 21));
  cmp = compare(route, samples);
  check('closed loop: camera returns to its start and matches the solver', cmp.pos < 2.0 && R.dist(samples[0].pos, samples[20].pos) < 0.5, `max ${fx(cmp.pos)} px, start/end gap ${fx(R.dist(samples[0].pos, samples[20].pos))} px`);

  // ------------------------------------------------------------- 4. undo
  const undoComp = await mkComp('RC Undo');
  applied = await applyRoute(testRoute());
  let hasRig = !!(await host('getContext', { compId: undoComp })).rig;
  await undoAE();
  const afterUndo = await host('getContext', { compId: undoComp });
  check('one After Effects undo removes the whole rig', hasRig && !afterUndo.rig && afterUndo.layers.length === 0, `${afterUndo.layers.length} layers left`);
  await redoAE();
  check('redo brings it back', !!(await host('getContext', { compId: undoComp })).rig);
  {
    const r = await panel.run(async () => {
      await RC.app.refresh({ force: true });
      const before = RC.app.state.route.points[1].x;
      const ed = RC.app.editor(); ed.select([1]);
      document.getElementById('ptX').value = before + 250; document.getElementById('ptX').dispatchEvent(new Event('change'));
      const moved = RC.app.state.route.points[1].x;
      RC.app.undo(); const undone = RC.app.state.route.points[1].x;
      RC.app.redo(); const redone = RC.app.state.route.points[1].x;
      RC.app.undo();
      return { before, moved, undone, redone };
    });
    check('editor undo / redo', r.moved === r.before + 250 && r.undone === r.before && r.redone === r.moved, JSON.stringify(r));
  }

  // --------------------------------------------- 5. masks and shape paths
  const imp = await mkComp('RC Import');
  await jsx(`(function () { var c = app.project.itemByID(${imp});
    var s = c.layers.addSolid([0.2, 0.2, 0.2], "MaskLayer", 1920, 1080, 1);
    var m = s.property("ADBE Mask Parade").addProperty("ADBE Mask Atom"), sh = new Shape();
    sh.vertices = [[200, 800], [900, 300], [1700, 700]]; sh.inTangents = [[0, 0], [-200, 0], [0, 0]]; sh.outTangents = [[0, 0], [200, 0], [0, 0]]; sh.closed = false;
    m.property("ADBE Mask Shape").setValue(sh);
    var f = c.layers.addSolid([0.1, 0.3, 0.3], "Floor3D", 2000, 2000, 1); f.threeDLayer = true;
    f.property("ADBE Transform Group").property("ADBE Position").setValue([960, 900, 1000]); f.property("ADBE Transform Group").property("ADBE Rotate X").setValue(-90);
    var m2 = f.property("ADBE Mask Parade").addProperty("ADBE Mask Atom"), s2 = new Shape();
    s2.vertices = [[500, 500], [1500, 1500], [500, 1500]]; s2.closed = true; m2.property("ADBE Mask Shape").setValue(s2);
    var sl = c.layers.addShape(); sl.name = "ShapeLayer";
    var g = sl.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
    var pg = g.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Group"), s3 = new Shape();
    s3.vertices = [[0, 0], [100, 0], [100, 100]]; s3.closed = false; pg.property("ADBE Vector Shape").setValue(s3);
    g = sl.property("ADBE Root Vectors Group").property(1);
    g.property("ADBE Vectors Group").addProperty("ADBE Vector Graphic - Stroke");
    var t = sl.property("ADBE Root Vectors Group").property(1).property("ADBE Vector Transform Group");
    t.property("ADBE Vector Position").setValue([100, 50]); t.property("ADBE Vector Scale").setValue([200, 200]); t.property("ADBE Vector Rotation").setValue(90);
    return "ok"; })()`);
  const selectOnly = (name) => jsx(`(function () { var c = app.project.itemByID(${imp}), i; for (i = 1; i <= c.numLayers; i++) { c.layer(i).selected = (c.layer(i).name === ${q(name)}); } return "ok"; })()`);
  await selectOnly('MaskLayer');
  let got = await host('importPath', { compId: imp });
  check('mask path on a 2D layer is read in composition space, tangents included',
    got.keys.length === 3 && R.dist(got.keys[1].p, [900, 300, 0]) < 0.01 && R.dist(got.keys[1].o, [200, 0, 0]) < 0.01 && R.dist(got.keys[1].i, [-200, 0, 0]) < 0.01 && !got.closed && !got.threeD, `${got.name} on ${got.layer}`);
  {
    const r = await panel.run(async () => {
      await RC.app.refresh({ force: true });
      document.getElementById('importPlane').value = 'floor';
      const ok = await RC.app.importPath();
      const pts = RC.app.state.route.points.map((p) => [p.x, p.y, p.z, p.type, p.o]);
      const hint = document.getElementById('importHint').textContent;
      RC.app.undo();
      return { ok, pts, msg: document.getElementById('msg').textContent, hint };
    });
    check('panel maps a flat path onto the floor plan (comp up = further away)',
      r.ok && r.pts.length === 3 && R.dist(r.pts[0], [200, 540, -260]) < 0.01 && R.dist(r.pts[1], [900, 540, 240]) < 0.01 && r.pts[1][3] === 'bezier' && R.dist(r.pts[1][4], [200, 0, 0]) < 0.01, r.hint);
  }
  await selectOnly('Floor3D');
  got = await host('importPath', { compId: imp });
  {
    ctx = await host('getContext', { compId: imp });
    const F = ctx.layers.find((l) => l.name === 'Floor3D'), M = SC.worldMatrix(F, SC.index(ctx.layers));
    const want = [[500, 500], [1500, 1500], [500, 1500]].map((v) => SC.toWorld(M, [v[0], v[1], 0]));
    const err = Math.max(...want.map((w, i) => R.dist(w, got.keys[i].p)));
    check('mask on a 3D floor layer becomes a real path in depth', got.threeD && got.closed && err < 0.01 && Math.abs(got.keys[0].p[1] - 900) < 0.01 && Math.abs(got.keys[1].p[2] - got.keys[0].p[2]) > 900,
      got.keys.map((k) => k.p.map((v) => fx(v, 0)).join(',')).join('  '));
  }
  await selectOnly('ShapeLayer');
  got = await host('importPath', { compId: imp });
  check('shape-layer path honours its group transform (position, scale, rotation)', got.keys.length === 3 && R.dist(got.keys[1].p, [1060, 790, 0]) < 0.01 && R.dist(got.keys[0].p, [1060, 590, 0]) < 0.01,
    got.keys.map((k) => k.p.map((v) => fx(v, 0)).join(',')).join('  '));
  ctx = await host('getContext', { compId: imp });
  check('reading a path leaves nothing behind and keeps the selection', ctx.layers.length === 3 && ctx.layers.filter((l) => l.selected).map((l) => l.name).join() === 'ShapeLayer', ctx.layers.length + ' layers, selected: ' + ctx.layers.filter((l) => l.selected).map((l) => l.name).join());

  // ----------------------------------------------------- 6. layer animation
  await openComp(flight);
  route = testRoute(); route.points.forEach((p) => { p.pause = 0; p.speed = 1; }); route.timing = { start: 1, duration: 10, ease: 'none', easeStrength: 60, pauseEase: 60 };
  applied = await applyRoute(route);
  let M = R.buildModel(R.normalize(route));
  const us = [0.3, 0.5, 0.7], names = ['Tile A', 'Tile B', 'Tile C'];
  const tilePos = us.map((u) => R.add(R.tablePoint(M.table, u), [320, 60, 0]).map((v) => Math.round(v)));
  const tileIds = (await jsx(`(function () { var c = app.project.itemByID(${flight}), pos = ${q(tilePos)}, names = ${q(names)}, ids = [], i, s;
    for (i = 0; i < pos.length; i++) { s = c.layers.addSolid([0.2, 0.6, 0.9], names[i], 300, 200, 1); s.threeDLayer = (i !== 1);
      s.property("ADBE Transform Group").property("ADBE Position").setValue(i !== 1 ? pos[i] : [pos[i][0], pos[i][1]]); s.moveToEnd(); ids.push(s.id); }
    return ids.join(","); })()`)).split(',').map(Number);
  const animate = (over) => panel.run(async (ids, over) => {
    await RC.app.refresh({ keepRoute: true, keepTime: true });
    const S = RC.app.state; S.animSel = {}; ids.forEach((id) => { S.animSel[id] = true; });
    S.anim = RC.presets.withDefaults(Object.assign({}, RC.presets.anims[0], over));
    const res = await RC.app.animate();
    return { res, msg: document.getElementById('msg').textContent };
  }, tileIds, over);
  const tile = (name, t) => jsx(`(function () { var L = app.project.itemByID(${flight}).layer(${q(name)}), tr = L.property("ADBE Transform Group"), fxg = L.property("ADBE Effect Parade"), t = ${t};
    var s = fxg.property("RC Start %"), sp = fxg.property("RC Span %"), p = tr.property("ADBE Position"), o = tr.property("ADBE Opacity"), sc = tr.property("ADBE Scale");
    return [p.valueAtTime(t, false).join(","), o.valueAtTime(t, false), sc.valueAtTime(t, false).join(","), p.numKeys, o.numKeys, sc.numKeys, p.expression !== "" ? 1 : 0, o.expression !== "" ? 1 : 0,
            s ? s.property(1).value : "none", sp ? sp.property(1).value : "none", L.threeDLayer, fxg.numProperties, (L.comment || "").indexOf("RCANIM:") >= 0, p.numKeys ? p.keyTime(1) : -1, p.numKeys ? p.keyTime(p.numKeys) : -1].join("|"); })()`)
    .then((s) => { const a = s.split('|'); return { pos: a[0].split(',').map(Number), opacity: +a[1], scale: a[2].split(',').map(Number), posKeys: +a[3], opKeys: +a[4], scKeys: +a[5], posExpr: a[6] === '1', opExpr: a[7] === '1',
                                                    start: a[8] === 'none' ? null : +a[8], span: a[9] === 'none' ? null : +a[9], threeD: a[10] === 'true', effects: +a[11], tagged: a[12] === 'true', k0: +a[13], k1: +a[14] }; });
  const rest0 = await Promise.all(names.map((n) => tile(n, 0)));

  let an = await animate({ trigger: 'approach', lead: 10, span: 6, order: 'route' });
  check('animate layers as the camera approaches', an.res && an.res.animated.length === 3 && an.res.skipped.length === 0, an.msg);
  {
    const a = await tile('Tile A', 0), uA = R.nearestU(M.table, tilePos[0]) * 100;
    check('each layer starts a set lead before the camera reaches it', Math.abs(a.start - (uA - 10)) < 0.2 && a.span === 6, `Tile A: camera passes at ${fx(uA, 1)} %, animation starts at ${fx(a.start, 1)} %`);
    const tBefore = R.timeAtValue(M.tm.keys, a.start - 2), tMid = R.timeAtValue(M.tm.keys, a.start + 3), tAfter = R.timeAtValue(M.tm.keys, a.start + 8);
    const b = await tile('Tile A', tBefore), m = await tile('Tile A', tMid), e = await tile('Tile A', tAfter);
    check('linked animation: offset before, travelling during, at rest after', b.opacity === 0 && Math.abs(b.pos[1] - (tilePos[0][1] + 320)) < 0.01 && m.opacity > 2 && m.opacity < 98 && e.opacity === 100 && R.dist(e.pos, tilePos[0]) < 0.01,
      `opacity ${fx(b.opacity, 0)} -> ${fx(m.opacity, 0)} -> ${fx(e.opacity, 0)}, y ${fx(b.pos[1], 0)} -> ${fx(m.pos[1], 0)} -> ${fx(e.pos[1], 0)}`);
    check('the animation is ordinary keyframes plus a link expression', a.posKeys === 2 && a.opKeys === 2 && a.posExpr && a.opExpr && a.tagged && Math.abs(a.k0 - Math.round(R.timeAtValue(M.tm.keys, a.start) * 30) / 30) < 0.02,
      `keys at ${fx(a.k0, 2)} s .. ${fx(a.k1, 2)} s`);
    const bb = await tile('Tile B', 0);
    check('2D layers are switched to 3D so they can move in depth', bb.threeD && bb.posKeys === 2);

    // retime the camera: the layers must follow without being touched
    const fast = JSON.parse(JSON.stringify(route)); fast.timing = { start: 6, duration: 5, ease: 'both', easeStrength: 70, pauseEase: 60 };
    await panel.run(async (r) => { RC.app.setRoute(r); await RC.app.applyToAE(); }, fast);
    const M2 = R.buildModel(R.normalize(fast)), t2 = R.timeAtValue(M2.tm.keys, a.start + 3), m2 = await tile('Tile A', t2), e2 = await tile('Tile A', R.timeAtValue(M2.tm.keys, a.start + 8));
    check('retiming the camera retimes the layers (synchronised to progress)', Math.abs(m2.opacity - m.opacity) < 1.5 && e2.opacity === 100 && Math.abs(t2 - tMid) > 0.5, `mid-animation moved from ${fx(tMid, 2)} s to ${fx(t2, 2)} s, opacity ${fx(m.opacity, 1)} vs ${fx(m2.opacity, 1)}`);
    await panel.run(async (r) => { RC.app.setRoute(r); await RC.app.applyToAE(); }, route);
  }
  errs = await exprErrors(flight, [0, 3, 6, 9, 11.9]);
  check('no expression errors with linked layers', /^\d+\|$/.test(errs), errs);

  an = await animate({ trigger: 'time', startTime: 2, stagger: 0.5, duration: 1, order: 'selection', pos: [0, 0, 0], scale: 0, opacity: 100, ease: 'back', overshoot: 10 });
  {
    const a = await tile('Tile A', 0), c = await tile('Tile C', 0), mid = await tile('Tile C', 3.62), end = await tile('Tile C', 5);
    check('re-applying replaces the old animation cleanly (position back at rest, no stale keys)', a.posKeys === 0 && !a.posExpr && R.dist(a.pos, tilePos[0]) < 0.01 && a.opKeys === 0 && a.opacity === 100 && a.start === null && a.effects === 0);
    check('time-triggered animation staggers plain keyframes', a.scKeys === 3 && Math.abs((await tile('Tile B', 0)).scale[0]) < 0.01 && c.scale[0] === 0 && mid.scale[0] > 100 && end.scale[0] === 100,
      `Tile C scale: 0 at 0 s, ${fx(mid.scale[0], 1)} % at the overshoot, 100 at 5 s`);
  }
  const rem = await panel.run(async () => { const r = await RC.app.unanimate(); return { r, msg: document.getElementById('msg').textContent }; });
  {
    const now = await Promise.all(names.map((n) => tile(n, 0)));
    const same = now.every((n, i) => n.posKeys === 0 && n.opKeys === 0 && n.scKeys === 0 && !n.posExpr && !n.tagged && n.effects === 0 && n.opacity === rest0[i].opacity && R.dist(n.scale, rest0[i].scale.length < 3 ? rest0[i].scale.concat(100) : rest0[i].scale) < 0.01 && Math.hypot(n.pos[0] - rest0[i].pos[0], n.pos[1] - rest0[i].pos[1]) < 0.01);
    check('remove animation restores every layer exactly', rem.r && rem.r.removed === 3 && same, rem.msg);
  }

  // ------------------------------------------------------ 7. bake / unbake
  const pre = await sampleRig(flight, times(1, 11, 11));
  const baked = await host('bakeCamera', { compId: flight, start: 1, end: 11 });
  {
    const st = await jsx(`(function () { var p = app.project.itemByID(${flight}).layer("RC Camera").property("ADBE Transform Group").property("ADBE Position"); return p.numKeys + "|" + p.expressionEnabled; })()`);
    const post = await sampleRig(flight, times(1, 11, 11));
    const err = Math.max(...post.map((s, i) => R.dist(s.pos, pre[i].pos) + R.dist(s.poi, pre[i].poi) + Math.abs(s.rotZ - pre[i].rotZ)));
    check('bake: one keyframe per frame, expressions off, same motion', st === `${baked.frames}|false` && baked.frames === 301 && err < 0.01, `${baked.frames} keys, max difference ${fx(err, 4)}`);
    check('panel reports the baked state', (await host('getContext', { compId: flight })).rig.baked === true);
    await host('unbakeCamera', { compId: flight });
    const st2 = await jsx(`(function () { var p = app.project.itemByID(${flight}).layer("RC Camera").property("ADBE Transform Group").property("ADBE Position"); return p.numKeys + "|" + p.expressionEnabled; })()`);
    check('restore live link removes the baked keys', st2 === '0|true');
  }

  // --------------------------------------- 8. edits made in After Effects
  {
    const r = await panel.run(async (flight) => {
      await RC.app.refresh({ force: true });
      const before = RC.app.state.route.points.map((p) => [p.x, p.y, p.z, p.type]);
      await RC.platform.evalScript(`(function () { var p = app.project.itemByID(${flight}).layer("RC Route Path").property("ADBE Transform Group").property("ADBE Position"); var v = p.keyValue(3); app.beginUndoGroup("move key"); p.setValueAtKey(3, [v[0] + 140, v[1] - 60, v[2]]); app.endUndoGroup(); return "ok"; })()`);
      await RC.app.refresh({ keepTime: true });
      const after = RC.app.state.route.points.map((p) => [p.x, p.y, p.z, p.type]);
      const msg = document.getElementById('msg').textContent, dirty = RC.app.state.dirty;
      await RC.platform.evalScript('app.executeCommand(16); "ok"');
      await RC.app.refresh({ keepTime: true });
      const undone = RC.app.state.route.points.map((p) => [p.x, p.y, p.z, p.type]);
      return { before, after, undone, msg, dirty };
    }, flight);
    check('reshaping the motion path in After Effects is picked up by the panel', r.after[2][0] === r.before[2][0] + 140 && r.after[2][1] === r.before[2][1] - 60 && r.after[0][0] === r.before[0][0], r.msg);
    check('...and an After Effects undo is picked up too', JSON.stringify(r.undone.map((p) => p.slice(0, 3))) === JSON.stringify(r.before.map((p) => p.slice(0, 3))));
  }

  // ------------------------------------------------- 9. save and reopen
  {
    const big = testRoute(); big.points = [];
    for (let i = 0; i < 80; i++) big.points.push(R.point(960 + Math.round(600 * Math.sin(i * 0.5)), 540 + Math.round(200 * Math.cos(i * 0.31)), -2000 + i * 130, { pause: i === 40 ? 0.5 : 0, roll: i % 20 === 0 ? i / 4 : null, type: i % 7 === 0 ? 'corner' : 'auto' }));
    big.timing.duration = 11; big.aim.lookAhead = 4;
    const bigComp = await mkComp('RC Reopen');
    applied = await applyRoute(big);
    const before = await sampleRig(bigComp, times(0, 11.5, 24));
    const stored = await jsx(`app.project.itemByID(${bigComp}).layer("RC Controller").comment.length`);
    const file = fwd(join(tmpdir(), `routecam-e2e-${Date.now()}.aep`));
    const reopened = await jsx(`(function () { var f = new File(${q(file)}); app.project.save(f); app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); app.open(f);
      var i, it; for (i = 1; i <= app.project.numItems; i++) { it = app.project.item(i); if (it instanceof CompItem && it.name === "RC Reopen") { it.openInViewer(); return it.id + "|" + it.layer("RC Controller").comment.length; } } return "missing"; })()`);
    const [newId, len2] = reopened.split('|');
    await sleep(1500);
    const st = await panel.run(async () => { await RC.app.refresh({ force: true }); const S = RC.app.state; return { comp: S.comp.name, linked: S.linked, dirty: S.dirty, route: S.route, msg: document.getElementById('msg').textContent }; });
    const a = R.normalize(big), b = R.normalize(st.route);
    check('project reopens with the full route (80 points, per-point settings, timing, aim, lens)', len2 === stored && st.linked && !st.dirty && JSON.stringify(a.points) === JSON.stringify(b.points) && JSON.stringify(a.timing) === JSON.stringify(b.timing) && JSON.stringify(a.aim) === JSON.stringify(b.aim) && JSON.stringify(a.camera) === JSON.stringify(b.camera),
      `${stored} characters of route data stored on the controller layer; panel state: ${st.comp}, in composition`);
    const after = await sampleRig(+newId, times(0, 11.5, 24));
    const err = Math.max(...after.map((s, i) => R.dist(s.pos, before[i].pos) + R.dist(s.poi, before[i].poi) + Math.abs(s.rotZ - before[i].rotZ)));
    check('reopened rig moves identically', err < 0.01, `max difference ${fx(err, 5)}`);
    cmp = compare(big, after);
    check('80-point route still matches the solver', cmp.pos < 2.5 && cmp.prog < 0.05, `pos ${fx(cmp.pos)} px, progress ${fx(cmp.prog, 4)} %`);
    await jsx('app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); app.newProject(); "ok"');
    try { rmSync(file); } catch { /* temp file */ }
  }

  // ------------------------------------------------ 10. sample composition
  await sleep(800);
  const sample = await panel.run(async () => { const r = await RC.app.createSample(); const S = RC.app.state; return { r, msg: document.getElementById('msg').textContent, comp: S.comp.name, linked: S.linked, layers: S.layers.length, anim: S.layers.filter((l) => l.anim).length }; });
  check('sample composition builds through the panel', sample.r && sample.linked && sample.anim === 10, `${sample.comp}: ${sample.layers} layers, ${sample.anim} animated cards. ${sample.msg}`);
  const sid = sample.r.compId;
  errs = await exprErrors(sid, [0, 2, 4, 6, 8, 10, 11.9]);
  check('sample: every expression evaluates without error', /^\d+\|$/.test(errs), errs.split('|')[0] + ' expressions' + (errs.split('|')[1] ? ' ## ' + errs.split('|')[1] : ''));
  samples = await sampleRig(sid, times(0, 11.9, 40));
  cmp = compare(P.sampleRoute(), samples);
  check('sample: camera flight matches the panel preview', cmp.pos < 2.5 && cmp.poi < 4 && cmp.rot < 0.3, `pos ${fx(cmp.pos)} px, poi ${fx(cmp.poi)} px, roll ${fx(cmp.rot)} deg`);
  for (const t of [1.5, 4.5, 7.5, 10.5]) {
    const file = join(shots, `sample-frame-${String(t).replace('.', '_')}s.png`);
    if (existsSync(file)) rmSync(file);
    await host('grabFrame', { compId: sid, time: t, path: file });
    for (let i = 0; i < 40 && !(existsSync(file) && statSync(file).size > 0); i++) await sleep(250);
    check(`sample: After Effects renders a frame at ${t} s`, existsSync(file) && statSync(file).size > 20000, existsSync(file) ? `${Math.round(statSync(file).size / 1024)} KB` : 'no file');
  }
  const grab = await panel.run(async () => { RC.app.setTime(4.5); const ok = await RC.app.grabFrame(); await new Promise((r) => setTimeout(r, 600)); return { ok, shown: document.getElementById('aeFrame').classList.contains('on'), msg: document.getElementById('msg').textContent }; });
  check('"AE frame" shows the real render in the panel', grab.ok && grab.shown, grab.msg);
  await panel.screenshot(join(shots, 'panel-ae-frame.png'));
  await panel.run(() => { document.getElementById('aeFrame').classList.remove('on'); RC.app.editor().select([3]); RC.app.setTime(6.2); });
  await panel.screenshot(join(shots, 'panel-route.png'));
  for (const tab of ['motion', 'camera', 'layers']) {
    await panel.run((tab) => { document.querySelector(`#tabs button[data-tab="${tab}"]`).click(); }, tab);
    await sleep(300);
    await panel.screenshot(join(shots, `panel-${tab}.png`));
  }
  await panel.run(() => { document.querySelector('#tabs button[data-tab="route"]').click(); RC.app.editor().setView('side'); });
  await panel.screenshot(join(shots, 'panel-side-view.png'));
  await panel.run(() => { RC.app.editor().setView('top'); });
  const out = fwd(join(ROOT, 'samples', 'routecam-sample-flight.aep'));
  mkdirSync(join(ROOT, 'samples'), { recursive: true });
  const saved = await jsx(`(function () { app.project.itemByID(${sid}).time = 4.5; app.project.save(new File(${q(out)})); return app.project.file ? app.project.file.fsName : "unsaved"; })()`);
  check('sample project saved', existsSync(out) && statSync(out).size > 20000, `${saved} (${existsSync(out) ? Math.round(statSync(out).size / 1024) : 0} KB)`);
} catch (e) {
  check('test run completed', false, e.stack || e.message);
}

const failed = results.filter((r) => !r.ok);
mkdirSync(join(ROOT, 'tests', 'results'), { recursive: true });
writeFileSync(join(ROOT, 'tests', 'results', 'ae-e2e.json'), JSON.stringify({ when: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results }, null, 2));
log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (started && !KEEP) {
  log('Closing After Effects (started by this test run)');
  try { await Promise.race([jsx('app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); app.quit(); "ok"'), sleep(8000)]); } catch { /* AE is shutting down */ }
}
panel.close();
process.exit(failed.length ? 1 : 0);
