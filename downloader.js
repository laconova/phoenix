'use strict';

// ─── downloader.js — workflow/engine acquisition core (v1.8.1, Stage 1 + 2a) ─
//
// The package contract's CORE + CONTRACT. Turns a registry entry's `install` block (workflows.js
// DEFAULT_WORKFLOWS shape, additive) into a resolved target, a preflight check, a read-only plan, and
// an executor — so "drop in a package" later (Voice/Image/Mesh) is data, not a core rebuild.
//
// The voice-engine support extends the SAME contract with a second `install.target` shape
// ("voice-engine", discriminated from the default "comfyui" form) — a venv +
// pip/git-with-requirements-surgery + weights recipe for the voice-service, instead of ComfyUI's
// custom_nodes[]/models[]. `install.target` is the ONLY new top-level field; every Stage-1 entry
// (which never set it) still validates and resolves exactly as before.
//
// WHY A SEPARATE MODULE (not workflows.js / i2i.js): workflows.js is the registry (data + presence
// checking via checkDeps); i2i.js runs a workflow against ComfyUI. This module answers a DIFFERENT
// question — "where do this workflow's missing deps come from, and how do I fetch them" — and talks
// to disk + ssh + huggingface/plain URLs, none of which the other two modules do. Kept separate so
// neither of them grows a network/ssh surface it doesn't need.
//
// Node core + i2i.baseForInstance + config only — Phoenix is dep-free, no npm packages here.
//
// ── Bound traps (spec §7 — non-negotiable) ────────────────────────────────────
// - No silent substitution / no silent success: unknown source, unreachable/misconfigured target,
//   sha mismatch, manual target → loud, structured outcome, never a pretend-OK.
// - Disk + VRAM checked BEFORE fetch/run (preflight()).
// - Endpoint reachability is fast + explicit (AbortSignal.timeout), never a hang.
// - Our rig is NEVER a silent default target — comfyInstall absent/instance-missing => manual,
//   always, regardless of what endpoints.comfyui happens to resolve to.
// - Licence is a property of `install` (surfaced by the caller/UI); NC confirm is a UI concern
//   (server.js/index.html), not enforced here — this module only ever acts on an explicit request.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
// Namespace import (not destructured): accept.js's tests mock child_process.spawnSync by
// reassigning the property on this SAME cached module object — a destructured `const { spawnSync }`
// would capture the original function at require-time and never see that reassignment.
const cp = require('child_process');
const { pipeline: streamPipeline } = require('stream/promises');
const { Readable } = require('stream');

const i2i   = require('./i2i.js');   // baseForInstance — reused, never reimplemented

// Fast + explicit: a configured-but-dead endpoint must fail in seconds, not hang on the OS's own
// TCP timeout (a stale hardcoded rig IP was this failure mode's original trigger — this spec exists
// partly to avoid repeating it).
const REACHABILITY_TIMEOUT_MS = 5000;

// ── small path helper ─────────────────────────────────────────────────────────
// A "supervisor" target lives on another host reached over ssh (today: our Linux rig) — its paths
// are POSIX regardless of what OS Phoenix itself runs on (this app runs from Windows too). A "local"
// target is THIS machine, so the native path module is correct there. Never mix the two.
function joinPath(kind, base, ...parts) {
  return kind === 'supervisor' ? path.posix.join(base, ...parts) : path.join(base, ...parts);
}

function gitRepoDirName(gitUrl) {
  const clean = String(gitUrl || '').replace(/\/+$/, '');
  const base = clean.split('/').pop() || 'node';
  return base.replace(/\.git$/, '');
}

function describeModelSource(source) {
  if (!source) return null;
  if (source.hf) return 'hf:' + source.hf;
  if (source.url) return source.url;
  return null;
}

// "<owner>/<repo>/<path...>" -> https://huggingface.co/<owner>/<repo>/resolve/main/<path...>
function hfDownloadUrl(hf) {
  const parts = String(hf || '').split('/').filter(Boolean);
  if (parts.length < 3) throw new Error(`bad hf source "${hf}" — expected "<owner>/<repo>/<path...>"`);
  const repo = parts.slice(0, 2).join('/');
  const file = parts.slice(2).join('/');
  return `https://huggingface.co/${repo}/resolve/main/${file}`;
}

function isValidModelSource(m) {
  if (!m || !m.filename || !m.dir) return false;
  const hasHf  = !!(m.source && m.source.hf);
  const hasUrl = !!(m.source && m.source.url);
  return hasHf !== hasUrl;   // exactly one
}

function isValidNodeSource(n) {
  return !!(n && n.classType && n.git);
}

function isValidWeightsSource(source) {
  if (!source) return false;
  const hasHf = !!source.hf, hasMs = !!source.modelscope, hasUrl = !!source.url;
  return [hasHf, hasMs, hasUrl].filter(Boolean).length === 1;   // exactly one
}

function describeWeightsSource(source) {
  if (!source) return null;
  if (source.hf) return 'hf:' + source.hf;
  if (source.modelscope) return 'modelscope:' + source.modelscope;
  if (source.url) return source.url;
  return null;
}

// ── 1. validateInstall(entry) → { ok, errors:[] } ─────────────────────────────
// Additive: an entry with NO install block at all stays valid (workflows.js pattern — every entry
// shipped before this spec has none). Only a PRESENT-but-malformed install block is rejected.
//
// `install.target` discriminates the shape:
// "comfyui" (DEFAULT — omitted target = comfyui, so every Stage-1 entry validates exactly as before)
// or "voice-engine" (the new engine{} block). license/vram_gb are required either way ("as Stage 1").
function validateInstall(entry) {
  const install = entry && entry.install;
  if (!install || typeof install !== 'object') return { ok: true, errors: [] };

  const errors = [];

  if (!install.license || typeof install.license !== 'string' || !install.license.trim()) {
    errors.push('install.license is required');
  }
  if (typeof install.vram_gb !== 'number' || !Number.isFinite(install.vram_gb) || install.vram_gb <= 0) {
    errors.push('install.vram_gb must be a positive number');
  }

  const target = install.target || 'comfyui';
  if (target !== 'comfyui' && target !== 'voice-engine') {
    errors.push(`install.target must be "comfyui" or "voice-engine" (got "${target}")`);
    return { ok: false, errors };   // unknown shape — nothing below is meaningful to check against it
  }

  if (target === 'voice-engine') {
    const engine = install.engine;
    if (!engine || typeof engine !== 'object') {
      errors.push('install.engine is required for target:"voice-engine"');
      return { ok: false, errors };
    }

    if (!engine.id || typeof engine.id !== 'string' || !engine.id.trim()) {
      errors.push('engine.id is required');
    }

    if (!engine.kind) {
      errors.push('engine.kind is required');
    } else if (engine.kind !== 'pip' && engine.kind !== 'git+requirements') {
      errors.push(`engine.kind must be "pip" or "git+requirements" (got "${engine.kind}")`);
    } else if (engine.kind === 'pip') {
      if (!engine.pip || typeof engine.pip !== 'string' || !engine.pip.trim()) {
        errors.push('engine.pip is required for kind:"pip"');
      }
    } else if (engine.kind === 'git+requirements') {
      if (!engine.repo || typeof engine.repo !== 'object' || !engine.repo.url) {
        errors.push('engine.repo.url is required for kind:"git+requirements"');
      }
    }

    if (!engine.venv || !engine.venv.path) {
      errors.push('engine.venv.path is required');
    }

    if (!engine.weights || typeof engine.weights !== 'object') {
      errors.push('engine.weights is required');
    } else {
      if (!isValidWeightsSource(engine.weights.source)) {
        errors.push('engine.weights.source must have exactly one of hf/modelscope/url');
      }
      if (!engine.weights.dir) {
        errors.push('engine.weights.dir is required');
      }
    }

    return { ok: errors.length === 0, errors };
  }

  // target === 'comfyui' — the Stage-1 form, byte-for-byte unchanged.
  const models = Array.isArray(install.models) ? install.models : [];
  for (const m of models) {
    const name = (m && m.filename) || '<unnamed>';
    if (!m || !m.filename) errors.push(`model "${name}" is missing filename`);
    if (!m || !m.dir)      errors.push(`model "${name}" is missing dir`);
    const hasHf  = !!(m && m.source && m.source.hf);
    const hasUrl = !!(m && m.source && m.source.url);
    if (hasHf && hasUrl)   errors.push(`model "${name}" declares both source.hf and source.url — exactly one is required`);
    if (!hasHf && !hasUrl) errors.push(`model "${name}" declares neither source.hf nor source.url — exactly one is required`);
  }

  const nodes = Array.isArray(install.custom_nodes) ? install.custom_nodes : [];
  for (const n of nodes) {
    const name = (n && n.classType) || '<unnamed>';
    if (!n || !n.classType) errors.push('custom_nodes item is missing classType');
    if (!n || !n.git)       errors.push(`custom node "${name}" is missing git`);
  }

  // A declared dep (workflows.js entry.deps) with no matching install source is a LOUD error, never
  // a silent skip — the entry claims the dep exists but the contract never says where it comes from.
  const installedFilenames = new Set(models.map(m => m && m.filename).filter(Boolean));
  const declaredModels = (entry.deps && entry.deps.models) || [];
  for (const dep of declaredModels) {
    if (!installedFilenames.has(dep)) errors.push(`dep ${dep} has no install source`);
  }

  return { ok: errors.length === 0, errors };
}

