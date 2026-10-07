# Routecam: architecture and API notes

Checked in October 2026 against After Effects 26.5 (CEP 12.0.1, Chromium 99) on Windows 11.

## Choosing the platform

| Option | Status for After Effects | Verdict |
| --- | --- | --- |
| **CEP panel + ExtendScript** | Supported. Adobe's September 2026 roadmap: no new CEP submissions from December 2028, CEP removed from December 2029. ExtendScript itself "is not affected by this transition". | **Used.** The only way today to ship a rich HTML panel that can also script After Effects. |
| **UXP plugin** | Public beta for After Effects announced for November 2026; not in release builds. | Not usable yet. The split below (pure JS core, thin host layer) is meant to make a later port cheap. |
| **ScriptUI panel (.jsx)** | Supported. | Rejected: ScriptUI has no usable canvas for a path editor with draggable Bezier handles. |
| **C++ plug-in (effect / AEGP)** | Supported. | Rejected as the main vehicle: needs a compiler toolchain and per-platform binaries. It is the only route to drawing in the Composition panel (see below), and even then only as an effect's own controls. |

Sources: [Adobe developer blog, UXP roadmap](https://blog.developer.adobe.com/en/publish/2026/09/investing-in-the-future-of-creative-cloud-extensibility-uxp-comes-to-our-flagship-applications), [After Effects scripting guide: Property](https://ae-scripting.docsforadobe.dev/property/property/), [After Effects SDK: effect UI and events](https://ae-plugins.docsforadobe.dev/effect-ui-events/effect-ui-events/).

## Drawing in the Composition panel

Neither CEP, UXP nor ExtendScript exposes the Composition panel as a drawing or input surface. The SDK documentation is explicit that custom UI there belongs to effect plug-ins: effects "can provide custom UI in two areas: (1) the Effect Controls Window, and (2) the Composition or Layer Windows", and for the latter "when the effect is selected, the Window can overlay custom controls directly on the video". There is no API for adding a tool to the toolbar or for a free-standing overlay.

So Routecam:

1. has its own editor (`js/editor.js`, an HTML canvas);
2. reads paths drawn with After Effects' native Pen tool (masks and shape paths);
3. writes the route as position keyframes with spatial Bezier tangents on a null, which After Effects displays and lets the user edit as a motion path in the Composition panel.

## ExtendScript APIs relied on, all exercised by `tests/ae-e2e.mjs`

| Need | API | Note |
| --- | --- | --- |
| Route as a native path | `Property.setValuesAtTimes`, `setSpatialTangentsAtKey`, `setSpatialAutoBezierAtKey`, `setSpatialContinuousAtKey` | Spatial tangents are Bezier handle offsets, so the panel's curve and the motion path are the same curve. |
| Constant speed | `Property.setRovingAtKey` on interior keys, linear temporal interpolation on the ends | Key time then equals distance along the path. After Effects' own roving agreed with the panel's arc-length table to 2 parts in a million. First and last keys cannot rove (documented). |
| Timing | `setTemporalEaseAtKey` with `KeyframeEase(speed, influence)`, `setInterpolationTypeAtKey` | The panel evaluates the same speed/influence Bezier; progress matched to 0.0003 %. |
| Controls | Slider, Layer and Dropdown Menu controls; `setPropertyParameters` for menu items | Dropdown items need After Effects 17.0.1 or later. Expressions address controls by index, not by display name, so they survive other UI languages. |
| Camera | `layers.addCamera`, `AutoOrientType.CAMERA_OR_POINT_OF_INTEREST`, match names `ADBE Camera Zoom`, `ADBE Camera Focus Distance`, `ADBE Camera Aperture`, `ADBE Camera Blur Level`, `ADBE Camera Depth of Field` | Zoom (px) = comp width x focal length / 36. Aperture (px) = focal length / F-stop x 72 / 25.4, which reproduces After Effects' default 50 mm, f/5.6, 25.3 px camera. Depth of Field has no stopwatch, so it is set as a value. |
| Reading paths | `PropertyValueType.SHAPE`, `Shape.vertices / inTangents / outTangents / closed` | Layer-to-world conversion is delegated to After Effects through one temporary text layer whose Source Text expression calls `toWorld()`. The selection is restored afterwards. |
| Undo | `app.beginUndoGroup / endUndoGroup` around every host call | One panel action is one Edit > Undo step. |
| Persistence | `Layer.comment` on the controller | 10,538 characters (an 80-point route) survived save, close and reopen unchanged. |
| Stable references | `Layer.id`, `app.project.layerByID` | After Effects 22.0 or later, hence the manifest's minimum version. |
| Real frame in the panel | `CompItem.saveFrameToPng` | Not in the public scripting guide, but present and working in 26.5. The panel falls back to a message if no file appears. |
| Panel keyboard input | `__adobe_cep__.registerKeyEventsInterest` | Not covered by the automated tests. |

## Layout

```
extension/
  CSXS/manifest.xml       panel registration (After Effects 22+, Node enabled)
  index.html, css/        panel markup and styling
  js/core/route.js        geometry, arc length, timing, camera solver (no DOM, no AE; unit tested)
  js/core/presets.js      built-in shapes, animation presets, layer scheduling, sample route
  js/preview.js           layer transform maths and the schematic camera view
  js/editor.js            the path editor
  js/platform.js          the only file that touches CEP and Node
  js/app.js               state, undo stack, controls, calls into After Effects
  host/index.jsx          ExtendScript: builds and reads After Effects objects
tests/unit                node --test
tests/ae-e2e.mjs          drives the panel inside After Effects over CEP's debug port (8199)
```

## The rig

- **RC Route Path** (3D null). Position keys are the route. `valueAtTime(t0 + (t1 - t0) * u)` returns the point at fraction `u` of the route's length. If the null is parented, the expressions convert through `parent.toWorld()`, so the whole route can be moved, rotated or scaled by parenting it.
- **RC Controller** (null). "Route Progress" holds the timing. Constant speed is two linear keys; a key is added only where a pause or a speed change needs one. The route as edited in the panel is stored as JSON in the layer comment.
- **RC Camera**. Expressions on Position, Point of Interest, Z Rotation, Zoom, Focus Distance, Aperture and Blur Level read the controller and the paths. Past the end of the route the look-ahead target is extended in a straight line, so the camera never collapses onto its own target.

`js/core/route.js` implements the same formulas as these expressions; `solve()` is what the preview draws. The end-to-end test compares the two at dozens of times per route.

Layer animation writes plain keyframes. For camera-linked timing each property also gets

```
valueAtTime(key(1).time + (key(numKeys).time - key(1).time) * phase)
```

where `phase` is how far Route Progress is through that layer's "RC Start %" to "RC Start % + RC Span %" window. The layer's rest values are stored in its comment so the animation can be replaced or removed exactly.

## Coordinate conventions (measured, not assumed)

- X right, Y down, Z into the screen.
- A layer's rotation matrix is orientation x (Rx . Ry . Rz), with Z applied to the layer first. Positive Y rotation turns the X axis towards negative Z.
- Positive camera Z rotation dips the right-hand side of the camera, i.e. banks right.

## Developing

```
npm test                         route maths
npm run preview                  the panel in a browser with a stand-in scene (http://localhost:5179)
scripts/install.ps1 -Dev         link extension/ into After Effects instead of copying
npm run test:ae -- --keep        end-to-end tests; needs an empty, unsaved project (--reset discards the open one)
npm run build                    dist/Routecam-<version>.zip
```

Two traps: `node --check` cannot see ExtendScript-only errors, so use `node tests/load-host.mjs` against a running After Effects; and `$.evalFile` must be called at the top level of the evaluated script, because inside a function the file's `var RoutecamHost` becomes a local and the old host stays in use.

## Not done yet

- macOS testing.
- More than one route per composition.
- A live link from a mask to the route.
- Port to UXP once After Effects ships it.
