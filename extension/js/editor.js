/*
 * Routecam - the path editor (a canvas with top / front / side views).
 *
 * After Effects gives panels no way to draw or receive clicks inside the
 * Composition panel, so routes are drawn here and written to After Effects as
 * an ordinary motion path.  The editor works on plain point objects (see
 * core/route.js) owned by app.js; it calls back for undo snapshots.
 *
 *   api.points()            active path's points (edited in place)
 *   api.closed()            is the active path a loop
 *   api.ghost()             the other path's resolved keys, drawn dimmed
 *   api.scene()             { comp, items (drawable layers), cam }
 *   api.begin()             an edit is starting (take an undo snapshot)
 *   api.commit(label)       the edit finished
 *   api.live()              points moved mid-drag (redraw dependants)
 *   api.selection(sel)      selection changed
 *   api.close(bool)         open / close the active path
 */
(function () {
  'use strict';
  var RC = window.RC, R = RC.route;

  // world axis shown horizontally (a) and vertically (b); bs flips so "far" is up in the top view
  var VIEWS = {
    top: { a: 0, b: 2, bs: -1, h: 1, name: 'Top', la: 'X', lb: 'Depth (Z)' },
    front: { a: 0, b: 1, bs: 1, h: 2, name: 'Front', la: 'X', lb: 'Elevation' },
    side: { a: 2, b: 1, bs: 1, h: 0, name: 'Side', la: 'Depth (Z)', lb: 'Elevation' }
  };
  var AX = ['x', 'y', 'z'];
  var COL = { route: '#34d399', target: '#fbbf24', grid: 'rgba(148,163,184,0.10)', gridStrong: 'rgba(148,163,184,0.20)', text: 'rgba(203,213,225,0.75)', frame: 'rgba(96,165,250,0.55)' };

  function Editor(canvas, api) {
    var self = this, ctx = canvas.getContext('2d');
    var view = 'top', k = 0.12, ox = 0, oy = 0, tool = 'select', sel = [], colour = COL.route;
    var drag = null, hover = null, spaceDown = false, fitted = false, dpr = 1, W = 0, H = 0;

    function V() { return VIEWS[view]; }
    function w2s(p) { var v = V(); return [ox + p[v.a] * k, oy + p[v.b] * v.bs * k]; }
    function s2w(sx, sy, base) { var v = V(), p = base.slice(); p[v.a] = (sx - ox) / k; p[v.b] = (sy - oy) / (k * v.bs); return p; }
    function pts() { return api.points(); }
    function keys() { return R.resolve(pts(), api.closed()); }
    function mouse(e) { var r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

    /* ------------------------------------------------------------ draw */

    function measure() {
      var r = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1; W = Math.max(50, r.width); H = Math.max(50, r.height);
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    }
    function resize() { measure(); if (!fitted && W > 60) { fit(); } }

    function gridStep() {
      var steps = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000], i;
      for (i = 0; i < steps.length; i++) { if (steps[i] * k >= 46) { return steps[i]; } }
      return 100000;
    }

    function drawGrid(scene) {
      var v = V(), step = gridStep(), x, y, n, a0 = (0 - ox) / k, a1 = (W - ox) / k, b0, b1, cy = scene.comp.height / 2, label;
      b0 = (0 - oy) / (k * v.bs); b1 = (H - oy) / (k * v.bs);
      if (b0 > b1) { n = b0; b0 = b1; b1 = n; }
      ctx.lineWidth = 1; ctx.font = '10px "Segoe UI", system-ui, sans-serif'; ctx.fillStyle = COL.text;
      for (x = Math.ceil(a0 / step) * step; x <= a1; x += step) {
        ctx.strokeStyle = (Math.round(x / step) % 5 === 0) ? COL.gridStrong : COL.grid;
        ctx.beginPath(); ctx.moveTo(Math.round(ox + x * k) + 0.5, 0); ctx.lineTo(Math.round(ox + x * k) + 0.5, H); ctx.stroke();
        if (Math.round(x / step) % 2 === 0) { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(String(Math.round(x)), ox + x * k, H - 3); }
      }
      for (y = Math.ceil(b0 / step) * step; y <= b1; y += step) {
        ctx.strokeStyle = (Math.round(y / step) % 5 === 0) ? COL.gridStrong : COL.grid;
        n = Math.round(oy + y * v.bs * k) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, n); ctx.lineTo(W, n); ctx.stroke();
        if (Math.round(y / step) % 2 === 0) {
          label = v.b === 1 ? Math.round(cy - y) : Math.round(y);       // elevation reads upwards from the comp centre
          ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(String(label), 4, n);
        }
      }
      ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.fillStyle = 'rgba(148,163,184,0.9)';
      ctx.fillText(v.name + ' view   → ' + v.la + '   ↑ ' + v.lb, W - 8, 6);
    }

    function drawFrame(scene) {
      // the composition frame sits on the Z = 0 plane
      var c = scene.comp, corners = [[0, 0, 0], [c.width, 0, 0], [c.width, c.height, 0], [0, c.height, 0]], i, p;
      ctx.strokeStyle = COL.frame; ctx.lineWidth = 1.25; ctx.setLineDash([5, 4]);
      ctx.beginPath();
      for (i = 0; i < 4; i++) { p = w2s(corners[i]); if (i) { ctx.lineTo(p[0], p[1]); } else { ctx.moveTo(p[0], p[1]); } }
      ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
      p = w2s(view === 'side' ? [0, 0, 0] : [0, 0, 0]);
      ctx.fillStyle = 'rgba(96,165,250,0.85)'; ctx.font = '10px "Segoe UI", system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(view === 'front' ? 'comp frame (Z = 0)' : 'comp plane (Z = 0)', p[0] + 4, p[1] - 3);
    }

    function drawLayers(scene) {
      var i, j, it, p, c, cx, cy;
      ctx.font = '10px "Segoe UI", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (i = 0; i < scene.items.length; i++) {
        it = scene.items[i]; c = it.layer.label || [120, 140, 170]; cx = 0; cy = 0;
        ctx.beginPath();
        for (j = 0; j < 4; j++) { p = w2s(it.corners[j]); cx += p[0] / 4; cy += p[1] / 4; if (j) { ctx.lineTo(p[0], p[1]); } else { ctx.moveTo(p[0], p[1]); } }
        ctx.closePath();
        var big = it.size > scene.comp.width * 2.5;      // floors and backdrops stay in the background
        ctx.fillStyle = RC.scene.rgba(c, big ? 0.05 : (it.layer.selected ? 0.34 : 0.16)); ctx.fill();
        ctx.strokeStyle = RC.scene.rgba(c, big ? 0.3 : (it.layer.selected ? 1 : 0.7)); ctx.lineWidth = it.layer.selected && !big ? 2 : 1.25; ctx.stroke();
        if (k > 0.05 && !big && it.layer.name.length < 22) { ctx.fillStyle = 'rgba(226,232,240,0.6)'; ctx.fillText(it.layer.name, cx, cy - 9); }
      }
    }

    function tracePath(ks, closed) {
      var i, a, b, p, c1, c2, n = ks.length, last = closed && n > 2 ? n : n - 1;
      if (!n) { return; }
      p = w2s(ks[0].p); ctx.moveTo(p[0], p[1]);
      for (i = 0; i < last; i++) {
        a = ks[i]; b = ks[(i + 1) % n];
        c1 = w2s(R.add(a.p, a.o)); c2 = w2s(R.add(b.p, b.i)); p = w2s(b.p);
        ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p[0], p[1]);
      }
    }

    function drawCamera(scene) {
      var cam = scene.cam, p, q, ang, half, len;
      if (!cam) { return; }
      p = w2s(cam.pos); q = w2s(cam.poi);
      ctx.strokeStyle = 'rgba(251,191,36,0.7)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); ctx.setLineDash([]);
      ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
      half = Math.atan(scene.comp.width / 2 / cam.zoom); len = 34;
      ctx.fillStyle = 'rgba(248,250,252,0.16)'; ctx.strokeStyle = 'rgba(248,250,252,0.8)';
      ctx.beginPath(); ctx.moveTo(p[0], p[1]);
      ctx.lineTo(p[0] + Math.cos(ang - half) * len, p[1] + Math.sin(ang - half) * len);
      ctx.lineTo(p[0] + Math.cos(ang + half) * len, p[1] + Math.sin(ang + half) * len);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#f8fafc'; ctx.beginPath(); ctx.arc(p[0], p[1], 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(251,191,36,0.95)'; ctx.beginPath(); ctx.arc(q[0], q[1], 4, 0, Math.PI * 2); ctx.stroke();
    }

    function draw() {
      resize();
      var scene = api.scene(), ks = keys(), ghost = api.ghost(), i, p, h, isSel, list = pts();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0a1220'; ctx.fillRect(0, 0, W, H);
      drawGrid(scene); drawFrame(scene); drawLayers(scene);

      if (ghost && ghost.keys.length) {
        ctx.strokeStyle = ghost.colour; ctx.globalAlpha = 0.45; ctx.lineWidth = 1.5;
        ctx.beginPath(); tracePath(ghost.keys, ghost.closed); ctx.stroke();
        for (i = 0; i < ghost.keys.length; i++) { p = w2s(ghost.keys[i].p); ctx.fillStyle = ghost.colour; ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, Math.PI * 2); ctx.fill(); }
        ctx.globalAlpha = 1;
      }

      ctx.strokeStyle = colour; ctx.lineWidth = 2.25; ctx.lineJoin = 'round';
      ctx.beginPath(); tracePath(ks, api.closed()); ctx.stroke();

      // handles of selected points
      for (i = 0; i < ks.length; i++) {
        if (sel.indexOf(i) < 0 || list[i].type === 'corner') { continue; }
        p = w2s(ks[i].p);
        ctx.strokeStyle = 'rgba(226,232,240,0.6)'; ctx.lineWidth = 1;
        [ks[i].i, ks[i].o].forEach(function (t) {
          if (R.len(t) < 1e-6) { return; }
          h = w2s(R.add(ks[i].p, t));
          ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(h[0], h[1]); ctx.stroke();
          ctx.fillStyle = list[i].type === 'auto' ? '#0a1220' : '#e2e8f0';
          ctx.beginPath(); ctx.arc(h[0], h[1], 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        });
      }
      // points
      ctx.font = '10px "Segoe UI", system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      for (i = 0; i < ks.length; i++) {
        p = w2s(ks[i].p); isSel = sel.indexOf(i) >= 0;
        ctx.lineWidth = 2; ctx.strokeStyle = colour; ctx.fillStyle = isSel ? colour : '#0a1220';
        ctx.beginPath();
        if (list[i].type === 'corner') { ctx.rect(p[0] - 4.5, p[1] - 4.5, 9, 9); } else { ctx.arc(p[0], p[1], 5, 0, Math.PI * 2); }
        ctx.fill(); ctx.stroke();
        if (hover && hover.kind === 'point' && hover.index === i) { ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p[0], p[1], 8.5, 0, Math.PI * 2); ctx.stroke(); }
        ctx.fillStyle = 'rgba(226,232,240,0.9)';
        ctx.fillText((i === 0 ? 'START ' : '') + (i + 1) + (list[i].pause > 0 ? '  ⏸' + list[i].pause + 's' : ''), p[0] + 8, p[1] - 6);
      }
      drawCamera(scene);

      if (drag && drag.kind === 'marquee') {
        ctx.strokeStyle = 'rgba(226,232,240,0.8)'; ctx.fillStyle = 'rgba(226,232,240,0.08)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.rect(drag.x0, drag.y0, drag.x1 - drag.x0, drag.y1 - drag.y0); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
      }
      if (drag && drag.kind === 'sketch' && drag.samples.length > 1) {
        ctx.strokeStyle = colour; ctx.globalAlpha = 0.7; ctx.lineWidth = 1.5; ctx.beginPath();
        for (i = 0; i < drag.samples.length; i++) { if (i) { ctx.lineTo(drag.samples[i][0], drag.samples[i][1]); } else { ctx.moveTo(drag.samples[i][0], drag.samples[i][1]); } }
        ctx.stroke(); ctx.globalAlpha = 1;
      }
      if (!list.length) {
        ctx.fillStyle = 'rgba(203,213,225,0.7)'; ctx.font = '12px "Segoe UI", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(tool === 'select' ? 'Choose the Pen or Sketch tool and draw a route here' : (tool === 'pen' ? 'Click to add points. Drag while clicking to pull out curve handles.' : 'Drag to sketch the route freehand'), W / 2, H / 2);
      }
    }

    /* -------------------------------------------------------- hit test */

    function hit(m) {
      var ks = keys(), list = pts(), i, p, h, best = null, d;
      for (i = 0; i < ks.length; i++) {
        if (sel.indexOf(i) < 0 || list[i].type === 'corner') { continue; }
        h = w2s(R.add(ks[i].p, ks[i].o));
        if (R.len(ks[i].o) > 1e-6 && Math.hypot(h[0] - m[0], h[1] - m[1]) < 8) { return { kind: 'handle', index: i, side: 'o' }; }
        h = w2s(R.add(ks[i].p, ks[i].i));
        if (R.len(ks[i].i) > 1e-6 && Math.hypot(h[0] - m[0], h[1] - m[1]) < 8) { return { kind: 'handle', index: i, side: 'i' }; }
      }
      for (i = ks.length - 1; i >= 0; i--) {
        p = w2s(ks[i].p); d = Math.hypot(p[0] - m[0], p[1] - m[1]);
        if (d < 9 && (!best || d < best.d)) { best = { kind: 'point', index: i, d: d }; }
      }
      return best;
    }
    /** Closest place on the drawn curve: { seg, t, d (px), w (world) } */
    function hitCurve(m) {
      var ks = keys(), n = ks.length, last = api.closed() && n > 2 ? n : n - 1, i, q, a, b, w, p, d, best = null;
      for (i = 0; i < last; i++) {
        a = ks[i]; b = ks[(i + 1) % n];
        for (q = 1; q < 40; q++) {
          w = R.bez(a.p, R.add(a.p, a.o), R.add(b.p, b.i), b.p, q / 40); p = w2s(w);
          d = Math.hypot(p[0] - m[0], p[1] - m[1]);
          if (!best || d < best.d) { best = { seg: i, t: q / 40, d: d, w: w }; }
        }
      }
      return best;
    }

    /* ------------------------------------------------------------ edits */

    function setSel(list) { sel = list; api.selection(sel.slice()); }
    function hiddenDefault() {
      // value for the axis this view cannot show: carry on from the last point, else the comp centre / Z = 0
      var list = pts(), v = V(), c = api.scene().comp;
      if (list.length) { return list[list.length - 1][AX[v.h]]; }
      return v.h === 1 ? c.height / 2 : (v.h === 0 ? c.width / 2 : 0);
    }
    function newPointAt(m) {
      var base = [0, 0, 0], w; base[V().h] = hiddenDefault();
      w = s2w(m[0], m[1], base);
      return R.point(Math.round(w[0]), Math.round(w[1]), Math.round(w[2]));
    }
    function makeBezier(i) {
      // freeze the automatic handles so they can be edited by hand
      var list = pts(), kk = keys()[i];
      if (list[i].type !== 'bezier') { list[i].type = 'bezier'; list[i].i = kk.i.slice(); list[i].o = kk.o.slice(); list[i].broken = false; }
    }

    function onDown(e) {
      canvas.focus();
      var m = mouse(e), h, list = pts(), c, p, i;
      if (e.button === 1 || e.button === 2 || spaceDown) { drag = { kind: 'pan', x: m[0], y: m[1], ox: ox, oy: oy }; e.preventDefault(); return; }
      if (e.button !== 0) { return; }
      h = hit(m);
      if (tool === 'sketch') { api.begin(); drag = { kind: 'sketch', samples: [m] }; return; }
      if (h && h.kind === 'handle') {
        api.begin(); makeBezier(h.index);
        drag = { kind: 'handle', index: h.index, side: h.side, alt: e.altKey, moved: false };
        return;
      }
      if (h && h.kind === 'point') {
        if (tool === 'pen' && h.index === 0 && list.length > 2 && !api.closed() && sel.length === 1 && sel[0] === list.length - 1 && api.canClose()) {
          api.begin(); api.close(true); api.commit('Close route'); setSel([0]); draw(); return;
        }
        if (e.shiftKey) { i = sel.indexOf(h.index); if (i >= 0) { sel.splice(i, 1); } else { sel.push(h.index); } setSel(sel); }
        else if (sel.indexOf(h.index) < 0) { setSel([h.index]); }
        api.begin();
        drag = { kind: 'move', x: m[0], y: m[1], start: list.map(function (q) { return [q.x, q.y, q.z]; }), moved: false };
        draw(); return;
      }
      if (tool === 'pen') {
        c = hitCurve(m);
        api.begin();
        if (c && c.d < 7) {
          p = R.point(Math.round(c.w[0]), Math.round(c.w[1]), Math.round(c.w[2]));
          list.splice(c.seg + 1, 0, p); setSel([c.seg + 1]);
          drag = { kind: 'move', x: m[0], y: m[1], start: list.map(function (q) { return [q.x, q.y, q.z]; }), moved: true, label: 'Insert point' };
        } else {
          p = newPointAt(m); list.push(p); setSel([list.length - 1]);
          drag = { kind: 'pull', index: list.length - 1, x: m[0], y: m[1], moved: false };
        }
        api.live(); draw(); return;
      }
      drag = { kind: 'marquee', x0: m[0], y0: m[1], x1: m[0], y1: m[1], add: e.shiftKey ? sel.slice() : [] };
    }

    function onMove(e) {
      var m = mouse(e), list = pts(), v = V(), i, p, w, base, d, o, other, L;
      if (!drag) {
        var h = hit(m), was = hover;
        hover = h;
        canvas.style.cursor = spaceDown ? 'grab' : (h ? 'move' : (tool === 'select' ? 'default' : 'crosshair'));
        if ((was && was.index) !== (h && h.index) || (was && was.kind) !== (h && h.kind)) { draw(); }
        return;
      }
      if (drag.kind === 'pan') { ox = drag.ox + m[0] - drag.x; oy = drag.oy + m[1] - drag.y; draw(); return; }
      if (drag.kind === 'marquee') {
        drag.x1 = m[0]; drag.y1 = m[1];
        var x0 = Math.min(drag.x0, drag.x1), x1 = Math.max(drag.x0, drag.x1), y0 = Math.min(drag.y0, drag.y1), y1 = Math.max(drag.y0, drag.y1), s = drag.add.slice();
        for (i = 0; i < list.length; i++) { p = w2s(R.pos(list[i])); if (p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1 && s.indexOf(i) < 0) { s.push(i); } }
        sel = s; draw(); return;
      }
      if (drag.kind === 'sketch') { p = drag.samples[drag.samples.length - 1]; if (Math.hypot(m[0] - p[0], m[1] - p[1]) > 2) { drag.samples.push(m); draw(); } return; }
      if (drag.kind === 'move') {
        var dx = (m[0] - drag.x) / k, dy = (m[1] - drag.y) / (k * v.bs);
        if (Math.abs(m[0] - drag.x) + Math.abs(m[1] - drag.y) > 2) { drag.moved = true; }
        if (e.shiftKey && !drag.label) { if (Math.abs(dx) > Math.abs(dy)) { dy = 0; } else { dx = 0; } }
        for (i = 0; i < sel.length; i++) {
          base = drag.start[sel[i]].slice(); base[v.a] += dx; base[v.b] += dy;
          list[sel[i]].x = Math.round(base[0]); list[sel[i]].y = Math.round(base[1]); list[sel[i]].z = Math.round(base[2]);
        }
        api.live(); draw(); return;
      }
      if (drag.kind === 'pull') {
        // pen: dragging after the click pulls symmetric handles out of the new point
        if (Math.hypot(m[0] - drag.x, m[1] - drag.y) < 5) { return; }
        drag.moved = true; L = list[drag.index];
        w = s2w(m[0], m[1], R.pos(L)); o = R.sub(w, R.pos(L));
        L.type = 'bezier'; L.o = o; L.i = R.mul(o, -1); L.broken = false;
        api.live(); draw(); return;
      }
      if (drag.kind === 'handle') {
        drag.moved = true; L = list[drag.index];
        base = R.add(R.pos(L), L[drag.side]);
        w = s2w(m[0], m[1], base); d = R.sub(w, R.pos(L));
        L[drag.side] = d;
        if (drag.alt || e.altKey) { L.broken = true; }
        if (!L.broken) {
          other = drag.side === 'o' ? 'i' : 'o';
          if (R.len(d) > 1e-6) { L[other] = R.mul(R.norm(d), -R.len(L[other])); }
        }
        api.live(); draw(); return;
      }
    }

    function onUp() {
      var d = drag, list = pts(), v = V(), i, simple, base, w, tolerance;
      drag = null;
      if (!d) { return; }
      if (d.kind === 'marquee') { setSel(sel); draw(); return; }
      if (d.kind === 'move') { if (d.moved) { api.commit(d.label || (sel.length > 1 ? 'Move points' : 'Move point')); } else { api.cancel(); } draw(); return; }
      if (d.kind === 'pull') { api.commit('Add point'); draw(); return; }
      if (d.kind === 'handle') { if (d.moved) { api.commit('Adjust curve'); } else { api.cancel(); } draw(); return; }
      if (d.kind === 'sketch') {
        if (d.samples.length < 3) { api.cancel(); draw(); return; }
        tolerance = 7;
        simple = R.simplify(d.samples, tolerance);
        base = [0, 0, 0]; base[v.h] = hiddenDefault();
        for (i = 0; i < simple.length; i++) { w = s2w(simple[i][0], simple[i][1], base); list.push(R.point(Math.round(w[0]), Math.round(w[1]), Math.round(w[2]))); }
        setSel([]); api.commit('Sketch route'); draw();
      }
    }

    function onWheel(e) {
      var m = mouse(e), f = Math.exp(-e.deltaY * 0.0015), nk = R.clamp(k * f, 0.002, 20);
      ox = m[0] - (m[0] - ox) * nk / k; oy = m[1] - (m[1] - oy) * nk / k; k = nk;
      e.preventDefault(); draw();
    }

    function onDouble(e) {
      var h = hit(mouse(e)), list = pts(), L;
      if (!h || h.kind !== 'point') { return; }
      L = list[h.index];
      api.begin();
      if (L.type === 'auto') { L.type = 'corner'; } else if (L.type === 'corner') { L.type = 'auto'; makeBezier(h.index); } else { L.type = 'auto'; }
      api.commit('Change point type'); draw();
    }

    function onKey(e) {
      var list = pts(), v = V(), step = (e.shiftKey ? 100 : 10), dx = 0, dy = 0, i, key = e.key, mod = e.ctrlKey || e.metaKey;
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) { return; }
      if (key === ' ') { spaceDown = e.type === 'keydown'; canvas.style.cursor = spaceDown ? 'grab' : 'default'; e.preventDefault(); return; }
      if (e.type !== 'keydown') { return; }
      if (mod && (key === 'z' || key === 'Z')) { if (e.shiftKey) { api.redo(); } else { api.undo(); } e.preventDefault(); return; }
      if (mod && (key === 'y' || key === 'Y')) { api.redo(); e.preventDefault(); return; }
      if (mod && (key === 'a' || key === 'A')) { setSel(list.map(function (q, n) { return n; })); draw(); e.preventDefault(); return; }
      if (mod) { return; }
      if (key === 'Delete' || key === 'Backspace') { self.removeSelected(); e.preventDefault(); return; }
      if (key === 'Escape') { setSel([]); draw(); return; }
      if (key === 'v' || key === 'V') { self.setTool('select'); return; }
      if (key === 'p' || key === 'P') { self.setTool('pen'); return; }
      if (key === 's' || key === 'S') { self.setTool('sketch'); return; }
      if (key === 'f' || key === 'F') { fit(); draw(); return; }
      if (key === '1') { self.setView('top'); return; }
      if (key === '2') { self.setView('front'); return; }
      if (key === '3') { self.setView('side'); return; }
      if (key === 'ArrowLeft') { dx = -step; } else if (key === 'ArrowRight') { dx = step; }
      else if (key === 'ArrowUp') { dy = -step * v.bs; } else if (key === 'ArrowDown') { dy = step * v.bs; }
      if ((dx || dy) && sel.length) {
        api.begin();
        for (i = 0; i < sel.length; i++) { list[sel[i]][AX[v.a]] += dx; list[sel[i]][AX[v.b]] += dy; }
        api.commit('Nudge points'); draw(); e.preventDefault();
      }
    }

    /** Frame the route, the comp frame and the layers. */
    function fit() {
      var scene = api.scene(), v = V(), all = [], i, j, a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity, p, list = pts(), g = api.ghost();
      measure();
      all.push([0, 0, 0], [scene.comp.width, scene.comp.height, 0]);
      for (i = 0; i < list.length; i++) { all.push(R.pos(list[i])); }
      if (g) { for (i = 0; i < g.keys.length; i++) { all.push(g.keys[i].p); } }
      // layer centres only: a huge floor or backdrop should not shrink the route to a dot
      for (i = 0; i < scene.items.length; i++) { p = [0, 0, 0]; for (j = 0; j < 4; j++) { p = R.add(p, R.mul(scene.items[i].corners[j], 0.25)); } all.push(p); }
      if (!list.length) { all.push([scene.comp.width / 2, scene.comp.height / 2, -scene.comp.width * 1.5], [scene.comp.width / 2, scene.comp.height / 2, scene.comp.width]); }
      for (i = 0; i < all.length; i++) { p = all[i]; a0 = Math.min(a0, p[v.a]); a1 = Math.max(a1, p[v.a]); b0 = Math.min(b0, p[v.b] * v.bs); b1 = Math.max(b1, p[v.b] * v.bs); }
      k = R.clamp(Math.min((W - 70) / Math.max(a1 - a0, 1), (H - 70) / Math.max(b1 - b0, 1)), 0.002, 20);
      ox = W / 2 - (a0 + a1) / 2 * k; oy = H / 2 - (b0 + b1) / 2 * k;
      fitted = W > 60;
    }

    /* ------------------------------------------------------------ public */

    this.draw = draw;
    this.fit = function () { fit(); draw(); };
    this.setTool = function (t) { tool = t; canvas.style.cursor = t === 'select' ? 'default' : 'crosshair'; api.toolChanged(t); draw(); };
    this.tool = function () { return tool; };
    this.setView = function (name) { if (VIEWS[name]) { view = name; fit(); api.viewChanged(name); draw(); } };
    this.view = function () { return view; };
    this.setColour = function (c) { colour = c; };
    this.selection = function () { return sel.slice(); };
    this.select = function (list) { setSel(list.filter(function (i) { return i >= 0 && i < pts().length; })); draw(); };
    this.removeSelected = function () {
      var list = pts(), i;
      if (!sel.length) { return; }
      api.begin();
      sel.slice().sort(function (a, b) { return b - a; }).forEach(function (n) { list.splice(n, 1); });
      if (list.length < 3 && api.closed()) { api.close(false); }
      setSel([]); api.commit('Delete points'); draw();
    };
    this.isDragging = function () { return !!drag; };

    canvas.tabIndex = 0;
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDouble);
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('keydown', onKey);
    canvas.addEventListener('keyup', onKey);
    canvas.addEventListener('blur', function () { spaceDown = false; });
    window.addEventListener('resize', function () { draw(); });
  }

  RC.Editor = Editor;
  RC.Editor.COLOURS = COL;
})();