// ── 2. resolveTarget(cfg, entry) → target ─────────────────────────────────────
// comfyInstall/voiceInstall absent, or this instance missing from it => kind:"manual". NEVER inferred
// from the base URL (our bases read localhost via an SSH tunnel even for the rig) and NEVER a silent
// default to our own rig — a fresh install with zero config must resolve to "manual", every time.
// Dispatches on serviceTypeFor(entry): image/mesh/i2i → ComfyUI shape (modelsRoot/customNodesRoot,
// unchanged from Stage 1); voice → the Stage-2a voice-engine shape (engineRoot/venvPath/weightsDir).
function resolveTarget(cfg, entry) {
  const serviceType = serviceTypeFor(entry);
  if (serviceType === 'voice') return resolveVoiceTarget(cfg, entry);
  return resolveComfyTarget(cfg, entry);
}

// voice.js's own apiBase() logic, duplicated on purpose rather than imported: voice.js reads its OWN
// module-local phoenix-config.json copy (cfg()), not the `cfg` object callers pass in here — importing
// it would silently ignore whatever config this call was actually given.
function voiceBase(cfg) {
  return String((cfg && cfg.voice && cfg.voice.api) || '').replace(/\/+$/, '');
}

function resolveComfyTarget(cfg, entry) {
  const instance = (entry && entry.instance) || 'trellis';
  const base = i2i.baseForInstance(cfg, instance);

  const comfyInstall = (cfg && cfg.comfyInstall) || {};
  const inst = comfyInstall[instance];
  if (!inst || !inst.root) {
    return {
      kind: 'manual', base, instance,
      modelsRoot: null, customNodesRoot: null, ssh: null,
      reason: `no acquisition target configured for instance "${instance}" — set comfyInstall.${instance}.root in phoenix-config.json, or install manually`,
    };
  }

  // via defaults to "local" — rig-side install happens ONLY when the config says so in words
  // (revised 2026-09-15: the old default-to-supervisor-when-comfySupervisor-is-set was a footgun for
  // a customer who set a root but happened to leave a supervisor entry in config; presence of
  // comfySupervisor/rigSsh must never imply a topology by itself).
  const via = inst.via || 'local';

  if (via !== 'supervisor' && via !== 'local') {
    return {
      kind: 'manual', base, instance,
      modelsRoot: null, customNodesRoot: null, ssh: null,
      reason: `comfyInstall.${instance}.via must be "supervisor" or "local" (got "${via}")`,
    };
  }

  const root = String(inst.root).replace(/[\\/]+$/, '');
  const modelsRoot      = joinPath(via, root, 'models');
  const customNodesRoot = joinPath(via, root, 'custom_nodes');

  if (via === 'supervisor') {
    const ssh = (cfg && cfg.endpoints && cfg.endpoints.rigSsh) || null;
    if (!ssh) {
      return {
        kind: 'manual', base, instance,
        modelsRoot: null, customNodesRoot: null, ssh: null,
        reason: `comfyInstall.${instance}.via is "supervisor" but endpoints.rigSsh is not set`,
      };
    }
    return { kind: 'supervisor', base, instance, modelsRoot, customNodesRoot, ssh, reason: null };
  }

  return { kind: 'local', base, instance, modelsRoot, customNodesRoot, ssh: null, reason: null };
}

// Stage 2a — voice-engine target. Same rules as comfyInstall (config-driven root, via defaults to
// "local", "supervisor" must be explicit, absent config/instance = manual, never our rig by default),
// mirrored onto a NEW `voiceInstall` config block ({root, via} per instance — see the example config
// phoenix-config.example.json's `_comment_voiceInstall`). "modelsRoot"/"customNodesRoot" have no voice
// equivalent — instead:
// engineRoot (the bench/install root, taken ENTIRELY from voiceInstall.<instance>.root — a manifest's
// `engine.root`, if present, is decorative-only and never read here; the customer's config is the only
// source of the real root, same as comfyInstall), venvPath (engineRoot + engine.venv.path).
//
// weightsDir (revised 2026-09-17 — release-blocker fix: DEFAULT_WORKFLOWS must never ship an absolute,
// per-user home path). `engine.weights.dir` is now RELATIVE-OR-ABSOLUTE:
//   - relative (the normal case — a subpath under the engine's install, e.g. "cosyvoice/pretrained_models/…")
//     → joined onto the resolved engineRoot, exactly like ComfyUI's models[].dir under modelsRoot.
//   - absolute (still supported — an engine's OWN external cache that genuinely lives outside the
//     install root, e.g. a real customer override) → used AS-IS, unchanged from the original Stage-2a
//     contract ("<abs target for repo-local weights, or the HF cache>").
// This is a superset of the old AS-IS-only behavior: every existing absolute-path manifest/fixture
// still resolves identically; only a relative value is new (and now the only thing DEFAULT_WORKFLOWS
// ships).
function resolveVoiceTarget(cfg, entry) {
  const instance = (entry && entry.instance) || 'voice';
  const base = voiceBase(cfg);

  const voiceInstall = (cfg && cfg.voiceInstall) || {};
  const inst = voiceInstall[instance];
  if (!inst || !inst.root) {
    return {
      kind: 'manual', base, instance,
      engineRoot: null, venvPath: null, weightsDir: null, ssh: null,
      reason: `no acquisition target configured for voice instance "${instance}" — set voiceInstall.${instance}.root in phoenix-config.json, or install manually`,
    };
  }

  const via = inst.via || 'local';
  if (via !== 'supervisor' && via !== 'local') {
    return {
      kind: 'manual', base, instance,
      engineRoot: null, venvPath: null, weightsDir: null, ssh: null,
      reason: `voiceInstall.${instance}.via must be "supervisor" or "local" (got "${via}")`,
    };
  }

  const root = String(inst.root).replace(/[\\/]+$/, '');
  const engine = (entry && entry.install && entry.install.engine) || {};
  const venvSub = (engine.venv && engine.venv.path) || 'venv';
  const venvPath = joinPath(via, root, venvSub);
  const weightsRaw = (engine.weights && engine.weights.dir) || null;
  const weightsDir = !weightsRaw ? null : (path.isAbsolute(weightsRaw) ? weightsRaw : joinPath(via, root, weightsRaw));

  if (via === 'supervisor') {
    const ssh = (cfg && cfg.endpoints && cfg.endpoints.rigSsh) || null;
    if (!ssh) {
      return {
        kind: 'manual', base, instance,
        engineRoot: root, venvPath: null, weightsDir: null, ssh: null,
        reason: `voiceInstall.${instance}.via is "supervisor" but endpoints.rigSsh is not set`,
      };
    }
    return { kind: 'supervisor', base, instance, engineRoot: root, venvPath, weightsDir, ssh, reason: null };
  }

  return { kind: 'local', base, instance, engineRoot: root, venvPath, weightsDir, ssh: null, reason: null };
}

// Where a voice engine's git repo (kind:"git+requirements") gets cloned to — the manifest has no
// explicit "repo destination" field, so this is <engineRoot>/<engine.id>, mirroring how ComfyUI custom
// nodes land at <customNodesRoot>/<repo-dir-name>: one predictable, collision-free slot per engine id.
function voiceRepoDir(target, engine) {
  if (!target || !target.engineRoot || !engine || !engine.id) return null;
  return joinPath(target.kind, target.engineRoot, engine.id);
}

// ── disk / vram helpers ────────────────────────────────────────────────────────

function localDiskFreeGb(dir) {
  let p = dir;
  for (let i = 0; i < 8; i++) {
    try {
      const st = fs.statfsSync(p);
      return (st.bavail * st.bsize) / 1e9;
    } catch (_) {
      const parent = path.dirname(p);
      if (parent === p) return null;
      p = parent;
    }
  }
  return null;
}

function sshDiskFreeGb(ssh, dir) {
  if (!ssh) return null;
  try {
    const r = cp.spawnSync('ssh', ['-o', 'ConnectTimeout=10', ssh, `df -Pk ${shQ(dir)} 2>/dev/null | tail -1`],
      { encoding: 'utf8', timeout: 15000 });
    // #5: an ENOENT (ssh binary not on PATH) or a nonzero status are NOT "no free space" — they are
    // "could not measure". Either way we return null; the caller (preflight) surfaces that as an
    // unverified-disk WARNING rather than a block, which is the correct handling for an unmeasurable
    // resource (and distinguishes it from a real "needs N GB, M free" block, which only happens on a
    // number we actually read). r.error is set on spawn failure (ssh missing); a nonzero status is a
    // dead/unreachable host or a bad path.
    if (r.error || r.status !== 0) return null;
    const cols = String(r.stdout || '').trim().split(/\s+/);
    const availKb = Number(cols[3]);   // df -P: Filesystem 1024-blocks Used Available Use% Mounted
    if (!Number.isFinite(availKb)) return null;
    return (availKb * 1024) / 1e9;
  } catch (_) { return null; }
}

