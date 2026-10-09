'use strict';
// render_check.js — Render-Vision: render the CURRENT Blender scene to a PNG and
// have a vision-capable model judge whether it looks right. This is the missing
// capability behind the orchestrator's blind "fixed ✓" claims: it lets Phoenix
// actually SEE a render instead of guessing.
//
// ADDITIVE + ISOLATED by design: depends only on blender-ipc (render) and
// claude-cli (vision). Does not touch the orchestrator's critical path. The
// render is NON-DESTRUCTIVE — the user's engine/resolution/filepath are saved
// and restored in a `finally` around the check.
//
// v1.9 M3: the judge is the VISION SEAT. A Claude seat keeps the path below (CLI + Read tool); a local/OpenAI
// seat gets the image BYTES plus a generated colour-stripe test card it must read first (providers/vision-proof.js).
//
// The Claude vision call reuses the existing claude CLI: the image path is passed
// explicitly and the model is told to open it with the Read tool (allowed for
// this one call only; the orchestrator's normal calls stay tool-less). The path
// is NOT passed as an `@`-mention — that tokenizes at whitespace and silently
// breaks on install paths with a space (C:\Users\First Last\...), which would let
// the model "judge" without seeing the image. Proven on claude-code CLI 2.1.219.

const path = require('path');
const fs = require('fs');
const providers = require('./providers');
const capabilities = require('./providers/capabilities');
const proof = require('./providers/vision-proof');

const VISION_SYSTEM =
  'You are a render-QA inspector for a 3D animation pipeline in Blender. You are shown a ' +
  'rendered frame. Judge ONLY what is visible. Be concrete and skeptical: call out holes, ' +
  'torn/jagged mesh, missing textures (magenta/pink), floating or clipping geometry, and ' +
  'obviously broken proportions. Do not invent problems that are not visible, and do not ' +
  'rubber-stamp. If the thing you were asked about is occluded or off-frame, say so instead ' +
  'of guessing. Keep it short.';

// Render the current scene to `outAbs` (EEVEE, fast) via the Blender IPC.
// Saves + restores the user's render settings. Resolves to { ok, frame } or throws.
async function renderCurrentScene(blenderIpc, outAbs, cfg, opts = {}) {
  const rx = opts.resX || 1280, ry = opts.resY || 720;
  const outFwd = outAbs.replace(/\\/g, '/'); // forward slashes: valid in Blender/Python everywhere, no escaping traps
  const py = `
import bpy, os, json
sc = bpy.context.scene
r = sc.render
_saved = (r.engine, r.resolution_x, r.resolution_y, r.resolution_percentage,
          r.filepath, r.image_settings.file_format)
ok = False; err = None
try:
    # EEVEE is 'BLENDER_EEVEE_NEXT' on Blender 4.2-4.4, 'BLENDER_EEVEE' on 4.1 and 5.x.
    for _eng in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'):
        try:
            r.engine = _eng
            break
        except Exception:
            continue
    r.resolution_x = ${rx}; r.resolution_y = ${ry}; r.resolution_percentage = 100
    r.image_settings.file_format = 'PNG'
    _out = ${JSON.stringify(outFwd)}
    os.makedirs(os.path.dirname(_out), exist_ok=True)
    r.filepath = _out
    bpy.ops.render.render(write_still=True)
    ok = os.path.isfile(_out)
except Exception as e:
    err = str(e)
finally:
    (r.engine, r.resolution_x, r.resolution_y, r.resolution_percentage,
     r.filepath, r.image_settings.file_format) = _saved
print("RC_JSON:" + json.dumps({"ok": bool(ok), "frame": sc.frame_current, "err": err}))
`;
  const resp = await blenderIpc.callBlender(py, { cfg, timeoutMs: opts.timeoutMs || 600000 });
  if (!resp || resp.status !== 'ok') {
    throw new Error('render failed: ' + (resp && resp.message ? resp.message : 'no response'));
  }
  const line = String(resp.stdout || resp.output || '').split('\n').find(l => l.startsWith('RC_JSON:'));
  const info = line ? JSON.parse(line.slice('RC_JSON:'.length)) : {};
  if (!info.ok) throw new Error('render produced no file' + (info.err ? ': ' + info.err : ''));
  return info;
}

