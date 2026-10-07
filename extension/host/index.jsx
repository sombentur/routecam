/*
 * Routecam - After Effects host script (ExtendScript, ES3).
 *
 * The panel does the geometry and timing (js/core/route.js) and calls this
 * file only to read and write After Effects objects.  Every public function
 * takes one plain object and returns one plain object; invoke() wraps the call
 * in a single undo group and converts to/from JSON.
 *
 * The rig (one per composition)
 *   RC Controller    null holding every control as an ordinary effect.  "Route
 *                    Progress" (0-100 %) carries all timing as keyframes.  The
 *                    route as edited in the panel is stored as JSON in this
 *                    layer's comment, so the project reopens with everything.
 *   RC Route Path    3D null whose POSITION KEYFRAMES are the route: spatial
 *                    Bezier tangents, linear in time, interior keys roving, so
 *                    time along the keys is distance along the path.  It is a
 *                    normal motion path and can be reshaped in the Composition
 *                    panel.
 *   RC Target Path   optional second path the camera looks at.
 *   RC Camera        two-node camera; position, point of interest, roll, zoom
 *                    and focus read the controller and paths through
 *                    expressions (mirrored by js/core/route.js for the preview).
 */
var RoutecamHost = (function () {
    var VERSION = "0.1.0";
    var TAG = "ROUTECAM:";
    var ANIM_TAG = "RCANIM:";
    var NAMES = { controller: "RC Controller", path: "RC Route Path", target: "RC Target Path", camera: "RC Camera" };
    var FX = {
        progress: "Route Progress", aimMode: "Aim Mode", lookAhead: "Look Ahead %", smooth: "Aim Smoothing %",
        trackLayer: "Track Layer", targetProgress: "Target Progress", roll: "Roll", bank: "Banking %", maxBank: "Max Bank",
        focal: "Focal Length (mm)", fstop: "F-Stop", focusMode: "Focus Mode", focusLayer: "Focus Layer",
        focusDistance: "Focus Distance", blur: "Blur Level %", start: "RC Start %", span: "RC Span %"
    };
    var AIM_ITEMS = ["Look Ahead", "Track Layer", "Target Path", "Manual"];
    var FOCUS_ITEMS = ["Aim Target", "Focus Layer", "Fixed Distance"];
    var THIRD = 100 / 3;

    /* ------------------------------------------------------------- JSON */

    function quote(s) {
        var out = '"', i, c, code;
        s = String(s);
        for (i = 0; i < s.length; i++) {
            c = s.charAt(i); code = s.charCodeAt(i);
            if (c === '"') { out += '\\"'; }
            else if (c === "\\") { out += "\\\\"; }
            else if (code === 10) { out += "\\n"; }
            else if (code === 13) { out += "\\r"; }
            else if (code === 9) { out += "\\t"; }
            else if (code < 32 || code > 126) { out += "\\u" + ("0000" + code.toString(16)).slice(-4); }
            else { out += c; }
        }
        return out + '"';
    }
    function stringify(v) {
        var i, parts, k;
        if (v === null || v === undefined) { return "null"; }
        if (typeof v === "number") { return isFinite(v) ? String(v) : "null"; }
        if (typeof v === "boolean") { return v ? "true" : "false"; }
        if (typeof v === "string") { return quote(v); }
        if (v instanceof Array) {
            parts = [];
            for (i = 0; i < v.length; i++) { parts.push(stringify(v[i])); }
            return "[" + parts.join(",") + "]";
        }
        if (typeof v === "object") {
            parts = [];
            for (k in v) {
                if (v.hasOwnProperty(k) && typeof v[k] !== "function" && v[k] !== undefined) { parts.push(quote(k) + ":" + stringify(v[k])); }
            }
            return "{" + parts.join(",") + "}";
        }
        return "null";
    }
    function parse(text) {
        // Input is JSON written by the panel (JSON.stringify) or by stringify() above, never user-typed code.
        return eval("(" + text + ")");
    }

    /* ---------------------------------------------------------- helpers */

    function fail(msg) { throw new Error(msg); }

    function getComp(args) {
        var c = null;
        if (args && args.compId) { try { c = app.project.itemByID(args.compId); } catch (e) { c = null; } }
        if (!(c instanceof CompItem)) { c = app.project.activeItem; }
        if (!(c instanceof CompItem)) { fail("Open a composition first (click its timeline or Composition panel)."); }
        return c;
    }
    function layerById(comp, id) {
        var L = null, i;
        if (!id) { return null; }
        try { L = app.project.layerByID(id); } catch (e) { L = null; }
        if (L) { try { if (L.containingComp.id === comp.id) { return L; } } catch (e2) {} }
        for (i = 1; i <= comp.numLayers; i++) { if (comp.layer(i).id === id) { return comp.layer(i); } }
        return null;
    }
    function layerByName(comp, name) {
        var i;
        for (i = 1; i <= comp.numLayers; i++) { if (comp.layer(i).name === name) { return comp.layer(i); } }
        return null;
    }
    function uniqueLayerName(comp, base) {
        var name = base, n = 2;
        while (layerByName(comp, name)) { name = base + " " + n; n++; }
        return name;
    }
    function tf(layer, matchName) { return layer.property("ADBE Transform Group").property(matchName); }
    function fxGroup(layer) { return layer.property("ADBE Effect Parade"); }
    function control(layer, name) {
        var f = fxGroup(layer).property(name);
        return f ? f.property(1) : null;
    }
    function clearKeys(prop) { while (prop.numKeys > 0) { prop.removeKey(prop.numKeys); } }
    function hasExpr(prop) { return prop.canSetExpression && prop.expression !== ""; }
    /** Panel-managed values never overwrite something the user has keyframed or driven by an expression. */
    function setIfFree(prop, v) { if (prop && prop.numKeys === 0 && !hasExpr(prop)) { prop.setValue(v); } }
    function setExpr(prop, code) {
        if (prop.expression !== code) { prop.expression = code; }
        prop.expressionEnabled = true;
        if (prop.expressionError && prop.expressionError !== "") { fail("Expression error on \"" + prop.name + "\": " + prop.expressionError); }
    }
    function ensureControl(layer, matchName, name, value) {
        var g = fxGroup(layer), f = g.property(name);
        if (!f) { f = g.addProperty(matchName); f.name = name; }
        // Re-fetch: adding effects invalidates earlier property references.
        if (value !== undefined) { setIfFree(control(layer, name), value); }
        return control(layer, name);
    }
    function ensureDropdown(layer, name, items, value) {
        var g = fxGroup(layer), f = g.property(name), p;
        if (!f) {
            f = g.addProperty("ADBE Dropdown Control");
            p = f.property(1).setPropertyParameters(items);
            p.propertyGroup(1).name = name;
        }
        if (value !== undefined) { setIfFree(control(layer, name), value); }
        return control(layer, name);
    }
    function ease1(e) { return [new KeyframeEase(e.s, Math.min(Math.max(e.f, 0.1), 100))]; }

    /* -------------------------------------------------------- rig lookup */

    function readState(layer) {
        var c = layer.comment;
        if (!c || c.indexOf(TAG) !== 0) { return null; }
        try { return parse(c.substring(TAG.length)); } catch (e) { return null; }
    }
    function findRig(comp) {
        var i, L, st, rig = null;
        for (i = 1; i <= comp.numLayers; i++) {
            L = comp.layer(i);
            if (L.comment && L.comment.indexOf(TAG) === 0) { st = readState(L); if (st) { rig = { controller: L, state: st }; break; } }
        }
        if (!rig) { return null; }
        // Stored ids survive renames; names are the fallback for duplicated compositions (ids change there).
        rig.path = layerById(comp, st.ids && st.ids.path) || layerByName(comp, NAMES.path);
        rig.camera = layerById(comp, st.ids && st.ids.camera) || layerByName(comp, NAMES.camera);
        rig.target = layerById(comp, st.ids && st.ids.target) || layerByName(comp, NAMES.target);
        if (rig.camera && !(rig.camera instanceof CameraLayer)) { rig.camera = null; }
        return rig;
    }

    function readPathKeys(layer) {
        var pos = tf(layer, "ADBE Position"), out = [], k, t0, t1, d;
        if (pos.numKeys === 0) { return [{ p: pos.value, i: [0, 0, 0], o: [0, 0, 0], f: 0 }]; }
        t0 = pos.keyTime(1); t1 = pos.keyTime(pos.numKeys); d = t1 - t0;
        for (k = 1; k <= pos.numKeys; k++) {
            out.push({ p: pos.keyValue(k), i: pos.keyInSpatialTangent(k), o: pos.keyOutSpatialTangent(k), f: d > 0 ? (pos.keyTime(k) - t0) / d : 0 });
        }
        return out;
    }

    /* ------------------------------------------------------- expressions */

    function exprHead(rig, loop) {
        return "var C = thisComp.layer(" + quote(rig.controller.name) + ");\n" +
               "var RL = thisComp.layer(" + quote(rig.path.name) + ");\n" +
               "function onPath(L, u) {\n" +
               "  var P = L.transform.position, n = P.numKeys, v, a, b;\n" +
               "  if (n < 2) { v = P.value; }\n" +
               "  else {\n" +
               "    var t0 = P.key(1).time, d = P.key(n).time - t0, e = 0.002;\n" +
               (loop ? "    if (u < 0 || u > 1) { u = u - Math.floor(u); }\n" : "") +
               "    if (u > 1) { a = P.valueAtTime(t0 + d); b = P.valueAtTime(t0 + d * (1 - e)); v = add(a, mul(sub(a, b), (u - 1) / e)); }\n" +
               "    else if (u < 0) { a = P.valueAtTime(t0); b = P.valueAtTime(t0 + d * e); v = add(a, mul(sub(a, b), -u / e)); }\n" +
               "    else { v = P.valueAtTime(t0 + d * u); }\n" +
               "  }\n" +
               "  return L.hasParent ? L.parent.toWorld(v) : v;\n" +
               "}\n" +
               "var u = clamp(C.effect(" + quote(FX.progress) + ")(1).value / 100, 0, 1);\n";
    }
    function ctl(name) { return "C.effect(" + quote(name) + ")(1)"; }

    function writeCameraExpressions(rig, loop) {
        var cam = rig.camera, head = exprHead(rig, loop), opt = cam.property("ADBE Camera Options Group");
        var targetName = rig.target ? rig.target.name : NAMES.target;
        setExpr(tf(cam, "ADBE Position"), "// Routecam: camera rides the route\n" + head + "onPath(RL, u);");
        setExpr(tf(cam, "ADBE Anchor Point"),
            "// Routecam: what the camera looks at\n" + head +
            "var mode = " + ctl(FX.aimMode) + ".value, r = null;\n" +
            "if (mode == 2) { try { var TL = " + ctl(FX.trackLayer) + "; try { r = TL.toWorld(TL.anchorPoint); } catch (e1) { r = TL.toWorld([0, 0, 0]); } } catch (e2) { r = null; } }\n" +
            "else if (mode == 3) { try { r = onPath(thisComp.layer(" + quote(targetName) + "), clamp(" + ctl(FX.targetProgress) + ".value / 100, 0, 1)); } catch (e3) { r = null; } }\n" +
            "else if (mode == 4) { r = value; }\n" +
            "if (r === null) {\n" +
            "  var la = Math.max(" + ctl(FX.lookAhead) + ".value / 100, 0.001);\n" +
            "  var sm = Math.min(Math.max(" + ctl(FX.smooth) + ".value / 100, 0), la * 0.9);\n" +
            "  var n = sm > 0 ? 5 : 1, s = [0, 0, 0];\n" +
            "  for (var i = 0; i < n; i++) { s = add(s, onPath(RL, u + la + (n > 1 ? (i / (n - 1) - 0.5) * 2 * sm : 0))); }\n" +
            "  r = div(s, n);\n" +
            "}\n" +
            "r;");
        setExpr(tf(cam, "ADBE Rotate Z"),
            "// Routecam: roll + banking into turns\n" + head +
            "var amt = " + ctl(FX.bank) + ".value / 100, mx = Math.abs(" + ctl(FX.maxBank) + ".value), b = 0;\n" +
            "if (amt != 0 && RL.transform.position.numKeys > 1) {\n" +
            "  var w = 0.03, A = onPath(RL, u - w), M = onPath(RL, u), B = onPath(RL, u + w);\n" +
            "  var ax = M[0] - A[0], az = M[2] - A[2], bx = B[0] - M[0], bz = B[2] - M[2];\n" +
            "  if (ax * ax + az * az > 0.000001 && bx * bx + bz * bz > 0.000001) {\n" +
            "    var dh = Math.atan2(bx, bz) - Math.atan2(ax, az);\n" +
            "    if (dh > Math.PI) { dh -= 2 * Math.PI; }\n" +
            "    if (dh < -Math.PI) { dh += 2 * Math.PI; }\n" +
            "    b = clamp(radiansToDegrees(dh) * amt, -mx, mx);\n" +
            "  }\n" +
            "}\n" +
            "value + " + ctl(FX.roll) + ".value + b;");
        var c = "var C = thisComp.layer(" + quote(rig.controller.name) + ");\n";
        setExpr(opt.property("ADBE Camera Zoom"), "// Routecam: focal length (36 mm film, measured horizontally)\n" + c +
            "thisComp.width * Math.max(" + ctl(FX.focal) + ".value, 1) / 36;");
        setExpr(opt.property("ADBE Camera Focus Distance"), "// Routecam: focus\n" + c +
            "var m = " + ctl(FX.focusMode) + ".value, r = null;\n" +
            "if (m == 2) { try { var FL = " + ctl(FX.focusLayer) + "; r = length(toWorld([0, 0, 0]), FL.toWorld(FL.anchorPoint)); } catch (e1) { r = null; } }\n" +
            "else if (m == 3) { r = " + ctl(FX.focusDistance) + ".value; }\n" +
            "if (r === null) { r = length(transform.position, transform.pointOfInterest); }\n" +
            "Math.max(r, 1);");
        setExpr(opt.property("ADBE Camera Aperture"), "// Routecam: aperture from F-Stop (After Effects converts mm to px at 72 px per inch)\n" + c +
            "Math.max(" + ctl(FX.focal) + ".value, 1) / Math.max(" + ctl(FX.fstop) + ".value, 0.1) * 72 / 25.4;");
        setExpr(opt.property("ADBE Camera Blur Level"), c + ctl(FX.blur) + ".value;");
    }

    var CAMERA_PROPS = [["T", "ADBE Position"], ["T", "ADBE Anchor Point"], ["T", "ADBE Rotate Z"],
                        ["C", "ADBE Camera Zoom"], ["C", "ADBE Camera Focus Distance"], ["C", "ADBE Camera Aperture"], ["C", "ADBE Camera Blur Level"]];
    function cameraProp(cam, spec) {
        return spec[0] === "T" ? tf(cam, spec[1]) : cam.property("ADBE Camera Options Group").property(spec[1]);
    }

    /* ------------------------------------------------------- write a path */

    /** keys: [{ p, i, o, f }]  f = route fraction.  Returns the fractions After Effects ends up with. */
    function writePath(layer, keys, span) {
        var pos = tf(layer, "ADBE Position"), times = [], values = [], k, n = keys.length, last = -1, t, out = [];
        if (pos.dimensionsSeparated) { pos.dimensionsSeparated = false; pos = tf(layer, "ADBE Position"); }
        if (hasExpr(pos)) { pos.expression = ""; }
        clearKeys(pos);
        if (n === 0) { return out; }
        if (n === 1) { pos.setValue(keys[0].p); return [0]; }
        for (k = 0; k < n; k++) {
            t = keys[k].f * span;
            if (t <= last) { t = last + span * 0.00001; }       // keys must not share a time
            times.push(t); values.push(keys[k].p); last = t;
        }
        pos.setValuesAtTimes(times, values);
        for (k = 1; k <= n; k++) {
            pos.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
            pos.setSpatialAutoBezierAtKey(k, false);
            pos.setSpatialContinuousAtKey(k, false);
            pos.setSpatialTangentsAtKey(k, keys[k - 1].i, keys[k - 1].o);
        }
        // Roving keeps the speed along the path constant even after the path is reshaped in the Composition panel.
        for (k = 2; k < n; k++) { pos.setRovingAtKey(k, true); }
        var t0 = pos.keyTime(1), d = pos.keyTime(n) - t0;
        for (k = 1; k <= n; k++) { out.push(d > 0 ? (pos.keyTime(k) - t0) / d : 0); }
        return out;
    }

    function ensurePathNull(comp, existing, name, label) {
        var L = existing;
        if (!L) {
            L = comp.layers.addNull(comp.duration);
            L.name = uniqueLayerName(comp, name);
            L.threeDLayer = true;
            L.guideLayer = true;
            L.label = label;
            L.startTime = 0;
        }
        if (!L.threeDLayer) { L.threeDLayer = true; }
        return L;
    }

    function writeProgressKeys(prop, keys, fractions) {
        var times = [], values = [], k, key, v;
        if (hasExpr(prop)) { prop.expression = ""; }
        clearKeys(prop);
        for (k = 0; k < keys.length; k++) {
            key = keys[k];
            // The value for a path point is the fraction After Effects itself reports for that key.
            v = (fractions && key.pt !== undefined && key.pt !== null && fractions[key.pt] !== undefined) ? fractions[key.pt] * 100 : key.v;
            times.push(key.t); values.push(v);
        }
        if (!times.length) { return; }
        if (times.length === 1) { prop.setValue(values[0]); return; }
        prop.setValuesAtTimes(times, values);
        for (k = 1; k <= keys.length; k++) {
            key = keys[k - 1];
            prop.setTemporalEaseAtKey(k, ease1(key.i), ease1(key.o));
            prop.setInterpolationTypeAtKey(k, key.linIn ? KeyframeInterpolationType.LINEAR : KeyframeInterpolationType.BEZIER,
                                              key.linOut ? KeyframeInterpolationType.LINEAR : KeyframeInterpolationType.BEZIER);
        }
    }
    /** Roll / focal length: keys at the moments the camera reaches the points that define a value (easy ease). */
    function writeScalar(prop, keys, base) {
        var times = [], values = [], k, e = [new KeyframeEase(0, THIRD)];
        if (hasExpr(prop)) { return; }
        clearKeys(prop);
        if (!keys || !keys.length) { prop.setValue(base); return; }
        if (keys.length === 1) { prop.setValue(keys[0].v); return; }
        for (k = 0; k < keys.length; k++) { times.push(keys[k].t); values.push(keys[k].v); }
        prop.setValuesAtTimes(times, values);
        for (k = 1; k <= keys.length; k++) { prop.setTemporalEaseAtKey(k, e, e); }
    }

    /* ------------------------------------------------------------ public */

    function ping() {
        return { version: app.version, host: VERSION, buildName: app.buildName };
    }

    var LABELS = [[102, 102, 102], [181, 56, 56], [228, 216, 76], [169, 203, 199], [229, 188, 201], [169, 169, 202], [231, 193, 158], [179, 199, 179],
                  [103, 125, 224], [74, 164, 76], [142, 44, 154], [232, 146, 13], [127, 69, 42], [244, 109, 214], [61, 162, 165], [168, 150, 119], [30, 64, 30]];

    function layerInfo(comp, L, t) {
        var kind = "av", info, tr = L.property("ADBE Transform Group"), rect, src;
        if (L instanceof CameraLayer) { kind = "camera"; }
        else if (L instanceof LightLayer) { kind = "light"; }
        else if (L instanceof ShapeLayer) { kind = "shape"; }
        else if (L instanceof TextLayer) { kind = "text"; }
        else if (L.nullLayer) { kind = "null"; }
        info = { id: L.id, index: L.index, name: L.name, kind: kind, threeD: !!L.threeDLayer, selected: L.selected, label: LABELS[L.label] || LABELS[0],
                 enabled: L.enabled, parent: L.parent ? L.parent.id : 0, anim: !!(L.comment && L.comment.indexOf(ANIM_TAG) >= 0),
                 rig: L.name.indexOf("RC ") === 0 };
        try {
            info.pos = tr.property("ADBE Position").valueAtTime(t, false);
            if (info.pos.length < 3) { info.pos = [info.pos[0], info.pos[1], 0]; }
            if (kind === "camera") { info.poi = tr.property("ADBE Anchor Point").valueAtTime(t, false); return info; }
            if (kind === "light") { return info; }
            info.anchor = tr.property("ADBE Anchor Point").valueAtTime(t, false);
            info.scale = tr.property("ADBE Scale").valueAtTime(t, false);
            info.rot = L.threeDLayer ? [tr.property("ADBE Rotate X").valueAtTime(t, false), tr.property("ADBE Rotate Y").valueAtTime(t, false), tr.property("ADBE Rotate Z").valueAtTime(t, false)]
                                     : [0, 0, tr.property("ADBE Rotate Z").valueAtTime(t, false)];
            info.ori = L.threeDLayer ? tr.property("ADBE Orientation").valueAtTime(t, false) : [0, 0, 0];
            if (kind === "shape" || kind === "text") {
                rect = L.sourceRectAtTime(t, false);
                info.rect = [rect.left, rect.top, rect.width, rect.height];
            } else {
                src = L.source;
                info.rect = [0, 0, L.width, L.height];
            }
        } catch (e) { info.pos = info.pos || [0, 0, 0]; }
        return info;
    }

    function selectedPathInfo(comp) {
        var p = findPathProp(comp);
        if (!p) { return null; }
        var owner = p.propertyGroup(p.propertyDepth), parent = p.parentProperty;
        return { layer: owner.name, name: parent ? parent.name : p.name, mask: p.matchName === "ADBE Mask Shape", threeD: !!owner.threeDLayer };
    }

    /** Everything the panel needs to draw the scene and to know whether a rig exists. */
    function getContext(args) {
        var comp = app.project.activeItem, out = { project: app.project.file ? app.project.file.fsName : "", comp: null, rig: null, layers: [] }, i, rig, cam;
        if (args && args.compId) { try { comp = app.project.itemByID(args.compId); } catch (e) {} }
        if (!(comp instanceof CompItem)) { return out; }
        out.comp = { id: comp.id, name: comp.name, width: comp.width, height: comp.height, fps: comp.frameRate, duration: comp.duration, time: comp.time,
                     workStart: comp.workAreaStart, workDuration: comp.workAreaDuration, renderer: comp.renderer };
        rig = findRig(comp);
        if (rig) {
            cam = rig.camera;
            out.rig = {
                controllerId: rig.controller.id, state: rig.state,
                pathKeys: rig.path ? readPathKeys(rig.path) : null,
                targetKeys: rig.target ? readPathKeys(rig.target) : null,
                hasCamera: !!cam, hasPath: !!rig.path,
                baked: !!(cam && tf(cam, "ADBE Position").numKeys > 0 && !tf(cam, "ADBE Position").expressionEnabled),
                progressKeys: control(rig.controller, FX.progress) ? control(rig.controller, FX.progress).numKeys : 0
            };
        }
        if (!args || !args.light) {
            for (i = 1; i <= comp.numLayers && i <= 400; i++) { out.layers.push(layerInfo(comp, comp.layer(i), comp.time)); }
            out.selectedPath = selectedPathInfo(comp);
        }
        return out;
    }

    /**
     * Create or update the rig from the panel's route.
     * args: { compId, state, loop, scope ('all' | 'path'), pathKeys, targetKeys, progressKeys, rollKeys, focalKeys, values }
     */
    function applyRoute(args) {
        var comp = getComp(args), rig = findRig(comp), v = args.values || {}, ctrl, path, target = null, cam, created = false, fr, span, st, L, opt;
        if (!args.pathKeys || args.pathKeys.length < 2) { fail("The route needs at least two points."); }
        span = Math.max(comp.duration - comp.frameDuration, comp.frameDuration * 2);

        if (!rig) {
            ctrl = comp.layers.addNull(comp.duration);
            ctrl.name = uniqueLayerName(comp, NAMES.controller);
            ctrl.label = 9; ctrl.startTime = 0; ctrl.guideLayer = true;
            tf(ctrl, "ADBE Position").setValue([80, 80]);
            rig = { controller: ctrl, state: {}, path: null, camera: null, target: null };
            created = true;
        }
        ctrl = rig.controller;
        var all = created || args.scope !== "path";

        // Controls (created once; values the user has keyframed in After Effects are left alone)
        ensureControl(ctrl, "ADBE Slider Control", FX.progress);
        ensureDropdown(ctrl, FX.aimMode, AIM_ITEMS, all ? v.aimMode : undefined);
        ensureControl(ctrl, "ADBE Slider Control", FX.lookAhead, all ? v.lookAhead : undefined);
        ensureControl(ctrl, "ADBE Slider Control", FX.smooth, all ? v.smooth : undefined);
        ensureControl(ctrl, "ADBE Layer Control", FX.trackLayer);
        ensureControl(ctrl, "ADBE Slider Control", FX.targetProgress);
        ensureControl(ctrl, "ADBE Slider Control", FX.roll);
        ensureControl(ctrl, "ADBE Slider Control", FX.bank, all ? v.bank : undefined);
        ensureControl(ctrl, "ADBE Slider Control", FX.maxBank, all ? v.maxBank : undefined);
        ensureControl(ctrl, "ADBE Slider Control", FX.focal);
        ensureControl(ctrl, "ADBE Slider Control", FX.fstop, all ? v.fstop : undefined);
        ensureDropdown(ctrl, FX.focusMode, FOCUS_ITEMS, all ? v.focusMode : undefined);
        ensureControl(ctrl, "ADBE Layer Control", FX.focusLayer);
        ensureControl(ctrl, "ADBE Slider Control", FX.focusDistance, all ? v.focusDistance : undefined);
        ensureControl(ctrl, "ADBE Slider Control", FX.blur, all ? v.blur : undefined);

        // Route path
        path = ensurePathNull(comp, rig.path, NAMES.path, 9);
        rig.path = path;
        fr = writePath(path, args.pathKeys, span);

        // Target path
        if (args.targetKeys && args.targetKeys.length) {
            target = ensurePathNull(comp, rig.target, NAMES.target, 11);
            writePath(target, args.targetKeys, span);
            rig.target = target;
        }

        if (all) {
            writeProgressKeys(control(ctrl, FX.progress), args.progressKeys, fr);
            writeScalar(control(ctrl, FX.roll), args.rollKeys, v.roll || 0);
            writeScalar(control(ctrl, FX.focal), args.focalKeys, v.focal || 35);
            L = layerById(comp, v.trackLayerId);
            setIfFree(control(ctrl, FX.trackLayer), L ? L.index : 0);
            L = layerById(comp, v.focusLayerId);
            setIfFree(control(ctrl, FX.focusLayer), L ? L.index : 0);
            var tp = control(ctrl, FX.targetProgress);
            if (v.targetLinked !== false) {
                clearKeys(tp);
                setExpr(tp, "// Routecam: the target moves in step with the camera\neffect(" + quote(FX.progress) + ")(1).value;");
            } else if (args.progressKeys && args.progressKeys.length > 1) {
                if (hasExpr(tp)) { tp.expression = ""; }
                if (tp.numKeys === 0) {
                    tp.setValuesAtTimes([args.progressKeys[0].t, args.progressKeys[args.progressKeys.length - 1].t], [0, 100]);
                }
            }
        }

        // Camera
        cam = rig.camera;
        if (!cam) {
            cam = comp.layers.addCamera(uniqueLayerName(comp, NAMES.camera), [comp.width / 2, comp.height / 2]);
            cam.autoOrient = AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
            cam.label = 9; cam.startTime = 0;
            rig.camera = cam;
        }
        if (cam.autoOrient !== AutoOrientType.CAMERA_OR_POINT_OF_INTEREST) { cam.autoOrient = AutoOrientType.CAMERA_OR_POINT_OF_INTEREST; }
        var baked = tf(cam, "ADBE Position").numKeys > 0 && !tf(cam, "ADBE Position").expressionEnabled;
        if (!baked || args.unbake) {
            if (args.unbake) { unbakeProps(cam); }
            writeCameraExpressions(rig, !!args.loop);
        }
        if (all) {
            opt = cam.property("ADBE Camera Options Group");
            try { opt.property("ADBE Camera Depth of Field").setValue(v.dof ? 1 : 0); } catch (eDof) {}
        }

        // Tidy stacking the first time: controller on top, then camera, then the paths.
        if (created) {
            if (target) { target.moveToBeginning(); }
            path.moveToBeginning(); cam.moveToBeginning(); ctrl.moveToBeginning();
        }

        st = args.state || {};
        st.ids = { path: path.id, camera: cam.id, target: rig.target ? rig.target.id : 0 };
        st.host = VERSION;
        ctrl.comment = TAG + stringify(st);
        return { compId: comp.id, created: created, controllerId: ctrl.id, cameraId: cam.id, pathId: path.id, fractions: fr,
                 baked: baked && !args.unbake, pathKeys: readPathKeys(path) };
    }

    function unbakeProps(cam) {
        var i, p;
        for (i = 0; i < CAMERA_PROPS.length; i++) {
            p = cameraProp(cam, CAMERA_PROPS[i]);
            clearKeys(p);
        }
    }

    /** Replace the camera's expressions with one keyframe per frame (for hand-off or render farms). */
    function bakeCamera(args) {
        var comp = getComp(args), rig = findRig(comp), cam, i, p, t, times = [], vals, k, fd = comp.frameDuration;
        if (!rig || !rig.camera) { fail("There is no Routecam camera in this composition yet."); }
        cam = rig.camera;
        var t0 = Math.max(0, Math.floor((args.start || 0) / fd) * fd), t1 = Math.min(comp.duration - fd, Math.ceil((args.end || comp.duration) / fd) * fd);
        for (t = t0; t <= t1 + fd / 2; t += fd) { times.push(t); }
        for (i = 0; i < CAMERA_PROPS.length; i++) {
            p = cameraProp(cam, CAMERA_PROPS[i]);
            if (!hasExpr(p) || !p.expressionEnabled) { continue; }
            vals = [];
            for (k = 0; k < times.length; k++) { vals.push(p.valueAtTime(times[k], false)); }
            p.expressionEnabled = false;
            clearKeys(p);
            p.setValuesAtTimes(times, vals);
        }
        return { frames: times.length };
    }
    /** Remove the baked keys and switch the live expressions back on. */
    function unbakeCamera(args) {
        var comp = getComp(args), rig = findRig(comp);
        if (!rig || !rig.camera || !rig.path) { fail("There is no Routecam camera in this composition yet."); }
        unbakeProps(rig.camera);
        writeCameraExpressions(rig, !!(rig.state && rig.state.closed));
        return { ok: true };
    }

    function removeRig(args) {
        var comp = getComp(args), rig = findRig(comp), n = 0;
        if (!rig) { return { removed: 0 }; }
        if (rig.camera) { rig.camera.remove(); n++; }
        if (rig.target) { rig.target.remove(); n++; }
        if (rig.path) { rig.path.remove(); n++; }
        rig.controller.remove(); n++;
        return { removed: n };
    }

    function setTime(args) {
        var comp = getComp(args);
        comp.time = Math.max(0, Math.min(args.time, comp.duration - comp.frameDuration));
        return { time: comp.time };
    }

    /* --------------------------------------------- masks and shape paths */

    function firstShapePath(group) {
        var i, p, r;
        for (i = 1; i <= group.numProperties; i++) {
            p = group.property(i);
            if (p.matchName === "ADBE Vector Shape - Group") { return p.property("ADBE Vector Shape"); }
            if (p.propertyType !== PropertyType.PROPERTY) { r = firstShapePath(p); if (r) { return r; } }
        }
        return null;
    }
    function findPathProp(comp) {
        var sp = comp.selectedProperties, i, p, L, masks, r;
        for (i = 0; i < sp.length; i++) {
            p = sp[i];
            if (p.propertyType === PropertyType.PROPERTY && p.propertyValueType === PropertyValueType.SHAPE) { return p; }
        }
        for (i = 0; i < sp.length; i++) {
            p = sp[i];
            if (p.matchName === "ADBE Mask Atom") { return p.property("ADBE Mask Shape"); }
            if (p.matchName === "ADBE Vector Shape - Group") { return p.property("ADBE Vector Shape"); }
            if (p.matchName === "ADBE Vector Group") { r = firstShapePath(p); if (r) { return r; } }
        }
        var layers = comp.selectedLayers;
        for (i = 0; i < layers.length; i++) {
            L = layers[i];
            masks = L.property("ADBE Mask Parade");
            if (masks && masks.numProperties > 0) { return masks.property(1).property("ADBE Mask Shape"); }
            if (L instanceof ShapeLayer) { r = firstShapePath(L.property("ADBE Root Vectors Group")); if (r) { return r; } }
        }
        return null;
    }

    /** Shape-group transforms between a path and its layer (anchor, position, scale, rotation; skew is ignored). */
    function groupChain(pathProp, t) {
        var chain = [], g = pathProp.parentProperty, tr;
        while (g && g.propertyDepth > 0) {
            if (g.matchName === "ADBE Vector Group") {
                tr = g.property("ADBE Vector Transform Group");
                if (tr) {
                    chain.push({ a: tr.property("ADBE Vector Anchor").valueAtTime(t, false), p: tr.property("ADBE Vector Position").valueAtTime(t, false),
                                 s: tr.property("ADBE Vector Scale").valueAtTime(t, false), r: tr.property("ADBE Vector Rotation").valueAtTime(t, false) * Math.PI / 180 });
                }
            }
            g = g.parentProperty;
        }
        return chain;
    }
    function applyChain(chain, pt) {
        var i, c, x = pt[0], y = pt[1], dx, dy, cs, sn;
        for (i = 0; i < chain.length; i++) {
            c = chain[i];
            dx = (x - c.a[0]) * c.s[0] / 100; dy = (y - c.a[1]) * c.s[1] / 100;
            cs = Math.cos(c.r); sn = Math.sin(c.r);
            x = dx * cs - dy * sn + c.p[0]; y = dx * sn + dy * cs + c.p[1];
        }
        return [x, y];
    }

    /**
     * Read the selected mask or shape path and return it in composition space.
     * The layer-to-world conversion is done by After Effects itself (one
     * temporary text layer with a toWorld() expression), so parenting, 3D
     * rotation and anchor points are all honoured.
     */
    function importPath(args) {
        var comp = getComp(args), prop = findPathProp(comp), shape, owner, chain, pts = [], n, i, v, a, b, tl, doc, text, rows, out = [], c, w = [];
        if (!prop) { fail("Select a mask or a shape path first. For a rectangle, ellipse or star, right-click its path and choose Convert To Bezier Path."); }
        owner = prop.propertyGroup(prop.propertyDepth);
        shape = prop.valueAtTime(comp.time, false);
        n = shape.vertices.length;
        if (n < 2) { fail("That path has fewer than two points."); }
        chain = prop.matchName === "ADBE Mask Shape" ? [] : groupChain(prop, comp.time);
        for (i = 0; i < n; i++) {
            v = shape.vertices[i]; a = shape.inTangents[i]; b = shape.outTangents[i];
            pts.push(applyChain(chain, v));
            pts.push(applyChain(chain, [v[0] + a[0], v[1] + a[1]]));
            pts.push(applyChain(chain, [v[0] + b[0], v[1] + b[1]]));
        }
        // Remember the selection by id / index: adding the temporary layer clears it and invalidates object references.
        var list = [], selIds = [], hadProps = comp.selectedProperties.length > 0, trail = [], walk = prop, ownerId = owner.id;
        for (i = 0; i < comp.selectedLayers.length; i++) { selIds.push(comp.selectedLayers[i].id); }
        while (walk && walk.propertyDepth > 0) { trail.unshift(walk.propertyIndex); walk = walk.parentProperty; }
        for (i = 0; i < pts.length; i++) { list.push("[" + pts[i][0] + "," + pts[i][1] + ",0]"); }
        tl = comp.layers.addText("routecam");
        try {
            doc = tl.property("ADBE Text Properties").property("ADBE Text Document");
            doc.expression = "var L = thisComp.layer(" + layerById(comp, ownerId).index + ");\nvar pts = [" + list.join(",") + "];\nvar out = [];\n" +
                             "for (var i = 0; i < pts.length; i++) { var w = L.toWorld(pts[i]); out.push(w[0] + \",\" + w[1] + \",\" + (w.length > 2 ? w[2] : 0)); }\n" +
                             "out.join(\";\");";
            if (doc.expressionError && doc.expressionError !== "") { fail("After Effects could not convert that path: " + doc.expressionError); }
            text = doc.value.text;
        } finally {
            tl.remove();
            // Adding the temporary layer cleared the selection; put it back as it was.
            try {
                for (i = 0; i < selIds.length; i++) { walk = layerById(comp, selIds[i]); if (walk) { walk.selected = true; } }
                if (hadProps) {
                    walk = layerById(comp, ownerId);
                    for (i = 0; walk && i < trail.length - 1; i++) { walk = walk.property(trail[i]); }
                    if (walk) { walk.selected = true; }
                }
            } catch (eSel) {}
        }
        rows = String(text).split(";");
        if (rows.length !== pts.length) { fail("After Effects returned an unexpected result while converting the path."); }
        for (i = 0; i < rows.length; i++) { c = rows[i].split(","); w.push([parseFloat(c[0]), parseFloat(c[1]), parseFloat(c[2])]); }
        for (i = 0; i < n; i++) {
            out.push({ p: w[i * 3],
                       i: [w[i * 3 + 1][0] - w[i * 3][0], w[i * 3 + 1][1] - w[i * 3][1], w[i * 3 + 1][2] - w[i * 3][2]],
                       o: [w[i * 3 + 2][0] - w[i * 3][0], w[i * 3 + 2][1] - w[i * 3][1], w[i * 3 + 2][2] - w[i * 3][2]] });
        }
        return { keys: out, closed: !!shape.closed, layer: owner.name, threeD: !!owner.threeDLayer,
                 name: prop.parentProperty ? prop.parentProperty.name : prop.name, compWidth: comp.width, compHeight: comp.height };
    }

    /* ---------------------------------------------------- layer animation */

    function readAnim(layer) {
        var c = layer.comment || "", at = c.indexOf(ANIM_TAG);
        if (at < 0) { return null; }
        try { return parse(c.substring(at + ANIM_TAG.length)); } catch (e) { return null; }
    }
    function writeAnim(layer, meta) {
        var c = layer.comment || "", at = c.indexOf(ANIM_TAG);
        if (at >= 0) { c = c.substring(0, at); }
        layer.comment = meta ? c + ANIM_TAG + stringify(meta) : c.replace(/\s+$/, "");
    }
    function animatable(L) { return !(L instanceof CameraLayer) && !(L instanceof LightLayer); }

    /** The transform properties Routecam animates on a layer, with their current (rest) values. */
    function restOf(L) {
        var tr = L.property("ADBE Transform Group"), pos = tr.property("ADBE Position"), r = { sep: !!pos.dimensionsSeparated };
        if (r.sep) {
            r.position = [tr.property("ADBE Position_0").value, tr.property("ADBE Position_1").value, L.threeDLayer ? tr.property("ADBE Position_2").value : 0];
        } else { r.position = pos.value; }
        r.rotation = L.threeDLayer ? [tr.property("ADBE Rotate X").value, tr.property("ADBE Rotate Y").value, tr.property("ADBE Rotate Z").value] : [0, 0, tr.property("ADBE Rotate Z").value];
        r.scale = tr.property("ADBE Scale").value;
        r.opacity = tr.property("ADBE Opacity").value;
        return r;
    }
    function managedProps(L, rest) {
        var tr = L.property("ADBE Transform Group"), list = [];
        if (rest.sep) {
            list.push({ p: tr.property("ADBE Position_0"), rest: rest.position[0], kind: "px" });
            list.push({ p: tr.property("ADBE Position_1"), rest: rest.position[1], kind: "py" });
            if (L.threeDLayer) { list.push({ p: tr.property("ADBE Position_2"), rest: rest.position[2], kind: "pz" }); }
        } else { list.push({ p: tr.property("ADBE Position"), rest: rest.position, kind: "pos" }); }
        if (L.threeDLayer) {
            list.push({ p: tr.property("ADBE Rotate X"), rest: rest.rotation[0], kind: "rx" });
            list.push({ p: tr.property("ADBE Rotate Y"), rest: rest.rotation[1], kind: "ry" });
        }
        list.push({ p: tr.property("ADBE Rotate Z"), rest: rest.rotation[2], kind: "rz" });
        list.push({ p: tr.property("ADBE Scale"), rest: rest.scale, kind: "scale" });
        list.push({ p: tr.property("ADBE Opacity"), rest: rest.opacity, kind: "opacity" });
        return list;
    }
    /** Put a layer back exactly as it was before Routecam animated it. */
    function restoreRest(L, meta) {
        var list = managedProps(L, meta.rest), i, m, used = meta.props || [], j, isUsed, g, f;
        for (i = 0; i < list.length; i++) {
            m = list[i]; isUsed = false;
            for (j = 0; j < used.length; j++) { if (used[j] === m.kind) { isUsed = true; } }
            if (!isUsed) { continue; }
            if (hasExpr(m.p)) { m.p.expression = ""; }
            clearKeys(m.p);
            m.p.setValue(m.rest);
        }
        g = fxGroup(L);
        if (g) { f = g.property(FX.start); if (f) { f.remove(); } f = fxGroup(L).property(FX.span); if (f) { f.remove(); } }
    }

    function offsetValue(kind, rest, a, is3D) {
        // "from" state of an in-animation (the layer's rest values plus the preset's offsets)
        var s = a.scale / 100, v, i;
        if (kind === "pos") { return rest.length > 2 ? [rest[0] + a.pos[0], rest[1] + a.pos[1], rest[2] + a.pos[2]] : [rest[0] + a.pos[0], rest[1] + a.pos[1]]; }
        if (kind === "px") { return rest + a.pos[0]; }
        if (kind === "py") { return rest + a.pos[1]; }
        if (kind === "pz") { return rest + a.pos[2]; }
        if (kind === "rx") { return rest + a.rot[0]; }
        if (kind === "ry") { return rest + a.rot[1]; }
        if (kind === "rz") { return rest + a.rot[2]; }
        if (kind === "scale") { v = []; for (i = 0; i < rest.length; i++) { v.push(rest[i] * s); } return v; }
        if (kind === "opacity") { return rest * a.opacity / 100; }
        return rest;
    }
    function isActive(kind, a, is3D) {
        if (kind === "pos") { return a.pos[0] !== 0 || a.pos[1] !== 0 || (is3D && a.pos[2] !== 0); }
        if (kind === "px") { return a.pos[0] !== 0; }
        if (kind === "py") { return a.pos[1] !== 0; }
        if (kind === "pz") { return a.pos[2] !== 0; }
        if (kind === "rx") { return a.rot[0] !== 0; }
        if (kind === "ry") { return a.rot[1] !== 0; }
        if (kind === "rz") { return a.rot[2] !== 0; }
        if (kind === "scale") { return a.scale !== 100; }
        if (kind === "opacity") { return a.opacity !== 100; }
        return false;
    }
    function mix(a, b, f) {
        var v, i;
        if (a instanceof Array) { v = []; for (i = 0; i < a.length; i++) { v.push(a[i] + (b[i] - a[i]) * f); } return v; }
        return a + (b - a) * f;
    }
    function easeFor(prop, influence) {
        var n = 1, out = [], i;
        if (!prop.isSpatial && prop.value instanceof Array) { n = prop.value.length; }
        for (i = 0; i < n; i++) { out.push(new KeyframeEase(0, Math.min(Math.max(influence, 0.1), 100))); }
        return out;
    }
    /** Two keys (or three with overshoot) from one state to another, eased. */
    function writeAnimKeys(prop, t0, t1, from, to, a) {
        var times = [t0, t1], vals = [from, to], over = (a.ease === "back" && a.overshoot > 0), n, k, zero;
        if (over) { times = [t0, t0 + (t1 - t0) * 0.62, t1]; vals = [from, mix(to, from, -a.overshoot / 100), to]; }
        prop.setValuesAtTimes(times, vals);
        n = times.length;
        if (prop.isSpatial) {
            zero = (from instanceof Array && from.length > 2) ? [0, 0, 0] : [0, 0];
            for (k = 1; k <= n; k++) { prop.setSpatialAutoBezierAtKey(k, false); prop.setSpatialContinuousAtKey(k, false); prop.setSpatialTangentsAtKey(k, zero, zero); }
        }
        if (a.ease === "linear") {
            for (k = 1; k <= n; k++) { prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR); }
            return;
        }
        var soft = easeFor(prop, 75), firm = easeFor(prop, 0.1), mid = easeFor(prop, 45);
        if (over) {
            prop.setTemporalEaseAtKey(1, firm, firm);
            prop.setTemporalEaseAtKey(2, soft, mid);
            prop.setTemporalEaseAtKey(3, mid, firm);
        } else if (a.ease === "in") {
            prop.setTemporalEaseAtKey(1, firm, soft); prop.setTemporalEaseAtKey(2, firm, firm);
        } else if (a.ease === "inout") {
            prop.setTemporalEaseAtKey(1, firm, mid); prop.setTemporalEaseAtKey(2, mid, firm);
        } else {
            prop.setTemporalEaseAtKey(1, firm, firm); prop.setTemporalEaseAtKey(2, soft, firm);
        }
    }

    /**
     * Animate layers with keyframes, optionally driven by camera progress.
     * args: { compId, anim: { direction, pos, rot, scale, opacity, ease, overshoot, name }, make3D,
     *         layers: [{ id, t0, t1, startPct, spanPct }] }
     * A layer with startPct gets "RC Start %" / "RC Span %" controls and an
     * expression that plays its own keyframes against Route Progress, so the
     * keyframes stay editable and the timing follows the camera.
     */
    function animateLayers(args) {
        var comp = getComp(args), a = args.anim, rig = findRig(comp), done = [], skipped = [], i, j, item, L, meta, rest, list, m, from, to, used, sync, expr, fd = comp.frameDuration;
        if (!args.layers || !args.layers.length) { fail("Choose at least one layer to animate."); }
        for (i = 0; i < args.layers.length; i++) {
            item = args.layers[i];
            L = layerById(comp, item.id);
            if (!L || !animatable(L) || (rig && (L === rig.controller || L === rig.path || L === rig.target))) { skipped.push(item.id); continue; }
            if (L.locked) { skipped.push(item.id); continue; }
            meta = readAnim(L);
            if (meta && meta.rest) { restoreRest(L, meta); }
            if (args.make3D && !L.threeDLayer) { L.threeDLayer = true; }
            rest = restOf(L);
            list = managedProps(L, rest);
            sync = item.startPct !== null && item.startPct !== undefined && !!rig;
            used = [];
            if (sync) {
                ensureControl(L, "ADBE Slider Control", FX.start, item.startPct);
                control(L, FX.start).setValue(item.startPct);
                ensureControl(L, "ADBE Slider Control", FX.span, item.spanPct);
                control(L, FX.span).setValue(item.spanPct);
                expr = "// Routecam: plays this property's own keyframes against camera progress\n" +
                       "var C = thisComp.layer(" + quote(rig.controller.name) + ");\n" +
                       "var p = C.effect(" + quote(FX.progress) + ")(1).value;\n" +
                       "var a = effect(" + quote(FX.start) + ")(1).value, s = Math.max(effect(" + quote(FX.span) + ")(1).value, 0.001);\n" +
                       "var ph = clamp((p - a) / s, 0, 1);\n" +
                       "numKeys > 1 ? valueAtTime(key(1).time + (key(numKeys).time - key(1).time) * ph) : value;";
                list = managedProps(L, rest);      // adding effects invalidated the property references
            }
            var t0 = Math.round(item.t0 / fd) * fd, t1 = Math.max(Math.round(item.t1 / fd) * fd, t0 + fd);
            for (j = 0; j < list.length; j++) {
                m = list[j];
                if (!isActive(m.kind, a, L.threeDLayer)) { continue; }
                from = offsetValue(m.kind, m.rest, a, L.threeDLayer); to = m.rest;
                if (a.direction === "out") { to = from; from = m.rest; }
                if (hasExpr(m.p)) { m.p.expression = ""; }
                clearKeys(m.p);
                writeAnimKeys(m.p, t0, t1, from, to, a);
                if (sync) { setExpr(m.p, expr); }
                used.push(m.kind);
            }
            writeAnim(L, { v: 1, rest: rest, props: used, sync: sync, name: a.name || "" });
            done.push({ id: L.id, name: L.name, t0: t0, t1: t1, sync: sync });
        }
        return { animated: done, skipped: skipped };
    }

    function removeLayerAnimation(args) {
        var comp = getComp(args), i, L, meta, n = 0, ids = args.ids || [];
        if (!ids.length) { for (i = 1; i <= comp.numLayers; i++) { if (args.all || comp.layer(i).selected) { ids.push(comp.layer(i).id); } } }
        for (i = 0; i < ids.length; i++) {
            L = layerById(comp, ids[i]);
            if (!L) { continue; }
            meta = readAnim(L);
            if (!meta || !meta.rest) { continue; }
            restoreRest(L, meta);
            writeAnim(L, null);
            n++;
        }
        return { removed: n };
    }

    /* -------------------------------------------------------- sample scene */

    /**
     * Build the layers of the demo composition (the panel then applies its
     * sample route and layer animation through the normal functions above).
     */
    function buildSampleScene(args) {
        var w = 1920, h = 1080, comp, bg, floor, fx, i, card, txt, doc, td, cards = [], x, z, side;
        var palette = [[0.04, 0.72, 0.56], [0.98, 0.76, 0.24], [0.94, 0.38, 0.36], [0.30, 0.56, 0.96], [0.72, 0.46, 0.94]];
        comp = app.project.items.addComp(args.name || "Routecam Sample - Curved Flight", w, h, 1, 12, 30);
        bg = comp.layers.addSolid([0.03, 0.06, 0.12], "Sky", w, h, 1);
        fx = bg.property("ADBE Effect Parade").addProperty("ADBE Ramp");
        try {
            fx.property("ADBE Ramp-0001").setValue([w / 2, 0]);
            fx.property("ADBE Ramp-0002").setValue([0.02, 0.04, 0.09, 1]);
            fx.property("ADBE Ramp-0003").setValue([w / 2, h]);
            fx.property("ADBE Ramp-0004").setValue([0.07, 0.16, 0.27, 1]);
        } catch (eRamp) { /* cosmetic only */ }

        floor = comp.layers.addSolid([0.05, 0.10, 0.17], "Floor", 4000, 4000, 1);
        floor.threeDLayer = true;
        floor.label = 14;
        tf(floor, "ADBE Rotate X").setValue(-90);
        tf(floor, "ADBE Position").setValue([w / 2, 900, 3000]);
        tf(floor, "ADBE Scale").setValue([160, 320, 100]);
        fx = floor.property("ADBE Effect Parade").addProperty("ADBE Grid");
        try {
            fx.property("ADBE Grid-0001").setValue([2000, 2000]);
            fx.property("ADBE Grid-0002").setValue(3);                 // size from: width and height sliders
            fx.property("ADBE Grid-0004").setValue(125);
            fx.property("ADBE Grid-0005").setValue(62.5);
            fx.property("ADBE Grid-0006").setValue(3);
            fx.property("ADBE Grid-0012").setValue([0.10, 0.62, 0.50, 1]);
            fx.property("ADBE Grid-0014").setValue(2);                 // blending: add onto the floor colour
        } catch (eGrid) { /* cosmetic only */ }

        for (i = 0; i < 10; i++) {
            side = i % 2 === 0 ? -1 : 1;
            x = w / 2 + side * 540; z = 500 + i * 760;
            card = comp.layers.addSolid(palette[i % palette.length], "Card " + (i < 9 ? "0" : "") + (i + 1), 480, 300, 1);
            card.threeDLayer = true;
            tf(card, "ADBE Position").setValue([x, 640, z]);
            tf(card, "ADBE Rotate Y").setValue(side * 28);
            card.label = 10 + (i % 5);
            txt = comp.layers.addText((i < 9 ? "0" : "") + (i + 1));
            txt.name = "Label " + (i < 9 ? "0" : "") + (i + 1);
            doc = txt.property("ADBE Text Properties").property("ADBE Text Document");
            td = doc.value;
            td.fontSize = 150; td.fillColor = [0.03, 0.07, 0.13]; td.applyFill = true; td.applyStroke = false;
            try { td.justification = ParagraphJustification.CENTER_JUSTIFY; } catch (eJ) {}
            doc.setValue(td);
            txt.threeDLayer = true;
            tf(txt, "ADBE Position").setValue([x, 690, z - 2]);
            tf(txt, "ADBE Rotate Y").setValue(side * 28);
            txt.parent = card;
            cards.push({ id: card.id, index: card.index, pos: [x, 640, z] });
        }
        bg.moveToEnd();
        comp.openInViewer();
        return { compId: comp.id, cards: cards };
    }

    /** Render one frame of the composition to a PNG (used for the "frame from After Effects" preview). */
    function grabFrame(args) {
        var comp = getComp(args), f = new File(args.path), t = args.time === undefined ? comp.time : args.time;
        if (f.exists) { f.remove(); }
        comp.saveFrameToPng(t, f);
        return { path: f.fsName, exists: f.exists, time: t };
    }

    /** Values of the rig at given times (used by the automated tests and the "check against After Effects" readout). */
    function sampleRig(args) {
        var comp = getComp(args), rig = findRig(comp), out = [], i, t, cam, opt;
        if (!rig || !rig.camera) { fail("No Routecam camera in this composition."); }
        cam = rig.camera; opt = cam.property("ADBE Camera Options Group");
        for (i = 0; i < args.times.length; i++) {
            t = args.times[i];
            out.push({ t: t, progress: control(rig.controller, FX.progress).valueAtTime(t, false),
                       pos: tf(cam, "ADBE Position").valueAtTime(t, false), poi: tf(cam, "ADBE Anchor Point").valueAtTime(t, false),
                       rotZ: tf(cam, "ADBE Rotate Z").valueAtTime(t, false), zoom: opt.property("ADBE Camera Zoom").valueAtTime(t, false),
                       focus: opt.property("ADBE Camera Focus Distance").valueAtTime(t, false), aperture: opt.property("ADBE Camera Aperture").valueAtTime(t, false) });
        }
        return { samples: out };
    }

    /* ---------------------------------------------------------- dispatch */

    var api = { ping: ping, getContext: getContext, applyRoute: applyRoute, bakeCamera: bakeCamera, unbakeCamera: unbakeCamera, removeRig: removeRig,
                setTime: setTime, importPath: importPath, animateLayers: animateLayers, removeLayerAnimation: removeLayerAnimation,
                buildSampleScene: buildSampleScene, grabFrame: grabFrame, sampleRig: sampleRig };
    var UNDO = { applyRoute: "Routecam: Apply Route", bakeCamera: "Routecam: Bake Camera", unbakeCamera: "Routecam: Restore Live Camera",
                 removeRig: "Routecam: Remove Rig", importPath: "Routecam: Read Path", animateLayers: "Routecam: Animate Layers",
                 removeLayerAnimation: "Routecam: Remove Layer Animation", buildSampleScene: "Routecam: Build Sample Scene" };

    function invoke(fn, json) {
        var result, undo = UNDO[fn];
        try {
            if (!api[fn]) { fail("Unknown host function: " + fn); }
            if (undo) { app.beginUndoGroup(undo); }
            try { result = api[fn](parse(json)); }
            finally { if (undo) { app.endUndoGroup(); } }
            return stringify({ ok: true, result: result });
        } catch (e) {
            return stringify({ ok: false, error: e.message || String(e), line: e.line });
        }
    }
    function invokeFile(fn, path) {
        var f = new File(path), json;
        f.encoding = "UTF-8";
        if (!f.open("r")) { return stringify({ ok: false, error: "Could not read arguments file." }); }
        json = f.read(); f.close();
        return invoke(fn, json);
    }

    return { version: VERSION, invoke: invoke, invokeFile: invokeFile };
})();