// rootPath is passed explicitly (not read off target.modelsRoot) so the SAME function serves both
// target shapes — ComfyUI's modelsRoot and voice's engineRoot.
async function diskFreeGb(target, rootPath) {
  if (target.kind === 'local')      return localDiskFreeGb(rootPath);
  if (target.kind === 'supervisor') return sshDiskFreeGb(target.ssh, rootPath);
  return null;
}

// ── dep presence (idempotency source for plan()/acquire()/status() — see the note on plan() below) ─
// 🔴 FILESYSTEM presence, not /object_info (revised 2026-09-15 — live-check finding D3: a freshly
// fetched model is absent from ComfyUI's /object_info until ComfyUI restarts — it caches its model
// list at load time — so keying the fetch decision on /object_info re-downloads the same file forever).
// Presence is resolved in ONE batched pass now — see resolvePresence(); a supervisor probe is a single
// `ssh 'if test -f/-d …; then echo P:<key>; fi'` handshake, never one ssh per dep (#4).
function localPathExists(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

// ── completion markers (spec #1/#3 — presence ≠ success) ───────────────────────
// A bare directory on disk is NOT proof of a successful install: a venv whose `pip install` failed, or
// a node whose pinned-ref `git checkout` failed, leaves the DIRECTORY behind at the wrong state, and a
// bare `test -d` then reads it as "installed / ready" on the next run — a masked failure (live-bug
// 2026-09-15, §2a-rig: a huggingface-cli-missing failure left an empty weights dir that reported ready).
// So an acquired directory target is "done" ONLY once a small marker file is written INSIDE it, AFTER
// the step's real success (see writeMarker calls in the executors). plan()/status() presence-check the
// MARKER, not just the dir — over local (fs) and supervisor (ssh test -f) alike. A partial / failed /
// cancelled build leaves the dir WITHOUT its marker → NOT ready → the plan shows the remaining fetch
// steps. (Model FILES need no marker: fetchModel streams to a `.part` and only renames on full success
// + sha check, so the final path existing already means success — an interrupted/cancelled model fetch
// leaves the `.part`, never the final file.)
const MARKER_NAME = '.phoenix-acquired.json';
function markerPathFor(target, dirPath) {
  if (!dirPath) return null;
  return joinPath(target.kind, dirPath, MARKER_NAME);
}
async function writeMarker(target, dirPath, data) {
  const mp = markerPathFor(target, dirPath);
  if (!mp) return;
  const json = JSON.stringify(data);
  if (target.kind === 'local') {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(mp, json);
    return;
  }
  if (target.kind === 'supervisor') {
    // printf (not echo) so a JSON body with backslashes is written verbatim; both dir + body are shQ'd.
    await runShell(target, `mkdir -p ${shQ(dirPath)} && printf '%s' ${shQ(json)} > ${shQ(mp)}`, {});
  }
}
async function fetchWithTimeout(url, ms) {
  return fetch(url, { signal: AbortSignal.timeout(ms) });
}

// Service-type awareness (added 2026-09-15 — live-check finding: ComfyUI has NO /health; it 404s
// there, which used to make preflight falsely report "unreachable" and block EVERY ComfyUI acquire).
// Derived from entry.stage — image/mesh/i2i are ComfyUI targets (liveness = /system_stats, no kasse
// at all in Stage 1); voice is a voice-service target (liveness = /health, kasse as voice.js reads it
// today). Any stage other than "voice" defaults to ComfyUI — Stage 1 only ships image/mesh/i2i
// entries, so this covers everything reachable today without guessing at an unbuilt voice contract.
function serviceTypeFor(entry) {
  return (entry && entry.stage === 'voice') ? 'voice' : 'comfyui';
}
function livenessPathFor(serviceType) {
  return serviceType === 'voice' ? '/health' : '/system_stats';
}

// ── 3. preflight(cfg, entry) → { ok, reason, disk, vram, diskVerified, vramVerified, warnings } ──
// Golden rule (revised 2026-09-15): a resource we CANNOT measure is reported UNVERIFIED and
// surfaced — never silently treated as fine. `ok:false` blocks; an unverifiable resource does NOT
// block (a mainstream customer has no kasse ledger at all, and statfs/df can simply fail) but sets
// its `*Verified:false` flag plus a human-readable line in `warnings[]`. A silent pass would be
// exactly the probabilistic-quality-gate failure mode this spec exists to close off.
async function preflight(cfg, entry) {
  const target = resolveTarget(cfg, entry);
  return preflightForTarget(cfg, entry, target);
}

async function preflightForTarget(cfg, entry, target) {
  if (target.kind === 'manual') {
    return { ok: false, reason: target.reason, disk: null, vram: null, diskVerified: false, vramVerified: false, warnings: [], target };
  }

  const serviceType = serviceTypeFor(entry);
  const livenessPath = livenessPathFor(serviceType);

  // #9: an empty base (a voice target whose cfg.voice.api is unset) must say so plainly — otherwise the
  // fetch below is handed a bare "/health" and throws the opaque "Failed to parse URL from /health".
  if (!target.base) {
    const reason = serviceType === 'voice'
      ? 'voice.api is not set in phoenix-config.json'
      : 'target base URL is not set';
    return { ok: false, reason, disk: null, vram: null, diskVerified: false, vramVerified: false, warnings: [], target };
  }

  const livenessUrl = `${target.base}${livenessPath}`;

  // Reachability — fast, explicit, via the SERVICE'S OWN liveness route; never an open-ended hang.
  // ComfyUI's /health 404s (it doesn't exist) — probing it would falsely report "unreachable" and
  // block every ComfyUI acquire, which is exactly the live bug this fixes. voice-service bodies are
  // parsed (kasse pass-through); ComfyUI's /system_stats body is not needed in Stage 1.
  let health = null;
  try {
    const r = await fetchWithTimeout(livenessUrl, REACHABILITY_TIMEOUT_MS);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (serviceType === 'voice') health = await r.json();
  } catch (e) {
    return {
      ok: false, reason: `${livenessUrl} unreachable — ${(e && e.message) || e}`,
      disk: null, vram: null, diskVerified: false, vramVerified: false, warnings: [], target,
    };
  }

  const warnings = [];

  // VRAM — only checked when the package actually declares a need (install.vram_gb) — nothing to
  // verify, and nothing to warn about, when no requirement was ever stated.
  let vram = null;
  let vramVerified = false;
  const vramGb = entry && entry.install && typeof entry.install.vram_gb === 'number' ? entry.install.vram_gb : null;
  if (vramGb != null) {
    if (serviceType === 'comfyui') {
      // ComfyUI has no kasse at all in Stage 1 (future: /system_stats carries real VRAM figures —
      // Stage 2/3, not here). Always unverified, always surfaced, never blocked.
      warnings.push('VRAM not verified — no ledger on this target');
    } else {
      // voice-service kasse pass-through (same shape voice.js already reads: aus/freiGb/gesamtGb/halter/braucht).
      const k = health && health.kasse;
      if (k && !k.aus && typeof k.freiGb === 'number') {
        vramVerified = true;
        const heldBy = (k.halter && k.halter.length) ? k.halter.join(', ') : null;
        vram = { needGb: vramGb, freeGb: k.freiGb, totalGb: (typeof k.gesamtGb === 'number') ? k.gesamtGb : null, heldBy };
        if (vramGb > k.freiGb) {
          return {
            ok: false,
            reason: `needs ${vramGb} GB VRAM, ${k.freiGb} GB free` + (heldBy ? ` — held by ${heldBy}` : ''),
            disk: null, vram, diskVerified: false, vramVerified: true, warnings, target,
          };
        }
      } else {
        // Kasse off/absent — the expected state when the voice-service ledger isn't running. Do NOT
        // block; surface it instead.
        warnings.push('VRAM not verified — no ledger on this target');
      }
    }
  }

  // Disk — free space at the target's root vs sum of KNOWN sizes (unsized entries are skipped, same
  // "when known" qualifier the spec already applies to size_gb). ComfyUI sums models[].size_gb across
  // the whole install; voice sums the ONE engine.weights.size_gb (single weights block, not a list).
  let disk = null;
  let diskVerified = false;
  const diskRoot = target.modelsRoot || target.engineRoot;
  let neededGb = 0;
  if (serviceType === 'comfyui') {
    const models = (entry && entry.install && Array.isArray(entry.install.models)) ? entry.install.models : [];
    neededGb = models.reduce((sum, m) => sum + (typeof (m && m.size_gb) === 'number' ? m.size_gb : 0), 0);
  } else {
    const w = entry && entry.install && entry.install.engine && entry.install.engine.weights;
    neededGb = (w && typeof w.size_gb === 'number') ? w.size_gb : 0;
  }
  if (neededGb > 0) {
    const freeGb = await diskFreeGb(target, diskRoot);
    if (freeGb != null) {
      diskVerified = true;
      disk = { neededGb, freeGb };
      if (neededGb > freeGb) {
        return {
          ok: false, reason: `needs ${neededGb} GB disk at ${diskRoot}, ${freeGb} GB free`,
          disk, vram, diskVerified: true, vramVerified, warnings, target,
        };
      }
    } else {
      // statfs/df failed to answer — unreadable, not "no space". Do NOT block; surface it instead.
      warnings.push(`free disk at ${diskRoot} could not be read`);
    }
  }

  return { ok: true, reason: null, disk, vram, diskVerified, vramVerified, warnings, target };
}

// ── 4. plan(cfg, entry) → { target, steps:[…], preflight } ────────────────────
// Read-only, no side effects.
//
// 🔴 Idempotency = FILESYSTEM presence at the target path, NOT /object_info (revised 2026-09-15 —
// live-check finding D3, real acquire onto the rig: the file landed on disk, but /object_info still
// reported it missing because ComfyUI only picks up new models at restart, so the OLD object_info-
// keyed plan() kept emitting 'fetch' forever). See resolvePresence() below (the batched fs/ssh probe).
// `/object_info`/`checkDeps` (workflows.js) are UNTOUCHED and stay exactly what they were — the
// separate "loaded and ready to run" signal behind GET /workflows/deps and the Library "✓ ready" row.
// This function simply no longer uses that signal to decide fetch vs skip.
async function plan(cfg, entry) {
  const target = resolveTarget(cfg, entry);
  const pf = await preflightForTarget(cfg, entry, target);
  const steps = serviceTypeFor(entry) === 'voice' ? planVoiceSteps(target, entry, pf.ok) : planComfySteps(target, entry, pf.ok);
  return { target, steps, preflight: pf };
}

// #4 — resolve presence for a set of {key, test:'-f'|'-d', path[, wantContent]} probes → { present:Set,
// content:Map<key, parsedJSON|null> }. A `wantContent` probe (a completion marker whose BODY we need,
// e.g. to compare a pinned ref or a voice build id) is read in the SAME pass — no separate readMarker
// round trips.
//   local:      fs.existsSync (+ readFileSync for content) per item — cheap, no network.
//   supervisor: ONE batched `ssh` handshake for ALL probes (a single `if test …; then echo P:<key>;
//               [printf M:<key>=; base64 <path>] fi; …` script), instead of N sequential ssh connections
//               — the Library-refresh path used to fire one ssh PER dep (and one more per marker read),
//               freezing for a handshake apiece.
//   short-circuit: when preflight ALREADY reported the target unreachable (pfOk === false) we do NOT
//               probe a supervisor at all — a dead rig would otherwise hang the refresh for the
//               ConnectTimeout of every probe. Everything reads absent → the plan shows the fetch steps.
// Paths are shell-quoted (shQ) so a `'` in a path can't break the probe command; marker bodies travel
// base64 so a JSON body with newlines/quotes can't corrupt the line protocol.
function resolvePresence(target, probes, pfOk) {
  const present = new Set();
  const content = new Map();
  const real = probes.filter(pr => pr.path);
  if (target.kind === 'local') {
    for (const pr of real) {
      if (!localPathExists(pr.path)) continue;
      present.add(pr.key);
      if (pr.wantContent) { try { content.set(pr.key, JSON.parse(fs.readFileSync(pr.path, 'utf8'))); } catch (_) { content.set(pr.key, null); } }
    }
    return { present, content };
  }
  if (target.kind === 'supervisor') {
    if (pfOk === false || !real.length) return { present, content };   // short-circuit a dead/unreachable supervisor
    const script = real.map((pr, i) => {
      const echoP = `echo ${shQ('P:' + pr.key)}`;
      if (!pr.wantContent) return `if test ${pr.test} ${shQ(pr.path)}; then ${echoP}; fi`;
      // presence + base64 marker body on ONE line: M:<index>=<base64>  (tr strips base64's own wrapping).
      // L-5: the body line is keyed by the probe INDEX, not the key text. The parser splits an M: line at
      // its FIRST '=', and a supervisor root can legitimately contain '=' (a path segment) — a raw key
      // there would be truncated, the marker would never match, and the dep would re-acquire forever
      // (non-destructively, but wastefully). An integer index can never contain '=', so the round-trip is
      // safe for ANY path. (P: lines are unaffected — they have no '=' delimiter; the whole tail is the key.)
      return `if test ${pr.test} ${shQ(pr.path)}; then ${echoP}; printf ${shQ('M:' + i + '=')}; base64 ${shQ(pr.path)} | tr -d '\\n'; echo; fi`;
    }).join('; ');
    try {
      const r = cp.spawnSync('ssh', ['-o', 'ConnectTimeout=10', target.ssh, script], { encoding: 'utf8', timeout: 20000 });
      if (!r.error && r.status === 0) {
        for (const ln of String(r.stdout || '').split(/\r?\n/)) {
          if (ln.startsWith('P:')) { present.add(ln.slice(2)); continue; }
          if (ln.startsWith('M:')) {
            const eq = ln.indexOf('=');
            if (eq > 2) {
              // L-5: the segment before '=' is the probe INDEX, mapped back to the real key here — so a
              // '=' inside the path can no longer corrupt which marker this body belongs to.
              const idx = Number(ln.slice(2, eq));
              const pr = Number.isInteger(idx) ? real[idx] : null;
              if (pr) {
                try { content.set(pr.key, JSON.parse(Buffer.from(ln.slice(eq + 1).trim(), 'base64').toString('utf8'))); }
                catch (_) { content.set(pr.key, null); }
              }
            }
          }
        }
      }
    } catch (_) { /* unreadable → treat as absent */ }
    return { present, content };
  }
  return { present, content };   // manual — nothing on disk to find
}

// The version identity recorded in a voice-build marker (NEW-7) — a manifest re-pin must trigger a
// rebuild, exactly as a node's marker.ref does. pip engines pin by `pip` spec; git by repo.commit.
function voiceBuildId(engine) {
  if (!engine) return null;
  if (engine.kind === 'pip') return 'pip:' + (engine.pip || '');
  if (engine.kind === 'git+requirements') return 'git:' + ((engine.repo && engine.repo.commit) || '');
  return null;
}

function planComfySteps(target, entry, pfOk) {
  const steps = [];
  const install = (entry && entry.install) || {};
  const modelsByFilename = new Map((Array.isArray(install.models) ? install.models : []).map(m => [m && m.filename, m]));
  const nodesByClass     = new Map((Array.isArray(install.custom_nodes) ? install.custom_nodes : []).map(n => [n && n.classType, n]));

  // Gather every presence probe first, resolve them in ONE batch (#4), then build the steps.
  const probes = [];
  const modelInfo = [];
  for (const name of ((entry && entry.deps && entry.deps.models) || [])) {
    const src = modelsByFilename.get(name);
    if (!isValidModelSource(src)) { modelInfo.push({ name, manual: true }); continue; }
    const to = modelDestPath(target, src);
    probes.push({ key: 'model:' + name, test: '-f', path: to });
    modelInfo.push({ name, src, to });
  }
  const nodeInfo = [];
  // Dedup by dest DIR (#4): several classTypes can share ONE repo (trellis2 ships 6) → probe that dir's
  // presence + marker ONCE, and request the marker BODY (wantContent) only when some node pins a ref.
  const nodeDirs = new Map();   // dir -> { needContent }
  for (const name of ((entry && entry.deps && entry.deps.custom_nodes) || [])) {
    const src = nodesByClass.get(name);
    if (!isValidNodeSource(src)) { nodeInfo.push({ name, manual: true }); continue; }
    const to = nodeDestPath(target, src);
    const d = nodeDirs.get(to) || { needContent: false };
    if (src.ref) d.needContent = true;
    nodeDirs.set(to, d);
    nodeInfo.push({ name, src, to });
  }
  for (const [dir, meta] of nodeDirs) {
    probes.push({ key: 'nodedir@' + dir, test: '-d', path: dir });
    probes.push({ key: 'nodemk@' + dir, test: '-f', path: markerPathFor(target, dir), wantContent: meta.needContent });
  }
  const { present, content } = resolvePresence(target, probes, pfOk);

  for (const mi of modelInfo) {
    if (mi.manual) { steps.push({ kind: 'model', name: mi.name, from: null, to: null, action: 'manual' }); continue; }
    const isPresent = present.has('model:' + mi.name);
    steps.push({ kind: 'model', name: mi.name, from: describeModelSource(mi.src.source), to: mi.to, action: isPresent ? 'skip' : 'fetch' });
  }
  for (const ni of nodeInfo) {
    if (ni.manual) { steps.push({ kind: 'node', name: ni.name, from: null, to: null, action: 'manual' }); continue; }
    // A node is present only with BOTH its dir AND its marker (spec #1/#3) — a bare/failed/cancelled
    // clone (or a user's un-adopted manual clone) has the dir but no marker → NOT ready → "fetch".
    let isPresent = present.has('nodedir@' + ni.to) && present.has('nodemk@' + ni.to);
    if (isPresent && ni.src.ref) {
      // Pinned ref: the marker must record the SAME requested ref, else a re-pin (or a failed checkout)
      // is masked as ready. Marker body came back in the SAME batched probe (content map) — no extra ssh.
      const m = content.get('nodemk@' + ni.to);
      if (!m || m.ref !== ni.src.ref) isPresent = false;
    }
    steps.push({ kind: 'node', name: ni.name, from: ni.src.git, to: ni.to, action: isPresent ? 'skip' : 'fetch' });
  }

  return steps;
}

function modelDestPath(target, src) {
  if (!src || target.kind === 'manual') return null;
  return joinPath(target.kind, target.modelsRoot, src.dir, src.filename);
}
function nodeDestPath(target, src) {
  if (!src || target.kind === 'manual') return null;
  return joinPath(target.kind, target.customNodesRoot, gitRepoDirName(src.git));
}

// Stage 2a — voice-engine plan. Idempotency (per D3) is COARSE, not per-package: "present iff the
// venv dir exists AND (weights dir exists OR weights.lazy)" (spec Part 2a). So every "build the venv"
// step (venv itself, clone, submodules, pip installs, the requirements surgery) shares ONE presence
// signal — the venv directory's existence — and only the weights step gets its own, independent
// signal. This still yields a meaningful "partial" via status()'s existing generic derivation (e.g.
// venv present but weights absent), and acquire() re-checks presence per-step at exec time regardless
// (same D3 discipline as the ComfyUI path), so a coarse plan() snapshot never causes a wrong skip.
function planVoiceSteps(target, entry, pfOk) {
  const engine = (entry && entry.install && entry.install.engine) || {};
  const steps = [];

  const weights = engine.weights || {};
  const weightsLazy = weights.lazy === true;
  const validWeights = isValidWeightsSource(weights.source) && !!target.weightsDir;

  // Presence is MARKER-based now (spec #1/#3): a bare venv dir left by a failed `pip install` no longer
  // reads as "built" — the venv-build marker is written only after the whole build chain succeeds (see
  // acquire's voice loop). Weights get their own marker, written only after the weights fetch succeeds
  // (this also subsumes the old empty-dir-after-failure guard: an empty dir has no marker). Both probes
  // go through the one batched, short-circuiting resolvePresence (#4).
  const probes = [{ key: 'venvmk', test: '-f', path: markerPathFor(target, target.venvPath), wantContent: true }];
  if (!weightsLazy) probes.push({ key: 'weightsmk', test: '-f', path: markerPathFor(target, target.weightsDir) });
  const { present, content } = resolvePresence(target, probes, pfOk);

  // NEW-7: the build marker records the engine's version identity (pip spec / repo.commit). A manifest
  // re-pin (e.g. pip:chatterbox-tts 0.1.7 → 0.2.0) must NOT read as already-installed — same discipline
  // as a node's marker.ref. So "built" requires the marker AND (when we can derive an id) a matching one.
  let venvBuilt = present.has('venvmk');
  if (venvBuilt) {
    const wantId = voiceBuildId(engine);
    if (wantId) { const m = content.get('venvmk'); if (!m || m.buildId !== wantId) venvBuilt = false; }
  }
  const buildAction = venvBuilt ? 'skip' : 'fetch';

  steps.push({ kind: 'venv', name: 'venv', from: null, to: target.venvPath, action: buildAction });

  if (engine.kind === 'pip') {
    const validPip = typeof engine.pip === 'string' && engine.pip.trim().length > 0;
    steps.push({ kind: 'pip', name: 'pip-install', from: engine.pip || null, to: target.venvPath, action: validPip ? buildAction : 'manual' });
  } else if (engine.kind === 'git+requirements') {
    const validRepo = !!(engine.repo && engine.repo.url);
    const repoDir = voiceRepoDir(target, engine);
    steps.push({
      kind: 'clone', name: 'clone',
      from: validRepo ? (engine.repo.url + (engine.repo.commit ? '@' + engine.repo.commit : '')) : null,
      to: repoDir, action: validRepo ? buildAction : 'manual',
    });

    const submodules = (engine.repo && Array.isArray(engine.repo.submodules)) ? engine.repo.submodules : [];
    if (submodules.length) {
      steps.push({ kind: 'submodules', name: 'submodules', from: submodules.join(', '), to: repoDir, action: validRepo ? buildAction : 'manual' });
    }

    const req = engine.requirements || {};
    const pre  = Array.isArray(req.pre)  ? req.pre  : [];
    const post = Array.isArray(req.post) ? req.post : [];
    if (pre.length) {
      steps.push({ kind: 'pip-pre', name: 'pip-pre', from: pre.join(', '), to: target.venvPath, action: buildAction });
    }
    const validReq = !!req.file;
    steps.push({ kind: 'requirements', name: 'requirements', from: req.file || null, to: target.venvPath, action: validReq ? buildAction : 'manual' });
    if (post.length) {
      steps.push({ kind: 'pip-post', name: 'pip-post', from: post.join(', '), to: target.venvPath, action: buildAction });
    }
  } else {
    // Unknown/missing engine.kind — validateInstall() already flags this as an error; plan() must
    // still never crash on a malformed manifest, so it surfaces as a loud, unactionable step instead.
    steps.push({ kind: 'pip', name: 'pip-install', from: null, to: target.venvPath, action: 'manual' });
  }

  const weightsPresent = weightsLazy ? true : present.has('weightsmk');
  const weightsAction = !validWeights ? 'manual' : (weightsPresent ? 'skip' : 'fetch');
  steps.push({ kind: 'weights', name: 'weights', from: describeWeightsSource(weights.source), to: target.weightsDir, action: weightsAction });

  return steps;
}

// ── 5. status(cfg, entry) → "ready"|"partial"|"missing"|"manual" ──────────────
// Derived from plan().steps, which are now filesystem-backed (see plan() above) — so "ready" means
// "on disk at the target", not "ComfyUI has loaded it". No code change needed here beyond that: this
// function was always a thin wrapper over plan()'s actions.
async function status(cfg, entry) {
  const p = await plan(cfg, entry);
  if (p.target.kind === 'manual') return 'manual';
  if (!p.steps.length) return 'ready';
  if (p.steps.some(s => s.action === 'manual')) return 'manual';
  const anyFetch = p.steps.some(s => s.action === 'fetch');
  const anySkip  = p.steps.some(s => s.action === 'skip');
  if (!anyFetch) return 'ready';
  if (anySkip)   return 'partial';
  return 'missing';
}

// ── sha256 ──────────────────────────────────────────────────────────────────
function verifySha256Local(filePath, expected) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => {
      const got = hash.digest('hex');
      if (got.toLowerCase() !== String(expected).toLowerCase()) {
        reject(new Error(`sha256 mismatch: expected ${expected}, got ${got}`));
      } else resolve();
    });
  });
}

