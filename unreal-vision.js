'use strict';

/**
 * unreal-vision.js — look at what is actually in the Unreal level.
 *
 * There are TWO ways to get a picture out of Unreal, and they are not interchangeable.
 * Picking the wrong one is why a working call can look broken (measured 2026-07-31):
 *
 *   'viewport' — unreal.AutomationLibrary.take_high_res_screenshot()
 *      Pretty: the real editor viewport with its full post-processing, bloom included.
 *      ⛔ Needs the Unreal WINDOW IN THE FOREGROUND. Not merely visible — foreground. When it is
 *      not, the call returns normally, prints nothing, and writes no file AND NO LOG LINE.
 *      Turning off `Slate.bAllowThrottling` keeps the editor rendering in the background (frame
 *      counter measured racing from 43k to 115k) but does NOT make this path work unfocused.
 *
 *   'camera' — a SceneCapture2D actor rendering into a TextureRenderTarget2D  ← the default
 *      Works regardless of which window the operator is using, because it is a camera IN THE
 *      LEVEL and owes nothing to the editor viewport.
 *      ⚠️ Honest limit: it does NOT carry the viewport's post-processing. Side by side, the
 *      capture is darker and emissive materials do not bloom — the Gravinium glow that is
 *      obvious in a viewport shot is simply absent here. So: fine for CHECKING (is it there, is
 *      it placed right, does it have material, is it broken), wrong for judging how it LOOKS.
 *
 * ⇒ Default to 'camera'. Reach for 'viewport' only when the question is about beauty, and only
 *   when the operator is actually in Unreal.
 *
 * 🪤 Two traps that both produce a file and still fail:
 *   - create_render_target2d(None, …) swallows the missing world context and returns None.
 *     Pass the editor world.
 *   - WITHOUT RTF_RGBA8 the export writes an OpenEXR carrying a .png name (magic 76 2f 31 01).
 *     It has a plausible size and is not a PNG. The default target format is 16-bit float.
 *   - export_render_target() returns None on success. Do not test its return value; test the file.
 */

const fs   = require('fs');
const path = require('path');

const unrealIpc = require('./unreal-ipc');

const CAMERA_LABEL = 'PHX_Kamera';           // the standing vision camera in the level
const DEFAULT_DIR  = path.join(__dirname, 'output');

// Horizontal FOV of the vision camera, in degrees. Set EXPLICITLY rather than left at Unreal's
// default, because the framing distance is derived from it — a camera whose FOV we only assume
// would silently reframe every shot the day that default changes.
const FOV_DEG = 50;

// Same guard as brush-to-unreal.js: the bridge reduces a Python exception to a bare
// "command failed" with empty output, so every script carries its own traceback printer.
function guarded(bodyLines) {
  return [
    'import unreal, traceback',
    'try:',
    ...bodyLines.map(l => '    ' + l),
    'except Exception as _e:',
    '    print("PHX_PY_ERROR:", type(_e).__name__, _e)',
    '    traceback.print_exc()',
  ].join('\n');
}

async function run(bodyLines, cfg, timeoutMs = 120000) {
  const r = await unrealIpc.callUnreal(guarded(bodyLines), { cfg, timeoutMs });
  const out = String(r.stdout || '').trim();
  if (r.status !== 'ok' && !out) throw new Error(`Unreal: ${r.message || 'command failed (no output)'}`);
  if (out.includes('PHX_PY_ERROR')) throw new Error(`Unreal Python error:\n${out}`);
  return out;
}

const py = v => JSON.stringify(v);

/**
 * Render the level to a PNG on disk and return its path.
 *
 * @param {object} o
 * @param {object} [o.cfg]        phoenix config (the bridge needs it to find the engine)
 * @param {string} [o.mode]       'camera' (default) | 'viewport'
 * @param {string} [o.focus]      actor label to frame; the camera is placed off its bounds
 * @param {number[]} [o.location] [x,y,z] explicit camera position (wins over focus)
 * @param {number[]} [o.rotation] [pitch,yaw,roll] — named, so the Rotator argument order cannot bite
 * @param {number} [o.width=1280]
 * @param {number} [o.height=720]
 * @param {string} [o.outFile]    absolute path for the PNG
 */
