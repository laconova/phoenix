'use strict';

// ─── Text → Animation (HY-Motion / Tencent Hunyuan Motion) ────────────────────
//
// Generates a motion clip from a text prompt and drops it into animations/ as a
// normal Mixamo-compatible FBX, so the existing retarget path (animate_human) can
// put it on any mixamo-rigged character in the scene.
//
// WHERE THINGS RUN: generation happens in ComfyUI (weights ~12 GB, GPU-bound); the retarget
// happens in the open Blender scene over file-IPC. Those can be the same machine or two —
// this module only talks HTTP to whatever `hyMotion.api` points at, downloads the resulting
// FBX, and hands the local path to animate_human. Nothing about the retarget changes.
//
// THE RETARGET TEMPLATE: HY-Motion retargets onto a character FBX that must be in the
// MIXAMO REST POSE (T-pose). The MPFB "mixamo" rig is built in an A-pose — feeding that
// in produces a hunched figure with the forearms bent in front of the body, and generation
// still reports success, so it reads as a bad model instead of a setup gap. Build the
// template with scripts/hy-motion/make_tpose_char.py and put it in that ComfyUI's input/3d/.
// It does NOT have to be the character in the scene: the template only decides the
// proportions HY generates against, and animate_human scale-matches the result to the
// real character (measured: going through an existing A-pose rig reproduced the direct
// path exactly — 3.36 m travel either way).
//
// Symptoms and fixes for users: troubleshooting/entries/hymotion-hunched-tpose.md and
// troubleshooting/entries/hymotion-endpoint-no-nodes.md

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { ANIM_DIR, ensureAnimDir } = require('./animate_human');

const DEFAULTS = {
  // The ComfyUI that has ComfyUI-HY-Motion1 in custom_nodes. That may well be the same one as
  // endpoints.comfyui — what decides it is whether the HY nodes are installed there, not the
  // port. Override with hyMotion.api when generation runs elsewhere (see the example config).
  api: 'http://localhost:8188',
  // Relative to that ComfyUI's own folder. The template must be a MIXAMO REST POSE (T-pose) FBX;
  // create it with scripts/hy-motion/make_tpose_char.py and drop it in ComfyUI/input/3d/.
  template: 'input/3d/phoenix_char_tpose.fbx',
  // Full model (3.9 GB) rather than -Lite (1.8 GB): with the LLM offloaded to CPU the motion
  // net has the card to itself, so on ~10 GB the smaller variant buys nothing and hits the
  // prompt less accurately.
  network: 'HY-Motion-1.0',
  // The motion net (3.9 GB) and Qwen3-8B do not fit in ~10 GB together. The LLM is only
  // needed once for text encoding, so it goes to CPU and the motion net keeps the GPU.
  // Set false if your card has room for both — it is faster that way.
  offloadLlm: true,
  // How hard the model is pushed towards the description. Higher = more literal but
  // stiffer; the node's own default is 5.0. Overridable per call via input.cfg.
  cfgScale: 5.0,
};

// Hard limit of the HYMotionGenerate node itself (its `duration` input is FLOAT min 0.5, max 12.0).
// Not a preference — sending more comes back as a validation error, so it is clamped here.
const MAX_DURATION = 12;

function cfgOf(cfg) {
  const hy = (cfg && cfg.hyMotion) || {};
  return { ...DEFAULTS, ...hy };
}

function postJSON(url, payload, timeoutMs = 30000) {
  return request(url, { method: 'POST', body: JSON.stringify(payload), timeoutMs,
                        headers: { 'Content-Type': 'application/json' } });
}