// sshSha256 → { hash } on a real answer, { error } when it could NOT be computed (transient: ssh down,
// binary missing, path unreadable). The distinction MATTERS (#6): a genuine hash MISMATCH deletes the
// file (it is corrupt), but an ERROR must NOT — the download may be perfectly good and we simply could
// not verify it this once. Conflating the two (the old `return null`) would rm a good multi-GB file on
// a flaky ssh blip.
// NEW-6: async (cp.spawn via runProc) with the fetch's ~1h-class timeout — hashing a multi-GB model
// takes far longer than the old 30s spawnSync budget, which made every big verified model degrade to
// "could not be verified". Plain ssh (NOT the -tt runShell path) so stdout is the clean hash line.
async function sshSha256(ssh, remotePath, opts = {}) {
  try {
    const r = await runProc('ssh', ['-o', 'ConnectTimeout=10', ssh, `sha256sum ${shQ(remotePath)}`],
      { timeout: 3600000, signal: opts.signal, label: 'sha256sum' });
    const got = String(r.stdout || '').trim().split(/\s+/)[0];
    return got ? { hash: got } : { error: 'sha256sum produced no output' };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { error: 'ssh not found on PATH' };
    return { error: String((e && e.message) || e) };   // nonzero exit / timeout / transient — NOT a mismatch
  }
}

