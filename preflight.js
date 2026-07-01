'use strict';

// preflight.js — dependency health check for the Phoenix agent
// Reads endpoints and model names from phoenix-config.json; no hardcoded values.
// Uses only Node built-ins: fs, path, http, https, net, child_process.

const fs           = require('fs');
const path         = require('path');
const http         = require('http');
const https        = require('https');
const { spawnSync } = require('child_process');
const { callBlender, ipcDir } = require('./blender-ipc');

// ─── Config path (constant — no side effects) ─────────────────────────────────

const CONFIG_FILE = path.join(__dirname, 'phoenix-config.json');

// ─── HTTP helper (built-in, no node-fetch) ────────────────────────────────────

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod     = url.startsWith('https') ? https : http;
    const timer   = setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, timeoutMs);
    const req     = mod.get(url, res => {
      clearTimeout(timer);
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', ()  => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ─── Main exported function ───────────────────────────────────────────────────

async function runPreflight({ exitOnFail = false } = {}) {
  // Load config
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error('[FAIL] Cannot read phoenix-config.json: ' + e.message);
    return { passed: 0, total: 0 };
  }

  // Compute constants (same defaults as before)
  const LOCAL_BASE         = cfg.endpoints && cfg.endpoints.local   || 'http://localhost:1234/v1';
  const COMFYUI_BASE       = cfg.endpoints && cfg.endpoints.comfyui || 'http://localhost:8000';
  const METAPROMPTER_MODEL = cfg.seats     && cfg.seats.metaprompter && cfg.seats.metaprompter.model || 'google/gemma-4-e4b';
  const ORCHESTRATOR_MODEL = cfg.seats     && cfg.seats.orchestrator && cfg.seats.orchestrator.model || 'claude-sonnet-4-6';
  const EXPECTED = (cfg.preflight && cfg.preflight.expected) || {};

  // ─── Individual checks (closures over the consts above) ──────────────────────

  async function checkLocalLLM() {
    const label = 'Local LLM';
    const url   = `${LOCAL_BASE}/models`;
    try {
      const { status, body } = await httpGet(url, 5000);
      if (status < 200 || status >= 300) {
        console.log(`[FAIL] ${label} — HTTP ${status} from ${url}`);
        return false;
      }
      let data;
      try { data = JSON.parse(body); } catch {
        console.log(`[FAIL] ${label} — non-JSON response from ${url}`);
        return false;
      }
      // OpenAI-style: { data: [ { id: "..." }, ... ] }
      const models = Array.isArray(data.data) ? data.data.map(m => m.id || m.name || String(m)) :
                     Array.isArray(data)       ? data.map(m => m.id || m.name || String(m))      : [];
      if (models.some(id => id === METAPROMPTER_MODEL)) {
        console.log(`[PASS] ${label} — ${url} reachable; model '${METAPROMPTER_MODEL}' loaded`);
        return true;
      } else {
        const listed = models.length ? models.join(', ') : '(empty list)';
        console.log(`[WARN] ${label} — endpoint up but expected model '${METAPROMPTER_MODEL}' not loaded (found: ${listed})`);
        return false;
      }
    } catch (e) {
      console.log(`[FAIL] ${label} — NOT REACHABLE (${e.message})`);
      return false;
    }
  }

  async function checkComfyUI() {
    const label    = 'ComfyUI';
    const primary  = `${COMFYUI_BASE}/system_stats`;
    const fallback = `${COMFYUI_BASE}/`;
    try {
      let res = await httpGet(primary, 5000);

      // Try to parse the system_stats body for env versions (wheelcheck).
      if (res.status >= 200 && res.status < 300) {
        let stats = null;
        try { stats = JSON.parse(res.body); } catch { /* not json — fall through */ }
        if (stats && stats.system) {
          const sys      = stats.system;
          const comfyVer = sys.comfyui_version || '?';
          const py       = (sys.python_version || '').split(' ')[0] || '?';
          const torchRaw = sys.pytorch_version || '';
          const torch    = torchRaw.split('+')[0] || '?';
          const cuda     = torchRaw.includes('+') ? torchRaw.split('+')[1] : '?';
          const dev      = (stats.devices && stats.devices[0]) ? stats.devices[0] : null;
          const devStr   = dev ? `${dev.name}${dev.vram_total ? ` (${(dev.vram_total / 1e9).toFixed(1)} GB)` : ''}` : 'no device';

          console.log(`[PASS] ${label} — ${COMFYUI_BASE} responded (HTTP ${res.status})`);
          console.log(`       ComfyUI ${comfyVer} · Python ${py} · PyTorch ${torch} (${cuda}) · ${devStr}`);

          // Wheelcheck: warn on drift from expected (prefix/substring match)
          if (EXPECTED.python  && !py.startsWith(EXPECTED.python))
            console.log(`[WARN] ComfyUI env — Python ${py} ≠ expected ${EXPECTED.python} (custom CUDA wheels may break)`);
          if (EXPECTED.pytorch && !torch.startsWith(EXPECTED.pytorch))
            console.log(`[WARN] ComfyUI env — PyTorch ${torch} ≠ expected ${EXPECTED.pytorch} (custom CUDA wheels may break)`);
          if (EXPECTED.cuda    && cuda !== '?' && !cuda.includes(EXPECTED.cuda))
            console.log(`[WARN] ComfyUI env — CUDA ${cuda} ≠ expected ${EXPECTED.cuda} (custom CUDA wheels may break)`);

          return true;
        }
      }

      // 404 (older ComfyUI without /system_stats) → fall back to root
      if (res.status === 404) res = await httpGet(fallback, 5000);

      if (res.status >= 200 && res.status < 400) {
        console.log(`[PASS] ${label} — ${COMFYUI_BASE} responded (HTTP ${res.status})`);
        return true;
      }
      console.log(`[FAIL] ${label} — HTTP ${res.status} from ${COMFYUI_BASE}`);
      return false;
    } catch (e) {
      console.log(`[FAIL] ${label} — NOT REACHABLE (${e.message})`);
      return false;
    }
  }

  async function checkBlender() {
    const label = 'Blender IPC (file-based)';
    try {
      const r = await callBlender(
        "import bpy\nprint('BLENDER_VERSION:' + bpy.app.version_string)",
        { timeoutMs: 8000 });
      if (r.status === 'error') {
        const last = (r.message || '').trim().split('\n').pop();
        console.log(`[FAIL] ${label} — addon responded with an error: ${last}`);
        return false;
      }
      const m   = /BLENDER_VERSION:([^\s]+)/.exec(r.stdout || '');
      const ver = m ? m[1] : null;
      if (ver) {
        console.log(`[PASS] ${label} — addon responded · Blender ${ver}`);
        if (EXPECTED.blender && !ver.startsWith(EXPECTED.blender))
          console.log(`[WARN] Blender — running ${ver} ≠ expected ${EXPECTED.blender} (config/runtime drift)`);
      } else {
        console.log(`[PASS] ${label} — reachable (version unknown)`);
      }
      return true;
    } catch (err) {
      const reason = /not responding/i.test(err.message)
        ? 'Blender not open, or the Phoenix IPC addon is not enabled'
        : err.message;
      console.log(`[FAIL] ${label} — NOT REACHABLE (${reason})`);
      return false;
    }
  }

  function checkClaudeCLI() {
    const label = 'Claude CLI';
    try {
      // shell:true on Windows — `claude` is often a .cmd shim the OS loader can't exec directly (ENOENT otherwise). No-op on POSIX.
      const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 8000, shell: process.platform === 'win32' });
      if (r.error) {
        console.log(`[FAIL] ${label} — NOT REACHABLE (${r.error.message})`);
        return false;
      }
      if (r.status !== 0) {
        console.log(`[FAIL] ${label} — exited ${r.status}: ${(r.stderr || '').trim()}`);
        return false;
      }
      const version = (r.stdout || '').trim() || (r.stderr || '').trim() || '(unknown)';
      console.log(`[PASS] ${label} — ${version}`);
      console.log(`       orchestrator model (from config): ${ORCHESTRATOR_MODEL}`);
      return true;
    } catch (e) {
      console.log(`[FAIL] ${label} — NOT REACHABLE (${e.message})`);
      return false;
    }
  }

  function checkBlenderExePath() {
    const label = 'Blender exe (config)';
    const p = cfg.apps && cfg.apps.blender;
    if (!p) {
      console.log(`[INFO] ${label} — not configured (apps.blender unset)`);
      return;
    }
    if (fs.existsSync(p)) {
      console.log(`[PASS] ${label} — ${p}`);
    } else {
      console.log(`[WARN] ${label} — configured path not found: ${p}`);
    }
  }

  // ─── Header + checks ─────────────────────────────────────────────────────────

  console.log('=== Phoenix Agent Dependency Preflight ===\n');
  console.log(`Phoenix version    : ${cfg.version || '(unset)'}`);
  console.log(`Config: ${CONFIG_FILE}`);
  console.log(`Local LLM endpoint : ${LOCAL_BASE}`);
  console.log(`ComfyUI endpoint   : ${COMFYUI_BASE}`);
  console.log(`Metaprompter model : ${METAPROMPTER_MODEL}`);
  console.log(`Orchestrator model : ${ORCHESTRATOR_MODEL}`);
  console.log(`Blender IPC dir    : ${ipcDir(cfg)}`);
  console.log('');

  // Run all checks; failures are isolated — one down check never crashes the others.
  const [r1, r2, r3, r4] = await Promise.all([
    checkLocalLLM().catch(e => { console.log(`[FAIL] Local LLM — unexpected error: ${e.message}`); return false; }),
    checkComfyUI().catch(e  => { console.log(`[FAIL] ComfyUI — unexpected error: ${e.message}`);   return false; }),
    checkBlender().catch(e  => { console.log(`[FAIL] Blender IPC — unexpected error: ${e.message}`); return false; }),
    Promise.resolve(checkClaudeCLI()),
  ]);

  checkBlenderExePath();

  const passed  = [r1, r2, r3, r4].filter(Boolean).length;
  const total   = 4;
  console.log(`\n${passed}/${total} checks passed`);

  return { passed, total };
}

// ─── Standalone CLI entry point ───────────────────────────────────────────────

if (require.main === module) {
  runPreflight().then(({ passed, total }) => process.exit(total > 0 && passed === total ? 0 : 1));
}

module.exports = { runPreflight };
