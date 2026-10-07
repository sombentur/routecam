/*
 * Routecam - scene geometry shared by the editor and the camera preview, and
 * the perspective preview itself (a schematic of what the After Effects camera
 * sees: layers as coloured outlines, the route, a ground grid).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./core/route.js')); }
  else { root.RC = root.RC || {}; root.RC.scene = factory(root.RC.route); }
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  /* ---------------------------------------------- layer transforms (3x4) */

  // After Effects axes: X right, Y down, Z into the screen.  Rotation signs
  // were checked against layer.toWorld() in After Effects (tests/ae-e2e.mjs).
  function rotX(d) { var a = d * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; }
  function rotY(d) { var a = d * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; }
  function rotZ(d) { var a = d * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; }
  function mul3(a, b) {
    var o = [], r, c;
    for (r = 0; r < 3; r++) { for (c = 0; c < 3; c++) { o.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]); } }
    return o;
  }
  function apply3(m, v) { return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]; }

  /** Rotation of a layer: orientation, then X, Y and Z rotation (Z is applied to the layer first). */
  function layerRotation(ori, rot) {
    var o = mul3(mul3(rotX(ori[0]), rotY(ori[1])), rotZ(ori[2]));
    var r = mul3(mul3(rotX(rot[0]), rotY(rot[1])), rotZ(rot[2]));
    return mul3(o, r);
  }

  /** { m: 3x3, t: [x,y,z] } taking layer-space points to the parent's space. */
  function localMatrix(L) {
    var sc = L.scale || [100, 100, 100], an = L.anchor || [0, 0, 0], rot = layerRotation(L.ori || [0, 0, 0], L.rot || [0, 0, 0]);
    var S = [sc[0] / 100, 0, 0, 0, sc[1] / 100, 0, 0, 0, (sc.length > 2 ? sc[2] : 100) / 100];
    var m = mul3(rot, S), a = apply3(m, [an[0], an[1], an.length > 2 ? an[2] : 0]);
    return { m: m, t: [L.pos[0] - a[0], L.pos[1] - a[1], (L.pos[2] || 0) - a[2]] };
  }
  function worldMatrix(L, byId, depth) {
    var loc = localMatrix(L), P;
    if (!L.parent || !byId || !byId[L.parent] || (depth || 0) > 20) { return loc; }
    P = worldMatrix(byId[L.parent], byId, (depth || 0) + 1);
    return { m: mul3(P.m, loc.m), t: R.add(apply3(P.m, loc.t), P.t) };
  }
  function toWorld(M, p) { return R.add(apply3(M.m, [p[0], p[1], p[2] || 0]), M.t); }

  function index(layers) { var o = {}, i; for (i = 0; i < layers.length; i++) { o[layers[i].id] = layers[i]; } return o; }

  /** World position of a layer's anchor point (what "Track Layer" aims at). */
  function layerWorldPos(L, byId) {
    if (!L) { return null; }
    if (L.kind === 'camera' || L.kind === 'light') { return [L.pos[0], L.pos[1], L.pos[2] || 0]; }
    var an = L.anchor || [0, 0, 0];
    return toWorld(worldMatrix(L, byId), [an[0], an[1], an.length > 2 ? an[2] : 0]);
  }
  /** Four world-space corners of a drawable 3D layer, or null. */
  function corners(L, byId) {
    if (!L.rect || L.kind === 'camera' || L.kind === 'light' || L.kind === 'null' || !L.threeD) { return null; }
    var r = L.rect, M = worldMatrix(L, byId);
    return [toWorld(M, [r[0], r[1], 0]), toWorld(M, [r[0] + r[2], r[1], 0]), toWorld(M, [r[0] + r[2], r[1] + r[3], 0]), toWorld(M, [r[0], r[1] + r[3], 0])];
  }
  /** Layers worth drawing: visible 3D layers that are not part of the rig. */
  function drawable(layers) {
    var byId = index(layers), out = [], i, c;
    for (i = 0; i < layers.length; i++) {
      if (layers[i].rig || layers[i].enabled === false) { continue; }
      c = corners(layers[i], byId);
      if (c) { out.push({ layer: layers[i], corners: c, size: Math.max(R.dist(c[0], c[2]), R.dist(c[1], c[3])) }); }
    }
    return out;
  }

  /* ------------------------------------------------------ camera preview */

  var NEAR = 4;
  function clipPolygon(pts) {
    // Sutherland-Hodgman against the near plane, in camera space
    var out = [], i, a, b, t;
    for (i = 0; i < pts.length; i++) {
      a = pts[i]; b = pts[(i + 1) % pts.length];
      if (a[2] >= NEAR) { out.push(a); }
      if ((a[2] >= NEAR) !== (b[2] >= NEAR)) { t = (NEAR - a[2]) / (b[2] - a[2]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]); }
    }
    return out;
  }
  function clipSegment(a, b) {
    var t;
    if (a[2] < NEAR && b[2] < NEAR) { return null; }
    if (a[2] < NEAR) { t = (NEAR - a[2]) / (b[2] - a[2]); a = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]; }
    else if (b[2] < NEAR) { t = (NEAR - b[2]) / (a[2] - b[2]); b = [b[0] + (a[0] - b[0]) * t, b[1] + (a[1] - b[1]) * t, NEAR]; }
    return [a, b];
  }
  function rgba(c, a) { return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + a + ')'; }

  /**
   * Draw the camera's view.
   *   cam    result of route.solve()
   *   scene  { comp: { width, height }, items: drawable(layers), table, ttable, keys, groundY }
   */
  function drawCamera(canvas, cam, scene, opts) {
    opts = opts || {};
    var ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height, cw = scene.comp.width, ch = scene.comp.height;
    var k = W / cw, basis = R.cameraBasis(cam), g, i, j, it, pts, c, p, seg, a, b;
    function scr(c3) { return [W / 2 + cam.zoom * c3[0] / c3[2] * k, H / 2 + cam.zoom * c3[1] / c3[2] * k]; }
    function line(w0, w1) {
      seg = clipSegment(R.toCamera(cam, basis, w0), R.toCamera(cam, basis, w1));
      if (!seg) { return; }
      a = scr(seg[0]); b = scr(seg[1]);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }

    g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#060d1a'); g.addColorStop(1, '#0f2338');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();

    // ground grid, centred under the camera
    var step = opts.gridStep || 500, n = 14, gy = scene.groundY, x0 = Math.round(cam.pos[0] / step) * step, z0 = Math.round(cam.pos[2] / step) * step;
    ctx.lineWidth = Math.max(1, W / 900); ctx.strokeStyle = 'rgba(52,211,153,0.16)';
    ctx.beginPath();
    for (i = -n; i <= n; i++) {
      line([x0 + i * step, gy, z0 - n * step], [x0 + i * step, gy, z0 + n * step]);
      line([x0 - n * step, gy, z0 + i * step], [x0 + n * step, gy, z0 + i * step]);
    }
    ctx.stroke();

    // layers, far to near
    var items = [];
    for (i = 0; i < scene.items.length; i++) {
      it = scene.items[i]; pts = [];
      for (j = 0; j < 4; j++) { pts.push(R.toCamera(cam, basis, it.corners[j])); }
      items.push({ it: it, pts: pts, depth: (pts[0][2] + pts[1][2] + pts[2][2] + pts[3][2]) / 4 });
    }
    items.sort(function (p1, p2) { return p2.depth - p1.depth; });
    ctx.lineJoin = 'round';
    for (i = 0; i < items.length; i++) {
      pts = clipPolygon(items[i].pts);
      if (pts.length < 3) { continue; }
      c = items[i].it.layer.label || [120, 140, 170];
      ctx.beginPath();
      for (j = 0; j < pts.length; j++) { p = scr(pts[j]); if (j) { ctx.lineTo(p[0], p[1]); } else { ctx.moveTo(p[0], p[1]); } }
      ctx.closePath();
      // floors and backdrops (much larger than the frame) are drawn faintly so they do not hide the scene
      var big = items[i].it.size > cw * 2.5;
      ctx.fillStyle = rgba(c, big ? 0.06 : (items[i].it.layer.selected ? 0.5 : 0.3)); ctx.fill();
      ctx.lineWidth = Math.max(1, W / 700); ctx.strokeStyle = rgba(c, big ? 0.35 : 0.95); ctx.stroke();
    }

    // the route ahead, and the target path
    function path(table, colour, loop) {
      if (!table || table.empty || table.total <= 0) { return; }
      ctx.beginPath();
      var prev = R.tablePoint(table, 0), cur, q, steps = 160;
      for (q = 1; q <= steps; q++) { cur = R.tablePoint(table, q / steps); line(prev, cur); prev = cur; }
      ctx.strokeStyle = colour; ctx.lineWidth = Math.max(1.25, W / 520); ctx.stroke();
    }
    path(scene.ttable, 'rgba(251,191,36,0.75)');
    path(scene.table, 'rgba(52,211,153,0.9)');

    // what the camera is aiming at
    p = R.project(cam, basis, cam.poi, cw, ch);
    if (p && opts.showAim !== false) {
      ctx.strokeStyle = 'rgba(251,191,36,0.95)'; ctx.lineWidth = Math.max(1, W / 700);
      var r = Math.max(5, W / 90);
      ctx.beginPath(); ctx.arc(p[0] * k, p[1] * k, r, 0, Math.PI * 2);
      ctx.moveTo(p[0] * k - r * 1.7, p[1] * k); ctx.lineTo(p[0] * k + r * 1.7, p[1] * k);
      ctx.moveTo(p[0] * k, p[1] * k - r * 1.7); ctx.lineTo(p[0] * k, p[1] * k + r * 1.7);
      ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = 'rgba(226,232,240,0.85)';
    ctx.font = Math.max(10, Math.round(W / 42)) + 'px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillText(Math.round(cam.focal) + ' mm   roll ' + cam.rotZ.toFixed(1) + '°   ' + (cam.u * 100).toFixed(1) + ' %', Math.round(W / 60), H - Math.round(H / 40));
  }

  return { rotX: rotX, rotY: rotY, rotZ: rotZ, mul3: mul3, apply3: apply3, layerRotation: layerRotation, localMatrix: localMatrix, worldMatrix: worldMatrix,
           toWorld: toWorld, index: index, layerWorldPos: layerWorldPos, corners: corners, drawable: drawable, drawCamera: drawCamera, rgba: rgba };
});