async function captureUnreal(o = {}) {
  const cfg    = o.cfg;
  const mode   = o.mode === 'viewport' ? 'viewport' : 'camera';
  const width  = o.width  || 1280;
  const height = o.height || 720;
  const outAbs = o.outFile || path.join(DEFAULT_DIR, 'unreal-check.png');
  const outDir = path.dirname(outAbs);
  const outName = path.basename(outAbs);

  fs.mkdirSync(outDir, { recursive: true });
  try { fs.unlinkSync(outAbs); } catch (_) {}   // so a stale file cannot pass as this run's result

  // Where to put the camera. With `focus`, sit back from the actor's bounds so the whole thing
  // fits; the offset is derived from its size rather than guessed, because a 10 cm part and a
  // 3 m assembly need very different distances.
  const place = o.location
    ? [
        'loc = unreal.Vector(' + Number(o.location[0]) + ', ' + Number(o.location[1]) + ', ' + Number(o.location[2]) + ')',
        'rot = unreal.Rotator(roll=' + Number((o.rotation || [0, 90, 0])[2]) + ', pitch=' + Number((o.rotation || [0, 90, 0])[0]) + ', yaw=' + Number((o.rotation || [0, 90, 0])[1]) + ')',
      ]
    : o.focus
      ? [
          'tgt = [a for a in eas.get_all_level_actors() if a.get_actor_label() == ' + py(o.focus) + ']',
          'if not tgt:',
          '    raise RuntimeError("no actor labelled " + ' + py(o.focus) + ')',
          '# 🪤 get_actor_bounds() on a PARENT does NOT include attached child actors. A brush root',
          '# is an empty Actor, so asking it alone returns extent ~0 and the camera ends up sitting',
          '# inside the object (measured 2026-07-31: framing the condensator gave a close-up of its',
          '# base). Union the whole tree instead.',
          '# 🪤 …and the walk must be RECURSIVE, not one level. Nesting depth varies per brush:',
          '# gravinium_condensator is root→meshes (2 levels), oak_tree_a is root→world→geometry_0',
          '# (3). A one-level walk found only empties for the tree and reported "no bounds" — which',
          '# reads like a broken import when the import was fine.',
          'def _descend(a):',
          '    out = [a]',
          '    for c in a.get_attached_actors():',
          '        out.extend(_descend(c))',
          '    return out',
          'tree = _descend(tgt[0])',
          'lo = [None, None, None]',
          'hi = [None, None, None]',
          'for a in tree:',
          '    o_, e_ = a.get_actor_bounds(False)',
          '    if float(e_.x) == 0.0 and float(e_.y) == 0.0 and float(e_.z) == 0.0:',
          '        continue',
          '    for i, (c, e) in enumerate(((o_.x, e_.x), (o_.y, e_.y), (o_.z, e_.z))):',
          '        lo[i] = c - e if lo[i] is None else min(lo[i], c - e)',
          '        hi[i] = c + e if hi[i] is None else max(hi[i], c + e)',
          'if lo[0] is None:',
          '    raise RuntimeError("actor " + ' + py(o.focus) + ' + " and its children have no bounds")',
          'ctr   = [(lo[i] + hi[i]) / 2.0 for i in range(3)]',
          'half  = [(hi[i] - lo[i]) / 2.0 for i in range(3)]',
          '# Distance from the FIELD OF VIEW, not a rule of thumb. The previous version backed off',
          '# a fixed multiple of the largest half-extent and tilted down slightly — which framed a',
          '# squat object fine and clipped every tall one off the top ("cap clipped, camera sits low',
          '# and close", reported three times running, 2026-07-31).',
          '# Looking along +Y: screen-horizontal is X, screen-vertical is Z. Each axis needs its own',
          '# distance, and the FARTHER of the two is the one that fits both.',
          'import math',
          'fov_h = ' + FOV_DEG + '.0',
          'aspect = ' + (width / height).toFixed(6),
          'th = math.tan(math.radians(fov_h) / 2.0)',
          'tv = math.tan(math.atan(th / aspect))',
          'need_w = max(half[0], 1.0) / th',
          'need_v = max(half[2], 1.0) / tv',
          'dist = max(need_w, need_v, 25.0) * 1.25',      // 25 % air so nothing touches the edge
          '# Camera at the CENTRE height looking level — an object is centred in frame only if the',
          '# camera points at its middle, not at its base.',
          'loc = unreal.Vector(ctr[0], ctr[1] - dist, ctr[2])',
          'rot = unreal.Rotator(roll=0.0, pitch=0.0, yaw=90.0)',
          'print("PHX_FRAME: dist", round(dist, 1), "centre", [round(v, 1) for v in ctr], "half", [round(v, 1) for v in half])',
        ]
      : [
          'loc, rot = ues.get_level_viewport_camera_info()',
        ];

  if (mode === 'viewport') {
    const shotName = 'phx-unreal-view.png';
    // Unreal writes its own Screenshots file, which we cannot delete up front (we do not know the
    // folder until it tells us). So stamp the request time and accept the file only if it is NEWER —
    // otherwise a stale shot from a previous capture (e.g. one that silently wrote nothing because
    // the window was not focused) passes as this run's render, and the vision seat judges an old image.
    const requestedAt = Date.now();
    const dirOut = await run([
      'ues = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)',
      'eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
      ...place,
      // 🪤 UnrealEditorSubsystem takes (location, rotation). LevelEditorSubsystem's same-named
      // method needs a third argument in 5.8 and raises without it.
      'ues.set_level_viewport_camera_info(loc, rot)',
      'unreal.AutomationLibrary.take_high_res_screenshot(' + width + ', ' + height + ', ' + py(shotName) + ')',
      'import os',
      // 🪤 project_saved_dir() is relative to the ENGINE BINARIES dir, not to the caller. Handed
      // over raw it reads "../../../../../../Users/..." and resolves, from Phoenix, to nothing —
      // so the poll below would always time out and blame the window focus for a path bug.
      // convert_relative_path_to_full() is what makes it a real path.
      'shotdir = unreal.Paths.convert_relative_path_to_full(os.path.join(unreal.Paths.project_saved_dir(), "Screenshots", "WindowsEditor"))',
      'print("PHX_SHOTDIR:", shotdir)',
    ], cfg);

    const m = dirOut.match(/^PHX_SHOTDIR:\s*(.+)$/m);
    if (!m) throw new Error('Unreal did not report its screenshot folder.');
    const shotAbs = path.join(m[1].trim(), shotName);

    // The request is NOT the result. Unreal writes at end of frame, and when its window is not in
    // the FOREGROUND it silently writes nothing at all — no error, no log line. Earlier this
    // function returned "requested" at this point, and the caller upstream turned that into
    // "screenshot captured and saved" out of thin air. So: poll, and if nothing lands, say the
    // real reason instead of a hopeful one.
    const deadline = Date.now() + 12000;
    for (;;) {
      try { const st = fs.statSync(shotAbs); if (st.size > 0 && st.mtimeMs >= requestedAt) break; } catch (_) {}
      if (Date.now() > deadline) {
        throw new Error(
          'The viewport screenshot was requested but no file appeared at ' + shotAbs + '. ' +
          'The usual cause is that the Unreal window is not in the FOREGROUND — that path renders ' +
          'nothing and reports no error. Use the camera route, which does not care about focus.'
        );
      }
      await new Promise(r => setTimeout(r, 400));
    }
    // Copy it to the SAME output file the camera route uses. Unreal writes into its own project's
    // Screenshots folder, which is outside Phoenix and not served over /file — so without this the
    // viewport render exists on disk and never reaches the Image tab (found live 2026-07-31).
    // One known destination means one broadcast rule for both routes.
    fs.copyFileSync(shotAbs, outAbs);
    return { mode, file: outAbs, bytes: fs.statSync(outAbs).size, origin: shotAbs };
  }

  await run([
    'ues = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)',
    'eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
    'w = ues.get_editor_world()',
    // 🪤 RTF_RGBA8 is not optional — without it the export is an EXR named .png.
    'rt = unreal.RenderingLibrary.create_render_target2d(w, ' + width + ', ' + height + ', unreal.TextureRenderTargetFormat.RTF_RGBA8)',
    'if rt is None:',
    '    raise RuntimeError("create_render_target2d returned None — world context missing")',
    'cams = [a for a in eas.get_all_level_actors() if a.get_actor_label() == ' + py(CAMERA_LABEL) + ']',
    'cap = cams[0] if cams else eas.spawn_actor_from_class(unreal.SceneCapture2D, unreal.Vector(0,0,0))',
    'cap.set_actor_label(' + py(CAMERA_LABEL) + ')',
    ...place,
    'cap.set_actor_location_and_rotation(loc, rot, False, False)',
    'comp = cap.capture_component2d',
    'comp.texture_target = rt',
    'comp.capture_source = unreal.SceneCaptureSource.SCS_FINAL_COLOR_LDR',
    // Must match the FOV the framing distance was computed with, or the object is framed for a
    // lens the camera is not using.
    'comp.fov_angle = ' + FOV_DEG + '.0',
    'comp.capture_scene()',
    // Returns None even when it works — the file is the result, not the return value.
    'unreal.RenderingLibrary.export_render_target(w, rt, r' + py(outDir.replace(/\\/g, '/')) + ', ' + py(outName) + ')',
    'print("PHX_CAPTURE: done")',
  ], cfg);

  if (!fs.existsSync(outAbs) || fs.statSync(outAbs).size === 0) {
    throw new Error(`Unreal reported the capture but ${outAbs} is missing or empty.`);
  }
  // Cheap authenticity check: PNG magic. Catches the EXR-named-.png trap if the format guard
  // above is ever weakened — a downstream image reader would otherwise fail far from the cause.
  // readFileSync ignores {start,end} (those are createReadStream options) — it silently read the
  // whole render. Read exactly the 8 magic bytes via a descriptor instead.
  const head = Buffer.alloc(8);
  { const fd = fs.openSync(outAbs, 'r'); try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); } }
  if (!(head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47)) {
    throw new Error(`${outAbs} was written but is not a PNG (first bytes ${[...head.slice(0, 4)].map(b => b.toString(16)).join(' ')}) — ` +
                    `this is the 16-bit-float render target writing an EXR under a .png name.`);
  }

  return { mode, file: outAbs, bytes: fs.statSync(outAbs).size };
}

