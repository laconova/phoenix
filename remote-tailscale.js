'use strict';

// ─── remote-tailscale.js — the Tailscale transport for R1 remote access ─────────────────────────────────────────────
// Phoenix opens a SECOND listener on 127.0.0.1:<ephemeral> (see remote-access.js) and asks the local Tailscale client to publish it
// to the tailnet over HTTPS with `tailscale serve`. This file only talks to the CLI:
//   enable({ listenerPort, savedRoute }) -> { ok, origin, hostname, port, target } | { ok:false, error:<plain sentence> }
//   disable(route)                       -> { ok, removed }   (removes ONLY a route that is still ours)
// Rules: execFile (never a shell), windowsHide, 12 s timeout; never reset / replace / remove anybody else's Serve route; never
// touch Funnel; no http fallback. The CLI call goes through ONE seam (`execFile`) so a suite can script the answers.
// Design adapted from Mr. Mak Workspace (MIT, desktop/service/mobile-tailscale.mjs) - the idea only, no code taken over.

const fs   = require('fs');
const path = require('path');

const PORTS = [8443, 8444, 8445, 8446];
const TIMEOUT_MS = 12000;

const SENTENCES = {
  notInstalled: 'Tailscale is not installed on this PC. Install it from tailscale.com, sign in, then switch Remote access on again.',
  notRunning:   'Tailscale is not running or not signed in. Open Tailscale, sign in, then switch Remote access on again.',
  noDns:        'Tailscale needs MagicDNS and HTTPS certificates enabled for your tailnet (Tailscale admin console, DNS page) - then switch Remote access on again.',
  noPort:       'Ports 8443 to 8446 of Tailscale Serve are all used by other routes. Free one (run: tailscale serve status) and try again.',
  funnel:       'Tailscale Funnel (public internet) is on for the port Phoenix would use - Phoenix refuses to share through it. Turn Funnel off for that port and try again.',
  notOurs:      'Tailscale Serve shows a route on that port that is not Phoenix\'s - Phoenix left it alone and switched Remote access off.',
  serveFailed:  'Tailscale refused to set up the private route.',
  adminHint:    ' Tailscale may need an administrator terminal for the first Serve setup.',
};