// ── async process runner (spec FIX #2) ─────────────────────────────────────────
// Replaces the old cp.spawnSync executors: spawnSync ran each 10–60-min step INSIDE the request and
// froze the entire single-threaded server for the whole download (no chat, no voice, no cancel). runProc
// is a Promise around cp.spawn that (a) resolves on exit 0 / rejects with stderr + `error.code` on
// nonzero, (b) STREAMS stdout/stderr lines to onProgress via onLine, and (c) is KILLABLE — an
// AbortSignal (opts.signal) SIGKILLs the child, which is how the acquire job's Cancel button stops a
// running clone/pip/weights fetch. #5: a spawn that never starts (ENOENT — the binary isn't on PATH)
// rejects with a REASON ("git not found on PATH"), not a bare empty-stderr failure.
function spawnErr(cmd, e) {
  if (e && e.code === 'ENOENT') { const x = new Error(`${cmd} not found on PATH`); x.code = 'ENOENT'; return x; }
  const x = new Error(`${cmd} could not start: ${(e && e.message) || e}`);
  if (e && e.code) x.code = e.code;
  return x;
}
const IS_WIN = process.platform === 'win32';
// NEW-2: kill the whole PROCESS GROUP, not just the direct child. A shell step is `sh -c "<a> && <b>"`,
// so the real pip/venv/hf/curl is a GRANDCHILD; SIGKILL'ing only the `sh` leaves the grandchild running
// (and the stdio pipes open, so the run never settles). When the step was spawned `detached:true` the
// child leads its own group, and `process.kill(-pid)` signals every process in it. Guarded: negative-pid
// signalling is POSIX-only and can throw (group already gone / unsupported) — always fall back to a
// direct child.kill so a cancel still stops the direct child at minimum.
function killTree(child, detached) {
  try {
    if (detached && !IS_WIN && typeof child.pid === 'number') { process.kill(-child.pid, 'SIGKILL'); return; }
  } catch (_) { /* group gone or platform lacks it → fall back */ }
  try { child.kill('SIGKILL'); } catch (_) {}
}
function runProc(cmd, args, opts = {}) {
  const { timeout, signal, onLine, label, detached, env } = opts;
  const tag = label || cmd;
  return new Promise((resolve, reject) => {
    let child;
    try {
      // env (L-3): callers merge extra vars (e.g. GIT_TERMINAL_PROMPT=0) onto the inherited environment
      // so a git step can be told to fail fast instead of blocking on a credential prompt. Omitted → the
      // child inherits process.env unchanged (spawn's default).
      const spawnOpts = { windowsHide: true, detached: !!detached };
      if (env) spawnOpts.env = Object.assign({}, process.env, env);
      child = cp.spawn(cmd, args, spawnOpts);
    } catch (e) { reject(spawnErr(cmd, e)); return; }

    let stdout = '', stderr = '', settled = false, timer = null;
    const onAbort = () => killTree(child, detached);
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) { try { signal.removeEventListener('abort', onAbort); } catch (_) {} }
    };
    const done = (fn, arg) => { if (settled) return; settled = true; cleanup(); fn(arg); };

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeout) timer = setTimeout(() => { killTree(child, detached); const x = new Error(`${tag} timed out after ${timeout}ms`); x.timedOut = true; done(reject, x); }, timeout);

    const feed = (acc, chunk) => {
      const text = chunk.toString('utf8');
      if (typeof onLine === 'function') {
        for (const ln of text.split(/\r?\n/)) { const t = ln.trim(); if (t) { try { onLine(t); } catch (_) {} } }
      }
      return acc + text;
    };
    if (child.stdout) child.stdout.on('data', d => { stdout = feed(stdout, d); });
    if (child.stderr) child.stderr.on('data', d => { stderr = feed(stderr, d); });
    child.on('error', e => done(reject, spawnErr(cmd, e)));
    child.on('close', code => {
      if (signal && signal.aborted) { const x = new Error(`${tag} cancelled`); x.cancelled = true; done(reject, x); return; }
      if (code === 0) { done(resolve, { stdout, stderr }); return; }
      const detail = (stderr || stdout || '').trim();
      const x = new Error(`${tag} failed (exit ${code})${detail ? ': ' + detail : ''}`);
      x.code = code;
      done(reject, x);
    });
  });
}