// Ask a vision-capable model about an image on disk. Reuses claude-cli's async
// runStream so it never blocks the server event loop. The path is passed
// explicitly (Read-tool target) — robust to spaces and special characters.
//
// The whole point of this feature is that the model must NOT judge blind. So we
// verify it actually opened the image: `--output-format json` returns a
// machine-checkable envelope, and because ONLY the Read tool is allowed,
// `num_turns > 1` proves a Read ran on the file — a model that answered from
// imagination stays at one turn and gets flagged UNVERIFIED instead of trusted.
async function askVision(claudeCli, model, imgAbs, question, timeout = 150000) {
  const p = imgAbs.replace(/\\/g, '/');
  const user =
    'Use the Read tool to open the image at the exact absolute path below, then judge it. ' +
    'The path may contain spaces — treat everything after "PATH: " up to the end of that ' +
    'line as the single file path.\n\nPATH: ' + p + '\n\n' + question;
  const raw = await claudeCli.runStream(model, VISION_SYSTEM, user, {
    extraFlags: ['--allowedTools', 'Read', '--strict-mcp-config', '--output-format', 'json'],
    timeout,
  });
  let env;
  try { env = JSON.parse(raw); } catch (_) {
    // Sweep 2 G8: without the envelope there is no num_turns proof that the image was opened - a bare "VERDICT: PASS" must not pass as a verified one.
    return '⚠ UNVERIFIED — the vision model\'s answer could not be read as a JSON envelope, so there is no proof it opened the image; ' +
      'this verdict is NOT based on the render and must not be trusted.\n\n' + (String(raw || '').trim() || '(no verdict returned)');
  }
  if (!env || typeof env !== 'object') {
    return '⚠ UNVERIFIED — the vision model\'s answer was not a JSON envelope, so there is no proof it opened the image.\n\n' + String(raw || '').trim();
  }
  const verdict = String(env.result || '').trim();
  const denials = Array.isArray(env.permission_denials) ? env.permission_denials.length : 0;
  const readRan = Number(env.num_turns || 0) > 1 && denials === 0 && env.is_error !== true;
  if (!readRan) {
    return '⚠ UNVERIFIED — the vision model did not open the image (no Read tool call' +
      (denials ? ', read was denied' : '') + '), so this verdict is NOT based on the render and ' +
      'must not be trusted.\n\n' + (verdict || '(no verdict returned)');
  }
  return verdict;
}

// The colour word list is shuffled per call (see vision-proof.colorWordList) — a fixed order let an unsure model parrot it.
const visionBytesPrompt = (rng) =>
  'Two images are attached. IMAGE 1 is a small test card with three vertical colour stripes. IMAGE 2 is the render. ' +
  'On the FIRST line write exactly `COLORS: <left>, <middle>, <right>` naming the stripes of IMAGE 1, using only these ' +
  'words: ' + proof.colorWordList(rng) + '. Then answer the following about IMAGE 2 only:\n\n';

// Why the vision seat may NOT judge right now, or null when it may. Claude seats: always fine (their proof is the
// Read tool). Local/OpenAI/ChatGPT plan: the vision test must have passed for exactly this
// provider|endpoint|model — also when the seat is inherited from a local orchestrator (never judges untested).
function visionSeatProblem(cfg) {
  let seat;
  try { seat = providers.resolveSeat('vision', cfg); } catch (e) { return e.message; }
  if (seat.provider === 'claude-cli') return null;
  const v = capabilities.getVision(seat);
  return v && v.vision === 'pass' ? null : 'vision test not passed for ' + (seat.model || 'Codex default') + ' — run it in Settings → General → Seats';
}