function defaultExecFile(file, args, opts) {
  return new Promise((resolve) => {
    let cp;
    try { cp = require('child_process'); } catch (e) { return resolve({ code: 'EFAIL', stdout: '', stderr: String(e && e.message || e) }); }
    try {
      cp.execFile(file, args, Object.assign({ timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, shell: false }, opts || {}), (err, stdout, stderr) => {
        if (err) return resolve({ code: err.code === undefined ? 1 : err.code, stdout: String(stdout || ''), stderr: String(stderr || '') || String(err.message || '') });
        resolve({ code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    } catch (e) { resolve({ code: (e && e.code) || 'EFAIL', stdout: '', stderr: String(e && e.message || e) }); }
  });
}

function create(opts) {
  opts = opts || {};
  let execFile = typeof opts.execFile === 'function' ? opts.execFile : defaultExecFile;   // the seam: (file, args, options) -> Promise<{code, stdout, stderr}>
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const exists = opts.exists || ((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });

  function findCli() {
    if (opts.cli) return opts.cli;
    if (platform === 'win32') {
      const pf = env.ProgramFiles || 'C:\\Program Files';
      const p = path.win32.join(pf, 'Tailscale', 'tailscale.exe');
      if (exists(p)) return p;
      return 'tailscale.exe';
    }
    return 'tailscale';
  }

  async function run(args) {
    const r = await execFile(findCli(), args, { timeout: TIMEOUT_MS, windowsHide: true });
    return r || { code: 1, stdout: '', stderr: '' };
  }
  const missing = (r) => r && (r.code === 'ENOENT' || /ENOENT|not recognized|not found/i.test(String(r.stderr || '')) && r.code !== 0 && !r.stdout);
  const parse = (s) => { try { const t = String(s || '').trim(); return t ? JSON.parse(t) : {}; } catch (_) { return null; } };

  // → { ok:true, hostname } | { ok:false, error }
  async function identity() {
    const r = await run(['status', '--json']);
    if (missing(r)) return { ok: false, error: SENTENCES.notInstalled };
    const j = parse(r.stdout);
    if (r.code !== 0 && !j) return { ok: false, error: SENTENCES.notRunning };
    if (!j || j.BackendState !== 'Running') return { ok: false, error: SENTENCES.notRunning };
    const dns = String((j.Self && j.Self.DNSName) || '').replace(/\.$/, '').toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(dns)) return { ok: false, error: SENTENCES.noDns };
    return { ok: true, hostname: dns };
  }

  async function serveStatus() {
    const r = await run(['serve', 'status', '--json']);
    const j = parse(r.stdout);
    if (r.code !== 0 || j === null || typeof j !== 'object') return null;
    return j;
  }

  const key = (host, port) => host + ':' + port;
  const norm = (u) => String(u || '').replace(/\/+$/, '').toLowerCase();
  const funnelOn = (cfg, host, port) => !!(cfg && cfg.AllowFunnel && cfg.AllowFunnel[key(host, port)]);
  const handlersOf = (cfg, host, port) => (cfg && cfg.Web && cfg.Web[key(host, port)] && cfg.Web[key(host, port)].Handlers) || null;
  // taken = anything of anybody's listens on that host:port in Serve (a Web entry or a TCP forward)
  const taken = (cfg, host, port) => !!(handlersOf(cfg, host, port) || (cfg && cfg.TCP && cfg.TCP[String(port)]));
  // ours = EXACTLY one handler "/" that proxies to our target, and no Funnel
  function ours(cfg, host, port, target) {
    const h = handlersOf(cfg, host, port);
    if (!h || funnelOn(cfg, host, port)) return false;
    const keys = Object.keys(h);
    return keys.length === 1 && keys[0] === '/' && !!h['/'] && norm(h['/'].Proxy) === norm(target);
  }

  async function enable(o) {
    o = o || {};
    const target = 'http://127.0.0.1:' + o.listenerPort;
    const id = await identity();
    if (!id.ok) return id;
    const host = id.hostname;
    const cfg0 = await serveStatus();
    if (!cfg0) return { ok: false, error: SENTENCES.serveFailed + (platform === 'win32' ? SENTENCES.adminHint : '') };
    // m2: a cookie is not port-scoped - Funnel on ANY port of this host makes the whole name public
    if (cfg0.AllowFunnel && Object.keys(cfg0.AllowFunnel).some(k => cfg0.AllowFunnel[k] && k.toLowerCase().startsWith(host + ':'))) return { ok: false, error: SENTENCES.funnel };

    let port = null;
    const saved = o.savedRoute;
    if (saved && saved.hostname === host && PORTS.includes(saved.port) && ours(cfg0, host, saved.port, saved.target)) port = saved.port;   // re-point our own route
    if (port === null && saved && saved.hostname === host && PORTS.includes(saved.port) && funnelOn(cfg0, host, saved.port) && handlersOf(cfg0, host, saved.port)
        && Object.keys(handlersOf(cfg0, host, saved.port)).length === 1 && norm((handlersOf(cfg0, host, saved.port)['/'] || {}).Proxy) === norm(saved.target)) {
      return { ok: false, error: SENTENCES.funnel };   // our old port, but somebody turned Funnel on for it
    }
    if (port === null) {
      for (const p of PORTS) { if (!taken(cfg0, host, p)) { port = p; break; } }
      if (port === null) return { ok: false, error: SENTENCES.noPort };
    }
    if (funnelOn(cfg0, host, port)) return { ok: false, error: SENTENCES.funnel };

    const r = await run(['serve', '--bg', '--yes', '--https=' + port, target]);
    if (r.code !== 0) return { ok: false, error: SENTENCES.serveFailed + (platform === 'win32' ? SENTENCES.adminHint : '') };
    if (typeof o.onRouteSet === 'function') { try { o.onRouteSet({ hostname: host, port, target }); } catch (_) {} }   // m4: recorded BEFORE the read-back

    const cfg1 = await serveStatus();
    if (!cfg1) return { ok: false, error: SENTENCES.serveFailed };
    if (funnelOn(cfg1, host, port)) return { ok: false, error: SENTENCES.funnel };   // never ours when public
    if (!ours(cfg1, host, port, target)) return { ok: false, error: SENTENCES.notOurs };
    return { ok: true, hostname: host, port, target, origin: 'https://' + host + ':' + port };
  }

  // C3: true = Funnel is on for ANY port of this host, null = could not tell (treated as "on" by the caller)
  async function hostFunnelOn(host) {
    const cfg = await serveStatus();
    if (!cfg) return null;
    return !!(cfg.AllowFunnel && Object.keys(cfg.AllowFunnel).some(k => cfg.AllowFunnel[k] && k.toLowerCase().startsWith(String(host).toLowerCase() + ':')));
  }

  // Removes the route ONLY while it is still exactly ours. { ok, removed, reason }
  async function disable(route) {
    if (!route || !route.hostname || !route.port || !route.target) return { ok: true, removed: false, reason: 'no route' };
    const cfg = await serveStatus();
    if (!cfg) return { ok: false, removed: false, reason: 'serve status failed' };
    if (!ours(cfg, route.hostname, route.port, route.target)) return { ok: true, removed: false, reason: 'not ours' };
    const r = await run(['serve', '--yes', '--https=' + route.port, 'off']);
    return { ok: r.code === 0, removed: r.code === 0, reason: r.code === 0 ? '' : 'serve off failed' };
  }

  return { enable, disable, funnelOn: hostFunnelOn, identity, serveStatus, PORTS, setExecFile(fn) { execFile = typeof fn === 'function' ? fn : defaultExecFile; }, _ours: ours, SENTENCES };
}

module.exports = { create, PORTS, SENTENCES };