// runShell — unifies local (`sh -c`) vs supervisor (`ssh host 'cmd'`), async through runProc.
// detached:true (NEW-2) → the shell leads its own process group so a cancel can SIGKILL the whole tree
// (the grandchild pip/curl/git, not just `sh`). Supervisor uses `ssh -tt` (NEW-3): forcing a remote pty
// means the remote command gets SIGHUP when the ssh session drops (i.e. when we kill the local client),
// so a cancel makes a best-effort attempt to stop the REMOTE work too, not just the local ssh client.
function runShell(target, cmd, opts = {}) {
  const o = Object.assign({ detached: true }, opts);
  if (target.kind === 'local')      return runProc('sh',  ['-c', cmd], Object.assign({ label: 'shell' }, o));
  if (target.kind === 'supervisor') return runProc('ssh', ['-tt', '-o', 'ConnectTimeout=15', target.ssh, cmd], Object.assign({ label: 'ssh' }, o));
  return Promise.reject(new Error(`unsupported target kind "${target.kind}"`));
}

function shQ(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }   // single-quote a shell argument

// ── fetch / clone executors ───────────────────────────────────────────────────
// supervisor mode runs the fetch/clone RIG-SIDE over the same ssh seam preflight's disk check
// already uses (plain portable shell commands — curl/git/sha256sum — quoted through shQ so a `'` in a
// path can't break the command). Returns { shaWarning } — a non-fatal integrity note surfaced to the UI.
async function fetchModel(target, src, opts = {}) {
  const { signal, onLine } = opts;
  const dest = joinPath(target.kind, target.modelsRoot, src.dir, src.filename);
  const url = src.source.hf ? hfDownloadUrl(src.source.hf) : src.source.url;
  if (!url) throw new Error(`model "${src.filename}" has no resolvable source`);

  if (target.kind === 'local') {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';   // rename only on FULL success — an aborted/failed fetch leaves .part, never the final file
    const res = await fetch(url, { redirect: 'follow', signal });
    if (!res.ok || !res.body) throw new Error(`download failed HTTP ${res.status} for ${url}`);
    await streamPipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
  } else if (target.kind === 'supervisor') {
    const remoteDir = path.posix.dirname(dest);
    const cmd = `mkdir -p ${shQ(remoteDir)} && curl -fL -o ${shQ(dest + '.part')} ${shQ(url)} && mv ${shQ(dest + '.part')} ${shQ(dest)}`;
    await runShell(target, cmd, { timeout: 3600000, signal, onLine, label: 'remote fetch' });
  } else {
    throw new Error(`unsupported target kind "${target.kind}"`);
  }

  // #6 — sha256: a real MISMATCH deletes the corrupt file and fails; a VERIFY ERROR (transient) keeps
  // the file and surfaces an "unverified" warning; and a model with NO declared sha256 is NEVER silently
  // trusted — it too is flagged unverified so the UI can show it was never checked.
  if (src.sha256) {
    if (target.kind === 'local') {
      try {
        await verifySha256Local(dest, src.sha256);
      } catch (e) {
        if (/mismatch/i.test(String((e && e.message) || e))) {
          try { fs.unlinkSync(dest); } catch (_) { /* best-effort cleanup */ }
          throw e;
        }
        return { shaWarning: `sha256 for ${src.filename} could not be verified (${(e && e.message) || e}) — file kept, integrity unconfirmed` };
      }
    } else {
      const got = await sshSha256(target.ssh, dest, { signal });
      if (got && got.error) {
        return { shaWarning: `sha256 for ${src.filename} could not be verified (${got.error}) — file kept, integrity unconfirmed` };
      }
      if (!got || !got.hash || got.hash.toLowerCase() !== String(src.sha256).toLowerCase()) {
        await runShell(target, `rm -f ${shQ(dest)}`).catch(() => {});
        throw new Error(`sha256 mismatch for ${src.filename}: expected ${src.sha256}, got ${(got && got.hash) || '(unreadable)'}`);
      }
    }
    return { shaWarning: null };
  }
  return { shaWarning: `${src.filename} was fetched WITHOUT a declared sha256 — integrity unverified` };
}

// L-3 (credential-prompt hang): a `git fetch`/`clone` against a private or renamed remote can, under the
// supervisor's `ssh -tt` pty, block on an interactive username/password prompt until the whole step's
// timeout (up to 600 s). GIT_TERMINAL_PROMPT=0 makes git error out instead of prompting, and
// `-c credential.helper=` disables any configured helper that might pop its own prompt — so a private
// remote fails FAST and loudly rather than hanging. Applied to every git invocation in cloneNode (local
// via these args+env, supervisor via the GIT_NOPROMPT_SH prefix below).
const GIT_NOPROMPT_ARGS = ['-c', 'credential.helper='];
const GIT_NOPROMPT_ENV = { GIT_TERMINAL_PROMPT: '0' };
const GIT_NOPROMPT_SH = 'GIT_TERMINAL_PROMPT=0 git -c credential.helper=';
function gitLocal(args, opts = {}) {
  return runProc('git', [...GIT_NOPROMPT_ARGS, ...args], Object.assign({ env: GIT_NOPROMPT_ENV }, opts));
}

// L-1 (masked-install edge): a SIGKILLed `git clone` leaves `.git` behind with an EMPTY index/working
// tree. `git ls-files` printing at least one tracked path is our proof the clone's checkout phase
// actually completed — a bare/interrupted clone lists nothing. Read-only, local, best-effort (an error
// reads as "not populated" so we never marker an unverifiable tree).
function localTreePopulated(dest) {
  try {
    const r = cp.spawnSync('git', ['-C', dest, 'ls-files'], { encoding: 'utf8', timeout: 30000, env: Object.assign({}, process.env, GIT_NOPROMPT_ENV) });
    if (r.error || r.status !== 0) return false;
    return String(r.stdout || '').split(/\r?\n/).some(l => l.trim().length > 0);
  } catch (_) { return false; }
}