function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // Honour the scheme. An https:// endpoint used to be spoken to in plaintext on port 80 and
    // failed as "not reachable", which says nothing about the real cause — and a remote GPU box
    // behind TLS is exactly what the README suggests as the non-local option.
    const isTls = u.protocol === 'https:';
    const mod   = isTls ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (isTls ? 443 : 80), path: u.pathname + u.search,
      method: opts.method || 'GET', headers: opts.headers || {},
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', e => reject(new Error(`HY-Motion: ${u.host} not reachable — ${e.message}`)));
    req.setTimeout(opts.timeoutMs || 30000, () => {
      req.destroy(new Error(`timeout after ${Math.round((opts.timeoutMs || 30000) / 1000)}s`));
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// The export node writes <prefix>_<timestamp>_<uid>_000.fbx — the uid is not derivable
// from the prompt id, so the exact name cannot be predicted. Two consequences shape this:
//   * output_dir is the output ROOT, not a subfolder: ComfyUI's file listing
//     (/internal/files/output) uses a flat os.scandir and never sees subfolders.
//   * filename_prefix carries a token unique to this job, so picking our file out of
//     that listing is exact rather than "the newest one" (which would race a second job).
// The node also reports NO outputs back to ComfyUI (history.outputs is {}), so the
// listing is the only way to find the file at all.
function buildPrompt(text, duration, seed, token, c) {
  return {
    '1': { class_type: 'HYMotionLoadNetwork', inputs: { model_name: c.network } },
    '2': { class_type: 'HYMotionLoadLLM', inputs: {
      model_name: 'Qwen3-8B-bnb-4bit', quantization: 'none', offload_to_cpu: c.offloadLlm } },
    '3': { class_type: 'HYMotionEncodeText', inputs: { llm: ['2', 0], text } },
    '4': { class_type: 'HYMotionGenerate', inputs: {
      network: ['1', 0], conditioning: ['3', 0],
      duration, seed, cfg_scale: c.cfgScale, num_samples: 1 } },
    '5': { class_type: 'HYMotionExportFBX', inputs: {
      motion_data: ['4', 0], output_dir: '', filename_prefix: token,
      custom_fbx_path: c.template, yaw_offset: 0.0, scale: 0.0 } },
  };
}

// prompt text -> safe, recognisable filename stem.
// Kept short on purpose: the name ends up in the Human tab's dropdown, and an over-long
// one used to stretch the row out of the panel.
function slug(text) {
  return String(text || 'motion').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24).replace(/-$/, '') || 'motion';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Poll /history until the job leaves the queue.
async function waitForJob(api, promptId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(4000);
    let hist;
    try {
      const r = await request(`${api}/history/${promptId}`, { timeoutMs: 20000 });
      hist = JSON.parse(r.buffer.toString('utf8'));
    } catch (_) {
      continue;                       // transient — keep polling until the deadline
    }
    const entry = hist[promptId];
    if (!entry) continue;             // still queued or running
    const st = entry.status || {};
    if (st.status_str && st.status_str !== 'success') {
      const msgs = (st.messages || []).slice(-3).map(m => JSON.stringify(m).slice(0, 300));
      throw new Error(`generation failed (${st.status_str}) — ${msgs.join(' | ') || 'no detail'}`);
    }
    return;
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
}

// Find the FBX this job wrote, by its unique prefix.
async function findOutput(api, token) {
  const r = await request(`${api}/internal/files/output`, { timeoutMs: 20000 });
  if (r.status !== 200) throw new Error(`could not list the HY-Motion server's output folder (HTTP ${r.status})`);
  const names = JSON.parse(r.buffer.toString('utf8'))
    .map(s => String(s).replace(/ \[output\]$/, ''))
    .filter(n => n.startsWith(token) && /\.fbx$/i.test(n));
  if (!names.length) throw new Error(`job reported success but wrote no FBX named ${token}*`);
  return names[0];                    // listing is sorted newest-first
}

/**
 * Generate a motion clip and store it in animations/.
 * input: { prompt, duration?, seed?, name? }
 * Returns { file, seconds, bytes } — `file` is the basename animate_human expects.
 */
async function generateMotion(input = {}, cfg) {
  const c = cfgOf(cfg);
  const text = String(input.prompt || '').trim();
  if (!text) return { error: 'Describe the motion first (e.g. "a person walks forward and looks around").' };

  if (Number.isFinite(Number(input.cfg))) c.cfgScale = Math.max(1, Math.min(15, Number(input.cfg)));
  // The HYMotionGenerate node caps duration at 12 s and rejects anything longer with a raw
  // validation error ("Value 14.0 bigger than max of 12.0"). Clamping to 20 here meant asking for
  // 15 s produced a wall of ComfyUI JSON instead of a clip. Clamp to what the node accepts and
  // say so, rather than letting the user discover the limit through an HTTP 400.
  const asked = Number(input.duration);
  const duration = Math.max(1, Math.min(MAX_DURATION, asked || 6));
  const clamped = Number.isFinite(asked) && asked > MAX_DURATION;
  const seed = Number.isFinite(Number(input.seed)) ? Number(input.seed) : Math.floor(Math.random() * 1e9);
  const token = 'phoenixhy' + crypto.randomBytes(5).toString('hex');
  const started = Date.now();

  let sub;
  try {
    sub = await postJSON(`${c.api}/prompt`, { prompt: buildPrompt(text, duration, seed, token, c) });
  } catch (e) {
    // request() already says "not reachable"; add the one thing the user can act on.
    return { error: `${e.message}. Text→motion needs its own ComfyUI (the one with ` +
                    'ComfyUI-HY-Motion1 installed) — set hyMotion.api in phoenix-config.json if it runs elsewhere.' };
  }
  if (sub.status !== 200) {
    const detail = sub.buffer.toString('utf8');
    // ComfyUI answers a missing node type with a 400 naming it. Without this the user gets a
    // wall of JSON for what is really "that install has no HY-Motion nodes".
    if (/HYMotion\w*/.test(detail) && /not.*(exist|found)|invalid.*(node|prompt)/i.test(detail)) {
      return { error: `${c.api} has no HY-Motion nodes — install ComfyUI-HY-Motion1 there, or point ` +
                      'hyMotion.api at the ComfyUI that has it (it is a separate install from the Trellis one).' };
    }
    return { error: `the generator rejected the job (HTTP ${sub.status}) — ${detail.slice(0, 400)}` };
  }
  const promptId = JSON.parse(sub.buffer.toString('utf8')).prompt_id;

  // Generation is the slow part: ~230 s for 6 s of motion with the LLM on CPU, and the
  // very first call also pays for loading the weights.
  let remoteName;
  try {
    await waitForJob(c.api, promptId, 20 * 60 * 1000);
    remoteName = await findOutput(c.api, token);
  } catch (e) {
    return { error: e.message };
  }

  const q = new URLSearchParams({ filename: remoteName, subfolder: '', type: 'output' });
  const dl = await request(`${c.api}/view?${q}`, { timeoutMs: 120000 });
  if (dl.status !== 200 || !dl.buffer.length) {
    return { error: `could not download the finished FBX (HTTP ${dl.status})` };
  }

  ensureAnimDir();
  const stem = String(input.name || '').trim() ? slug(input.name) : slug(text);
  // The name is built from prompt + seed only, so the SAME wording at a different duration (or
  // cfg) lands on the same filename and used to overwrite the earlier clip without a word —
  // measured 2026-07-23, where a 12 s take silently ate the 8 s one it was meant to improve on.
  // Generation costs minutes; never spend them and then destroy the result. Take the next free
  // name instead, and hand the real name back so the caller never guesses.
  let base = `hy-${stem}-${String(seed).slice(-4)}.fbx`;
  let abs = path.join(ANIM_DIR, base);
  for (let n = 2; fs.existsSync(abs) && n < 1000; n++) {
    base = `hy-${stem}-${String(seed).slice(-4)}-${n}.fbx`;
    abs = path.join(ANIM_DIR, base);
  }
  fs.writeFileSync(abs, dl.buffer);

  // Sidecar: marks this FBX as carrying HY-Motion conventions (on its back, centimetres).
  // animate_human reads it and corrects the source on import. Deterministic — a filename
  // check would break the moment someone renames the clip.
  fs.writeFileSync(abs + '.hy.json', JSON.stringify({
    source: 'hymotion', prompt: text, duration, seed,
    network: c.network, template: c.template,
  }, null, 2), 'utf8');

  return {
    file: base, seconds: Math.round((Date.now() - started) / 1000), bytes: dl.buffer.length,
    note: clamped ? `asked for ${asked}s, generated ${duration}s — that is the model's maximum` : '',
  };
}

module.exports = { generateMotion, buildPrompt, slug, findOutput, DEFAULTS, MAX_DURATION };