// Ask the vision SEAT about an image on disk → the verdict string. Claude: askVision, unchanged. Local/OpenAI: card +
// render as two images; the verdict only counts when the model named the card's stripes (else UNVERIFIED prefix).
async function askVisionSeat(cfg, imgAbs, question, { timeoutMs = 150000, claudeCli, complete, rng, dbg } = {}) {
  const seat = providers.resolveSeat('vision', cfg);
  if (seat.provider === 'claude-cli') return askVision(claudeCli, seat.model, imgAbs, question, timeoutMs);
  const problem = visionSeatProblem(cfg);
  if (problem) throw new Error(problem);
  let render;
  try { render = fs.readFileSync(imgAbs); } catch (_) { throw new Error('render file missing'); }
  const card = proof.makeCard(rng);
  const prompt = visionBytesPrompt(rng);   // a separate draw from the card's colours
  const t0 = Date.now();
  const r = await (complete || providers.complete)('vision', cfg, {
    system: VISION_SYSTEM, messages: [{ role: 'user', content: prompt + question }],
    images: [{ mime: 'image/png', data: card.png }, { mime: 'image/png', data: render }], purpose: 'vision', timeoutMs,
  });
  const chk = proof.checkProof(r.text, card.colors);
  const ok = r.imagesSent === 2 && chk.ok;
  const detail = r.imagesSent === 2 ? chk.detail : 'the images were not sent to the model';
  try {
    const log = dbg || require('./debug-log');
    log.event('vision-proof', { provider: seat.provider, model: seat.model, ok, detail, ms: Date.now() - t0 });
  } catch (_) {}
  const verdict = proof.stripColorsLine(r.text) || '(no verdict returned)';
  if (ok) return verdict;
  return '⚠ UNVERIFIED — the vision model did not prove it saw the images (' + detail + '), so this verdict is NOT ' +
    'based on the render and must not be trusted.\n\n' + verdict;
}

/**
 * checkRender — render the current scene and get a vision verdict.
 * deps: { blenderIpc, claudeCli }
 * opts: { outAbs (required), question, cfg (required for the vision step), resX, resY, timeoutMs, visionTimeout }
 *   (opts.model is ignored since M3 — the vision seat decides; kept so old callers do not break)
 * deps may also carry { complete, rng } (tests).
 * Returns { imagePath, verdict, frame }.
 */
async function checkRender(deps, opts) {
  const { blenderIpc, claudeCli } = deps;
  const outAbs = opts.outAbs;
  const question =
    opts.question ||
    "Look at this render. Answer with 'VERDICT: PASS' or 'VERDICT: FAIL' on the first " +
    'line, then one short sentence. FAIL only if something is visibly broken (holes, torn ' +
    'mesh, missing/pink textures, floating or clipping geometry, broken proportions).';
  const info = await renderCurrentScene(blenderIpc, outAbs, opts.cfg, opts);
  // M6.1: the render exists from here on. A vision failure is tagged so the caller can tell it from a failed render
  // (visionFailed → 'rendered, but the vision model could not look'); the message itself is unchanged.
  let verdict;
  try {
    verdict = await askVisionSeat(opts.cfg, outAbs, question, { timeoutMs: opts.visionTimeout, claudeCli, complete: deps.complete, rng: deps.rng, dbg: deps.dbg });
  } catch (e) {
    const err = (e instanceof Error) ? e : new Error(String(e));
    try { err.visionFailed = true; err.imagePath = outAbs; err.frame = info.frame; } catch (_) { /* frozen error: keep it as is */ }
    throw err;
  }
  return { imagePath: outAbs, verdict: String(verdict || '').trim(), frame: info.frame };
}

module.exports = { checkRender, renderCurrentScene, askVision, askVisionSeat, visionSeatProblem, VISION_SYSTEM };
