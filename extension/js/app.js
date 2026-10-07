/*
 * Routecam - panel logic: state, undo, controls, and the calls into After Effects.
 */
(function () {
  'use strict';
  var RC = window.RC, R = RC.route, P = RC.presets, SC = RC.scene, PF = RC.platform;
  function $(id) { return document.getElementById(id); }
  function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(n, d) { return (Math.round(n * Math.pow(10, d || 0)) / Math.pow(10, d || 0)).toString(); }

  var AIM = { ahead: 1, layer: 2, path: 3, manual: 4 }, FOCUS = { aim: 1, layer: 2, fixed: 3 };

  /* A stand-in scene so the panel can be tried in an ordinary browser (npm run preview). */
  function mockContext() {
    var layers = [], i, side;
    layers.push({ id: 100, index: 12, name: 'Floor', kind: 'av', threeD: true, selected: false, label: [61, 162, 165], enabled: true, parent: 0, rig: false, anim: false,
                  pos: [960, 900, 3000], anchor: [2000, 2000, 0], scale: [160, 320, 100], rot: [-90, 0, 0], ori: [0, 0, 0], rect: [0, 0, 4000, 4000] });
    for (i = 0; i < 8; i++) {
      side = i % 2 ? 1 : -1;
      layers.push({ id: i + 1, index: i + 1, name: 'Card ' + (i + 1), kind: 'av', threeD: true, selected: false, enabled: true, parent: 0, rig: false, anim: false,
                    label: [[74, 164, 76], [232, 146, 13], [181, 56, 56], [103, 125, 224]][i % 4],
                    pos: [960 + side * 540, 640, 500 + i * 760], anchor: [240, 150, 0], scale: [100, 100, 100], rot: [0, side * 28, 0], ori: [0, 0, 0], rect: [0, 0, 480, 300] });
    }
    return { project: '', mock: true, comp: { id: -1, name: 'Preview (not connected)', width: 1920, height: 1080, fps: 30, duration: 12, time: 0, workStart: 0, workDuration: 12 }, rig: null, layers: layers, selectedPath: null };
  }

  var S = {
    ctx: null, comp: mockContext().comp, compId: null, hasComp: false, layers: [], byId: {}, items: [],
    route: R.defaultRoute(), model: null, cam: null, which: 'route', sel: [],
    undo: [], redo: [], snapshot: null, dirty: false, linked: false, baked: false, rigSig: '',
    time: 0, playing: false, anim: P.withDefaults(P.anims[1]), animSel: {},
    store: { routes: [], anims: [] }, busy: 0, applyTimer: null, applying: null
  };
  var editor = null;

  /* ------------------------------------------------------------ status */

  function msg(text, kind) { var m = $('msg'); m.textContent = text; m.className = 'msg' + (kind ? ' ' + kind : ''); m.title = text; }
  function fail(e) { msg(e && e.message ? e.message : String(e), 'err'); }
  function chips() {
    $('compName').textContent = S.hasComp ? S.comp.name : (PF.inAE ? 'No composition open' : S.comp.name);
    var c = $('linkState');
    if (S.baked) { c.textContent = 'Baked'; c.className = 'chip warn'; c.title = 'The camera has baked keyframes. Use Camera > Restore live link to reconnect it.'; }
    else if (S.linked && !S.dirty) { c.textContent = 'In composition'; c.className = 'chip ok'; c.title = 'The route in the panel matches the composition.'; }
    else if (S.linked) { c.textContent = 'Unapplied changes'; c.className = 'chip warn'; c.title = 'Press Apply to After Effects.'; }
    else { c.textContent = 'Draft'; c.className = 'chip dim'; c.title = 'This route is not in the composition yet.'; }
    $('btnApply').textContent = S.linked ? 'Update After Effects' : 'Apply to After Effects';
  }

  /* -------------------------------------------------------- route state */

  function activePoints() { return S.which === 'route' ? S.route.points : S.route.target.points; }
  function activeClosed() { return S.which === 'route' ? !!S.route.closed : false; }
  function env() {
    return { compW: S.comp.width,
             layerPos: function (id) { return S.byId[id] ? SC.layerWorldPos(S.byId[id], S.byId) : null; },
             manualPoi: [S.comp.width / 2, S.comp.height / 2, 0] };
  }
  function recompute() {
    S.model = R.buildModel(S.route);
    S.cam = S.route.points.length >= 2 ? R.solve(S.route, S.model, S.time, env()) : null;
  }

  function begin() { S.snapshot = JSON.stringify(S.route); }
  function cancel() { S.snapshot = null; }
  function commit() {
    var before = S.snapshot; S.snapshot = null;
    S.route.points = R.dedupe(S.route.points);
    S.route.target.points = R.dedupe(S.route.target.points);
    if (S.route.points.length < 3) { S.route.closed = false; }
    if (before !== null && before !== JSON.stringify(S.route)) {
      S.undo.push(before); if (S.undo.length > 200) { S.undo.shift(); }
      S.redo = []; S.dirty = true;
      scheduleApply();
    }
    S.sel = S.sel.filter(function (i) { return i < activePoints().length; });
    rebuild();
  }
  function restore(json) { S.route = R.normalize(JSON.parse(json)); S.sel = []; S.dirty = true; if (editor) { editor.select([]); } rebuild(); scheduleApply(); }
  function undo() { if (!S.undo.length) { msg('Nothing to undo in the editor.'); return; } S.redo.push(JSON.stringify(S.route)); restore(S.undo.pop()); msg('Undone.'); }
  function redo() { if (!S.redo.length) { msg('Nothing to redo.'); return; } S.undo.push(JSON.stringify(S.route)); restore(S.redo.pop()); msg('Redone.'); }

  /** Replace the whole route as one undoable step. */
  function setRoute(route, label) { begin(); S.route = R.normalize(route); S.sel = []; if (editor) { editor.select([]); } commit(); if (editor) { editor.fit(); } if (label) { msg(label, 'ok'); } }

  /* --------------------------------------------------- After Effects I/O */

  function hostArgs(scope) {
    var r = S.route, M = S.model;
    function keys(ks, fr) { return ks.map(function (k, n) { return { p: k.p, i: k.i, o: k.o, f: fr[n] }; }); }
    return {
      compId: S.compId, scope: scope || 'all', loop: !!r.closed, state: { route: clone(r) },
      pathKeys: keys(M.keys, M.fr),
      targetKeys: (r.aim.mode === 'path' && M.tkeys.length) ? keys(M.tkeys, M.tfr) : null,
      progressKeys: M.tm.keys, rollKeys: M.rollKeys, focalKeys: M.focalKeys,
      values: { aimMode: AIM[r.aim.mode] || 1, lookAhead: R.num(r.aim.lookAhead, 8), smooth: R.num(r.aim.smooth, 0), trackLayerId: r.aim.layerId || 0,
                targetLinked: r.aim.targetLinked !== false, roll: R.num(r.camera.roll, 0), bank: R.num(r.camera.bank, 0), maxBank: R.num(r.camera.maxBank, 0),
                focal: R.num(r.camera.focal, 35), fstop: R.num(r.camera.fstop, 2.8), focusMode: FOCUS[r.camera.focusMode] || 1, focusLayerId: r.camera.focusLayerId || 0,
                focusDistance: R.num(r.camera.focusDistance, 1500), blur: R.num(r.camera.blur, 100), dof: !!r.camera.dof }
    };
  }

  function rigSig(rig) {
    function rk(list) { return (list || []).map(function (k) { return [k.p, k.i, k.o].map(function (v) { return v.map(function (x) { return Math.round(x * 20) / 20; }); }); }); }
    return JSON.stringify([rk(rig.pathKeys), rk(rig.targetKeys), rig.state && rig.state.route, rig.baked]);
  }

  /** Bring edits made to the motion path in After Effects back into the panel's points. */
  function adopt(points, aeKeys, closed) {
    var exp = R.pathKeys(points, closed), n = aeKeys.length, k, a, e, loop, list;
    function collinear(i, o) { return R.len(i) < 1e-6 || R.len(o) < 1e-6 || R.dot(R.norm(i), R.norm(o)) < -0.9995; }
    function fromKey(key) {
      var p = R.point(key.p[0], key.p[1], key.p[2] || 0), flat = R.len(key.i) < 1e-6 && R.len(key.o) < 1e-6;
      p.type = flat ? 'corner' : 'bezier'; p.i = key.i.slice(); p.o = key.o.slice(); p.broken = !collinear(key.i, key.o);
      return p;
    }
    if (n !== exp.length) {
      loop = n > 3 && R.dist(aeKeys[0].p, aeKeys[n - 1].p) < 0.05;
      list = aeKeys.slice(0, loop ? n - 1 : n).map(fromKey);
      return { points: list, closed: loop, changed: true };
    }
    var changed = false;
    for (k = 0; k < points.length; k++) {
      a = aeKeys[k];
      if (R.dist(a.p, exp[k].p) > 0.05) { points[k].x = a.p[0]; points[k].y = a.p[1]; points[k].z = a.p[2] || 0; changed = true; }
    }
    exp = R.pathKeys(points, closed);
    for (k = 0; k < points.length; k++) {
      a = aeKeys[k]; e = exp[k];
      if (R.dist(a.i, e.i) > 0.05 || R.dist(a.o, e.o) > 0.05) {
        points[k].type = (R.len(a.i) < 1e-6 && R.len(a.o) < 1e-6) ? 'corner' : 'bezier';
        points[k].i = a.i.slice(); points[k].o = a.o.slice(); points[k].broken = !collinear(a.i, a.o); changed = true;
      }
    }
    return { points: points, closed: closed, changed: changed };
  }

  function loadRig(rig) {
    var r = R.normalize((rig.state && rig.state.route) || {}), res;
    if (rig.pathKeys && rig.pathKeys.length) { res = adopt(r.points, rig.pathKeys, r.closed); r.points = res.points; r.closed = res.closed; }
    if (rig.targetKeys && rig.targetKeys.length && r.aim.mode === 'path') { res = adopt(r.target.points, rig.targetKeys, false); r.target.points = res.points; }
    S.route = r; S.undo = []; S.redo = []; S.snapshot = null; S.dirty = false; S.linked = true; S.sel = [];
    if (editor) { editor.select([]); }
  }

  function useContext(c, opts) {
    opts = opts || {};
    S.ctx = c;
    if (!c.comp) {
      S.hasComp = false; S.layers = []; S.byId = {}; S.items = []; S.linked = false; S.compId = null;
      rebuild(); msg('Open a composition in After Effects to begin.', 'warn'); return;
    }
    var changed = S.compId !== c.comp.id, sig = c.rig ? rigSig(c.rig) : '';
    S.comp = c.comp; S.compId = c.comp.id; S.hasComp = true;
    if (c.layers && (c.layers.length || !opts.light)) { S.layers = c.layers; S.byId = SC.index(c.layers); S.items = SC.drawable(c.layers); }
    S.baked = !!(c.rig && c.rig.baked);
    if (opts.keepRoute) { S.linked = !!c.rig; }
    else if (c.rig && (changed || opts.force || (!S.dirty && sig !== S.rigSig))) {
      loadRig(c.rig);
      if (!changed && !opts.force && !opts.quiet) { msg('Picked up changes made in After Effects.', 'ok'); }
    }
    else if (!c.rig) { if (S.linked) { S.linked = false; S.dirty = false; } }
    else { S.linked = true; }
    S.rigSig = sig;
    if (!opts.keepTime && changed) { S.time = R.clamp(c.comp.time || 0, 0, c.comp.duration); }
    rebuild();
    if (changed && editor) { editor.fit(); }
  }

  function refresh(opts) {
    if (!PF.inAE) { if (!S.ctx) { useContext(mockContext(), opts); } return Promise.resolve(); }
    return PF.host('getContext', {}).then(function (c) { useContext(c, opts); }).catch(fail);
  }

  function applyToAE(scope) {
    if (!PF.inAE) { msg('Preview mode: open this panel inside After Effects to apply the route.', 'warn'); return Promise.resolve(null); }
    if (!S.hasComp) { msg('Open a composition in After Effects first.', 'warn'); return Promise.resolve(null); }
    if (S.route.points.length < 2) { msg('Draw at least two points before applying.', 'warn'); return Promise.resolve(null); }
    clearTimeout(S.applyTimer); S.applyTimer = null;
    recompute();
    var sent = JSON.stringify(S.route), was = S.linked;
    S.applying = PF.host('applyRoute', hostArgs(scope)).then(function (res) {
      S.applying = null; S.linked = true;
      if (JSON.stringify(S.route) === sent) { S.dirty = false; }
      return refresh({ keepRoute: true, keepTime: true }).then(function () {
        if (res.baked) { msg('Route updated, but the camera is baked. Use Camera > Restore live link to see it move.', 'warn'); }
        else if (S.model.tm.end > S.comp.duration + 0.001) { msg('Applied. The flight ends at ' + fmt(S.model.tm.end, 2) + ' s, after the composition ends (' + fmt(S.comp.duration, 2) + ' s).', 'warn'); }
        else { msg(was ? 'After Effects updated.' : 'Camera, route path and controller added to "' + S.comp.name + '".', 'ok'); }
        return res;
      });
    }).catch(function (e) { S.applying = null; fail(e); return null; });
    return S.applying;
  }
  function scheduleApply() {
    if (!PF.inAE || !$('live').checked || !S.linked || S.route.points.length < 2) { return; }
    clearTimeout(S.applyTimer);
    S.applyTimer = setTimeout(function () { S.applyTimer = null; applyToAE(); }, 220);
  }

  /* ----------------------------------------------------------- drawing */

  function sizePreview() {
    var c = $('preview'), pip = $('pip'), aspect = S.comp.height / S.comp.width, dpr = window.devicePixelRatio || 1, w, h;
    if ($('stage').classList.contains('swap')) {
      w = Math.min(pip.clientWidth, (pip.clientHeight - 27) / aspect); c.style.height = '';
    } else { w = pip.clientWidth; c.style.height = Math.round(w * aspect) + 'px'; }
    w = Math.max(80, Math.round(w * dpr)); h = Math.round(w * aspect);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }
  function drawPreview() {
    sizePreview();
    var c = $('preview'), ctx, cam = S.cam;
    if (!cam) {
      ctx = c.getContext('2d'); ctx.fillStyle = '#060d1a'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = 'rgba(203,213,225,0.6)'; ctx.font = Math.max(10, c.width / 30) + 'px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('The camera view appears once the route has two points', c.width / 2, c.height / 2);
      ctx.textAlign = 'left'; return;
    }
    SC.drawCamera(c, cam, { comp: S.comp, items: S.items, table: S.model.table, ttable: S.route.aim.mode === 'path' ? S.model.ttable : null, groundY: groundY() });
  }
  function groundY() {
    // put the preview's ground grid under the lowest layer edge (or the bottom of the comp frame)
    var y = S.comp.height, i, j;
    for (i = 0; i < S.items.length; i++) { for (j = 0; j < 4; j++) { y = Math.max(y, Math.min(S.items[i].corners[j][1], S.comp.height * 3)); } }
    return y;
  }
  function drawGraph() {
    var c = $('speedGraph'); if (!c.offsetParent) { return; }
    var dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight, ctx = c.getContext('2d'), keys = S.model.tm.keys, d = Math.max(S.comp.duration, S.model.tm.end), x, t, v, i;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(248,113,113,0.12)'; x = S.comp.duration / d * w; ctx.fillRect(x, 0, w - x, h);
    ctx.strokeStyle = 'rgba(148,163,184,0.25)'; ctx.lineWidth = 1; ctx.beginPath();
    for (i = 1; i < 4; i++) { ctx.moveTo(0, h * i / 4 + 0.5); ctx.lineTo(w, h * i / 4 + 0.5); } ctx.stroke();
    if (S.route.points.length < 2) { return; }
    ctx.strokeStyle = '#34d399'; ctx.lineWidth = 1.75; ctx.beginPath();
    for (x = 0; x <= w; x += 2) { t = x / w * d; v = R.evalKeys(keys, t); if (x) { ctx.lineTo(x, h - 4 - v / 100 * (h - 8)); } else { ctx.moveTo(x, h - 4 - v / 100 * (h - 8)); } }
    ctx.stroke();
    ctx.fillStyle = '#34d399';
    for (i = 0; i < keys.length; i++) { ctx.beginPath(); ctx.arc(keys[i].t / d * w, h - 4 - keys[i].v / 100 * (h - 8), 2.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = 'rgba(248,250,252,0.7)'; ctx.lineWidth = 1; x = S.time / d * w; ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); ctx.stroke();
  }
  function drawAll() { if (editor) { editor.draw(); } drawPreview(); drawGraph(); }

  /* ------------------------------------------------------------ fields */

  function getPath(o, path) { return path.split('.').reduce(function (a, k) { return a == null ? a : a[k]; }, o); }
  function setPath(o, path, v) { var ks = path.split('.'), last = ks.pop(), t = ks.reduce(function (a, k) { return a[k]; }, o); t[last] = v; }
  function readEl(el, old) {
    if (el.type === 'checkbox') { return el.checked; }
    if (el.type === 'number') { var n = parseFloat(el.value); return isFinite(n) ? n : old; }
    return el.value;
  }
  function writeEl(el, v) {
    if (document.activeElement === el && el.type === 'number') { return; }
    if (el.type === 'checkbox') { el.checked = !!v; } else { el.value = (v === null || v === undefined) ? '' : v; }
  }
  function show(sel, on) { all(sel).forEach(function (el) { el.hidden = !on; }); }

  function layerOptions(select, current, name) {
    var html = '<option value="0">Choose a layer...</option>', found = false;
    S.layers.forEach(function (L) {
      if (L.rig) { return; }
      if (L.id === current) { found = true; }
      html += '<option value="' + L.id + '">' + L.index + '. ' + esc(L.name) + '</option>';
    });
    if (current && !found) { html += '<option value="' + current + '">' + esc(name || 'Missing layer') + ' (not in this comp)</option>'; }
    select.innerHTML = html; select.value = String(current || 0);
  }

  function syncFields() {
    var r = S.route, a = S.anim;
    all('[data-bind]').forEach(function (el) { writeEl(el, getPath(r, el.dataset.bind)); });
    all('[data-anim]').forEach(function (el) { writeEl(el, getPath(a, el.dataset.anim)); });
    layerOptions($('aimLayer'), r.aim.layerId, r.aim.layerName);
    layerOptions($('focusLayer'), r.camera.focusLayerId, r.camera.focusLayerName);
    show('.aim-ahead', r.aim.mode === 'ahead'); show('.aim-layer', r.aim.mode === 'layer'); show('.aim-path', r.aim.mode === 'path'); show('.aim-manual', r.aim.mode === 'manual');
    show('.dof', !!r.camera.dof);
    show('.focus-layer', !!r.camera.dof && r.camera.focusMode === 'layer'); show('.focus-fixed', !!r.camera.dof && r.camera.focusMode === 'fixed');
    show('.trig-approach', a.trigger === 'approach'); show('.trig-progress', a.trigger === 'progress'); show('.trig-time', a.trigger === 'time');
    show('.trig-sync', a.trigger !== 'time'); show('.trig-order', a.trigger !== 'approach');
    show('.routeOnly', S.which === 'route');
    $('closed').disabled = S.route.points.length < 3;
  }

  function common(list, get) {
    var v, i, x;
    for (i = 0; i < list.length; i++) { x = get(list[i]); if (i === 0) { v = x; } else if (x !== v) { return { mixed: true }; } }
    return { value: v };
  }
  function renderInspector() {
    var pts = activePoints(), sel = S.sel.filter(function (i) { return i < pts.length; }), list = sel.map(function (i) { return pts[i]; }), cy = S.comp.height / 2;
    $('ptNone').hidden = !!sel.length; $('ptFields').hidden = !sel.length;
    $('ptTitle').textContent = sel.length > 1 ? sel.length + ' points selected' : (sel.length ? (S.which === 'route' ? 'Route' : 'Target') + ' point ' + (sel[0] + 1) : 'Selected point');
    if (!sel.length) { return; }
    function put(id, get) {
      var el = $(id), c = common(list, get);
      if (document.activeElement === el) { return; }
      el.value = c.mixed || c.value === null || c.value === undefined ? '' : c.value;
      if (el.tagName === 'INPUT') { el.placeholder = c.mixed ? 'mixed' : (id === 'ptRoll' || id === 'ptFocal' ? '–' : ''); }
    }
    put('ptX', function (p) { return Math.round(p.x * 100) / 100; });
    put('ptElev', function (p) { return Math.round((cy - p.y) * 100) / 100; });
    put('ptDepth', function (p) { return Math.round(p.z * 100) / 100; });
    put('ptType', function (p) { return p.type; });
    put('ptPause', function (p) { return p.pause; }); put('ptSpeed', function (p) { return p.speed; });
    put('ptRoll', function (p) { return p.roll; }); put('ptFocal', function (p) { return p.focal; });
  }
  function renderPointList() {
    var pts = activePoints(), cy = S.comp.height / 2, html = '';
    pts.forEach(function (p, i) {
      var extra = [];
      if (S.which === 'route') {
        if (p.pause > 0) { extra.push('pause ' + p.pause + ' s'); }
        if (p.speed !== 1) { extra.push('speed ×' + p.speed); }
        if (R.hasValue(p.roll)) { extra.push('roll ' + p.roll + '°'); }
        if (R.hasValue(p.focal)) { extra.push(p.focal + ' mm'); }
      }
      html += '<div class="item' + (S.sel.indexOf(i) >= 0 ? ' on' : '') + '" data-pt="' + i + '"><span class="meta">' + (i + 1) + '</span>' +
              '<span class="name">X ' + fmt(p.x) + ' &nbsp; elev ' + fmt(cy - p.y) + ' &nbsp; depth ' + fmt(p.z) + '</span><span class="meta">' + esc(extra.join(', ')) + '</span></div>';
    });
    $('ptList').innerHTML = html;
    var M = S.model, len = S.which === 'route' ? M.table.total : M.ttable.total;
    $('routeStats').textContent = pts.length ? pts.length + ' point' + (pts.length > 1 ? 's' : '') + ', ' + fmt(len) + ' px long' : '';
  }
  function renderMotionStats() {
    var M = S.model, tm = M.tm, flight = tm.end - tm.start, pauses = 0, i;
    if (S.route.points.length < 2) { $('motionStats').textContent = 'Draw a route to see its timing.'; return; }
    for (i = 0; i < tm.arrive.length; i++) { pauses += tm.depart[i] - tm.arrive[i]; }
    $('motionStats').textContent = 'Flight ' + fmt(tm.start, 2) + ' s to ' + fmt(tm.end, 2) + ' s, average ' + fmt(M.table.total / Math.max(flight - pauses, 0.01)) + ' px/s' +
      (pauses > 0 ? ', paused for ' + fmt(pauses, 2) + ' s' : '') + '. ' + tm.keys.length + ' Route Progress keyframes.' +
      (tm.end > S.comp.duration + 0.001 ? ' Ends after the composition (' + fmt(S.comp.duration, 2) + ' s).' : '');
  }
  function renderLayers() {
    var html = '', n = 0;
    S.layers.forEach(function (L) {
      if (L.rig || L.kind === 'camera' || L.kind === 'light') { return; }
      var on = !!S.animSel[L.id]; if (on) { n++; }
      html += '<label class="item' + (on ? ' on' : '') + '"><input type="checkbox" data-layer="' + L.id + '"' + (on ? ' checked' : '') + '>' +
              '<span class="sw" style="background:' + SC.rgba(L.label || [120, 140, 170], 1) + '"></span><span class="name">' + L.index + '. ' + esc(L.name) + '</span>' +
              (L.anim ? '<span class="tag on">animated</span>' : '') + '<span class="tag">' + (L.threeD ? '3D' : '2D') + '</span></label>';
    });
    $('layerList').innerHTML = html;
    $('layerCount').textContent = n ? n + ' ticked' : '';
  }
  function renderImportHint() {
    var sp = S.ctx && S.ctx.selectedPath;
    $('importHint').textContent = sp ? 'Selected in After Effects: "' + sp.name + '" on layer "' + sp.layer + '"' + (sp.threeD ? ' (3D layer: its real position in space is used).' : '.')
      : 'Draw a mask or shape path with After Effects\' Pen tool, select it, then press the button. Or draw directly in the editor above.';
    $('importPlane').disabled = !!(sp && sp.threeD);
  }
  function renderPresets() {
    var html = '';
    S.store.routes.forEach(function (p, i) {
      html += '<div class="item" data-load-route="' + i + '"><span class="name">' + esc(p.name) + '</span><span class="meta">' + p.route.points.length + ' points, ' + fmt(p.route.timing.duration, 1) + ' s</span>' +
              '<button class="mini" data-load-route="' + i + '">Load</button><button class="mini danger" data-del-route="' + i + '">Delete</button></div>';
    });
    $('routePresets').innerHTML = html;
    html = '';
    S.store.anims.forEach(function (p, i) {
      html += '<div class="item" data-load-anim="' + i + '"><span class="name">' + esc(p.name) + '</span><span class="meta">' + esc(p.trigger) + '</span>' +
              '<button class="mini" data-load-anim="' + i + '">Use</button><button class="mini danger" data-del-anim="' + i + '">Delete</button></div>';
    });
    $('animPresets').innerHTML = html;
    html = '';
    P.anims.forEach(function (p) { html += '<option value="b:' + p.id + '">' + esc(p.name) + '</option>'; });
    S.store.anims.forEach(function (p, i) { html += '<option value="u:' + i + '">★ ' + esc(p.name) + '</option>'; });
    html += '<option value="custom">Custom</option>';
    $('animPreset').innerHTML = html; $('animPreset').value = S.animKey || 'custom';
    if ($('animPreset').selectedIndex < 0) { $('animPreset').value = 'custom'; }
    $('presetPath').textContent = PF.dataDir ? 'Presets are saved in ' + PF.dataDir + '\\presets.json' : '';
  }
  function renderTransport() {
    var d = Math.max(S.comp.duration, 0.01);
    if (document.activeElement !== $('scrub')) { $('scrub').value = Math.round(S.time / d * 1000); }
    $('readout').textContent = fmt(S.time, 2).replace(/^(\d+)$/, '$1.00') + ' s' + (S.cam ? '  ·  ' + fmt(S.cam.u * 100, 1) + ' %' : '');
  }

  /** Recompute everything derived from the route and repaint the panel. */
  function rebuild() {
    recompute();
    if (editor) { editor.setColour(S.which === 'route' ? RC.Editor.COLOURS.route : RC.Editor.COLOURS.target); }
    chips(); syncFields(); renderInspector(); renderPointList(); renderMotionStats(); renderLayers(); renderImportHint(); renderTransport();
    drawAll();
  }

  /* ---------------------------------------------------------- transport */

  var followBusy = false, followWant = null;
  function followAE() {
    if (!PF.inAE || !$('follow').checked || !S.hasComp) { return; }
    followWant = S.time;
    if (followBusy) { return; }
    followBusy = true;
    var t = followWant;
    PF.host('setTime', { compId: S.compId, time: t }).catch(function () {}).then(function () {
      followBusy = false;
      if (followWant !== null && Math.abs(followWant - t) > 1e-4) { followAE(); }
    });
  }
  function setTime(t, quiet) {
    S.time = R.clamp(t, 0, S.comp.duration);
    S.cam = S.route.points.length >= 2 ? R.solve(S.route, S.model, S.time, env()) : null;
    $('aeFrame').classList.remove('on');
    renderTransport(); drawAll();
    if (!quiet) { followAE(); }
  }
  var playStart = 0, playFrom = 0, lastFollow = 0;
  function tick(now) {
    if (!S.playing) { return; }
    var end = Math.min(S.comp.duration, S.model.tm.end + 0.4), t = playFrom + (now - playStart) / 1000;
    if (t >= end) { setTime(end); stop(); return; }
    setTime(t, true);
    if (now - lastFollow > 160) { lastFollow = now; followAE(); }
    requestAnimationFrame(tick);
  }
  function play() {
    if (S.route.points.length < 2) { msg('Draw a route first.', 'warn'); return; }
    var end = Math.min(S.comp.duration, S.model.tm.end + 0.4);
    playFrom = S.time >= end - 0.05 ? Math.max(0, S.model.tm.start - 0.3) : S.time;
    playStart = performance.now(); S.playing = true; $('btnPlay').textContent = 'Stop';
    requestAnimationFrame(tick);
  }
  function stop() { S.playing = false; $('btnPlay').textContent = 'Play'; }

  /* ------------------------------------------------------------ actions */

  function importPath() {
    if (!PF.inAE) { msg('Preview mode: masks and shape paths are read inside After Effects.', 'warn'); return Promise.resolve(false); }
    return PF.host('importPath', { compId: S.compId }).then(function (res) {
      var plane = res.threeD ? 'world' : $('importPlane').value, cy = res.compHeight / 2;
      function mp(v) { return plane === 'floor' ? [v[0], cy, cy - v[1]] : v; }
      function mt(v) { return plane === 'floor' ? [v[0], 0, -v[1]] : v; }
      var pts = res.keys.map(function (k) {
        var p = mp(k.p), i = mt(k.i), o = mt(k.o), flat = R.len(i) < 1e-6 && R.len(o) < 1e-6;
        var q = R.point(Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100, Math.round(p[2] * 100) / 100);
        q.type = flat ? 'corner' : 'bezier'; q.i = i; q.o = o;
        q.broken = !(R.len(i) < 1e-6 || R.len(o) < 1e-6 || R.dot(R.norm(i), R.norm(o)) < -0.9995);
        return q;
      });
      begin();
      if (S.which === 'route') { S.route.points = pts; S.route.closed = !!res.closed && pts.length > 2; }
      else { S.route.target.points = pts; }
      S.sel = []; editor.select([]);
      commit(); editor.fit();
      msg('Imported "' + res.name + '" from "' + res.layer + '" (' + pts.length + ' points' + (plane === 'floor' ? ', laid flat as a floor plan' : (plane === 'world' ? ', in 3D' : '')) + '). Adjust depth and elevation per point.', 'ok');
      return true;
    }).catch(function (e) { fail(e); return false; });
  }

  function insertShape() {
    var s = P.shapes.filter(function (x) { return x.id === $('shapeSel').value; })[0], made;
    if (!s) { return; }
    made = s.make(S.comp.width, S.comp.height);
    begin();
    S.route.points = made.points; S.route.closed = !!made.closed;
    if (made.target) { S.route.target.points = made.target; }
    if (made.aim) { Object.keys(made.aim).forEach(function (k) { S.route.aim[k] = made.aim[k]; }); }
    S.which = 'route'; setWhich('route', true);
    S.sel = []; editor.select([]);
    commit(); editor.fit();
    msg('Inserted "' + s.name + '".', 'ok');
  }

  function animSpec() {
    var a = S.anim;
    return { name: a.name || '', direction: a.direction === 'out' ? 'out' : 'in', pos: [R.num(a.pos[0], 0), R.num(a.pos[1], 0), R.num(a.pos[2], 0)],
             rot: [R.num(a.rot[0], 0), R.num(a.rot[1], 0), R.num(a.rot[2], 0)], scale: R.num(a.scale, 100), opacity: R.clamp(R.num(a.opacity, 100), 0, 100),
             ease: a.ease || 'out', overshoot: R.num(a.overshoot, 0) };
  }
  function animate() {
    if (!PF.inAE) { msg('Preview mode: layers are animated inside After Effects.', 'warn'); return Promise.resolve(null); }
    var chosen = S.layers.filter(function (L) { return S.animSel[L.id] && !L.rig && L.kind !== 'camera' && L.kind !== 'light'; });
    if (!chosen.length) { msg('Tick at least one layer to animate.', 'warn'); return Promise.resolve(null); }
    var spec = animSpec();
    if (!spec.pos[0] && !spec.pos[1] && !spec.pos[2] && !spec.rot[0] && !spec.rot[1] && !spec.rot[2] && spec.scale === 100 && spec.opacity === 100) {
      msg('This animation changes nothing. Set a move, rotation, scale or opacity.', 'warn'); return Promise.resolve(null);
    }
    var linkedTiming = S.anim.trigger !== 'time', ready = Promise.resolve(true);
    if (linkedTiming && S.route.points.length < 2) { msg('Camera-linked timing needs a route. Draw one, or choose "At a time".', 'warn'); return Promise.resolve(null); }
    if (linkedTiming && (!S.linked || S.dirty)) { ready = applyToAE(); }
    return ready.then(function (ok) {
      if (linkedTiming && !ok) { return null; }
      var infos = chosen.map(function (L) { return { id: L.id, index: L.index, pos: SC.layerWorldPos(L, S.byId) }; });
      var sched = P.schedule(infos, S.anim, S.route, S.model);
      return PF.host('animateLayers', { compId: S.compId, make3D: true, anim: spec, layers: sched }).then(function (res) {
        return refresh({ keepRoute: true, keepTime: true }).then(function () {
          msg('Animated ' + res.animated.length + ' layer' + (res.animated.length === 1 ? '' : 's') + (linkedTiming ? ', linked to camera progress' : '') +
              (res.skipped.length ? ' (' + res.skipped.length + ' skipped: locked or not animatable)' : '') + '.', res.animated.length ? 'ok' : 'warn');
          return res;
        });
      });
    }).catch(function (e) { fail(e); return null; });
  }
  function unanimate() {
    var ids = S.layers.filter(function (L) { return S.animSel[L.id]; }).map(function (L) { return L.id; });
    if (!ids.length) { msg('Tick the layers to restore.', 'warn'); return Promise.resolve(null); }
    return PF.host('removeLayerAnimation', { compId: S.compId, ids: ids }).then(function (res) {
      return refresh({ keepRoute: true, keepTime: true }).then(function () { msg(res.removed ? 'Restored ' + res.removed + ' layer' + (res.removed === 1 ? '' : 's') + ' to how they were.' : 'None of the ticked layers had Routecam animation.', res.removed ? 'ok' : 'warn'); return res; });
    }).catch(fail);
  }

  function createSample() {
    if (!PF.inAE) { setRoute(P.sampleRoute(), 'Loaded the sample route (preview mode).'); return Promise.resolve(null); }
    msg('Building the sample composition...');
    return PF.host('buildSampleScene', {}).then(function (res) {
      S.route = P.sampleRoute(); S.undo = []; S.redo = []; S.dirty = true; S.linked = false; S.compId = res.compId; S.sel = [];
      return refresh({ keepRoute: true }).then(function () { return applyToAE(); }).then(function () {
        S.animSel = {};
        S.layers.forEach(function (L) { if (/^Card /.test(L.name)) { S.animSel[L.id] = true; } });
        S.anim = P.withDefaults(P.anims[1]); S.anim.trigger = 'approach'; S.anim.lead = 34; S.anim.span = 9; S.animKey = 'b:' + P.anims[1].id;
        return animate();
      }).then(function () {
        editor.fit(); setTime(S.model.tm.start + (S.model.tm.end - S.model.tm.start) * 0.35);
        renderPresets();
        msg('Sample composition created. Press Play here, or preview it in After Effects.', 'ok');
        return res;
      });
    }).catch(function (e) { fail(e); return null; });
  }

  function grabFrame() {
    if (!PF.inAE) { msg('Preview mode: frames are rendered inside After Effects.', 'warn'); return Promise.resolve(false); }
    var file = PF.tempFile('routecam-frame-' + Date.now() + '.png');
    msg('Rendering this frame in After Effects...');
    return PF.host('grabFrame', { compId: S.compId, time: S.time, path: file }).then(function () {
      var tries = 0;
      return new Promise(function (resolve) {
        (function wait() {
          if (PF.fileExists(file)) { resolve(true); return; }
          if (++tries > 40) { resolve(false); return; }
          setTimeout(wait, 150);
        })();
      });
    }).then(function (ok) {
      if (!ok) { msg('After Effects did not produce a frame. Use "Follow in AE" and look at the Composition panel instead.', 'warn'); return false; }
      var img = $('aeFrame');
      img.onload = function () { img.classList.add('on'); };
      img.src = PF.fileUrl(file);
      msg('Showing the frame rendered by After Effects at ' + fmt(S.time, 2) + ' s. Click it to go back to the live preview.', 'ok');
      return true;
    }).catch(function (e) { fail(e); return false; });
  }

  function saveStore() { if (!PF.writeJSON('presets.json', S.store)) { msg('Could not write the presets file.', 'err'); } }

  function setWhich(which, silent) {
    S.which = which;
    all('#whichSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.which === which); });
    S.sel = []; if (editor) { editor.select([]); }
    if (!silent) {
      if (which === 'target' && S.route.aim.mode !== 'path') { begin(); S.route.aim.mode = 'path'; commit(); msg('Aim switched to "Follow the target path". Draw where the camera should look.', 'ok'); }
      else { rebuild(); }
    }
  }

  /* ------------------------------------------------------------- wiring */

  function wire() {
    editor = new RC.Editor($('editor'), {
      points: activePoints, closed: activeClosed,
      ghost: function () {
        if (S.which === 'route') { return S.route.aim.mode === 'path' ? { keys: R.resolve(S.route.target.points, false), closed: false, colour: RC.Editor.COLOURS.target } : null; }
        return { keys: R.resolve(S.route.points, S.route.closed), closed: !!S.route.closed, colour: RC.Editor.COLOURS.route };
      },
      scene: function () { return { comp: S.comp, items: S.items, cam: S.cam }; },
      begin: begin, commit: commit, cancel: cancel, undo: undo, redo: redo,
      live: function () { recompute(); drawPreview(); renderInspector(); },
      selection: function (sel) { S.sel = sel; renderInspector(); renderPointList(); },
      close: function (b) { if (S.which === 'route') { S.route.closed = b; } },
      canClose: function () { return S.which === 'route'; },
      toolChanged: function (t) { all('#toolSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.tool === t); }); },
      viewChanged: function (v) { all('#viewSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.view === v); }); }
    });

    all('#toolSeg button').forEach(function (b) { b.addEventListener('click', function () { editor.setTool(b.dataset.tool); }); });
    all('#viewSeg button').forEach(function (b) { b.addEventListener('click', function () { editor.setView(b.dataset.view); }); });
    all('#whichSeg button').forEach(function (b) { b.addEventListener('click', function () { setWhich(b.dataset.which); }); });
    $('btnFit').addEventListener('click', function () { editor.fit(); });
    $('btnUndo').addEventListener('click', undo); $('btnRedo').addEventListener('click', redo);
    $('btnDelete').addEventListener('click', function () { editor.removeSelected(); });

    all('#tabs button').forEach(function (b) {
      b.addEventListener('click', function () {
        all('#tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
        all('.tab').forEach(function (t) { t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab); });
        drawGraph();
        if (b.dataset.tab === 'layers' || b.dataset.tab === 'camera' || b.dataset.tab === 'route') { refreshSoon(); }
      });
    });

    // route settings
    all('[data-bind]').forEach(function (el) {
      el.addEventListener('change', function () {
        var old = getPath(S.route, el.dataset.bind), v = readEl(el, old);
        if (v === old) { return; }
        begin(); setPath(S.route, el.dataset.bind, v); commit();
      });
    });
    function pickLayer(select, idKey, nameKey, group) {
      select.addEventListener('change', function () {
        var id = parseInt(select.value, 10) || 0, L = S.byId[id];
        begin(); S.route[group][idKey] = id; S.route[group][nameKey] = L ? L.name : ''; commit();
      });
    }
    pickLayer($('aimLayer'), 'layerId', 'layerName', 'aim');
    pickLayer($('focusLayer'), 'focusLayerId', 'focusLayerName', 'camera');

    // selected point
    function onPoint(id, apply) {
      $(id).addEventListener('change', function () {
        var pts = activePoints(), raw = $(id).value, keys = R.resolve(pts, activeClosed());
        if (!S.sel.length) { return; }
        begin();
        S.sel.forEach(function (i) { if (pts[i]) { apply(pts[i], raw, keys[i]); } });
        commit();
      });
    }
    function numOr(raw, fallback) { var n = parseFloat(raw); return isFinite(n) ? n : fallback; }
    onPoint('ptX', function (p, raw) { p.x = numOr(raw, p.x); });
    onPoint('ptElev', function (p, raw) { p.y = S.comp.height / 2 - numOr(raw, S.comp.height / 2 - p.y); });
    onPoint('ptDepth', function (p, raw) { p.z = numOr(raw, p.z); });
    onPoint('ptType', function (p, raw, key) { if (raw === 'bezier' && p.type !== 'bezier') { p.i = key.i.slice(); p.o = key.o.slice(); p.broken = false; } if (raw) { p.type = raw; } });
    onPoint('ptPause', function (p, raw) { p.pause = Math.max(0, numOr(raw, 0)); });
    onPoint('ptSpeed', function (p, raw) { p.speed = R.clamp(numOr(raw, 1), 0.05, 20); });
    onPoint('ptRoll', function (p, raw) { p.roll = raw === '' ? null : numOr(raw, p.roll); });
    onPoint('ptFocal', function (p, raw) { p.focal = raw === '' ? null : Math.max(5, numOr(raw, p.focal)); });
    $('ptList').addEventListener('click', function (e) {
      var row = e.target.closest('[data-pt]'); if (!row) { return; }
      var i = parseInt(row.dataset.pt, 10), sel = S.sel.slice(), at = sel.indexOf(i);
      if (e.shiftKey || e.ctrlKey) { if (at >= 0) { sel.splice(at, 1); } else { sel.push(i); } } else { sel = [i]; }
      editor.select(sel);
    });

    $('btnImport').addEventListener('click', importPath);
    $('btnShape').addEventListener('click', insertShape);
    $('btnReverse').addEventListener('click', function () {
      var pts = activePoints(); if (pts.length < 2) { return; }
      begin();
      pts.reverse().forEach(function (p) { var t = p.i; p.i = p.o; p.o = t; });
      commit(); msg('Route reversed.', 'ok');
    });
    $('btnClear').addEventListener('click', function () {
      if (!activePoints().length) { return; }
      begin();
      if (S.which === 'route') { S.route.points = []; S.route.closed = false; } else { S.route.target.points = []; }
      editor.select([]); commit(); msg('Cleared. Ctrl+Z in the editor brings it back.');
    });
    $('btnFitComp').addEventListener('click', function () { begin(); S.route.timing.start = 0; S.route.timing.duration = Math.round((S.comp.duration - 1 / S.comp.fps) * 100) / 100; commit(); });
    $('btnFitWork').addEventListener('click', function () { begin(); S.route.timing.start = Math.round(S.comp.workStart * 100) / 100; S.route.timing.duration = Math.round(S.comp.workDuration * 100) / 100; commit(); });

    // transport
    $('scrub').addEventListener('input', function () { stop(); setTime($('scrub').value / 1000 * S.comp.duration); });
    $('btnPlay').addEventListener('click', function () { if (S.playing) { stop(); } else { play(); } });
    $('follow').addEventListener('change', followAE);
    $('preview').addEventListener('click', function () { $('stage').classList.toggle('swap'); $('btnSwap').textContent = $('stage').classList.contains('swap') ? 'Back to editor' : 'Enlarge'; drawAll(); });
    $('btnSwap').addEventListener('click', function () { $('preview').click(); });
    $('aeFrame').addEventListener('click', function () { $('aeFrame').classList.remove('on'); });
    $('btnGrab').addEventListener('click', grabFrame);

    // camera
    $('btnBake').addEventListener('click', function () {
      if (!S.linked) { msg('Apply the route first.', 'warn'); return; }
      PF.host('bakeCamera', { compId: S.compId, start: S.model.tm.start, end: S.model.tm.end }).then(function (r) { return refresh({ keepRoute: true, keepTime: true }).then(function () { msg('Camera baked: ' + r.frames + ' keyframes per property. The route no longer drives it until you restore the live link.', 'ok'); }); }).catch(fail);
    });
    $('btnUnbake').addEventListener('click', function () {
      PF.host('unbakeCamera', { compId: S.compId }).then(function () { return refresh({ keepRoute: true, keepTime: true }).then(function () { msg('Live link restored.', 'ok'); }); }).catch(fail);
    });
    $('btnRemoveRig').addEventListener('click', function () {
      PF.host('removeRig', { compId: S.compId }).then(function (r) { S.linked = false; S.dirty = false; return refresh({ keepTime: true }).then(function () { msg(r.removed ? 'Removed the Routecam layers. The route is still here as a draft. Undo in After Effects brings them back.' : 'This composition has no Routecam layers.', r.removed ? 'ok' : 'warn'); }); }).catch(fail);
    });

    // layers
    $('layerList').addEventListener('change', function (e) {
      var id = e.target.dataset.layer; if (!id) { return; }
      S.animSel[id] = e.target.checked; renderLayers();
    });
    $('btnUseSel').addEventListener('click', function () {
      refresh({ keepRoute: true, keepTime: true }).then(function () {
        S.animSel = {}; var n = 0;
        S.layers.forEach(function (L) { if (L.selected && !L.rig && L.kind !== 'camera' && L.kind !== 'light') { S.animSel[L.id] = true; n++; } });
        renderLayers(); msg(n ? n + ' selected layer' + (n === 1 ? '' : 's') + ' ticked.' : 'No layers are selected in After Effects.', n ? 'ok' : 'warn');
      });
    });
    $('btnAll3D').addEventListener('click', function () { S.animSel = {}; S.layers.forEach(function (L) { if (L.threeD && !L.rig && L.kind !== 'camera' && L.kind !== 'light' && L.kind !== 'null') { S.animSel[L.id] = true; } }); renderLayers(); });
    $('btnNone').addEventListener('click', function () { S.animSel = {}; renderLayers(); });
    all('[data-anim]').forEach(function (el) {
      el.addEventListener('change', function () {
        setPath(S.anim, el.dataset.anim, readEl(el, getPath(S.anim, el.dataset.anim)));
        S.animKey = 'custom'; $('animPreset').value = 'custom'; syncFields();
      });
    });
    $('animPreset').addEventListener('change', function () {
      var v = $('animPreset').value, src = null, keep = {};
      if (v.indexOf('b:') === 0) { src = P.anims.filter(function (a) { return a.id === v.slice(2); })[0]; ['trigger', 'startTime', 'startPct', 'stagger', 'staggerPct', 'lead', 'span', 'order'].forEach(function (k) { keep[k] = S.anim[k]; }); }
      else if (v.indexOf('u:') === 0) { src = S.store.anims[parseInt(v.slice(2), 10)]; }
      if (src) { S.anim = P.withDefaults(src); Object.keys(keep).forEach(function (k) { S.anim[k] = keep[k]; }); }
      S.animKey = v; syncFields();
    });
    $('btnAnimate').addEventListener('click', animate);
    $('btnUnanimate').addEventListener('click', unanimate);

    // presets
    $('btnSaveRoute').addEventListener('click', function () {
      var name = $('routePresetName').value.trim();
      if (!name) { msg('Type a name for the route preset.', 'warn'); $('routePresetName').focus(); return; }
      if (S.route.points.length < 2) { msg('There is no route to save yet.', 'warn'); return; }
      S.store.routes = S.store.routes.filter(function (p) { return p.name !== name; });
      S.store.routes.push({ name: name, compWidth: S.comp.width, compHeight: S.comp.height, route: clone(S.route) });
      saveStore(); $('routePresetName').value = ''; renderPresets(); msg('Saved route preset "' + name + '".', 'ok');
    });
    $('btnSaveAnim').addEventListener('click', function () {
      var name = $('animPresetName').value.trim(), a;
      if (!name) { msg('Type a name for the animation preset.', 'warn'); $('animPresetName').focus(); return; }
      a = clone(S.anim); a.name = name; delete a.id;
      S.store.anims = S.store.anims.filter(function (p) { return p.name !== name; });
      S.store.anims.push(a); S.animKey = 'u:' + (S.store.anims.length - 1);
      saveStore(); $('animPresetName').value = ''; renderPresets(); msg('Saved animation preset "' + name + '".', 'ok');
    });
    $('tab-presets').addEventListener('click', function (e) {
      var d = e.target.dataset, row = e.target.closest('.item'), i;
      if (d.delRoute !== undefined) { i = +d.delRoute; msg('Deleted route preset "' + S.store.routes[i].name + '".'); S.store.routes.splice(i, 1); saveStore(); renderPresets(); return; }
      if (d.delAnim !== undefined) { i = +d.delAnim; msg('Deleted animation preset "' + S.store.anims[i].name + '".'); S.store.anims.splice(i, 1); S.animKey = 'custom'; saveStore(); renderPresets(); return; }
      if (row && row.dataset.loadRoute !== undefined) {
        i = +row.dataset.loadRoute; var p = S.store.routes[i], r = clone(p.route);
        r.aim.layerId = S.byId[r.aim.layerId] ? r.aim.layerId : 0; r.camera.focusLayerId = S.byId[r.camera.focusLayerId] ? r.camera.focusLayerId : 0;
        setRoute(r, 'Loaded route preset "' + p.name + '".'); return;
      }
      if (row && row.dataset.loadAnim !== undefined) {
        i = +row.dataset.loadAnim; S.anim = P.withDefaults(S.store.anims[i]); S.animKey = 'u:' + i; renderPresets(); syncFields();
        msg('Animation preset "' + S.store.anims[i].name + '" is ready on the Layers tab.', 'ok');
      }
    });
    $('btnSample').addEventListener('click', createSample);

    $('btnApply').addEventListener('click', function () { applyToAE(); });
    $('btnReload').addEventListener('click', function () { refresh({ force: true, keepTime: true }).then(function () { if (S.hasComp) { msg(S.linked ? 'Reloaded the route from "' + S.comp.name + '".' : '"' + S.comp.name + '" has no Routecam route yet.', 'ok'); } }); });

    var html = '';
    P.shapes.forEach(function (s) { html += '<option value="' + s.id + '">' + esc(s.name) + '</option>'; });
    $('shapeSel').innerHTML = html;

    window.addEventListener('resize', drawAll);
    window.addEventListener('focus', refreshSoon);
    document.addEventListener('mouseenter', refreshSoon);
    document.addEventListener('keydown', function (e) {
      // undo/redo work anywhere in the panel except while typing in a field
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) { return; }
      if (e.target === $('editor')) { return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { if (e.shiftKey) { redo(); } else { undo(); } e.preventDefault(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { redo(); e.preventDefault(); }
    });

    var keys = [{ keyCode: 90, ctrlKey: true }, { keyCode: 90, ctrlKey: true, shiftKey: true }, { keyCode: 89, ctrlKey: true }, { keyCode: 65, ctrlKey: true },
                { keyCode: 46 }, { keyCode: 8 }, { keyCode: 27 }, { keyCode: 32 }, { keyCode: 86 }, { keyCode: 80 }, { keyCode: 83 }, { keyCode: 70 }, { keyCode: 49 }, { keyCode: 50 }, { keyCode: 51 }];
    [37, 38, 39, 40].forEach(function (k) { keys.push({ keyCode: k }); keys.push({ keyCode: k, shiftKey: true }); });
    [90, 89, 65].forEach(function (k) { keys.push({ keyCode: k, metaKey: true }); });
    PF.claimKeys(keys);
  }

  /** Re-read the composition when the user comes back to the panel (picks up After Effects undo and motion-path edits). */
  var lastRefresh = 0;
  function refreshSoon() {
    var now = Date.now();
    if (!PF.inAE || now - lastRefresh < 1200 || (editor && editor.isDragging()) || S.applying || S.applyTimer || S.playing) { return; }
    lastRefresh = now;
    refresh({ keepTime: true });
  }

  function init() {
    S.store = PF.readJSON('presets.json', { routes: [], anims: [] });
    if (!S.store.routes) { S.store.routes = []; } if (!S.store.anims) { S.store.anims = []; }
    S.animKey = 'b:' + P.anims[1].id;
    recompute();
    wire();
    renderPresets();
    rebuild();
    refresh({ force: true }).then(function () {
      if (!PF.inAE) { msg('Preview mode: the editor and camera preview work here; open the panel in After Effects to apply.', 'warn'); }
      else if (S.hasComp) { msg(S.linked ? 'Loaded the route stored in "' + S.comp.name + '".' : 'Draw a route, or pick a shape, then press Apply to After Effects.', S.linked ? 'ok' : ''); }
    });
  }

  RC.app = { state: S, refresh: refresh, applyToAE: applyToAE, setRoute: setRoute, setTime: setTime, importPath: importPath, animate: animate, unanimate: unanimate,
             createSample: createSample, grabFrame: grabFrame, hostArgs: hostArgs, undo: undo, redo: redo, rebuild: rebuild, setWhich: setWhich,
             editor: function () { return editor; } };
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();
