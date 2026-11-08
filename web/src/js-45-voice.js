      // ── Audio workspace (R5b) + Settings > Voice engines (VO1b) ─────────────────────────────────────────────────
      // Two things live here: the Audio workspace (Speak a line, Cast a new voice and Sound effects as modes of ONE panel; the r5b-audio block)
      // and Settings > Voice engines (engines, install folder, watermark, the one-time cloning consent; the vo1b-ui block, unchanged).

      // <vo1b-ui>
      // ── Settings -> Voice engines + the one-time cloning consent (VO1b) ─────────────────────────────────────
      // makeVoiceSettings(deps) draws the "Voice engines on this PC" pane from the /config `voice` view and saves each change
      // at once (POST /config {voice:{…}}). It also owns the consent dialog the Voice tab asks before the first Chatterbox take /
      // before opening the reference folder: the answer is stored server-side (voice.consentAck), so it survives browsers.
      // deps: { document, fetch, flash?, refreshEngines? } - no native dialog: the consent and the watermark question are inline rows.
      function makeVoiceSettings(deps) {
        const d = deps.document, $ = function (id) { return d.getElementById(id); };
        const CONSENT_TEXT = "Only use your own voice, or a voice you have the person's consent for. Generated speech is marked as AI by default.";
        const WM_OFF_TEXT = 'Recommended. Turn off only for your own private use.';
        const LOCKED_TEXT = 'Locked: voice runs on a separate voice server (voice.dispatcher in phoenix-config.json). Remove that line to run the voice engines on this PC.';
        let view = null, consent = null;
        function showErr(msg) { const e = $('vs-err'); if (!e) return; e.textContent = msg || ''; e.hidden = !msg; }
        function diskLine(v) {
          const free = (typeof v.freeGb === 'number') ? (v.freeGb + ' GB') : 'unknown';
          return 'Chatterbox needs about ' + (v.needGb || 9) + ' GB here (5.4 GB Python + CUDA libraries, 3.2 GB voice model). Free on this drive: ' + free +
            '. ComfyUI models need far more — put both on a drive with room.';
        }
        function render(v) {
          if (!v) return;
          view = v; consent = v.consentAck === true;
          const sw = $('vs-local'), lab = $('vs-local-label'), root = $('vs-root'), port = $('vs-port'), wm = $('vs-watermark'), dk = $('vs-disk');
          if (sw) { sw.checked = v.dispatcherLocal === true || v.rig === true; sw.disabled = v.rig === true; }
          if (port) port.disabled = !(v.dispatcherLocal === true);   // R3-M2: the port only exists while the engines run on this PC
          if (lab) lab.textContent = v.rig === true ? 'Separate voice server (set in phoenix-config.json)' : 'Run voice engines on this PC';
          { const lk = $('vs-locked'), sh = $('vs-save-hint');   // <lc2d-locked> T8-4: a locked switch says why and how to change it; the "saves immediately" hint is for switches that can be changed
            if (lk) { lk.textContent = v.rig === true ? LOCKED_TEXT : ''; lk.hidden = v.rig !== true; }
            if (sh) sh.hidden = v.rig === true; }
          if (root) root.value = v.installRoot || '';
          if (port) port.value = v.port || 8091;
          if (wm) wm.checked = v.watermark !== false;
          if (dk) dk.textContent = diskLine(v);
        }
        async function post(body) {
          try {
            const r = await deps.fetch('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: body }) });
            let j = {}; try { j = await r.json(); } catch (_) {}
            if (r && r.ok === false) { showErr((j && j.error ? j.error : 'The server refused the voice settings (' + r.status + ').') + ' — not saved.'); await loadVoiceView(); return false; }
            showErr('');
            if (deps.flash && body && !('consentAck' in body)) deps.flash();   // R2: the Settings header's "Saved ✓"
            // <lc2c-engine-refresh> the engine switch / folder / port changed what the engines can do: the Workflows list and the Voice/SFX panels re-read it now (same as a tab switch), once per saved change
            if (body && ('dispatcherLocal' in body || 'installRoot' in body || 'port' in body)) { try { if (deps.refreshEngines) deps.refreshEngines(); } catch (_) {} }
            if (j && j.voice) {
              render(j.voice);
              retryIfUnknown(j.voice);
              const w = $('vs-root-warn');
              if (w) { const rc = j.voice.rootChanged; w.textContent = rc ? rc.warning : ''; w.hidden = !rc; }
            }
            return true;
          } catch (_) { showErr('Could not reach Phoenix — not saved.'); return false; }
        }
        // R2: the one save signal is the Settings header's "Saved ✓" (deps.flash, above); this pane shows failures only
        let retryPending = false;
        // the server measures free space off the request: an "unknown" figure is asked for once more shortly after (load AND post paths)
        function retryIfUnknown(v) {
          if (v && v.freeGb == null && !retryPending && typeof setTimeout === 'function') { retryPending = true; setTimeout(function () { retryPending = false; loadVoiceView(true); }, 700); }
        }
        async function loadVoiceView(isRetry) {
          try {
            const r = await deps.fetch('/config'); if (r && r.ok === false) return; const c = await r.json();
            if (c && c.voice) {
              render(c.voice);
              if (!isRetry) retryIfUnknown(c.voice);
            }
          } catch (_) {}
        }
        // The one-time consent: resolves true when acknowledged (now or before), false when the user declines.
        let consentP = null;   // ONE in-flight consent (inline row + save) shared by every caller
        // an inline question row: <div data-inline=kind role=group> <p>text</p> [ok] [cancel] </div>
        function inlineRow(kind, label, text, okText, okClass, noText, noClass) {
          const row = d.createElement('div'); row.setAttribute('data-inline', kind); row.setAttribute('role', 'group'); row.setAttribute('aria-label', label);
          const t = d.createElement('p'); t.textContent = text; row.appendChild(t);
          const mk = function (act, txt, cls) { const b = d.createElement('button'); b.type = 'button'; b.setAttribute('type', 'button'); b.className = cls; b.setAttribute('data-inline-act', act); b.textContent = txt; row.appendChild(b); return b; };
          return { row: row, ok: mk('ok', okText, okClass), cancel: mk('cancel', noText, noClass) };
        }
        function dropRow(row) { if (row && row.parentNode) row.parentNode.removeChild(row); }
        function ensureConsent(anchor) {
          if (consent === true) return Promise.resolve(true);
          if (consentP) return consentP;
          const p = new Promise(function (resolve) {
            const panel = $('panel-audio'), ir = inlineRow('consent', 'Voice consent', CONSENT_TEXT, 'I understand', 'btn btn-primary btn-sm', 'Cancel', 'btn btn-secondary btn-sm');
            if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(ir.row, anchor.nextSibling || null);
            else if (panel) panel.insertBefore(ir.row, panel.firstChild || null);
            else { resolve(false); return; }
            ir.cancel.addEventListener('click', function () { dropRow(ir.row); resolve(false); });
            ir.ok.addEventListener('click', function () {
              dropRow(ir.row);
              post({ consentAck: true }).then(function (ok) { if (ok) consent = true; resolve(ok); }, function () { resolve(false); });
            });
          });
          consentP = p;   // assigned FIRST; cleared by the attached handler (a synchronous decline can no longer leave a stale resolved false behind)
          const clear = function () { if (consentP === p) consentP = null; };
          p.then(clear, clear);
          return p;
        }
        function wire() {
          const sw = $('vs-local'), root = $('vs-root'), port = $('vs-port'), wm = $('vs-watermark');
          if (sw) sw.addEventListener('change', function () { post({ dispatcherLocal: !!sw.checked }); });
          if (root) {   // R2: the install folder saves on Enter / leaving the field (there is no Change button), only when it differs from the stored one
            const saveRoot = function () { if (view && root.value === (view.installRoot || '')) return; post({ installRoot: root.value }); };
            root.addEventListener('change', saveRoot);
            root.addEventListener('keydown', function (e) { if (e.key === 'Enter') { if (e.preventDefault) e.preventDefault(); saveRoot(); } });
          }
          if (port) port.addEventListener('change', function () { post({ port: Number(port.value) }); });
          let wmRow = null;
          if (wm) wm.addEventListener('change', function () {
            dropRow(wmRow); wmRow = null;
            if (wm.checked) { post({ watermark: true }); return; }
            const host = wm.parentNode, ir = inlineRow('watermark', 'Turn the watermark off', WM_OFF_TEXT, 'Turn the watermark off', 'btn btn-danger btn-sm', 'Keep it on', 'btn btn-secondary btn-sm');
            if (host && host.parentNode) host.parentNode.insertBefore(ir.row, host.nextSibling || null);
            wmRow = ir.row;
            ir.cancel.addEventListener('click', function () { dropRow(ir.row); wmRow = null; wm.checked = true; });
            ir.ok.addEventListener('click', function () { dropRow(ir.row); wmRow = null; post({ watermark: false }); });
          });
        }
        return { render: render, load: loadVoiceView, post: post, wire: wire, ensureConsent: ensureConsent, setConsent: function (b) { consent = b === true; }, CONSENT_TEXT: CONSENT_TEXT };
      }
      if (typeof window !== 'undefined' && document.getElementById('vs-local')) {
        window.__voSettings = makeVoiceSettings({ document: document, fetch: function () { return fetch.apply(null, arguments); },
          flash: function () { if (typeof flashSettingsSaved === 'function') flashSettingsSaved(); },
          refreshEngines: function () {   // <lc2c-engine-refresh>
            try { if (window.__reloadLibraryWorkflows) window.__reloadLibraryWorkflows(); } catch (_) {}
            try { if (window.__voRefresh) window.__voRefresh(); } catch (_) {}
            try { if (window.__sxRefresh) window.__sxRefresh(); } catch (_) {}
          } });
        window.__voSettings.wire();
      }
      // </vo1b-ui>

      // <r5b-audio>
      // ── Audio workspace (v1.10.1 R5b): Speak a line · Cast a new voice · Sound effects, three modes of ONE panel (#panel-audio) ───────────────
      // Every mode: inputs → the one effect rack → primary action → status line → connection line → takes desk. Each mode loads when it is shown
      // (setMode), never through a hidden tab click. Timers only through deps.visiblePoll (the card line, the dispatcher line - while their
      // workspace is visible) and deps.jobClock (a running job and a dispatcher restart - until they end). All text via textContent.
      // deps: { document, root, fetch, visiblePoll(ws, fn, ms), jobClock(fn, ms), storage(), ensureConsent(anchorButton), openSettings(section), voiceEngine(),
      //         makeEffectRack, rackChainLine, cardStatusText(health), cardWaitReason(health, action), wave(url), now(), voiceState?(state) }
      //   -> { setMode, mode, enter, refresh, loaded, setControl, control, desk, rack, onEngineChange, job }

      // n peaks (0..1) of a PCM WAV (16-bit, 8-bit or 32-bit float); [] when the buffer is not one
      function wavPeaks(arrayBuffer, n) {
        const out = [];
        try {
          const dv = new DataView(arrayBuffer), len = dv.byteLength;
          if (len < 44 || dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645) return out;
          let pos = 12, fmt = 1, bits = 16, ch = 1, start = -1, size = 0;
          while (pos + 8 <= len) {
            const id = dv.getUint32(pos, false), sz = dv.getUint32(pos + 4, true);
            if (id === 0x666d7420) { fmt = dv.getUint16(pos + 8, true); ch = Math.max(1, dv.getUint16(pos + 10, true)); bits = dv.getUint16(pos + 22, true); }
            else if (id === 0x64617461) { start = pos + 8; size = Math.min(sz, len - start); break; }
            pos += 8 + sz + (sz % 2);
          }
          const bytes = bits >> 3;
          if (start < 0 || !n || n < 1 || (bytes !== 1 && bytes !== 2 && !(bytes === 4 && fmt === 3))) return out;
          const frames = Math.floor(size / (bytes * ch));
          if (frames < 1) return out;
          let top = 0;
          for (let i = 0; i < n; i++) {
            const a = Math.floor(i * frames / n), b = Math.max(a + 1, Math.floor((i + 1) * frames / n));
            let pk = 0;
            for (let f = a; f < b && f < frames; f++) {
              const at = start + f * bytes * ch;
              let v = 0;
              if (bytes === 2) v = Math.abs(dv.getInt16(at, true)) / 32768;
              else if (bytes === 1) v = Math.abs(dv.getUint8(at) - 128) / 128;
              else v = Math.abs(dv.getFloat32(at, true));
              if (v > pk) pk = v;
            }
            out.push(pk); if (pk > top) top = pk;
          }
          if (top > 0) for (let i = 0; i < out.length; i++) out[i] = Math.round(out[i] / top * 1000) / 1000;
        } catch (_) { return []; }
        return out;
      }

      function makeAudioWs(deps) {
        const doc = deps.document, root = deps.root;
        const MODES = ['speak', 'cast', 'sfx'];
        const DESK_KEY = 'phoenix.audio.desk.v1', DESK_MAX = 50;
        const CONN = 'connected · ';
        const ENGINE_LABEL = { crispasr: 'CrispASR', chatterbox: 'Chatterbox' };
        let mode = 'speak', ctl = 'fader';
        const loaded = { speak: false, cast: false, sfx: false };

        function el(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
        function btn(text, variant, small, id) {
          const b = el('button', 'btn ' + variant + (small ? ' btn-sm' : ''), text); b.type = 'button'; b.setAttribute('type', 'button');
          if (id) b.id = id;
          return b;
        }
        function field(labelText, control, forId, cls) {
          const f = el('div', 'au-field' + (cls ? ' ' + cls : ''));
          const l = el('label', null, labelText); l.setAttribute('for', forId); l.htmlFor = forId;
          f.appendChild(l); f.appendChild(control);
          return f;
        }
        function input(id, type, cls) { const i = el('input', cls || 'au-text'); i.id = id; i.type = type; i.setAttribute('type', type); return i; }
        function numberInput(id, value, min, max) {
          const i = input(id, 'number', 'au-num'); i.value = String(value);
          if (min != null) { i.min = String(min); i.setAttribute('min', String(min)); }
          if (max != null) { i.max = String(max); i.setAttribute('max', String(max)); }
          return i;
        }
        function area(id, rows) { const a = el('textarea', 'au-area'); a.id = id; a.rows = rows || 3; a.setAttribute('rows', String(rows || 3)); return a; }
        function line(id, cls, role) { const d = el('div', cls); d.id = id; if (role) d.setAttribute('role', role); return d; }
        function sw(id, text) {   // an on/off switch: a button with role=switch (never a checkbox)
          const b = btn(text, 'btn-ghost', true, id); b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', 'false');
          b.addEventListener('click', function () { b.setAttribute('aria-checked', b.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); });
          return b;
        }
        const isOn = function (b) { return b.getAttribute('aria-checked') === 'true'; };
        function nowDate() { try { const d = deps.now(); return d instanceof Date ? d : new Date(); } catch (_) { return new Date(); } }
        function peekWait(health, action) { try { return deps.cardWaitReason(health, action); } catch (_) { return null; } }
        function cardText(health) { try { return deps.cardStatusText(health) || ''; } catch (_) { return ''; } }
        function chainLineOf(chain, catalogue) { try { return deps.rackChainLine(chain, catalogue); } catch (_) { return chain ? '' : 'dry'; } }
        function getJson(r) { return r.json(); }
        function postJson(url, body) {
          const o = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
          if (body !== undefined) o.body = JSON.stringify(body);
          return deps.fetch(url, o).then(getJson);
        }

        const player = el('audio'); player.id = 'au-player'; player.hidden = true; player.setAttribute('controls', '');
        function play(url) {
          player.src = url; player.hidden = false;
          try { const r = player.play(); if (r && r.catch) r.catch(function () {}); } catch (_) { /* no audio output is not an error */ }
        }

        // ── the takes desk store: { speak: [], cast: [], sfx: [] }, newest first, per viewer ──
        function store() { try { return deps.storage ? deps.storage() : null; } catch (_) { return null; } }
        const deskData = { speak: [], cast: [], sfx: [] };
        (function readDesk() {
          try {
            const st = store(), raw = st && st.getItem(DESK_KEY), o = raw ? JSON.parse(raw) : null;
            if (o && typeof o === 'object') MODES.forEach(function (m) {
              if (Array.isArray(o[m])) deskData[m] = o[m].filter(function (e) { return e && typeof e === 'object' && typeof e.url === 'string' && e.url; }).slice(0, DESK_MAX);
            });
          } catch (_) { /* broken storage: an empty desk */ }
        })();
        function writeDesk() { try { const st = store(); if (st) st.setItem(DESK_KEY, JSON.stringify(deskData)); } catch (_) { /* a view, not data */ } }

        // ── the sections ──
        const benchPlay = {}, tiles = {}, sections = {}, statusEl = {}, connEl = {}, benchEl = {}, racks = {}, deskEl = {}, cats = { speak: [], cast: [], sfx: [] };   // cats: the effect catalogue each mode last saw
        function makeSection(m) {
          const s = el('div', 'au-mode'); s.id = 'au-mode-' + m; s.setAttribute('data-mode', m); s.hidden = m !== 'speak';
          sections[m] = s;
          return s;
        }
        function addTail(m) {   // the mode's rack (its own instance of the one component); the caller places the returned root
          const rk = el('div', 'au-rack'); rk.id = 'au-rack-' + m;
          racks[m] = deps.makeEffectRack({ document: doc, root: rk, catalogue: [], control: ctl, onChange: function () {} });
          return rk;
        }
        function addStatus(m, s) {
          statusEl[m] = line('au-status-' + m, 'au-status', 'status'); s.appendChild(statusEl[m]);
          connEl[m] = line('au-conn-' + m, 'au-conn'); s.appendChild(connEl[m]);
        }
        function addDesk(m, s) { const d = line('au-desk-' + m, 'au-desk'); deskEl[m] = d; s.appendChild(d); }
        function setStatus(m, t) { if (statusEl[m]) statusEl[m].textContent = t || ''; }

        // ═════ Speak a line ═════
        const spk = makeSection('speak');
        const selVoice = el('select', 'au-select'); selVoice.id = 'au-voice';
        const lineEl = area('au-line', 4);
        const seedEl = numberInput('vo-seed', '', 0, 2147483647); seedEl.placeholder = 'random'; seedEl.setAttribute('placeholder', 'random'); seedEl.step = '1'; seedEl.setAttribute('step', '1');
        const reuseBtn = btn('Keep seed', 'btn-ghost', true, 'vo-seed-reuse'); reuseBtn.hidden = true;
        const speakBtn = btn('Speak', 'btn-primary', false, 'au-speak');
        const hintEl = line('au-speak-hint', 'au-hint');
        const wmEl = el('span', 'au-wm'); wmEl.id = 'au-wm'; const wmDot = el('span', 'au-wm-dot'); const wmTxt = el('span', null, ''); wmEl.appendChild(wmDot); wmEl.appendChild(wmTxt);
        const wmLink = btn('Voice engines settings', 'btn-ghost', true, 'au-wm-link');
        const dispBox = line('au-disp', 'au-disp'); dispBox.hidden = true;
        const dispTxt = el('span', null, ''); dispTxt.id = 'au-disp-text';
        const dispRestart = btn('Restart', 'btn-secondary', true, 'au-disp-restart');
        const dispLogBtn = btn('Show log', 'btn-ghost', true, 'au-disp-logbtn');
        const dispLog = el('pre', 'au-log'); dispLog.id = 'au-disp-log'; dispLog.hidden = true;
        dispBox.appendChild(dispTxt); dispBox.appendChild(dispRestart); dispBox.appendChild(dispLogBtn); dispBox.appendChild(dispLog);
        (function buildSpeak() {
          const engineLine = doc.getElementById('voice-engine-line');   // the static default-engine line of 02-body.html moves in here
          if (engineLine) spk.appendChild(engineLine);
          const top = el('div', 'au-row');
          top.appendChild(field('Voice', selVoice, 'au-voice'));
          const lf = field('Line', lineEl, 'au-line', 'au-grow'); top.appendChild(lf);
          spk.appendChild(top);
          const seedRow = el('div', 'au-row au-center');
          seedRow.appendChild(field('Seed', seedEl, 'vo-seed')); seedRow.appendChild(reuseBtn);
          spk.appendChild(seedRow);
          spk.appendChild(addTail('speak'));
          const act = el('div', 'au-row au-center');
          act.appendChild(speakBtn); act.appendChild(hintEl); act.appendChild(wmEl); act.appendChild(wmLink);
          spk.appendChild(act);
          addStatus('speak', spk);
          spk.appendChild(dispBox);
          addDesk('speak', spk);
        })();

        // the voice picker: one <select> grouped by engine; choices = the enabled options [{ value, engine }]
        let choices = [], vsLast = null, userPicked = false, dispMode = 'off', lastSeed = null;
        function parseChoice(v) {
          const s = String(v == null ? '' : v), i = s.indexOf('|');
          if (i < 0) return null;
          const rest = s.slice(i + 1), k = rest.indexOf(':');
          return k < 0 ? null : { engine: s.slice(0, i), kind: rest.slice(0, k), name: rest.slice(k + 1) };
        }
        function selectedEngine() { const c = parseChoice(selVoice.value); return c ? c.engine : (deps.voiceEngine ? deps.voiceEngine() : 'crispasr'); }
        function defaultChoice() {
          const pref = deps.voiceEngine ? deps.voiceEngine() : 'crispasr';
          // rig mode + Chatterbox: the first rig voice wins (it needs no reference and no consent); local mode keeps the first reference
          if (pref === 'chatterbox' && vsLast && vsLast.dispatcher && vsLast.dispatcher.mode === 'rig') {
            const rv = choices.find(function (c) { return c.engine === 'chatterbox' && c.value.indexOf('chatterbox|voice:') === 0; });
            if (rv) return rv;
          }
          return choices.find(function (c) { return c.engine === pref; }) || choices[0] || null;
        }
        function updateSeed() {
          const isPack = selectedEngine() === 'crispasr';
          seedEl.disabled = isPack;
          seedEl.title = isPack ? 'Voice packs (CrispASR) always sound the same — seed applies to Chatterbox' : '';
          hintEl.textContent = selectedEngine() !== 'crispasr' ? 'First take loads the model (~30 s)' : '';
        }
        function buildPicker(j) {
          const keep = selVoice.value;
          selVoice.textContent = ''; choices = [];
          const voices = Array.isArray(j.voices) ? j.voices : [], engines = Array.isArray(j.engines) ? j.engines : [];
          const group = function (label, id, disabled) {
            const g = el('optgroup'); g.setAttribute('label', label); g.setAttribute('data-engine', id); if (disabled) g.setAttribute('disabled', '');
            selVoice.appendChild(g); return g;
          };
          const opt = function (g, value, text, disabled) {
            const o = el('option', null, text); if (value != null) o.value = value; if (disabled) o.setAttribute('disabled', '');
            g.appendChild(o); if (!disabled) choices.push({ value: value, engine: g.getAttribute('data-engine') });
          };
          if ((j.health && j.health.ok) || voices.length) {
            const g = group('CrispASR packs', 'crispasr', false);
            voices.forEach(function (v) { opt(g, 'crispasr|voice:' + v.name, v.name, false); });
          }
          const cb = engines.find(function (e) { return e && e.id === 'chatterbox'; });
          if (cb && cb.available) {
            const g = group('Chatterbox · your references', 'chatterbox', false);
            const files = (j.refs && Array.isArray(j.refs.files)) ? j.refs.files : [];
            files.forEach(function (f) { opt(g, 'chatterbox|ref:' + f, f, false); });
            if (j.dispatcher && j.dispatcher.mode === 'rig') voices.forEach(function (v) { opt(g, 'chatterbox|voice:' + v.name, v.name + ' (server)', false); });
            if (!g.children.length) opt(g, null, 'No reference voices yet — add one in Cast a new voice', true);
          }
          engines.forEach(function (e) {
            if (!e || e.available !== false) return;
            const g = group((e.label || e.id) + ' · not available', e.id, true);
            opt(g, null, e.blockedReason || 'not available', true);
          });
          const stay = keep && choices.find(function (c) { return c.value === keep; });
          const pick = stay || defaultChoice();
          selVoice.value = pick ? pick.value : '';
          updateSeed();
        }
        selVoice.addEventListener('change', function () { userPicked = true; updateSeed(); });
        reuseBtn.addEventListener('click', function () { if (lastSeed != null) seedEl.value = String(lastSeed); });
        wmLink.addEventListener('click', function () { try { deps.openSettings('voice'); } catch (_) {} });

        function renderWm(on) { wmEl.setAttribute('data-on', on ? 'true' : 'false'); wmTxt.textContent = on ? 'AI watermark on' : 'AI watermark off'; }
        renderWm(true);

        // the local dispatcher line (only in local mode)
        let logOpen = false;
        function dispLine(d) {
          if (d.state === 'running') return 'Dispatcher: running on 127.0.0.1:' + d.port;
          if (d.state === 'starting') return 'Dispatcher: starting…';
          if (d.state === 'error') return 'Dispatcher: error — ' + (d.reason || 'unknown');
          return 'Dispatcher: stopped';
        }
        function renderDisp(d) {
          d = d && typeof d === 'object' ? d : { mode: 'off' };
          dispMode = d.mode || 'off';
          dispBox.hidden = dispMode !== 'local';
          if (dispMode === 'local') { dispTxt.textContent = dispLine(d); dispLog.textContent = (d.lastLines || []).join('\n'); }
          dispLog.hidden = !(dispMode === 'local' && logOpen);
          dispLogBtn.textContent = logOpen ? 'Hide log' : 'Show log';
          if (vsLast) vsLast.dispatcher = d;
        }
        let dispBusy = false;
        async function readDisp() {
          try { const j = await (await deps.fetch('/voice/dispatcher')).json(); renderDisp(j); return j; } catch (_) { return null; }
        }
        async function dispTick() {
          if (mode !== 'speak' || dispMode !== 'local' || dispBusy) return;
          dispBusy = true;
          try { await readDisp(); } finally { dispBusy = false; }
        }
        let restartClock = null;
        dispRestart.addEventListener('click', async function () {
          try { await deps.fetch('/voice/dispatcher/restart', { method: 'POST' }); } catch (_) { /* the re-read below shows the truth */ }
          if (restartClock) { restartClock.stop(); restartClock = null; }
          let j = await readDisp(), reads = 1, busy = false;
          if (!j || j.state !== 'starting') return;
          restartClock = deps.jobClock(async function () {   // one read after another until it is not starting any more (at most 20 reads)
            if (busy) return;
            busy = true;
            try { const k = await readDisp(); reads++; if (!k || k.state !== 'starting' || reads >= 20) { if (restartClock) { restartClock.stop(); restartClock = null; } } }
            finally { busy = false; }
          }, 750);
        });
        dispLogBtn.addEventListener('click', function () { logOpen = !logOpen; renderDisp(vsLast && vsLast.dispatcher); });

        // ═════ Cast a new voice ═════
        const cst = makeSection('cast');
        const castDesc = area('au-cast-desc', 3), castLine = area('au-cast-line', 3);
        const castN = numberInput('au-cast-n', 3, 1, 8);
        const castGo = btn('Generate', 'btn-primary', false, 'au-cast-go');
        const renderCast = btn('Apply effects', 'btn-secondary', false, 'au-render-cast');
        const packOpen = btn('Save as voice pack', 'btn-secondary', false, 'au-pack-open');
        const pack = el('div', 'au-inline'); pack.id = 'au-pack'; pack.hidden = true;
        const packName = input('au-pack-name', 'text'), packTr = area('au-pack-transcript', 3);
        const rights = sw('au-pack-rights', 'I have the rights to clone this voice'), over = sw('au-pack-overwrite', 'Overwrite a pack of that name');
        const packGo = btn('Bake pack', 'btn-primary', false, 'au-pack-go'), packCancel = btn('Cancel', 'btn-ghost', false, 'au-pack-cancel');
        const refAdd = btn('Add a reference voice', 'btn-secondary', false, 'au-ref-add');
        function syncPackGo() { packGo.disabled = !isOn(rights); packGo.title = isOn(rights) ? '' : 'Turn on "I have the rights" first.'; }
        (function buildCast() {
          // M1.3: the bench comes first (tile, rack, Apply + pack form), then what makes a new take
          benchEl.cast = line('au-bench-cast', 'au-bench'); cst.appendChild(benchTile('cast'));
          cst.appendChild(addTail('cast'));
          const r2 = el('div', 'au-row au-center'); r2.appendChild(renderCast); r2.appendChild(packOpen); cst.appendChild(r2);
          pack.appendChild(field('Pack name', packName, 'au-pack-name'));
          pack.appendChild(field('Transcript', packTr, 'au-pack-transcript'));
          const sr = el('div', 'au-switch-row'); sr.appendChild(rights); pack.appendChild(sr);
          const sr2 = el('div', 'au-switch-row'); sr2.appendChild(over); pack.appendChild(sr2);
          const pr = el('div', 'au-row au-center'); pr.appendChild(packGo); pr.appendChild(packCancel); pack.appendChild(pr);
          cst.appendChild(pack);
          cst.appendChild(field('Describe the voice', castDesc, 'au-cast-desc'));
          cst.appendChild(field('Line it should say', castLine, 'au-cast-line'));
          const r = el('div', 'au-row au-center'); r.appendChild(field('Throws', castN, 'au-cast-n')); r.appendChild(castGo); cst.appendChild(r);
          const r3 = el('div', 'au-row au-center'); r3.appendChild(refAdd); cst.appendChild(r3);
          cst.appendChild(el('p', 'au-note', 'Put a clean 10–20 s WAV of the voice into sounds/refs/ — it shows up under Chatterbox in the voice picker.'));
          addStatus('cast', cst);
          addDesk('cast', cst);
          syncPackGo();
        })();
        rights.addEventListener('click', syncPackGo);

        // ═════ Sound effects ═════
        const sfx = makeSection('sfx');
        const sfxPrompt = area('au-sfx-prompt', 3);
        const sfxSeconds = numberInput('au-sfx-seconds', 8, 1, 30), sfxN = numberInput('au-sfx-n', 3, 1, 8), sfxSeed = numberInput('au-sfx-seed', '', 0, 2147483647);
        sfxSeed.placeholder = 'random'; sfxSeed.setAttribute('placeholder', 'random');
        const sfxGo = btn('Generate', 'btn-primary', false, 'au-sfx-go');
        const loadPath = input('au-load-path', 'text'), loadGo = btn('Load a clip', 'btn-secondary', false, 'au-load-go');
        const renderSfx = btn('Apply effects', 'btn-secondary', false, 'au-render-sfx');
        const clipName = input('au-clip-name', 'text'), clipSave = btn('Save clip', 'btn-primary', false, 'au-clip-save');
        (function buildSfx() {
          benchEl.sfx = line('au-bench-sfx', 'au-bench'); sfx.appendChild(benchTile('sfx'));   // M1.3: tile, rack, Apply row, then the fields
          sfx.appendChild(addTail('sfx'));
          const r2 = el('div', 'au-row au-center'); r2.appendChild(renderSfx); r2.appendChild(field('Clip name', clipName, 'au-clip-name')); r2.appendChild(clipSave); sfx.appendChild(r2);
          sfx.appendChild(field('Describe the sound', sfxPrompt, 'au-sfx-prompt'));
          const r = el('div', 'au-row au-center');
          r.appendChild(field('Seconds', sfxSeconds, 'au-sfx-seconds')); r.appendChild(field('Throws', sfxN, 'au-sfx-n')); r.appendChild(field('Seed', sfxSeed, 'au-sfx-seed')); r.appendChild(sfxGo);
          sfx.appendChild(r);
          const r1 = el('div', 'au-row au-center'); r1.appendChild(field('Load a clip — full path', loadPath, 'au-load-path', 'au-grow')); r1.appendChild(loadGo); sfx.appendChild(r1);
          addStatus('sfx', sfx);
          addDesk('sfx', sfx);
        })();

        root.appendChild(player); root.appendChild(spk); root.appendChild(cst); root.appendChild(sfx);

        // ═════ the bench (one clip on the server, shown in Cast and in Sound effects) ═════
        let bench = null;
        const BENCH_EMPTY = 'Nothing on the bench yet. Use + From Library, or Send to bench on a take.';
        function benchKindWord() { return bench && bench.meta && bench.meta.library ? 'library clip' : (bench && bench.kind === 'cast') ? 'voice take' : (bench && bench.kind === 'sfx') ? 'sfx take' : 'loaded clip'; }
        function benchName() {   // the clip's own name, else the file it came from, else the kind word
          const mt = (bench && bench.meta) || {};
          if (mt.name) return String(mt.name);
          if (mt.origin) { const parts = String(mt.origin).split(/[\\/]/); if (parts[parts.length - 1]) return parts[parts.length - 1]; }
          return benchKindWord();
        }
        function benchText() {
          if (!bench) return BENCH_EMPTY;
          const kind = benchKindWord();
          const bits = [kind];
          if (bench.seconds != null) bits.push(bench.seconds + ' s');
          bits.push(bench.text ? 'transcript known' : 'no transcript');
          return 'On the bench: ' + bits.join(' · ');
        }
        // M1.3: the bench tile (top of Cast and Sound effects). Empty and filled are the SAME box: name, wave, chips and the buttons keep their room (CSS hides, never removes).
        function benchTile(m) {
          const t = el('div', 'au-bench-tile'); t.id = 'au-bench-tile-' + m; t.setAttribute('data-state', 'empty');
          const head = el('div', 'au-bt-head');
          const txt = el('div', 'au-bt-text');
          const name = el('div', 'au-bt-name'); txt.appendChild(name); txt.appendChild(benchEl[m]);
          const wave = el('div', 'au-wave au-bt-wave');
          const acts = el('div', 'au-bt-acts');
          const pb = btn('Play', 'btn-secondary', true, 'au-bench-play-' + m); pb.setAttribute('aria-label', 'Play the bench');
          pb.addEventListener('click', function () { if (bench && bench.url) play(bench.url); });
          benchPlay[m] = pb; acts.appendChild(pb);
          const rm = btn('Remove', 'btn-secondary', true, 'au-bench-remove-' + m); rm.setAttribute('aria-label', 'Take the clip off the bench');
          rm.addEventListener('click', function () {
            if (bench && (bench.chain || bench.hasChain)) { openBenchConfirm(m); return; }   // F5: effects on the bench - ask first (one click without them)
            removeBench(m, rm);
          });
          acts.appendChild(rm);
          head.appendChild(txt); head.appendChild(wave); head.appendChild(acts);
          const fx = el('div', 'au-bt-fx');
          t.appendChild(head); t.appendChild(fx);
          tiles[m] = { root: t, name: name, wave: wave, fx: fx, remove: rm, waveRev: undefined, waveTok: 0 };
          return t;
        }
        // F5: the inline ask for a bench with effects. Its own row at the end of the tile, so nothing above moves.
        function closeBenchConfirm(m) { const t = tiles[m]; if (t && t.confirm) { t.confirm.remove(); t.confirm = null; } }
        function openBenchConfirm(m) {
          const t = tiles[m]; if (!t || t.confirm) return;
          const row = el('div', 'au-desk-confirm'); row.id = 'au-bench-confirm-' + m; row.setAttribute('data-inline', 'bench-remove'); row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'Remove the bench clip');
          row.appendChild(el('span', null, 'Remove the clip and its applied effects from the bench?'));
          const go = btn('Remove', 'btn-danger', true, 'au-bench-remove-go-' + m), keep = btn('Keep', 'btn-secondary', true, 'au-bench-remove-keep-' + m);
          go.addEventListener('click', function () { removeBench(m, t.remove); });
          keep.addEventListener('click', function () { closeBenchConfirm(m); });
          row.appendChild(go); row.appendChild(keep);
          t.root.appendChild(row); t.confirm = row;
        }
        function paintTile(m) {
          const t = tiles[m]; if (!t) return;
          if (t.confirm && !(bench && (bench.chain || bench.hasChain))) closeBenchConfirm(m);
          t.root.setAttribute('data-state', bench ? 'filled' : 'empty');
          t.name.textContent = bench ? benchName() : ''; t.name.title = bench ? benchName() : '';
          t.remove.disabled = !bench; t.remove.title = bench ? '' : 'Nothing on the bench yet.';
          const rv = bench ? benchRev(bench) : null, key = bench ? String(rv) : '';
          if (t.waveRev !== key) {   // the wave is rebuilt only when the bench revision changes
            t.waveRev = key; const tok = ++t.waveTok; t.wave.textContent = '';
            if (bench && bench.url) fillWave(t.wave, bench.url, function () { return t.waveTok === tok; });
          }
          t.fx.textContent = '';
          const order = bench && bench.chain && bench.chain.spec && Array.isArray(bench.chain.spec.order) ? bench.chain.spec.order : [];
          order.forEach(function (id) {
            const c = (cats[m] || []).find(function (x) { return x && x.id === id; });
            t.fx.appendChild(el('span', 'au-bt-chip', (c && c.label) ? String(c.label) : String(id)));
          });
        }
        async function removeBench(m, b) {
          if (b.disabled) return;
          b.disabled = true;
          try {
            const j = await postJson('/sfx-clear', {});
            if (j && j.error) { setStatus(m, j.error); paintTile(m); return; }
            dropBenchEntries();
            applyBench(j && j.bench);
          } catch (_) { setStatus(m, 'Could not reach Phoenix.'); paintTile(m); }
        }
        // the rack of a bench mode shows the chain the shared bench was rendered with (Cast and Sound effects share ONE bench)
        // per mode: the rack follows the bench only when the bench REVISION changed since this mode last applied it, so edits the user has not
        // applied survive a mode switch and every poll answer. A bench that goes away (null after a number) clears the rack once.
        const lastRackRev = { cast: null, sfx: null };
        function rackFromBench(m) {
          if ((m !== 'cast' && m !== 'sfx') || !racks[m]) return;
          if (!cats[m].length) return;   // no catalogue yet: a rack cannot hold the chain, the answer that brings the catalogue applies it
          const rv = benchRev(bench);
          if (rv === lastRackRev[m] && (rv !== null || !bench)) return;   // a bench without a rev (older answer) cannot be compared: it always applies
          lastRackRev[m] = rv;
          const spec = bench && bench.chain && bench.chain.spec;
          if (spec && Array.isArray(spec.order)) racks[m].load(spec);
          else racks[m].clear();
        }
        function benchChainLine(m) {
          const spec = bench && bench.chain && bench.chain.spec;
          if (spec && Array.isArray(spec.order)) return chainLineOf(spec, cats[m]);
          return 'dry';   // only the chain the server says it rendered counts (never the rack or what was sent)
        }
        // ONE bench file (/sfx-bench.wav) -> at most ONE bench entry on ALL desks. It stays only while it still is the server's bench: the same
        // bench revision (`rev`, issued by sfx.js on every change - two clips can share kind, length, size and filter). Every bench answer (render,
        // use, load, state, reload) drops a stale one everywhere; an entry stored without a rev (older build) is dropped. No copies in sounds/.
        let benchReady = false;
        const benchRev = function (b) { return b && typeof b.rev === 'number' && isFinite(b.rev) ? b.rev : null; };
        function dropBenchEntries() { MODES.forEach(function (m) { if (deskData[m].some(function (e) { return e.src === 'bench'; })) { deskData[m] = deskData[m].filter(function (e) { return e.src !== 'bench'; }); persist(m); } }); }
        function syncBenchEntries() {
          const rv = benchRev(bench); let keep = null;
          MODES.forEach(function (m) { deskData[m].forEach(function (e) { if (e.src === 'bench' && rv !== null && e.rev === rv && (!keep || String(e.at) > String(keep.e.at))) keep = { m: m, e: e }; }); });
          MODES.forEach(function (m) {
            const n = deskData[m].length;
            deskData[m] = deskData[m].filter(function (e) { return e.src !== 'bench' || (keep !== null && e === keep.e); });
            if (keep && keep.m === m) keep.e.url = bench.url;   // the server's cache-busted url of the same render
            if (deskData[m].length !== n || (keep && keep.m === m)) persist(m);
          });
        }
        function applyBench(b) {
          bench = b && typeof b === 'object' ? b : null;
          ['cast', 'sfx'].forEach(function (m) {
            if (benchEl[m]) benchEl[m].textContent = benchText();
            if (benchPlay[m]) { benchPlay[m].disabled = !bench; benchPlay[m].title = bench ? '' : 'Nothing on the bench yet.'; }
            paintTile(m);
          });
          if (bench && bench.text) { packTr.value = bench.text; packTr.readOnly = true; }
          else packTr.readOnly = false;
          rackFromBench(mode);
          if (benchReady) syncBenchEntries();
        }
        applyBench(null);

        // ═════ the takes desk (one per mode) ═════
        const dui = {};
        MODES.forEach(function (m) { dui[m] = { selected: new Set(), confirm: false, result: null, pick: null, undo: null, delBtn: null, tosb: null }; });
        const libName = function (m) { return m === 'sfx' ? 'SFX' : 'Sound'; };
        function fmtTime(at) {
          const d = new Date(at);
          if (isNaN(d.getTime())) return '';
          const z = function (n) { return (n < 10 ? '0' : '') + n; };
          return z(d.getHours()) + ':' + z(d.getMinutes());
        }
        function metaOf(e) {
          const bits = [e.seconds != null && e.seconds !== '' ? e.seconds + ' s' : '—', e.chainLine || 'dry'];
          const t = fmtTime(e.at); if (t) bits.push(t);
          return bits.join(' · ');
        }
        function onDesk(m, url) { return deskData[m].some(function (e) { return e.url === url; }); }
        function syncPick(m) {
          const p = dui[m].pick;
          if (!p) return;
          p.buttons.forEach(function (b, url) { b.disabled = onDesk(m, url); });
        }
        function syncHead(m) {
          const ui = dui[m];
          if (!ui.delBtn) return;
          const n = deskData[m].filter(function (e) { return ui.selected.has(e.url); }).length;
          ui.delBtn.disabled = n === 0; ui.delBtn.title = n === 0 ? 'Select takes first.' : '';
        }
        function persist(m) { writeDesk(); renderDesk(m); }
        function addEntries(m, entries) {
          if (!entries.length) return;
          deskData[m] = entries.concat(deskData[m]).slice(0, DESK_MAX);
          persist(m);
        }
        function fillWave(box, url, alive) {
          let w = null;
          try { w = deps.wave ? deps.wave(url) : null; } catch (_) { w = null; }
          if (!w || typeof w.then !== 'function') return;
          w.then(function (vals) {
            if (!Array.isArray(vals) || (alive && !alive())) return;
            vals.forEach(function (v) { const s = el('span'); s.style.height = Math.max(2, Math.round(2 + Number(v) * 22)) + 'px'; box.appendChild(s); });
          }).catch(function () { /* no waveform is not an error */ });
        }
        function renderRow(m, e) {
          const ui = dui[m];
          const row = el('div', 'au-take'); row.setAttribute('data-url', e.url); row.setAttribute('data-src', e.src || 'vo');
          const sb = btn('Select', 'btn-ghost', true); sb.setAttribute('data-act', 'select'); sb.setAttribute('role', 'checkbox');
          sb.setAttribute('aria-checked', ui.selected.has(e.url) ? 'true' : 'false'); sb.setAttribute('aria-label', 'Select ' + e.who);
          if (e.src === 'take') { sb.disabled = true; sb.title = 'Unsaved throw — save it first; Clear desk removes it from the list.'; }
          if (e.src === 'bench') { sb.disabled = true; sb.title = 'Bench preview — save it first to keep it.'; }
          sb.addEventListener('click', function () {
            if (ui.selected.has(e.url)) ui.selected.delete(e.url); else ui.selected.add(e.url);
            sb.setAttribute('aria-checked', ui.selected.has(e.url) ? 'true' : 'false');
            if (ui.confirm) renderDesk(m); else syncHead(m);
          });
          row.appendChild(sb);
          const pb = btn('Play', 'btn-ghost', true); pb.setAttribute('data-act', 'play'); pb.setAttribute('aria-label', 'Play ' + e.who);
          pb.addEventListener('click', function () { play(e.url); });
          row.appendChild(pb);
          const wv = el('div', 'au-wave'); row.appendChild(wv); fillWave(wv, e.url);
          const col = el('div', 'au-text-col'); col.appendChild(el('span', 'au-who', e.who)); col.appendChild(el('span', 'au-meta', metaOf(e))); row.appendChild(col);
          if (e.src === 'take') {
            const ub = btn('Send to bench', 'btn-secondary', true); ub.setAttribute('data-act', 'use'); ub.setAttribute('aria-label', 'Send ' + e.who + ' to the bench');
            ub.addEventListener('click', function () { adopt(m, e); });
            row.appendChild(ub);
          }
          if ((e.src === 'vo' || e.src === 'sfx') && (m === 'cast' || m === 'sfx')) {   // M1.3: a saved clip of the Library goes to the bench too
            const bb = btn('Send to bench', 'btn-secondary', true); bb.setAttribute('data-act', 'bench'); bb.setAttribute('aria-label', 'Send ' + e.who + ' to the bench');
            bb.addEventListener('click', function () { adoptLibrary(m, e); });
            row.appendChild(bb);
          }
          if (e.src === 'vo' || e.src === 'sfx') {   // R6: send this take / clip to a storyboard shot (the picker opens inside this row; the desk is not rebuilt)
            const tb = btn('To storyboard', 'btn-secondary', true); tb.setAttribute('data-act', 'to-sb'); tb.setAttribute('aria-label', 'Send ' + e.who + ' to a storyboard');
            if (sbSending) { tb.disabled = true; tb.setAttribute('title', SB_BUSY_TITLE); }
            tb.addEventListener('click', function () { if (sbSending) return; toggleToSb(m, e, row); });
            row.appendChild(tb);
          }
          return row;
        }
        // ── To storyboard (R6): board -> shot -> (voice: an existing line or "+ new line" with a speaker | SFX: the shot's sound clip) -> Send ──
        // The picker is local to its row and the desk is not re-rendered by it; the result line below the desk head says what happened and carries "Open in Story".
        function sbJson(url, body) {
          const o = body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
          return deps.fetch(url, o).then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { ok: !!r.ok, status: r.status, j: j }; }); });
        }
        const sbErr = function (r) { return (r && r.j && r.j.error) || ('HTTP ' + (r && r.status)); };
        // B6: ONE send lock for every picker on every desk, from the click on Send until the POST settles
        let sbSending = false;
        const SB_BUSY_TITLE = 'A take is being sent to a storyboard' + String.fromCharCode(8230);
        function applySbLock(m) {   // [data-act="to-sb"] buttons of one desk follow the lock; the open picker's Send too
          const d = deskEl[m]; if (d && d.querySelectorAll) Array.prototype.slice.call(d.querySelectorAll('[data-act="to-sb"]')).forEach(function (b) { b.disabled = sbSending; if (sbSending) b.setAttribute('title', SB_BUSY_TITLE); else b.removeAttribute('title'); });
          const t = dui[m] && dui[m].tosb; if (t && t.box && t.box.querySelector) { const g = t.box.querySelector('[data-tosb="go"]'); if (g) g.disabled = !!(sbSending || t.busy || t.loading || !t.board || !t.shot); }
        }
        function setSbLock(on) { sbSending = !!on; Object.keys(deskEl).forEach(applySbLock); }
        function closeToSb(m) { const t = dui[m].tosb; if (!t) return; dui[m].tosb = null; if (t.box && t.box.parentNode) t.box.parentNode.removeChild(t.box); }
        function toggleToSb(m, e, row) {
          const ui = dui[m], open = ui.tosb;
          if (open && open.url === e.url) { closeToSb(m); return; }
          closeToSb(m);
          const t = { url: e.url, entry: e, kind: e.src === 'sfx' ? 'sfx' : 'vo', box: el('div', 'au-tosb'), seq: 0, boards: null, active: '', board: '', data: null, shot: '', line: '', speaker: '', loading: true, busy: false, err: '' };
          t.box.setAttribute('data-tosb-box', '');
          ui.tosb = t; row.appendChild(t.box);
          paintToSb(m);
          loadBoards(m, t);
        }
        function loadBoards(m, t) {
          const my = ++t.seq;
          sbJson('/storyboards').then(function (r) {
            if (dui[m].tosb !== t || t.seq !== my) return;
            if (!r.ok || !r.j || !Array.isArray(r.j.boards)) { t.loading = false; t.err = r.ok ? 'Phoenix sent an unreadable board list.' : sbErr(r); paintToSb(m); return; }
            t.boards = r.j.boards; t.active = typeof r.j.active === 'string' ? r.j.active : '';
            t.board = t.boards.some(function (b) { return b.id === t.active; }) ? t.active : (t.boards[0] ? t.boards[0].id : '');
            if (!t.board) { t.loading = false; t.err = 'There is no storyboard yet.'; paintToSb(m); return; }
            loadBoardData(m, t);
          }).catch(function () { if (dui[m].tosb === t) { t.loading = false; t.err = 'Phoenix is not reachable.'; paintToSb(m); } });
        }
        function loadBoardData(m, t) {
          const my = ++t.seq, want = t.board;
          t.loading = true; t.data = null; t.err = ''; paintToSb(m);
          sbJson('/storyboard?board=' + encodeURIComponent(want)).then(function (r) {
            if (dui[m].tosb !== t || t.seq !== my) return;   // another board was picked meanwhile: this answer is not for the screen
            t.loading = false;
            if (!r.ok || !r.j || !Array.isArray(r.j.shots)) { t.err = r.ok ? 'Phoenix sent an unreadable board.' : sbErr(r); paintToSb(m); return; }
            t.data = r.j; t.shot = r.j.shots[0] ? r.j.shots[0].id : ''; pickLine(t); paintToSb(m);
          }).catch(function () { if (dui[m].tosb === t && t.seq === my) { t.loading = false; t.err = 'Phoenix is not reachable.'; paintToSb(m); } });
        }
        function shotOf(t) { return t.data && Array.isArray(t.data.shots) ? t.data.shots.find(function (s) { return s.id === t.shot; }) || null : null; }
        function castNames(t) { const c = t.data && t.data.board && Array.isArray(t.data.board.cast) ? t.data.board.cast : []; return c.map(function (x) { return x && x.name; }).filter(function (n) { return typeof n === 'string' && n; }); }
        function pickLine(t) {   // the first line without a take, else "+ new line"; the speaker defaults to the first cast member
          const s = shotOf(t), lines = s && Array.isArray(s.lines) ? s.lines : [];
          const free = lines.find(function (l) { return !l.take; });
          t.line = free ? free.lid : '__new';
          t.speaker = castNames(t)[0] || '';
        }
        function tsel(name, aria, options, value, onChange) {
          const s = el('select', 'au-select'); s.setAttribute('data-tosb', name); s.setAttribute('aria-label', aria);
          options.forEach(function (o) { const op = el('option', null, o[1]); op.value = o[0]; op.setAttribute('value', o[0]); s.appendChild(op); });
          s.value = value;
          if (sendLocked) s.disabled = true;   // B5: no selection changes while the send runs
          s.addEventListener('change', function () { onChange(s.value); });
          return s;
        }
        let sendLocked = false;   // set only for the duration of one paintToSb pass
        function paintToSb(m) {
          const t = dui[m].tosb;
          if (!t) return;
          sendLocked = !!t.busy;
          const box = t.box; box.textContent = '';
          const who = t.entry.who || t.entry.file || 'this take';
          if (t.loading && !t.data) { box.appendChild(el('span', 'au-note', 'Loading the storyboards\u2026')); }
          if (t.boards && t.boards.length) box.appendChild(tsel('board', 'Storyboard', t.boards.map(function (b) { return [b.id, b.title || b.id]; }), t.board, function (v) { if (v === t.board) return; t.board = v; loadBoardData(m, t); }));
          const shots = t.data && Array.isArray(t.data.shots) ? t.data.shots : [];
          if (t.data && !shots.length) box.appendChild(el('span', 'au-note', 'This storyboard has no shots yet.'));
          if (shots.length) {
            box.appendChild(tsel('shot', 'Shot', shots.map(function (s, k) { return [s.id, 'Shot ' + (k + 1) + (s.title ? ' \u00B7 ' + s.title : '')]; }), t.shot, function (v) { t.shot = v; pickLine(t); paintToSb(m); }));
            if (t.kind === 'sfx') box.appendChild(el('span', 'au-note', 'Sound clip of the shot'));
            else {
              const s = shotOf(t), lines = s && Array.isArray(s.lines) ? s.lines : [];
              const lo = lines.map(function (l, k) { const txt = String(l.line || ''); return [l.lid, (k + 1) + '. ' + (l.speaker ? l.speaker + ': ' : '') + (txt.length > 40 ? txt.slice(0, 40) : txt)]; });
              lo.push(['__new', '+ new line']);
              box.appendChild(tsel('line', 'Line', lo, t.line, function (v) { t.line = v; paintToSb(m); }));
              if (t.line === '__new') {
                const names = castNames(t);
                box.appendChild(tsel('speaker', 'Speaker', names.length ? names.map(function (n) { return [n, n]; }) : [['', 'No speaker']], t.speaker, function (v) { t.speaker = v; }));
              }
            }
          }
          if (t.err) { const er = el('span', 'au-note', t.err); er.setAttribute('role', 'alert'); box.appendChild(er); }
          const go = btn('Send', 'btn-primary', true); go.setAttribute('data-tosb', 'go'); go.setAttribute('aria-label', 'Send ' + who + ' to the shot');
          if (sbSending || t.busy || t.loading || !t.board || !t.shot) go.disabled = true;
          go.addEventListener('click', function () { sendToSb(m); });
          const cn = btn('Cancel', 'btn-ghost', true); cn.setAttribute('data-tosb', 'cancel');
          cn.addEventListener('click', function () { closeToSb(m); });
          box.appendChild(go); box.appendChild(cn);
        }
        function paintResult(m) {   // the desk's result line, in place (the line is also drawn by renderDesk)
          const ui = dui[m], res = ui.resEl;
          if (!res) return;
          res.textContent = '';
          if (ui.result) {
            res.appendChild(el('span', null, ui.result.text));
            if (ui.result.undo) { const ub = btn('Undo', 'btn-secondary', true); ub.setAttribute('data-desk', 'undo'); ub.addEventListener('click', function () { undoDelete(m); }); res.appendChild(ub); }
            if (ui.result.open) {
              const o = ui.result.open, ob = btn('Open in Story', 'btn-ghost', true); ob.setAttribute('data-tosb', 'open');
              ob.addEventListener('click', function () { if (deps.openStory) { try { Promise.resolve(deps.openStory(o.board, o.shot)).catch(function () {}); } catch (_) {} } });
              res.appendChild(ob);
            }
          }
        }
        async function sendToSb(m) {
          const ui = dui[m], t = ui.tosb;
          if (!t || t.busy || sbSending || !t.board || !t.shot) return;
          const snap = { board: t.board, shot: t.shot, line: t.line, speaker: t.speaker };   // B5: the choice AT THE CLICK; nothing below reads the selects again
          setSbLock(true); t.busy = true; t.err = ''; paintToSb(m);
          const fail = function (text, close) { if (ui.tosb === t) { if (close) closeToSb(m); else { t.busy = false; t.err = ''; paintToSb(m); } } ui.result = { text: text, undo: false }; paintResult(m); };
          try {
            const fr = await sbJson('/storyboard?board=' + encodeURIComponent(snap.board));   // fresh: the lines / shots as they are NOW
            if (ui.tosb !== t) return;
            if (!fr.ok || !fr.j || !Array.isArray(fr.j.shots)) { fail(fr.ok ? 'Phoenix sent an unreadable board.' : sbErr(fr)); return; }
            const k = fr.j.shots.findIndex(function (s) { return s.id === snap.shot; });
            if (k < 0) { fail('That shot is no longer in the storyboard \u2014 nothing was sent.', true); return; }
            const sh = fr.j.shots[k], file = t.entry.file, body = { board: snap.board, id: snap.shot }; let route = '/storyboard/shot/update';
            if (t.kind === 'sfx') body.sound = { clip: file };
            else {
              const lines = (Array.isArray(sh.lines) ? sh.lines : []).map(function (l) { return { lid: l.lid, speaker: l.speaker || '', line: l.line || '', gap_s: Number(l.gap_s) || 0 }; });
              if (snap.line === '__new') { route = '/storyboard/shot/line/add'; body.speaker = snap.speaker || ''; body.line = t.entry.text || ''; body.gap_s = 0; body.take = '/vo/' + file; }   // B6: the server appends atomically
              else {
                const tg = lines.find(function (l) { return l.lid === snap.line; });
                if (!tg) { fail('That line is no longer in the shot \u2014 nothing was sent.', true); return; }
                tg.take = '/vo/' + file;
              }
              if (route === '/storyboard/shot/update') body.lines = lines;
            }
            const ur = await sbJson(route, body);   // F5.2: no 'picker closed' bail-out here: the result line is written either way
            if (!ur.ok) { fail(sbErr(ur)); return; }
            if (ui.tosb === t) closeToSb(m);
            ui.result = { text: 'Sent to ' + ((fr.j.board && fr.j.board.title) || 'the storyboard') + ' \u00B7 shot ' + (k + 1), undo: false, open: { board: snap.board, shot: snap.shot } };
            paintResult(m);
          } catch (_) { fail('Phoenix is not reachable \u2014 nothing was sent.'); }
          finally { setSbLock(false); }
        }
        function renderDesk(m) {
          const box = deskEl[m], ui = dui[m], list = deskData[m];
          ui.selected.forEach(function (u) { if (!list.some(function (e) { return e.url === u && e.src !== 'take' && e.src !== 'bench'; })) ui.selected.delete(u); });
          ui.tosb = null;   // the rows below are rebuilt: a To-storyboard picker is gone with its row
          box.textContent = '';
          const head = el('div', 'au-desk-head');
          head.appendChild(el('span', 'au-desk-title', 'Takes on the desk · ' + list.length));
          ui.delBtn = null;
          const nSel = ui.selected.size;
          if (ui.confirm) {
            const c = el('span', 'au-desk-confirm'); c.appendChild(el('span', null, 'Move ' + nSel + ' take(s) to the Library trash?'));
            const go = btn('Move to trash', 'btn-danger', true); go.setAttribute('data-desk', 'delete-go'); go.addEventListener('click', function () { deleteSelected(m); });
            const no = btn('Cancel', 'btn-ghost', true); no.setAttribute('data-desk', 'delete-cancel'); no.addEventListener('click', function () { ui.confirm = false; ui.usedBy = null; renderDesk(m); });
            c.appendChild(go); c.appendChild(no); head.appendChild(c);
            if (ui.usedBy && ui.usedBy.length) {
              const shown = ui.usedBy.slice(0, 3).map(function (u) { return u.title + ' · shot ' + (u.shots || []).join(', '); });
              if (ui.usedBy.length > 3) shown.push('+' + (ui.usedBy.length - 3) + ' more');
              const ub = el('span', 'au-desk-usedby', 'Used in ' + shown.join(' · ')); ub.setAttribute('data-desk', 'used-by'); head.appendChild(ub);
            }
          } else {
            const fl = btn('+ From Library', 'btn-secondary', true); fl.setAttribute('data-desk', 'from-library'); fl.addEventListener('click', function () { openPick(m); });
            const cl = btn('Clear desk', 'btn-secondary', true); cl.setAttribute('data-desk', 'clear'); cl.addEventListener('click', function () { clearDesk(m); });
            const dl = btn('Delete selected', 'btn-danger', true); dl.setAttribute('data-desk', 'delete');
            dl.addEventListener('click', async function () {
              if (!ui.selected.size) return;
              // which storyboards use the selected files? a failed read = no warning, the confirm opens all the same
              let users = [];
              try {
                const files = deskData[m].filter(function (e) { return ui.selected.has(e.url) && e.src !== 'take' && e.src !== 'bench'; }).map(function (e) { return { dir: e.src, file: e.file }; });
                if (files.length) { const j = await postJson('/library/sound-users', { files: files }); if (j && j.ok && Array.isArray(j.users)) users = j.users; }
              } catch (_) { users = []; }
              ui.usedBy = users; ui.confirm = true; renderDesk(m);
            });
            ui.delBtn = dl;
            head.appendChild(fl); head.appendChild(cl); head.appendChild(dl);
            syncHead(m);
          }
          box.appendChild(head);
          box.appendChild(el('p', 'au-desk-note', 'Clear desk only empties this list — the files stay in Library ▸ ' + libName(m) + '. Delete goes to the Library trash (Undo).'));
          const res = el('div'); res.setAttribute('data-desk-result', ''); res.setAttribute('role', 'status');
          ui.resEl = res; paintResult(m);
          box.appendChild(res);
          if (ui.pick) { box.appendChild(ui.pick.el); syncPick(m); }
          list.forEach(function (e) { box.appendChild(renderRow(m, e)); });
        }
        function clearDesk(m) {
          const ui = dui[m];
          deskData[m] = []; ui.selected.clear(); ui.confirm = false; ui.undo = null;
          ui.result = { text: 'Desk cleared — the files stay in Library ▸ ' + libName(m) + '.', undo: false };
          persist(m);
        }
        async function deleteSelected(m) {
          const ui = dui[m];
          const rows = deskData[m].filter(function (e) { return ui.selected.has(e.url) && e.src !== 'take' && e.src !== 'bench'; });
          ui.confirm = false; ui.usedBy = null;
          if (!rows.length) { renderDesk(m); return; }
          try {
            const j = await postJson('/library/trash/sound', { files: rows.map(function (e) { return { dir: e.src, file: e.file }; }) });
            if (j && j.ok) {
              // the files are gone from EVERY desk (same url), selection included; the desk that deleted keeps the Undo
              const gone = new Set(rows.map(function (e) { return e.url; }));
              MODES.forEach(function (o) {
                deskData[o] = deskData[o].filter(function (e) { return !(gone.has(e.url) && e.src !== 'take' && e.src !== 'bench'); });
                gone.forEach(function (u) { dui[o].selected.delete(u); });
              });
              ui.selected.clear(); ui.undo = { id: j.id, rows: rows };
              ui.result = { text: 'Moved ' + rows.length + ' to the trash — ', undo: true };
              try { if (typeof libraryPage !== 'undefined' && libraryPage) { libraryPage.noteChange('sound'); libraryPage.noteChange('sfx'); } } catch (_) {}   // F4: the Library's counts and Trash follow
              writeDesk();
            } else ui.result = { text: (j && j.error) || 'Could not move them to the trash.', undo: false };
          } catch (_) { ui.result = { text: 'Could not reach Phoenix.', undo: false }; }
          MODES.forEach(renderDesk);
        }
        async function undoDelete(m) {
          const ui = dui[m], u = ui.undo;
          if (!u) return;
          try {
            const j = await postJson('/library/trash/restore', { id: u.id });
            if (j && j.ok) {
              const back = u.rows.filter(function (e) { return !onDesk(m, e.url); });
              deskData[m] = back.concat(deskData[m]).slice(0, DESK_MAX);
              ui.undo = null; ui.result = { text: 'Restored ' + u.rows.length + '.', undo: false };
              try { if (typeof libraryPage !== 'undefined' && libraryPage) { libraryPage.noteChange('sound'); libraryPage.noteChange('sfx'); } } catch (_) {}
              writeDesk();
            } else ui.result = { text: (j && j.error) || 'Could not restore them.', undo: false };
          } catch (_) { ui.result = { text: 'Could not reach Phoenix.', undo: false }; }
          renderDesk(m);
        }
        const PICK_PAGE = 100;
        function pickFolder(m) { return m === 'sfx' ? 'sounds/sfx' : 'sounds/vo'; }
        function pickNote(m, n) {
          const where = 'Library ▸ ' + libName(m) + ' (' + pickFolder(m) + '). ' + (m === 'sfx' ? 'Saved clips' : 'New takes') + ' land here.';
          return (n === 0 ? 'Nothing yet in ' : n === 1 ? '1 file in ' : n + ' files in ') + where;
        }
        function drawPick(m) {
          const ui = dui[m], p = ui.pick;
          if (!p) return;
          const q = p.filter.trim().toLowerCase();
          const hits = p.items.filter(function (it) { return !q || String(it.label || '').toLowerCase().indexOf(q) >= 0 || String(it.file || '').toLowerCase().indexOf(q) >= 0; });
          const rowsBox = p.rowsBox; rowsBox.textContent = ''; p.buttons.clear();
          hits.slice(0, p.shown).forEach(function (it) {
            const t = fmtTime(new Date(it.mtime));
            const r = el('div', 'au-pick-row'); r.appendChild(el('span', null, (it.label || it.file) + (t ? ' · ' + t : '')));
            const b = btn('Add', 'btn-ghost', true); b.setAttribute('data-pick', it.url); p.buttons.set(it.url, b);
            b.addEventListener('click', function () {
              if (onDesk(m, it.url)) return;
              const at = new Date(it.mtime); const iso = isNaN(at.getTime()) ? nowDate().toISOString() : at.toISOString();
              addEntries(m, [{ src: m === 'sfx' ? 'sfx' : 'vo', file: it.file, url: it.url, who: it.label || it.file, engine: '', seconds: null, chainLine: '—', at: iso }]);
            });
            r.appendChild(b); rowsBox.appendChild(r);
          });
          if (p.items.length && !hits.length) rowsBox.appendChild(el('div', 'au-note', 'No match.'));
          p.moreBox.textContent = '';
          if (hits.length > p.shown) {
            const more = btn('Show more (' + (hits.length - p.shown) + ' left)', 'btn-secondary', true); more.setAttribute('data-desk', 'pick-more');
            more.addEventListener('click', function () { p.shown += PICK_PAGE; drawPick(m); });
            p.moreBox.appendChild(more);
          }
          syncPick(m);
        }
        async function openPick(m) {
          const ui = dui[m];
          try {
            const j = await (await deps.fetch(m === 'sfx' ? '/library/sfx' : '/library/sounds')).json();
            const items = (j && Array.isArray(j.items)) ? j.items : [];
            const pe = el('div', 'au-desk-pick'), buttons = new Map();
            const flt = el('input', 'au-text'); flt.type = 'text'; flt.setAttribute('type', 'text'); flt.setAttribute('data-pick-filter', ''); flt.setAttribute('aria-label', 'Filter the list'); flt.setAttribute('placeholder', 'Filter');
            const note = el('div', 'au-note', pickNote(m, items.length)); note.setAttribute('data-pick-note', '');
            const rowsBox = el('div', 'au-pick-rows'), moreBox = el('div');
            pe.appendChild(flt); pe.appendChild(note); pe.appendChild(rowsBox); pe.appendChild(moreBox);
            const done = btn('Done', 'btn-secondary', true); done.setAttribute('data-desk', 'pick-close');
            done.addEventListener('click', function () { ui.pick = null; renderDesk(m); });
            pe.appendChild(done);
            ui.pick = { el: pe, buttons: buttons, items: items, filter: '', shown: PICK_PAGE, rowsBox: rowsBox, moreBox: moreBox };
            flt.addEventListener('input', function () { if (!ui.pick) return; ui.pick.filter = flt.value; ui.pick.shown = PICK_PAGE; drawPick(m); });
            drawPick(m);
          } catch (_) { ui.result = { text: 'Could not read the Library.', undo: false }; }
          renderDesk(m);
        }
        MODES.forEach(renderDesk);

        // ═════ the connection line ═════
        function localOk(j) {
          return !!(j && j.dispatcher && j.dispatcher.mode === 'local' && (j.engines || []).some(function (e) { return e && e.id !== 'crispasr' && e.available; }));
        }
        function connText(m, j) {
          const h = j && j.health;
          if (h && h.ok) return CONN + (h.backend || '?') + ' · ' + ((m === 'speak' ? j.voices : j.packs) || []).length + ' packs' + cardText(h);
          if (m === 'speak' && localOk(j)) return 'local voice engines';
          return 'No speech server configured (voice.api).';
        }
        const stateUrl = function (m) { return m === 'speak' ? '/voice-state' : '/sfx-state'; };
        async function refresh(m) {
          m = MODES.indexOf(m) >= 0 ? m : mode;
          try {
            const j = await (await deps.fetch(stateUrl(m))).json();
            if (m === 'speak') {
              vsLast = j;
              if (typeof deps.voiceState === 'function') { try { deps.voiceState(j); } catch (_) {} }
              cats.speak = j.effects || []; racks.speak.setCatalogue(cats.speak);
              buildPicker(j);
              renderWm(j.watermark !== false);
              renderDisp(j.dispatcher);
            } else {
              cats[m] = j.effects || []; racks[m].setCatalogue(cats[m]);
              applyBench(j.bench);
            }
            connEl[m].textContent = connText(m, j);
          } catch (_) { connEl[m].textContent = 'could not reach Phoenix'; }
        }
        let cardBusy = false;
        async function cardTick() {   // the card line follows the card while Audio is visible - and only while it is the connected line (no request otherwise)
          const m = mode, ln = connEl[m];
          if (cardBusy || !ln || String(ln.textContent).indexOf(CONN) !== 0) return;
          cardBusy = true;
          try {
            const j = await (await deps.fetch(stateUrl(m))).json();
            if (j && j.health && j.health.ok && String(ln.textContent).indexOf(CONN) === 0) ln.textContent = connText(m, j);
          } catch (_) { /* a failed peek must never break the mode it decorates */ }
          finally { cardBusy = false; }
        }
        deps.visiblePoll('audio', cardTick, 10000);
        let dispPoll = deps.visiblePoll('audio', dispTick, 3000);

        // ═════ Speak ═════
        speakBtn.addEventListener('click', async function () {
          const text = (lineEl.value || '').trim();
          if (!text) { setStatus('speak', 'Type a line first.'); return; }
          if (speakBtn.disabled) return;
          speakBtn.disabled = true;   // claimed BEFORE the first await: a double click is one request
          try {
            const ch = parseChoice(selVoice.value);
            if (!ch) { setStatus('speak', 'Pick a voice first.'); return; }
            if (ch.engine !== 'crispasr' && !(await deps.ensureConsent(speakBtn))) return;   // cloning a voice: the one-time consent first
            setStatus('speak', 'Speaking…');
            try {   // say WHY it will be slow before it is slow
              const hj = await (await deps.fetch('/voice-state')).json();
              const warte = peekWait(hj && hj.health, 'speak');
              if (warte) setStatus('speak', warte);
            } catch (_) { /* a failed peek must never stop the actual attempt */ }
            const body = { voice: ch.name, text: text, engine: ch.engine, seed: seedEl.value === '' ? null : seedEl.value, reference: null };
            if (ch.engine === 'chatterbox' && ch.kind === 'ref') { body.voice = ch.name.replace(/\.wav$/i, ''); body.reference = ch.name; }
            const rc = racks.speak.chain();
            if (rc) body.chain = rc;
            try {
              const j = await postJson('/voice-speak', body);
              if (j && j.url) {
                const voiceLabel = ch.kind === 'ref' ? ch.name.replace(/\.wav$/i, '') : ch.name;
                addEntries('speak', [{ src: 'vo', file: j.file, url: j.url, text: text, who: voiceLabel + ' · ' + (ENGINE_LABEL[ch.engine] || ch.engine), engine: ch.engine,
                  seconds: j.seconds != null ? j.seconds : null, chainLine: j.error ? 'dry' : chainLineOf(rc, cats.speak), at: nowDate().toISOString() }]);
                if (j.seed != null) { lastSeed = j.seed; reuseBtn.hidden = false; setStatus('speak', 'seed ' + j.seed); }
                else { reuseBtn.hidden = true; setStatus('speak', j.seedIgnored ? 'seed ignored — voice packs are fixed' : 'Take added to the desk.'); }
                if (j.watermark === 'failed') setStatus('speak', 'Watermark could not be applied (' + (j.watermarkReason || 'unknown reason') + ')');
                if (j.error) setStatus('speak', j.error);
              } else setStatus('speak', (j && j.error) || 'Speaking failed.');
            } catch (_) { setStatus('speak', 'Speaking failed.'); }
          } finally { speakBtn.disabled = false; }
        });

        // ═════ jobs (Cast, Sound effects) ═════
        const jobs = { cast: null, sfx: null }, clocks = { cast: null, sfx: null };
        function endJob(m) { if (clocks[m]) { clocks[m].stop(); clocks[m] = null; } jobs[m] = null; }
        async function startJob(m, url, body, label) {
          if (jobs[m]) { setStatus(m, 'A job is still running.'); return; }
          const job = jobs[m] = { id: null, status: 'starting', t0: nowDate().getTime() };
          setStatus(m, label + ' — starting…');
          let j = null;
          try { j = await postJson(url, body); } catch (_) { j = { error: 'could not reach Phoenix' }; }
          if (!j || j.error || !j.job) { jobs[m] = null; setStatus(m, (j && j.error) || label + ' — no job started.'); return; }
          job.id = j.job; job.status = 'running';
          let busy = false;
          const tick = async function () {
            if (busy || jobs[m] !== job) return;
            busy = true;
            try {
              const k = await (await deps.fetch('/sfx-job?id=' + encodeURIComponent(job.id))).json();
              if (jobs[m] !== job) return;
              const secs = Math.max(0, Math.round((nowDate().getTime() - job.t0) / 1000));
              if (k.error) { endJob(m); setStatus(m, k.error); return; }
              job.status = k.status;
              setStatus(m, label + ' — ' + k.status + ' · ' + secs + 's');
              if (k.status === 'running') return;
              endJob(m);
              if (k.status !== 'done') { setStatus(m, k.error || 'failed'); return; }
              const res = k.result || {}, at = nowDate().toISOString(), text = m === 'cast' ? (res.text || castLine.value) : undefined, out = [];
              (res.takes || []).forEach(function (t, i) {
                if (!t.playUrl) return;
                out.push({ src: 'take', take: t.local, url: t.playUrl, kind: m, text: text, who: m === 'cast' ? 'Cast · throw ' + (i + 1) : (t.seed != null ? 'SFX · seed ' + t.seed : 'SFX · throw ' + (i + 1)),
                  engine: '', seconds: t.dauer_s != null ? t.dauer_s : null, chainLine: 'dry', at: at });
              });
              addEntries(m, out);
            } catch (_) { /* a single hiccup is not a failure: the next tick asks again */ }
            finally { busy = false; }
          };
          await tick();
          if (jobs[m] === job) clocks[m] = deps.jobClock(tick, 3000);
        }
        castGo.addEventListener('click', function () {
          startJob('cast', '/sfx-cast', { instruction: castDesc.value, text: castLine.value, n: Number(castN.value) }, 'Cast');
        });
        sfxGo.addEventListener('click', function () {
          startJob('sfx', '/sfx-generate', { prompt: sfxPrompt.value, seconds: Number(sfxSeconds.value), n: Number(sfxN.value), seed: sfxSeed.value === '' ? null : Number(sfxSeed.value) }, 'SFX');
        });

        // ═════ bench actions ═════
        async function adopt(m, e) {
          try {
            const j = await postJson('/sfx-adopt', { take: e.take, kind: e.kind, text: e.text, meta: { name: e.who } });
            if (j && j.error) { setStatus(m, j.error); return; }
            dropBenchEntries();   // a new source on the ONE bench: no bench entry describes it any more
            applyBench(j && j.bench);
          } catch (_) { setStatus(m, 'Could not reach Phoenix.'); }
        }
        async function adoptLibrary(m, e) {   // M1.3: a saved clip (sounds/vo, sounds/sfx) becomes the bench's source
          try {
            const j = await postJson('/sfx-adopt', { library: { dir: e.src, file: e.file } });
            if (j && j.error) { setStatus(m, j.error); return; }
            dropBenchEntries();
            applyBench(j && j.bench);
          } catch (_) { setStatus(m, 'Could not reach Phoenix.'); }
        }
        function wireRender(m, b) {
          b.addEventListener('click', async function () {
            if (b.disabled) return;
            b.disabled = true;
            try {
              const sent = racks[m].chain();
              const j = await postJson('/sfx-render', sent || {});
              if (j && j.error) setStatus(m, j.error);
              if (j && j.bench) applyBench(j.bench);   // the bench as the server has it now (after a refused render: the newer bench, dry)
              if (j && j.bench && !j.error) {   // only a committed render is a desk entry
                const kind = benchKindWord();
                MODES.forEach(function (x) { deskData[x] = deskData[x].filter(function (e) { return e.src !== 'bench'; }); if (x !== m) persist(x); });   // ONE file (/sfx-bench.wav), ONE entry on all desks: the newest render replaces it
                addEntries(m, [{ src: 'bench', file: '', url: bench.url, who: 'Bench \u00b7 ' + kind, engine: '', seconds: bench.seconds != null ? bench.seconds : null, chainLine: benchChainLine(m), rev: benchRev(bench), at: nowDate().toISOString() }]);
              }
            } catch (_) { setStatus(m, 'Could not reach Phoenix.'); }
            finally { b.disabled = false; }
          });
        }
        wireRender('cast', renderCast); wireRender('sfx', renderSfx);
        loadGo.addEventListener('click', async function () {
          try {
            const j = await postJson('/sfx-load', { path: loadPath.value });
            if (j && j.error) { setStatus('sfx', j.error); return; }
            dropBenchEntries();   // a new source on the ONE bench: no bench entry describes it any more
            applyBench(j && j.bench);
          } catch (_) { setStatus('sfx', 'Could not reach Phoenix.'); }
        });
        clipSave.addEventListener('click', async function () {
          try {
            const j = await postJson('/sfx-save-clip', { name: clipName.value });
            if (!j || j.error || !j.file) { setStatus('sfx', (j && j.error) || 'Could not save the clip.'); return; }
            addEntries('sfx', [{ src: 'sfx', file: j.file, url: j.url, who: j.file, engine: '', seconds: bench && bench.seconds != null ? bench.seconds : null,
              chainLine: benchChainLine('sfx'), at: nowDate().toISOString() }]);
            setStatus('sfx', 'Saved as ' + j.file);
          } catch (_) { setStatus('sfx', 'Could not reach Phoenix.'); }
        });

        // ═════ Save as voice pack · Add a reference voice ═════
        packOpen.addEventListener('click', function () {
          pack.hidden = !pack.hidden;
          if (!pack.hidden && bench && bench.text) { packTr.value = bench.text; packTr.readOnly = true; }
        });
        packCancel.addEventListener('click', function () { pack.hidden = true; });
        let baking = false;
        packGo.addEventListener('click', async function () {
          if (!isOn(rights) || baking) return;   // the switch decides, not the disabled flag
          baking = true; packGo.disabled = true;
          try {
            try {
              const hj = await (await deps.fetch('/sfx-state')).json();
              const warte = peekWait(hj && hj.health, 'bake');
              if (warte) setStatus('cast', warte);
            } catch (_) { /* a failed peek must never stop the actual attempt */ }
            const j = await postJson('/sfx-save-character', { name: packName.value.trim(), transcript: packTr.value.trim(), iHaveRights: true, overwrite: isOn(over) });
            setStatus('cast', j && j.error ? j.error : 'Baked pack "' + (j && j.pack) + '" — it is now in Speak a line.');
            if (j && !j.error && loaded.speak) refresh('speak');   // the new pack joins the voice picker
          } catch (_) { setStatus('cast', 'Could not reach Phoenix.'); }
          finally { baking = false; syncPackGo(); }
        });
        refAdd.addEventListener('click', async function () {
          if (!(await deps.ensureConsent(refAdd))) return;
          try {
            const j = await postJson('/voice-refs-open');
            if (j && j.error) setStatus('cast', j.error);
          } catch (_) { setStatus('cast', 'Could not reach Phoenix.'); }
        });

        // ═════ the api ═════
        function setMode(m) {
          if (MODES.indexOf(m) < 0) return;
          mode = m;
          MODES.forEach(function (x) { sections[x].hidden = x !== m; });
          if (m === 'speak' && !dispPoll) dispPoll = deps.visiblePoll('audio', dispTick, 3000);
          if (m !== 'speak' && dispPoll) { dispPoll.stop(); dispPoll = null; }
          if (!loaded[m]) { loaded[m] = true; refresh(m); }
          rackFromBench(m);   // the shared bench decides what the rack shows, every time the mode is shown
        }
        function setControl(c) {
          ctl = c === 'knob' ? 'knob' : 'fader';
          MODES.forEach(function (m) { racks[m].setControl(ctl); });
        }
        function onEngineChange() {
          if (vsLast && !userPicked) { const d = defaultChoice(); if (d) selVoice.value = d.value; }
          updateSeed();
        }
        updateSeed();
        benchReady = true;   // from here on every bench answer re-checks the stored bench entries
        return {
          setMode: setMode, mode: function () { return mode; },
          enter: function () { return refresh(mode); },
          refresh: function (m) { return refresh(m); }, loaded: function (m) { return loaded[m] === true; },
          setControl: setControl, control: function () { return ctl; },
          desk: function (m) { return (deskData[m] || []).slice(); }, rack: function (m) { return racks[m]; },
          onEngineChange: onEngineChange,
          job: function (m) { const j = jobs[m]; return j ? { id: j.id, status: j.status } : null; },
        };
      }
      // </r5b-audio>

      // The one instance of the page. window.__audioWs is what switchTab (mode + a fresh arrival), Settings > Voice engines and the engine line (js-35)
      // talk to. The effect-control choice (Faders | Knobs) is a per-viewer working preference: localStorage phoenix.audio.rackControl.
      (function wireAudioWorkspace() {
        const root = document.getElementById('panel-audio');
        if (!root) return;
        const peaks = new Map();
        const api = makeAudioWs({
          document: document, root: root,
          fetch: function (u, o) { return fetch(u, o); },
          visiblePoll: function (ws, fn, ms) { return visiblePoll(ws, fn, ms); },
          jobClock: function (fn, ms) { return jobClock(fn, ms); },
          storage: function () { return localStorage; },
          ensureConsent: function (a) { return window.__voSettings ? window.__voSettings.ensureConsent(a) : Promise.resolve(true); },
          openSettings: function (sec) { shellOpenSettings(sec); },
          voiceEngine: function () { return window.__voiceEngine || 'crispasr'; },
          makeEffectRack: makeEffectRack, rackChainLine: rackChainLine,
          cardStatusText: cardStatusText, cardWaitReason: cardWaitReason,
          wave: function (url) {
            if (!peaks.has(url)) peaks.set(url, fetch(url).then(function (r) { return r.arrayBuffer(); }).then(function (b) { return wavPeaks(b, 48); }).catch(function () { return []; }));
            return peaks.get(url);
          },
          now: function () { return new Date(); },
          voiceState: function (j) { if (window.__voSettings && j && typeof j.consent === 'boolean') window.__voSettings.setConsent(j.consent); },   // VO1b
          openStory: function (boardId, shotId) { return window.__storyOpen ? window.__storyOpen(boardId, shotId) : Promise.resolve(); },   // R6: "Open in Story" after To storyboard
        });
        window.__audioWs = api;
        window.__vo_updateSeedDisabled = function () { api.onEngineChange(); };   // js-35 calls it after every place window.__voiceEngine can change
        window.__voRefresh = function () { return api.loaded('speak') ? api.refresh('speak') : undefined; };   // <lc2c-engine-refresh> Settings > Voice engines calls these after a saved change
        window.__sxRefresh = function () { return Promise.all(['cast', 'sfx'].filter(function (m) { return api.loaded(m); }).map(function (m) { return api.refresh(m); })); };
        const qs = document.getElementById('qs-rack');
        const paint = function (c) { if (qs) Array.prototype.forEach.call(qs.querySelectorAll('[data-rack-control]'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-rack-control') === c ? 'true' : 'false'); }); };
        let stored = 'fader';
        try { if (localStorage.getItem('phoenix.audio.rackControl') === 'knob') stored = 'knob'; } catch (_) { /* no storage: faders */ }
        api.setControl(stored); paint(stored);
        if (qs) qs.addEventListener('click', function (ev) {
          const b = ev.target && ev.target.closest ? ev.target.closest('[data-rack-control]') : null;
          if (!b) return;
          const c = b.getAttribute('data-rack-control') === 'knob' ? 'knob' : 'fader';
          api.setControl(c); paint(c);
          try { localStorage.setItem('phoenix.audio.rackControl', c); } catch (_) { /* a working preference, not data */ }
        });
      })();