// NEW-1 (RELEASE BLOCKER / no-destroy invariant): Acquire must NEVER delete a directory Phoenix did not
// create. A user's MANUAL clone of e.g. ComfyUI-RMBG holds a self-downloaded sam3.pt (GBs) INSIDE the
// dir, and the Library actively offers ⬇ Acquire whenever /object_info doesn't list the class. So we
// ADOPT an existing repo in place — clone only when the dir is absent; otherwise `git fetch` + `git
// checkout <ref>` into the EXISTING repo (checkout preserves untracked files like sam3.pt), then write
// our marker. A dir that exists but is NOT a git repo is left untouched and fails loudly. We never rm.
async function cloneNode(target, src, opts = {}) {
  const { signal, onLine } = opts;
  const dest = joinPath(target.kind, target.customNodesRoot, gitRepoDirName(src.git));

  if (target.kind === 'local') {
    fs.mkdirSync(target.customNodesRoot, { recursive: true });
    const exists = fs.existsSync(dest);
    const isRepo = exists && fs.existsSync(path.join(dest, '.git'));
    if (!exists) {
      await gitLocal(['clone', src.git, dest], { timeout: 600000, signal, onLine, label: 'git clone' });
    } else if (isRepo) {
      // Adopt in place — fetch new refs, never touch the working tree's untracked files.
      await gitLocal(['-C', dest, 'fetch', '--all', '--tags'], { timeout: 600000, signal, onLine, label: 'git fetch' });
    } else {
      throw new Error(`"${dest}" already exists and is not a git repository — refusing to overwrite it (move it aside and retry)`);
    }
    if (src.ref) {
      await gitLocal(['-C', dest, 'checkout', src.ref], { timeout: 60000, signal, onLine, label: `git checkout ${src.ref}` });
    } else if (isRepo) {
      // L-1: no pinned ref to check out (the pinned path above already populates the tree). A prior
      // SIGKILLed clone can leave `.git` + an EMPTY tree that the bare fetch above would let us marker as
      // "acquired" with no files. Require a tracked file to actually be present first; an empty tree
      // throws BEFORE writeMarker (loud, non-destructive — we never rm), so plan() keeps showing "fetch".
      if (!localTreePopulated(dest)) {
        throw new Error(`"${dest}" is a git repository with an empty working tree (interrupted clone?) — not marking it acquired; move it aside and retry to re-clone`);
      }
    }
  } else if (target.kind === 'supervisor') {
    // Same safe form remotely: clone only if absent; adopt an existing repo (fetch); a non-repo dir
    // exits 3 (loud, no destruction). NEVER `rm -rf`. L-3: every git call carries the no-prompt prefix.
    const refCmd = src.ref ? ` && ${GIT_NOPROMPT_SH} -C ${shQ(dest)} checkout ${shQ(src.ref)}` : '';
    const body = `if [ -d ${shQ(dest + '/.git')} ]; then ${GIT_NOPROMPT_SH} -C ${shQ(dest)} fetch --all --tags; ` +
                 `elif [ -e ${shQ(dest)} ]; then echo "not a git repository: ${dest}" 1>&2; exit 3; ` +
                 `else ${GIT_NOPROMPT_SH} clone ${shQ(src.git)} ${shQ(dest)}; fi`;
    // L-1 (supervisor): with no pinned ref, verify a tracked file exists after the fetch/clone — an
    // interrupted prior clone (empty tree) exits 4 → runShell rejects → no marker → re-fetch next plan.
    const verifyCmd = src.ref ? '' : ` && { [ -n "$(${GIT_NOPROMPT_SH} -C ${shQ(dest)} ls-files 2>/dev/null | head -n1)" ] || { echo "empty working tree: ${dest}" 1>&2; exit 4; }; }`;
    const cmd = `mkdir -p ${shQ(target.customNodesRoot)} && ( ${body} )${refCmd}${verifyCmd}`;
    await runShell(target, cmd, { timeout: 600000, signal, onLine, label: 'remote git clone' });
  } else {
    throw new Error(`unsupported target kind "${target.kind}"`);
  }

  // Resolve HEAD (best-effort, informational) then write the completion marker — ONLY now, after the
  // clone AND checkout both succeeded. A failed checkout above threw before reaching here → no marker.
  let head = null;
  try {
    const rp = target.kind === 'local'
      ? cp.spawnSync('git', ['-C', dest, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 15000 })
      : cp.spawnSync('ssh', ['-o', 'ConnectTimeout=10', target.ssh, `git -C ${shQ(dest)} rev-parse HEAD`], { encoding: 'utf8', timeout: 15000 });
    if (!rp.error && rp.status === 0) head = String(rp.stdout || '').trim();
  } catch (_) { /* head is decorative */ }
  await writeMarker(target, dest, {
    target: 'comfy-node', classType: src.classType || null, ref: src.ref || null, head,
    steps: ['clone', ...(src.ref ? ['checkout'] : [])], at: new Date().toISOString(),
  });
}

// ── voice-engine executor (Stage 2a) ──────────────────────────────────────────
// Every voice step is a SHELL command (python -m venv, pip, git, grep -v -iE, curl, modelscope's
// python -c) — the CosyVoice-class "requirements surgery" genuinely needs a shell pipeline. Async now
// (runShell → cp.spawn): streams output + is cancellable via opts.signal, same as the ComfyUI path.
async function acquireVoiceStep(target, entry, step, opts = {}) {
  const engine = entry.install.engine;
  const pythonBin = 'python' + ((engine.venv && engine.venv.python) || '3');
  const pipBin = `${target.venvPath}/bin/pip`;
  const pyBin  = `${target.venvPath}/bin/python`;
  const ro = { signal: opts.signal, onLine: opts.onLine };   // relay cancel + streaming to every step

  switch (step.kind) {
    case 'venv':
      await runShell(target, `mkdir -p ${shQ(target.engineRoot)} && ${pythonBin} -m venv ${shQ(target.venvPath)}`, Object.assign({ label: 'venv creation' }, ro));
      return;
    case 'pip': {
      const pins = Array.isArray(engine.venv && engine.venv.pins) ? engine.venv.pins : [];
      const pkgs = [engine.pip, ...pins].filter(Boolean).map(shQ).join(' ');
      await runShell(target, `${pipBin} install ${pkgs}`, Object.assign({ label: 'pip install', timeout: 1800000 }, ro));
      return;
    }
    case 'clone': {
      const commit = engine.repo.commit;
      // Idempotent so a coarse-marker retry after a later build-step failure doesn't hit "dir exists":
      // clone only if there is no .git yet, then always (re)checkout the pinned commit.
      const cloneCmd = `[ -d ${shQ(step.to + '/.git')} ] || git clone ${shQ(engine.repo.url)} ${shQ(step.to)}`;
      const cmd = cloneCmd + (commit ? ` && git -C ${shQ(step.to)} checkout ${shQ(commit)}` : '');
      await runShell(target, cmd, Object.assign({ label: 'git clone', timeout: 600000 }, ro));
      return;
    }
    case 'submodules': {
      const subs = (engine.repo.submodules || []).map(shQ).join(' ');
      await runShell(target, `git -C ${shQ(step.to)} submodule update --init ${subs}`, Object.assign({ label: 'git submodule update', timeout: 600000 }, ro));
      return;
    }
    case 'pip-pre': {
      const pkgs = engine.requirements.pre.map(shQ).join(' ');
      await runShell(target, `${pipBin} install ${pkgs}`, Object.assign({ label: 'pip pre-install', timeout: 1800000 }, ro));
      return;
    }
    case 'requirements': {
      const repoDir = voiceRepoDir(target, engine);
      const reqPath = joinPath(target.kind, repoDir, engine.requirements.file);
      const strippedPath = reqPath + '.stripped';
      const strip = (engine.requirements.strip || []).join('|');
      // The surgery, AS ORDERED DATA: strip the listed packages out of the repo's requirements.txt
      // (grep -v -iE, case-insensitive, extended regex over the '|'-joined strip list) before install.
      const filterCmd = strip ? `grep -v -iE ${shQ(strip)} ${shQ(reqPath)} > ${shQ(strippedPath)}` : `cp ${shQ(reqPath)} ${shQ(strippedPath)}`;
      await runShell(target, `${filterCmd} && ${pipBin} install -r ${shQ(strippedPath)}`, Object.assign({ label: 'requirements install', timeout: 1800000 }, ro));
      return;
    }
    case 'pip-post': {
      const pkgs = engine.requirements.post.map(shQ).join(' ');
      await runShell(target, `${pipBin} install ${pkgs}`, Object.assign({ label: 'pip post-install', timeout: 1800000 }, ro));
      return;
    }
    case 'weights': {
      const w = engine.weights;
      const dir = target.weightsDir;
      let cmd;
      // `hf download` (huggingface_hub's CLI; the old `huggingface-cli` is a deprecated non-zero shim).
      // ModelScope path uses snapshot_download; url path a plain curl. All args shQ'd.
      if (w.source.hf) {
        cmd = `mkdir -p ${shQ(dir)} && ${pipBin.replace(/pip$/, 'hf')} download ${shQ(w.source.hf)} --local-dir ${shQ(dir)}`;
      } else if (w.source.modelscope) {
        const pyCode = `from modelscope import snapshot_download; snapshot_download(${JSON.stringify(w.source.modelscope)}, local_dir=${JSON.stringify(dir)})`;
        cmd = `mkdir -p ${shQ(dir)} && ${pyBin} -c ${shQ(pyCode)}`;
      } else if (w.source.url) {
        const filename = String(w.source.url).split('/').filter(Boolean).pop() || 'weights.bin';
        cmd = `mkdir -p ${shQ(dir)} && curl -fL -o ${shQ(dir + '/' + filename)} ${shQ(w.source.url)}`;
      } else {
        throw new Error('weights has no resolvable source');
      }
      try {
        await runShell(target, cmd, Object.assign({ label: 'weights fetch', timeout: 3600000 }, ro));
      } catch (e) {
        // Remove the dir we just mkdir'd IFF the failed download left it empty, so a bare dir can't be
        // mistaken for progress. (Presence is marker-based now, so this is hygiene, not correctness.)
        // Never touch a non-empty dir — a partial download may be worth resuming. Best-effort.
        await runShell(target, `[ -d ${shQ(dir)} ] && [ -z "$(ls -A ${shQ(dir)} 2>/dev/null)" ] && rmdir ${shQ(dir)} 2>/dev/null; true`).catch(() => {});
        throw e;
      }
      return;
    }
    default:
      throw new Error(`unknown voice step kind "${step.kind}"`);
  }
}