/**
 * What is actually in the level, as Unreal reports it — actor labels and their nesting.
 *
 * This exists because a vision model handed a bare image can only describe SHAPES. It called an
 * oak trunk "a canopy/shelter structure" and a capacitor "a translucent canister" (live,
 * 2026-07-31) — accurate about pixels, useless about the scene. Phoenix knows the names; not
 * passing them was throwing away information it already had.
 *
 * Template/lighting actors are filtered: they are in every level and would bury the two or three
 * things the operator actually cares about.
 */
const SCENERY = new Set([
  'Floor', 'SkyLight', 'DirectionalLight', 'SkyAtmosphere', 'ExponentialHeightFog',
  'VolumetricCloud', 'PlayerStart', 'SM_SkySphere', CAMERA_LABEL,
]);

async function levelInventory(cfg) {
  const out = await run([
    'eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
    'skip = ' + py([...SCENERY]),
    'def walk(a, d):',
    '    lbl = a.get_actor_label()',
    '    print("PHX_ACTOR:", d, "|", lbl, "|", a.get_class().get_name())',   // depth as a NUMBER — string indent got eaten by the parser
    '    for c in a.get_attached_actors():',
    '        walk(c, d + 1)',
    'for a in eas.get_all_level_actors():',
    '    if a.get_attach_parent_actor() is not None:',
    '        continue',
    '    if a.get_actor_label() in skip:',
    '        continue',
    '    walk(a, 0)',
  ], cfg, 60000);
  return [...out.matchAll(/^PHX_ACTOR:\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(\S+)$/gm)]
    .map(m => ({ depth: parseInt(m[1], 10), label: m[2], cls: m[3] }));
}

module.exports = { captureUnreal, levelInventory, CAMERA_LABEL };