// ── 6. acquire(cfg, entry, {onProgress, signal}) → { done, skipped, failed, warnings } ─
// Async + cancellable + progress-reporting (spec FIX #2). Runs the same plan()-driven step loop as
// before, but every executor is now a cancellable Promise (opts.signal → SIGKILL the child) that
// streams its output lines through onProgress. Completion markers are written only on real success
// (#1/#3). onProgress phases: step-start | line | skip | done | manual | warn | error | cancelled.
async function acquire(cfg, entry, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const signal = opts.signal || null;
  const aborted = () => !!(signal && signal.aborted);
  const lineCb = (step) => (line) => onProgress({ phase: 'line', step, line });

  const p = await plan(cfg, entry);
  const { target, steps, preflight: pf } = p;

  if (target.kind === 'manual') {
    const err = new Error(target.reason || 'no acquisition target configured');
    err.manual = true;
    throw err;
  }
  if (!pf.ok) {
    const err = new Error('preflight failed: ' + pf.reason);
    err.preflight = pf;
    throw err;
  }

  const done = [], skipped = [], failed = [], warnings = [];
  const serviceType = serviceTypeFor(entry);
  const warn = (step, warning) => { warnings.push(warning); onProgress({ phase: 'warn', step, warning }); };

  if (serviceType === 'voice') {
    // Voice steps form a DEPENDENT chain (venv → pip/clone/requirements → weights). Two rules the
    // ComfyUI loop below does NOT have: (1) honor plan()'s fresh action (do NOT re-derive presence
    // live — the venv step creating its own dir would else flip pip/requirements to "skip"); (2) the
    // first failure/cancel HALTS the chain (a failed venv makes pip/weights meaningless).
    const buildKinds = new Set(['venv', 'pip', 'clone', 'submodules', 'pip-pre', 'requirements', 'pip-post']);

    for (const step of steps) {
      onProgress({ phase: 'step-start', step });

      if (aborted()) { failed.push({ name: step.name, error: 'cancelled', cancelled: true }); onProgress({ phase: 'cancelled', step }); break; }

      if (step.action === 'manual') {
        failed.push({ name: step.name, error: 'no install source declared — install manually' });
        onProgress({ phase: 'manual', step });
        break;
      }
      if (step.action === 'skip') {
        skipped.push(step.name);
        onProgress({ phase: 'skip', step });
        continue;
      }

      try {
        await acquireVoiceStep(target, entry, step, { signal, onLine: lineCb(step) });
        done.push(step.name);
        onProgress({ phase: 'done', step });
        if (step.kind === 'weights') {
          // Weights marker — written only after the weights fetch fully succeeds.
          try {
            await writeMarker(target, target.weightsDir, { target: 'voice-weights', engine: (entry.install.engine || {}).id || null, source: describeWeightsSource((entry.install.engine || {}).weights && entry.install.engine.weights.source), at: new Date().toISOString() });
          } catch (_) { /* marker write is best-effort; a failure just means the next plan re-fetches */ }
        }
      } catch (e) {
        const msg = String((e && e.message) || e);
        const cancelled = !!(e && e.cancelled) || aborted();
        failed.push({ name: step.name, error: cancelled ? 'cancelled' : msg, cancelled });
        onProgress({ phase: cancelled ? 'cancelled' : 'error', step, error: msg });
        break;
      }
    }

    // Voice-build completion marker (#1/#3): written ONLY if every build step succeeded (none in
    // failed[]) and we weren't cancelled — so a bare venv from a failed `pip install` never reads as
    // "built" on the next run (it has no marker → the whole idempotent build chain re-runs).
    const failedNames = new Set(failed.map(f => f.name));
    const buildOk = !aborted() && steps.filter(s => buildKinds.has(s.kind)).every(s => !failedNames.has(s.name));
    if (buildOk && steps.some(s => s.kind === 'venv')) {
      try {
        await writeMarker(target, target.venvPath, {
          target: 'voice-build', engine: (entry.install.engine || {}).id || null,
          buildId: voiceBuildId(entry.install.engine || {}),   // NEW-7: version identity → re-pin rebuilds
          steps: steps.filter(s => buildKinds.has(s.kind)).map(s => s.kind), at: new Date().toISOString(),
        });
      } catch (_) { /* best-effort */ }
    }

    return { done, skipped, failed, warnings };
  }

  const install = entry.install || {};
  const modelsByFilename = new Map((install.models || []).map(m => [m.filename, m]));
  const nodesByClass     = new Map((install.custom_nodes || []).map(n => [n.classType, n]));

  // L-2 (shared-repo dedup): several classTypes can point at ONE repo dir (trellis2 ships 6 → one dir).
  // The clone/adopt is idempotent, but re-running it per classType is pure waste — and on a supervisor it
  // opens a fresh `ssh -tt` session each time and prints a misleading done:N for one real fetch. So we
  // clone/adopt each dest dir ONCE per run; the sibling classTypes of that dir are satisfied by that same
  // repo and are recorded as skipped, not re-fetched. (All classTypes of a dir share plan()'s action, so
  // a dir reaching this fetch loop never has a "skip" sibling to worry about.)
  const acquiredNodeDirs = new Set();

  for (const step of steps) {
    onProgress({ phase: 'step-start', step });

    if (aborted()) { failed.push({ name: step.name, error: 'cancelled', cancelled: true }); onProgress({ phase: 'cancelled', step }); break; }

    if (step.action === 'manual') {
      failed.push({ name: step.name, error: 'no install source declared — install manually' });
      onProgress({ phase: 'manual', step });
      continue;
    }

    // Trust plan()'s FRESH action — plan() was recomputed at the top of acquire() moments ago (not the
    // client's stale snapshot), so its skip/fetch is authoritative and the exec-time re-probe would only
    // add a redundant per-item ssh handshake (NEW-4). The executors are themselves idempotent: fetchModel
    // renames only on full success, and cloneNode adopts/fetches an existing repo without ever destroying
    // it — so a benign race just re-fetches, never corrupts.
    if (step.action === 'skip') {
      skipped.push(step.name);
      onProgress({ phase: 'skip', step });
      continue;
    }

    try {
      if (step.kind === 'model') {
        const r = await fetchModel(target, modelsByFilename.get(step.name), { signal, onLine: lineCb(step) });
        if (r && r.shaWarning) warn(step, r.shaWarning);
      } else {
        // L-2: a sibling classType already clone/adopted this exact repo dir this run → don't re-run it.
        if (step.to && acquiredNodeDirs.has(step.to)) {
          skipped.push(step.name);
          onProgress({ phase: 'skip', step });
          continue;
        }
        await cloneNode(target, nodesByClass.get(step.name), { signal, onLine: lineCb(step) });
        if (step.to) acquiredNodeDirs.add(step.to);
      }
      done.push(step.name);
      onProgress({ phase: 'done', step });
    } catch (e) {
      const msg = String((e && e.message) || e);
      const cancelled = !!(e && e.cancelled) || aborted();
      failed.push({ name: step.name, error: cancelled ? 'cancelled' : msg, cancelled });
      onProgress({ phase: cancelled ? 'cancelled' : 'error', step, error: msg });
      if (cancelled) break;   // ComfyUI items are independent, but a cancel stops the whole run
    }
  }

  return { done, skipped, failed, warnings };
}

module.exports = { validateInstall, resolveTarget, preflight, plan, acquire, status };
