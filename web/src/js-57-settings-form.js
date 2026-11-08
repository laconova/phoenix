      // ── Settings window (R2/R2b): 6 sections · one save rule · one home per setting ────────────────────────
      // Spec: phoenix-design-rules §2 (where things live), §6 (a change saves at once; text saves on Enter / leaving the field; "Saved ✓").
      // SETTINGS_HOMES is the single registry: every editable control carries data-setting = one of its keys (static markup: the literal attribute;
      // JS-built controls: set from the registry), the Onboarding mirrors carry data-setting-mirror. accept.design-rules.js enforces it.

      // <settings-pure>
      // Pure data + helpers (no DOM, no network): the registry, the request each key produces, and the search.
      const SETTINGS_SECTIONS = [
        { id: 'general', label: 'General', desc: 'Theme and feedback. Every change saves at once.' },
        { id: 'brains', label: 'Brains', desc: 'Which AI does which job. Every change saves at once.' },
        { id: 'connections', label: 'Connections', desc: 'ComfyUI, Blender, Unreal, MCP and your phone. Every change saves at once.' },
        { id: 'voice', label: 'Voice engines', desc: 'Run the voice engines on this PC. Every change saves at once.' },
        { id: 'keys', label: 'Cloud & keys', desc: 'API keys and paid cloud features. A typed key saves on Enter or when you leave the field.' },
        { id: 'storage', label: 'Storage & checkpoints', desc: 'Scene copies Phoenix keeps so you can rewind. Every change saves at once.' },
      ];
      const SETTINGS_HOMES = [
        ['ui.theme', 'general'],
        ['feedback.endpointUrl', 'general'],
        ['seats.orchestrator.provider', 'brains'], ['seats.orchestrator.model', 'brains'],
        ['seats.vision.provider', 'brains'], ['seats.vision.model', 'brains'],
        ['seats.metaprompter.provider', 'brains'], ['seats.metaprompter.model', 'brains'],
        ['seats.utility.provider', 'brains'], ['seats.utility.model', 'brains'],
        ['seats.troubleshooter.provider', 'brains'], ['seats.troubleshooter.model', 'brains'],
        ['orchestrator.historyMessages', 'brains'], ['orchestrator.stepTimeoutS', 'brains'], ['orchestrator.maxToolCalls', 'brains'], ['orchestrator.maxToolCallsAuto', 'brains'], ['metaprompter.ejectAfterUse', 'brains'],
        ['endpoints.local', 'connections'], ['endpoints.comfyui', 'connections'], ['apps.blender', 'connections'], ['apps.comfyOutput', 'connections'],
        ['unreal.visionWidth', 'connections'], ['unreal.visionHeight', 'connections'],
        ['mcp.allowBlenderRun', 'connections'], ['mcp.allowUnrealRun', 'connections'], ['mcp.allowDelete', 'connections'], ['remote.enabled', 'connections'],
        ['voice.dispatcherLocal', 'voice'], ['voice.installRoot', 'voice'], ['voice.port', 'voice'], ['voice.watermark', 'voice'],
        ['keys.openai', 'keys'], ['remesh.enabled', 'keys'], ['keys.meshy', 'keys'], ['remesh.maxUploadMB', 'keys'],
        ['video.fal.enabled', 'keys'], ['keys.fal', 'keys'], ['video.fal.audio', 'keys'],
        ['checkpoints.enabled', 'storage'], ['checkpoints.keep', 'storage'], ['checkpoints.maxGB', 'storage'],
        ['gates.prompt', 'quick'], ['gates.image', 'quick'], ['gates.mesh', 'quick'], ['page.blenderOnly', 'quick'], ['gates.vision', 'quick'],
        ['unreal.brushTarget', 'quick'], ['unreal.visionMode', 'quick'],
        ['gates.mode', 'copilot'],
        ['workflows.image', 'create'], ['workflows.i2i', 'create'], ['workflows.mesh', 'create'],
      ].map(function (p) { return { key: p[0], home: p[1] }; });
      // The request that stores one setting: keys -> /secrets, the theme -> /ui/theme, everything else -> /config with ONLY that field's path.
      // Seats (their own gated save), page state and anything outside the registry have no request: null.
      function settingBody(key, value) {
        if (typeof key !== 'string' || !SETTINGS_HOMES.some(function (h) { return h.key === key; })) return null;
        const parts = key.split('.');
        if (parts[0] === 'seats' || parts[0] === 'page') return null;
        if (parts[0] === 'workflows') return { path: '/workflows', body: { stage: parts[1], id: value } };
        if (parts[0] === 'keys') return { path: '/secrets', body: { ref: parts[1], key: value } };
        if (key === 'ui.theme') return { path: '/ui/theme', body: { theme: value } };
        let body = value;
        for (let i = parts.length - 1; i >= 0; i--) { const o = {}; o[parts[i]] = body; body = o; }
        return { path: '/config', body: body };
      }
      // rows = [{ section, key, label, hint? }] -> the rows where every word of the query is in label + hint + section label, in section order.
      // An empty query finds nothing (the view shows everything then).
      function settingsSearch(rows, query) {
        const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) return [];
        const order = SETTINGS_SECTIONS.map(function (s) { return s.id; });
        const labelOf = function (id) { const s = SETTINGS_SECTIONS.find(function (x) { return x.id === id; }); return s ? s.label : ''; };
        const hits = rows.filter(function (r) {
          const hay = (String(r.label || '') + ' ' + String(r.hint || '') + ' ' + labelOf(r.section)).toLowerCase();
          return words.every(function (w) { return hay.indexOf(w) >= 0; });
        });
        return hits.map(function (r, i) { return { r: r, i: i }; })
          .sort(function (a, b) { return (order.indexOf(a.r.section) - order.indexOf(b.r.section)) || (a.i - b.i); })
          .map(function (x) { return x.r; });
      }
      function workflowHome(stage) { const h = SETTINGS_HOMES.find(function (x) { return x.key === 'workflows.' + stage; }); return h ? h.home : null; }
      // </settings-pure>

      // <settings-fields>
      // The shared field components (one implementation per field, used by the Settings rows AND by Onboarding, which passes mirror:true so the
      // control carries data-setting-mirror instead of data-setting) and the one write helper. deps: { document, fetch, settingBody, flash }.
      // A key value only ever travels in the POST body of /secrets - never into an element's text, a log or a URL.
      function makeSettingsFields(deps) {
        const d = deps.document;
        const keyHandles = {};     // ref -> [{ set(bool) }]
        const epHandles = {};      // name -> [{ set(value) }]
        const keyOn = {};          // ref -> last known "a key is stored"
        const KEY_NAME = { openai: 'OpenAI', meshy: 'Meshy', fal: 'fal.ai' };
        function mk(tag, cls, text) { const e = d.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
        // the one error line of a field: say what helps, with a button where one exists. msg '' clears it (the line keeps its height).
        function makeLine() {
          const el = mk('div', 'srow-err'); el.setAttribute('role', 'status');
          function report(msg, action) {
            el.textContent = msg || '';
            if (msg && action && action.label) {
              const b = d.createElement('button'); b.type = 'button'; b.className = 'btn btn-ghost btn-sm'; b.textContent = action.label;
              b.addEventListener('click', function () { action.run(); });
              el.appendChild(b);
            }
          }
          return { el: el, report: report };
        }
        // One write: POST the request settingBody(key, value) names (or an explicit override { path, body }). Success -> "Saved ✓"; failure -> ONE line.
        async function save(key, value, report, override) {
          const req = override || deps.settingBody(key, value);
          if (!req) return { ok: false, error: 'not a saved setting' };
          const say = report || function () {};
          let r, j = {};
          try {
            r = await deps.fetch(req.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
            try { j = await r.json(); } catch (_) {}
          } catch (_) {
            const m = 'Phoenix is not reachable — not saved. Check that it is still running.';
            say(m); return { ok: false, error: m };
          }
          if (!r.ok) {
            const m = ((j && j.error) || ('The server refused it (' + r.status + ')')) + ' — not saved.';
            say(m); return { ok: false, error: m, json: j };
          }
          say('');
          deps.flash();
          return { ok: true, json: j };
        }
        // Write-only key field: type + Enter / leave the field saves; the field empties; "Clear" deletes after an inline confirm row.
        function renderKeyField(host, ref, opts) {
          opts = opts || {};
          const key = 'keys.' + ref, name = KEY_NAME[ref] || ref;
          const wrap = mk('div', 'keyfield');
          const line = mk('div', 'keyfield-line');
          const inp = d.createElement('input');
          inp.type = 'password'; inp.id = opts.id || ('key-' + ref); inp.autocomplete = 'off'; inp.spellcheck = false; inp.placeholder = 'not set';
          if (opts.placeholder) inp.setAttribute('data-hint', opts.placeholder);
          if (opts.mirror) inp.dataset.settingMirror = key; else inp.dataset.setting = key;
          const clear = d.createElement('button'); clear.type = 'button'; clear.className = 'btn btn-danger btn-sm'; clear.textContent = 'Clear'; clear.hidden = true;
          line.appendChild(inp); line.appendChild(clear);
          const confirm = mk('div', 'keyfield-confirm'); confirm.hidden = true;
          const ask = mk('span', null, 'Delete the stored ' + name + ' key?');
          const yes = d.createElement('button'); yes.type = 'button'; yes.className = 'btn btn-danger btn-sm'; yes.textContent = 'Delete key';
          const no = d.createElement('button'); no.type = 'button'; no.className = 'btn btn-ghost btn-sm'; no.textContent = 'Keep it';
          confirm.appendChild(ask); confirm.appendChild(yes); confirm.appendChild(no);
          const status = mk('div', 'srow-hint', 'not set'); status.setAttribute('role', 'status'); if (opts.statusId) status.id = opts.statusId;
          const ln = makeLine();
          wrap.appendChild(line); wrap.appendChild(confirm); wrap.appendChild(status); wrap.appendChild(ln.el);
          let isSet = false, busy = false, shown = 'not set';
          function show(set) {
            isSet = !!set; keyOn[ref] = isSet;
            shown = isSet ? 'stored ✓' : 'not set';
            status.textContent = shown; inp.placeholder = shown; clear.hidden = !isSet; if (!isSet) confirm.hidden = true;
          }
          async function commit() {
            const v = String(inp.value || '').trim();
            if (!v || busy) return;
            busy = true; status.textContent = 'saving…';
            const res = await save(key, v, ln.report);
            busy = false;
            if (!res.ok) { status.textContent = shown; return; }
            inp.value = '';
            const on = !!(res.json && res.json.keys && res.json.keys[ref]);
            (keyHandles[ref] || []).forEach(function (h) { h.set(on); });
            if (opts.onChange) opts.onChange(on, ref);
          }
          async function wipe() {
            if (busy) return;
            busy = true; confirm.hidden = true;
            const res = await save(key, '', ln.report);
            busy = false;
            if (!res.ok) return;
            inp.value = '';
            (keyHandles[ref] || []).forEach(function (h) { h.set(false); });
            if (opts.onChange) opts.onChange(false, ref);
          }
          inp.addEventListener('input', function () { const typed = String(inp.value || '').trim() !== ''; status.textContent = typed ? 'not saved yet — press Enter or leave the field' : shown; });
          inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { if (e.preventDefault) e.preventDefault(); commit(); } });
          inp.addEventListener('change', commit);
          clear.addEventListener('click', function () { confirm.hidden = false; });
          yes.addEventListener('click', wipe);
          no.addEventListener('click', function () { confirm.hidden = true; });
          // Onboarding re-renders its mirror on every step change: only the newest mirror of a key is kept, so the list stays bounded
          keyHandles[ref] = (keyHandles[ref] || []).filter(function (h) { return !(opts.mirror && h.mirror); });
          keyHandles[ref].push({ set: show, input: inp, mirror: !!opts.mirror });
          show(keyOn[ref] === true);
          host.appendChild(wrap);
          return { input: inp, set: show, status: status, line: ln };
        }
        // Endpoint text field (ComfyUI / local server): saves on Enter / leaving the field, only when it differs from the stored value.
        function renderEndpointField(host, name, opts) {
          opts = opts || {};
          const key = 'endpoints.' + name;
          const wrap = mk('div', 'epfield');
          const inp = d.createElement('input');
          inp.type = 'text'; inp.id = opts.id || ('ep-' + name); inp.autocomplete = 'off'; inp.spellcheck = false;
          if (opts.placeholder) inp.placeholder = opts.placeholder;
          if (opts.mirror) inp.dataset.settingMirror = key; else inp.dataset.setting = key;
          const ln = makeLine();
          wrap.appendChild(inp); wrap.appendChild(ln.el);
          let stored = opts.value != null ? String(opts.value) : '', busy = false;
          inp.value = stored;
          function set(v) { stored = String(v == null ? '' : v); inp.value = stored; }
          async function commit() {
            const v = String(inp.value || '').trim();
            if (busy) return;
            if (v === stored) { ln.report(''); return; }
            busy = true; ln.el.textContent = 'checking…'; ln.el.className = 'srow-err srow-busy';
            const res = await save(key, v, ln.report, null);
            ln.el.className = 'srow-err';
            busy = false;
            if (!res.ok) {
              if (opts.helpSection) ln.report(res.error, { label: 'Open Connections', run: opts.helpSection });
              inp.value = stored; return;
            }
            stored = v;
            (epHandles[name] || []).forEach(function (h) { if (h.input !== inp) h.set(v); });
            if (opts.onSaved) { const msg = await opts.onSaved(v, res.json); if (typeof msg === 'string') ln.report(msg); }
          }
          inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { if (e.preventDefault) e.preventDefault(); commit(); } });
          inp.addEventListener('change', commit);
          epHandles[name] = (epHandles[name] || []).filter(function (h) { return !(opts.mirror && h.mirror); });   // same rule as the key fields
          epHandles[name].push({ set: set, input: inp, mirror: !!opts.mirror });
          host.appendChild(wrap);
          return { input: inp, set: set, line: ln };
        }
        function setKeys(keys) { Object.keys(KEY_NAME).forEach(function (ref) { const on = !!(keys && keys[ref]); keyOn[ref] = on; (keyHandles[ref] || []).forEach(function (h) { h.set(on); }); }); }
        function setEndpoints(eps) { Object.keys(epHandles).forEach(function (n) { if (eps && typeof eps[n] === 'string') (epHandles[n] || []).forEach(function (h) { if (!(d.activeElement && d.activeElement === h.input)) h.set(eps[n]); }); }); }
        return { save: save, makeLine: makeLine, renderKeyField: renderKeyField, renderEndpointField: renderEndpointField, setKeys: setKeys, setEndpoints: setEndpoints, keyState: function () { return Object.assign({}, keyOn); },
          handleCount: function () { let n = 0; Object.keys(keyHandles).forEach(function (k) { n += keyHandles[k].length; }); Object.keys(epHandles).forEach(function (k) { n += epHandles[k].length; }); return n; } };
      }
      // </settings-fields>

      // "Saved ✓" for ~2 s in the Settings header and the Quick switches popover; the spans are always there, so nothing moves.
      let setSavedTimer = null;
      function flashSettingsSaved() {
        ['set-saved', 'qs-saved'].forEach(function (id) { const s = document.getElementById(id); if (s) s.textContent = 'Saved ✓'; });
        if (setSavedTimer !== null) clearTimeout(setSavedTimer);
        setSavedTimer = setTimeout(function () {
          setSavedTimer = null;
          ['set-saved', 'qs-saved'].forEach(function (id) { const s = document.getElementById(id); if (s) s.textContent = ''; });
        }, 2000);
      }
      const settingsFields = makeSettingsFields({ document: document, fetch: function (u, o) { return fetch(u, o); }, settingBody: function (k, v) { return settingBody(k, v); }, flash: flashSettingsSaved });
      const settingsHooks = {};   // set while the Settings window is open: { keyChanged(ref, isSet) } -> the seat pickers follow a key

      // ── the window: nav, sections, search ──
      const settingsWin = document.getElementById('settings-win');
      // <settings-view>
      let setActive = 'general', setQuery = '', setPhone = false, setReturnFocus = null;
      function normalizeSection(t) {
        if (t === 'conn') t = 'connections';   // the old four-tab values
        if (t === 'appearance') t = 'general';   // R2b: the themes moved into General
        return SETTINGS_SECTIONS.some(function (s) { return s.id === t; }) ? t : 'general';
      }
      // the searchable rows: every .srow with a label (seat rows included), built from what is rendered right now
      function settingsRows() {
        const rows = [];
        SETTINGS_SECTIONS.forEach(function (sec) {
          const pane = setById('set-sec-' + sec.id);
          if (!pane) return;
          pane.querySelectorAll('.srow').forEach(function (el) {
            const lab = el.querySelector('.srow-label'), hint = el.querySelector('.srow-hint'), ctl = el.querySelector('[data-setting]');
            if (!lab) return;
            const themes = Array.prototype.map.call(el.querySelectorAll('.theme-name'), function (n) { return n.textContent; }).join(' ');   // R2b: the theme names are searchable ("brass", "light")
            rows.push({ section: sec.id, key: ctl ? ctl.dataset.setting : '', label: lab.textContent, hint: ((hint ? hint.textContent : '') + ' ' + themes).trim(), el: el });
          });
        });
        return rows;
      }
      function renderSettingsView() {
        const q = setQuery.trim();
        const hits = {}, hitEls = new Set();
        if (q && !setPhone) settingsSearch(settingsRows(), q).forEach(function (r) { (hits[r.section] = hits[r.section] || []).push(r); hitEls.add(r.el); });
        const anyHit = Object.keys(hits).length > 0;
        if (q && anyHit && !hits[setActive]) setActive = SETTINGS_SECTIONS.map(function (s) { return s.id; }).find(function (id) { return hits[id]; });
        const sec = SETTINGS_SECTIONS.find(function (s) { return s.id === setActive; });
        document.querySelectorAll('#set-nav [data-sec]').forEach(function (b) {
          const id = b.dataset.sec, cnt = b.querySelector('.set-nav-count');
          b.hidden = setPhone || (!!q && !hits[id]);
          if (id === setActive && !setPhone) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
          if (cnt) { cnt.hidden = !(q && hits[id]); cnt.textContent = hits[id] ? String(hits[id].length) : ''; }
        });
        SETTINGS_SECTIONS.forEach(function (s) {
          const pane = setById('set-sec-' + s.id);
          if (!pane) return;
          pane.hidden = setPhone || s.id !== setActive || (!!q && !anyHit);
          pane.querySelectorAll('.srow').forEach(function (el) { el.hidden = !!q && !hitEls.has(el); });
          // search hides group titles / notes through its OWN attribute, so clearing it never un-hides what an owner hid (e.g. #vs-save-hint while the rig locks the pane)
          pane.querySelectorAll('.sgroup-title, .snote, .seats-head').forEach(function (el) { if (q) el.setAttribute('data-search-hidden', '1'); else el.removeAttribute('data-search-hidden'); });
          pane.querySelectorAll('details').forEach(function (dt) { if (q && dt.querySelector('.srow:not([hidden])')) dt.open = true; });
        });
        const nohit = setById('set-nohits'); if (nohit) nohit.hidden = !(q && !anyHit) || setPhone;
        const t = setById('set-sec-title'), ds = setById('set-sec-desc');
        if (t) t.textContent = setPhone ? 'Settings' : sec.label;
        if (ds) ds.textContent = setPhone ? '' : sec.desc;
        const ph = setById('set-phone'); if (ph) ph.hidden = !setPhone;
        const srch = setById('set-search'); if (srch) srch.disabled = setPhone;
        const rs = setById('set-run-setup'); if (rs) rs.hidden = setPhone;   // onboarding writes are laptop-only
      }
      function showSection(id, save) {
        setActive = normalizeSection(id);
        if (save) { try { localStorage.setItem('phoenix.settingsTab', setActive); } catch (_) {} }
        renderSettingsView();
        const body = setById('set-body'); if (body) body.scrollTop = 0;
        if (setActive === 'keys' && typeof refreshRemeshBalance === 'function') refreshRemeshBalance();
        if (setActive === 'connections' && window.__remoteUi) window.__remoteUi.refresh();   // <r1-remote>
        if (setActive === 'voice' && window.__voSettings) window.__voSettings.load();
        if (setActive === 'storage' && window.__cacheClean) window.__cacheClean.refresh();   // F2.9: read once each time the section opens
        if (setActive === 'general') fillVersion();   // F6.8: read once each time the section opens, no timer
      }
      function fillVersion() {
        const el = setById('set-version'); if (!el) return;
        fetch('/version').then(function (r) { return r.json(); }).then(function (j) { if (j && j.version) el.textContent = 'Phoenix ' + j.version; }).catch(function () { /* the row stays empty */ });
      }
      // </settings-view>
      // the window is open: restore the last section (or the one asked for), clear the search, load every value
      function openSettingsWindow(sec) {
        setReturnFocus = document.activeElement || null;
        setPhone = !!(window.__remoteUi && window.__remoteUi.isRemote());   // <r1-remote> a phone reads the note and flips the quick switches; the rest is the laptop's
        setQuery = ''; { const s = setById('set-search'); if (s) s.value = ''; }
        let t0 = 'general';
        if (!sec) { try { t0 = localStorage.getItem('phoenix.settingsTab') || 'general'; } catch (_) {} }
        settingsWin.hidden = false;
        renderThemeRows(setById('set-theme-host'));   // the active mark follows the theme (also one applied from the phone or the palette)
        showSection(sec || t0, false);
        if (!setPhone) loadGates();
        const cur = document.querySelector('#set-nav [data-sec][aria-current="page"]');
        const first = setPhone ? setById('remote-quick-open') : cur;
        if (first && first.focus) first.focus();
      }
      function closeSettingsWindow() {
        settingsWin.hidden = true;
        const f = setReturnFocus; setReturnFocus = null;
        if (f && f.focus && document.contains(f)) f.focus();
      }
      document.querySelectorAll('#set-nav [data-sec]').forEach(function (b) { b.addEventListener('click', function () { showSection(b.dataset.sec, true); }); });
      setById('set-search').addEventListener('input', function () { setQuery = this.value; renderSettingsView(); });
      setById('set-close').addEventListener('click', closeSettingsWindow);
      setById('set-run-setup').addEventListener('click', function () { closeSettingsWindow(); if (typeof openOnboarding === 'function') openOnboarding(); });
      setById('remote-quick-open').addEventListener('click', function () { closeSettingsWindow(); settingsPanel.hidden = false; loadGates(); });
      setById('qs-all-settings').addEventListener('click', function () { toggleQuickSwitches(false); openSettings(); });
      settingsWin.addEventListener('click', function (e) { if (e.target === settingsWin) closeSettingsWindow(); });
      settingsWin.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        if (setQuery) { setQuery = ''; setById('set-search').value = ''; renderSettingsView(); } else closeSettingsWindow();   // Esc clears the search first
      });

      // ── values: the registry fills every direct control, one write helper saves it ──
      // <settings-values>
      const SET_STORE = {};       // key -> the stored value of every direct control (the diff base of "save only when it changed")
      const SET_INFLIGHT = {};
      function setById(id) { return document.getElementById(id); }
      const SET_DEFAULT_ON = ['gates.prompt', 'gates.image', 'gates.mesh', 'checkpoints.enabled', 'video.fal.audio'];
      const SET_DEFAULT = { 'gates.vision': 'focused', 'unreal.brushTarget': 'blender', 'unreal.visionMode': 'camera', 'orchestrator.historyMessages': 3, 'orchestrator.stepTimeoutS': 300, 'orchestrator.maxToolCalls': 3,
        'orchestrator.maxToolCallsAuto': 8, 'checkpoints.keep': 10, 'checkpoints.maxGB': 2, 'remesh.maxUploadMB': 60, 'unreal.visionWidth': 1280, 'unreal.visionHeight': 720 };
      // controls with their own save path: seats (gated), keys / endpoints (field components), the theme, the phone switch, the voice pane, page state, the Copilot toggle
      const SET_OWN = /^(keys|seats|page|voice|remote|workflows)\.|^endpoints\.|^ui\.theme$|^gates\.mode$/;
      function readControl(el) {
        if (el.type === 'checkbox') return !!el.checked;
        if (el.type === 'number') return el.value === '' ? NaN : Number(el.value);
        return String(el.value == null ? '' : el.value).trim();
      }
      function writeControl(el, v) {
        if (el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : String(v);
      }
      function setControlLabel(el) {
        const l = el.id ? document.querySelector('label[for="' + el.id + '"]') : null;
        return (l && l.textContent) || el.getAttribute('aria-label') || 'This value';
      }
      // a number outside min / max / whole-number is refused here with the reason - the server checks again
      function badNumber(el, v) {
        const mn = el.getAttribute('min'), mx = el.getAttribute('max'), whole = el.getAttribute('step') === '1';
        if (!isFinite(v) || (whole && !Number.isInteger(v)) || (mn !== null && v < Number(mn)) || (mx !== null && v > Number(mx))) {
          return setControlLabel(el) + ' must be ' + (whole ? 'a whole number' : 'a number') + (mn !== null && mx !== null ? ' from ' + mn + ' to ' + mx : '') + ' — not saved.';
        }
        return '';
      }
      function setLineFor(el) {
        const row = el.closest ? el.closest('.srow') : null;
        if (row) return row.querySelector('.srow-err');
        return el.closest && el.closest('#settings-panel') ? setById('qs-err') : null;
      }
      function setReporter(el) {
        const line = setLineFor(el);
        return function (msg) { if (line) line.textContent = msg || ''; };
      }
      function fillSettings(c) {
        createPipe.set({ gates: c.gates || {} });
        c = c || {};
        document.querySelectorAll('[data-setting]').forEach(function (el) {
          const key = el.dataset.setting;
          if (!key || SET_OWN.test(key)) return;
          let v = c; key.split('.').forEach(function (p) { v = (v && typeof v === 'object') ? v[p] : undefined; });
          if (el.type === 'checkbox') v = SET_DEFAULT_ON.indexOf(key) >= 0 ? v !== false : v === true;
          else if (el.tagName === 'SELECT') { if (!Array.prototype.some.call(el.options, function (o) { return o.value === v; })) v = SET_DEFAULT[key]; }
          else if (v === undefined || v === null) v = key in SET_DEFAULT ? SET_DEFAULT[key] : '';
          writeControl(el, v);
          SET_STORE[key] = v;
        if (/^gates\.(prompt|image|mesh)$/.test(key)) { const gates = {}; gates[key.split('.')[1]] = v; createPipe.set({ gates: gates }); }
        });
        // a key found only in the environment still counts as stored (GET /config reports it as keyPresent, never as keys.<ref>)
        settingsFields.setKeys(Object.assign({}, c.keys, { meshy: !!((c.keys && c.keys.meshy) || (c.remesh && c.remesh.keyPresent === true)), fal: !!((c.keys && c.keys.fal) || (c.video && c.video.fal && c.video.fal.keyPresent === true)) }));
        settingsFields.setEndpoints(c.endpoints);
        SET_STORE['seats.openai'] = Object.keys(c.seats || {}).some(function (n) { const s = c.seats[n]; return s && s.provider === 'openai-compat' && s.endpoint === 'openai'; });
        updateMissingBadge();
      }
      // the Cloud & keys nav badge: keys that an enabled feature or a chosen seat provider needs but that are not stored
      function missingKeyCount() {
        const k = settingsFields.keyState();
        return (SET_STORE['seats.openai'] && !k.openai ? 1 : 0) + (SET_STORE['remesh.enabled'] && !k.meshy ? 1 : 0) + (SET_STORE['video.fal.enabled'] && !k.fal ? 1 : 0);
      }
      function updateMissingBadge() {
        const b = setById('set-badge-keys'); if (!b) return;
        const n = missingKeyCount();
        b.textContent = n + ' missing'; b.hidden = n === 0;
      }
      function afterSave(key, v, j) {
        if (key === 'gates.vision') setVisionGateVal(v);
        if (key.indexOf('checkpoints.') === 0 && typeof refreshCheckpoints === 'function') refreshCheckpoints();
        if (key.indexOf('remesh.') === 0 && j && j.remesh) {
          REMESH_ON = j.remesh.enabled === true; REMESH_DEFAULTS = { topology: j.remesh.topology, targetPolycount: j.remesh.targetPolycount };
          if (typeof loadAssets === 'function') loadAssets();
        }
        updateMissingBadge();
      }
      // one control, one write: toggles / selects on change; text and number on Enter or leaving the field, only when the value differs from the stored one
      async function commitControl(el) {
        const key = el.dataset.setting;
        if (!key || SET_INFLIGHT[key]) return;
        const report = setReporter(el);
        const v = readControl(el);
        if (el.type === 'number') {
          const bad = badNumber(el, v);
          if (bad) { report(bad); if (key in SET_STORE) writeControl(el, SET_STORE[key]); return; }
        }
        if ((el.type === 'text' || el.type === 'number') && v === SET_STORE[key]) { report(''); return; }
        let override = null;
        if (key === 'unreal.visionWidth' || key === 'unreal.visionHeight') {   // the two render-size fields travel together
          override = { path: '/config', body: { unreal: { visionWidth: parseInt(setById('set-vision-w').value, 10), visionHeight: parseInt(setById('set-vision-h').value, 10) } } };
        }
        SET_INFLIGHT[key] = true;
        const res = await settingsFields.save(key, v, report, override);
        SET_INFLIGHT[key] = false;
        if (!res.ok) { if (key in SET_STORE) writeControl(el, SET_STORE[key]); return; }
        SET_STORE[key] = v;
        if (/^gates\.(prompt|image|mesh)$/.test(key)) { const gates = {}; gates[key.split('.')[1]] = v; createPipe.set({ gates: gates }); }
        afterSave(key, v, res.json);
      }
      // </settings-values>
      // <settings-wire>
      document.querySelectorAll('[data-setting]').forEach(function (el) {
        const key = el.dataset.setting;
        if (!key || SET_OWN.test(key)) return;
        el.addEventListener('change', function () { commitControl(el); });
        if (el.type === 'text' || el.type === 'number') el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { if (e.preventDefault) e.preventDefault(); commitControl(el); } });
      });
      // </settings-wire>

      // ── Brains: the seats table. Built on every open, because the picker lists ask the server again. ──
      // <seat-check-pure>
      function seatCheckReading(chk) {
        if (!chk) return null;
        if (chk.phase === 'running') return { state: 'running', text: chk.title + (chk.tested ? ': testing…' : ': saving…'), tip: chk.tested ? 'Testing ' + (chk.model || 'Codex default') : 'Saving ' + (chk.model || 'Codex default') };
        if (chk.phase === 'saved') return { state: 'ok', text: chk.title + ': saved ✓' };
        const why = String(chk.why || 'Not saved.');
        return { state: 'warn', text: chk.title + ': not changed', tip: why };
      }
      // </seat-check-pure>
      // <seat-check-ui>
      const seatChecks = new Map();
      let seatCheckSerial = 0, seatCheckFocus = null;
      const seatCheckRows = new Map();
      function seatCheckCurrent() {
        return Array.from(seatChecks.values()).filter(function (c) { return c.visible; }).sort(function (a, b) { return Number(b.phase === 'running') - Number(a.phase === 'running') || b.serial - a.serial; })[0] || null;
      }
      function seatCheckRender() { if (window.__renderStatusBar) window.__renderStatusBar(); }
      function seatCheckUpdate(name, patch) {
        const old = seatChecks.get(name);
        if (old && old.timer) clearTimeout(old.timer);
        const c = Object.assign({}, old, patch, { name: name, visible: true, serial: ++seatCheckSerial, timer: null, rowShown: false });
        seatChecks.set(name, c);
        if (c.phase === 'saved') c.timer = setTimeout(function () { if (seatChecks.get(name) === c) { seatChecks.delete(name); seatCheckRender(); } }, 4000);
        const row = seatCheckRows.get(name); if (row) row(c);
        if (c.phase !== 'running' && row && !settingsWin.hidden && setActive === 'brains') { c.visible = false; c.rowShown = true; }
        seatCheckRender();
      }
      window.registerStatusItem({ id: 'seat-check', label: 'Seat check', kind: 'dot', order: 900,
        read: function () { return seatCheckReading(seatCheckCurrent()); },
        click: function () {
          const c = seatCheckCurrent(); if (!c) return;
          if (c.phase !== 'running') c.visible = false; seatCheckFocus = c.name; seatCheckRender();
          shellOpenSettings('brains');
        }
      });
      // </seat-check-ui>

      async function openSettings() {
        openSettingsWindow();
        if (window.__remoteUi && window.__remoteUi.isRemote()) return;   // a phone sees the note (set-phone) instead

        // ── Providers (v1.9): which AI answers each seat ───────────────────────
        // Per seat: a provider select + a REAL model select (the list depends on the provider) + a text
        // input that holds the saved value (shown only for "Custom…"). The text input is the single
        // source of truth for the save; the legacy Orchestrator/Metaprompter pickers above are hidden.
        const PROVIDER_CHOICES = [
          { label: 'Claude CLI',       value: 'claude-cli' },
          { label: 'Local server',     value: 'local' },
          { label: 'OpenAI (API key)', value: 'openai' },
          { label: 'ChatGPT plan (Codex CLI)', value: 'codex' },   // saved as provider 'codex-cli'
        ];
        const CODEX_HINT = 'Uses your ChatGPT subscription (Plus/Pro). Businesses: use OpenAI (API key).';
        // [seat, row title, Claude default, what it does] - the canvas order
        const SEAT_ROWS = [
          ['orchestrator', 'Orchestrator', 'claude-sonnet-4-6', 'drives the scene'],
          ['vision', 'Vision', 'claude-opus-4-8', 'judges renders'],   // v1.9 M3: no override, local/OpenAI need the vision test
          ['metaprompter', 'Metaprompter', 'claude-haiku-4-5-20251001', 'writes image prompts'],
          ['utility', 'Category', 'claude-sonnet-4-6', 'sorts new props'],
          ['troubleshooter', 'Troubleshooter', 'claude-sonnet-4-6', 'reads logs, explains'],
        ];
        // Claude models: aliases always resolve to the newest model; fixed ids pin a version.
        // One constant, easy to update when new models ship.
        const CLAUDE_ALIASES = [
          { value: 'opus',   label: 'opus — newest Opus' },
          { value: 'sonnet', label: 'sonnet — newest Sonnet' },
          { value: 'haiku',  label: 'haiku — newest Haiku' },
          { value: 'fable',  label: 'fable — newest Fable' },
        ];
        const CLAUDE_FIXED = [
          'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001',
          'claude-opus-4-8', 'claude-sonnet-4-6',
        ].map(id => ({ value: id, label: id }));
        const ALIAS_HINT = 'Aliases follow new releases automatically — for the vision judge a fixed version keeps verdicts comparable.';
        const OPENAI_CHAT_ID = /^(gpt-|o[0-9]|chatgpt-)/;   // the endpoint also lists embedding/audio/image models
        let _keySet = false;

        function addOpt(parent, value, label, opts) {
          const o = document.createElement('option');
          o.value = value; o.textContent = label;
          if (opts && opts.disabled) o.disabled = true;
          if (opts && opts.title) o.title = opts.title;
          parent.appendChild(o);
          return o;
        }
        function addGroup(pick, label, items) {
          const g = document.createElement('optgroup'); g.label = label;
          for (const it of items) addOpt(g, it.value, it.label);
          pick.appendChild(g);
        }
        // Rebuild one seat's model select. NO caching: every call asks the server again, so a failed
        // fetch (server down, tunnel off) never blocks the next try. A token drops stale answers.
        async function renderPick(name) {
          const ctl = seatCtl[name];
          const pick = ctl.pick, prov = ctl.sel.value; let cur = ctl.mdl.value.trim();
          updateKeyNote(name);
          const token = ctl.token = (ctl.token || 0) + 1;
          pick.innerHTML = '';
          ctl.retry.style.display = 'none';
          const ids = [];
          if (prov === 'claude-cli') {
            addGroup(pick, 'Always the latest', CLAUDE_ALIASES);
            addGroup(pick, 'Fixed version', CLAUDE_FIXED);
            for (const it of CLAUDE_ALIASES.concat(CLAUDE_FIXED)) ids.push(it.value);
          } else {
            let models = [], note = '', title = '', labels = {};
            if (prov === 'codex') addOpt(pick, '', 'Codex default');   // empty model = Codex's own default
            try {
              if (prov === 'codex') {
                const j = await (await fetch('/provider-models?provider=codex')).json();
                if (j.reachable === false) { note = 'Codex CLI not found — npm install -g @openai/codex'; title = j.error || ''; }
                else if (!j.loggedIn) { note = 'Codex is not logged in — run `codex login` in a terminal, then Retry'; title = j.error || ''; }
                else if (Array.isArray(j.models)) { models = j.models; labels = j.labels || {}; if (!models.length) { note = 'No Codex models listed'; title = j.error || ''; } }
              } else if (prov === 'local') {
                const j = await (await fetch('/lmstudio/models' + (candEndpoints() ? '?local=' + encodeURIComponent(candEndpoints().local) : ''))).json();
                if (j.reachable && Array.isArray(j.models)) {
                  models = j.models;
                  if (!models.length) note = 'No models loaded on the local server';
                } else { note = 'Local server not reachable at ' + (j.base || 'the configured endpoint') + ' — start it (or the tunnel), then Retry'; title = j.error || ''; }
              } else {
                if (!_keySet) note = 'Add the OpenAI key in Cloud & keys first';
                else {
                  const j = await (await fetch('/provider-models?endpoint=openai')).json();
                  if (Array.isArray(j.models) && !j.error) {
                    models = j.models.filter(id => OPENAI_CHAT_ID.test(id));
                    if (!models.length) note = 'OpenAI returned no chat models';
                  } else { note = 'OpenAI model list not available — Retry'; title = j.error || ''; }
                }
              }
            } catch (e) { note = (prov === 'local' ? 'Local server not reachable' : 'OpenAI model list not available') + ' — Retry'; title = e.message; }
            if (token !== ctl.token) return;   // a newer render superseded this one
            if (note) { addOpt(pick, '', note, { disabled: true, title }); if (!models.length) ctl.retry.style.display = ''; }
            for (const id of models) { addOpt(pick, id, prov === 'codex' && labels[id] ? labels[id] + ' (' + id + ')' : id); ids.push(id); }
            if (prov === 'codex') ids.push('');
          }
          if (token !== ctl.token) return;
          // Provider switch (M2.3): a model id from another provider is never carried over silently — it survives only if the
          // NEW provider's freshly loaded list contains it; otherwise the model resets (Codex default / "— pick a model —").
          if (ctl.switching) {
            ctl.switching = false;
            if (cur && !ids.includes(cur)) { cur = ''; ctl.mdl.value = ''; }
          }
          // A saved value outside the list is shown, never silently replaced.
          if (cur && !ids.includes(cur)) addOpt(pick, cur, '(current) ' + cur);
          addOpt(pick, '__custom__', 'Custom…');
          if (cur) pick.value = cur;
          else if (prov === 'codex') pick.value = '';
          else { const ph = document.createElement('option'); ph.value = ''; ph.textContent = '— pick a model —'; ph.disabled = true; pick.insertBefore(ph, pick.firstChild); pick.value = ''; }
          ctl.mdl.style.display = pick.value === '__custom__' ? '' : 'none';
          ctl.aliasHint.style.display = CLAUDE_ALIASES.some(a => a.value === cur) && prov === 'claude-cli' ? '' : 'none';
          ctl.codexHint.style.display = prov === 'codex' ? '' : 'none';
          syncNotes(ctl);
          renderCaps(name);
        }
        function refreshOpenaiPicks() { for (const [n] of SEAT_ROWS) if (seatCtl[n] && seatCtl[n].sel.value === 'openai') renderPick(n); }


        const seatCtl = {};
        // R2b: the full-width notes line is only there while one of its three hints shows (no empty band, no extra row gap)
        function syncNotes(ctl) {
          if (!ctl || !ctl.notesCell) return;
          ctl.notesCell.hidden = !!ctl.keyNote.hidden && ctl.codexHint.style.display === 'none' && ctl.aliasHint.style.display === 'none';
        }
        const PROBED_SEATS = ['orchestrator', 'troubleshooter'];   // the seats that drive tools (v1.9 M2)
        const seatHost = document.getElementById('set-seats-host') || toolBody;
        while (seatHost.firstChild) seatHost.removeChild(seatHost.firstChild);
        const homeKey = function (key) { const h = SETTINGS_HOMES.find(function (x) { return x.key === key; }); return h ? h.key : ''; };   // data-setting always comes from the registry
        function mkBtn(text, cls, id) {
          const b = document.createElement('button');
          b.type = 'button'; b.className = cls; b.textContent = text;
          if (id) b.id = id;
          return b;
        }
        for (const [name, title, claudeDefault, job] of SEAT_ROWS) {
          const row = document.createElement('div');
          row.className = 'seat-row srow'; row.id = 'set-seat-' + name + '-row';
          // Job
          const sel = document.createElement('select');
          sel.id = 'set-seat-' + name + '-provider'; sel.dataset.setting = homeKey('seats.' + name + '.provider');
          for (const c of PROVIDER_CHOICES) addOpt(sel, c.value, c.label);
          const pick = document.createElement('select');
          pick.id = 'set-seat-' + name + '-model-pick'; pick.dataset.setting = homeKey('seats.' + name + '.model');
          const jobCell = document.createElement('div'); jobCell.className = 'seat-job';
          const l1 = document.createElement('label'); l1.className = 'srow-label'; l1.htmlFor = sel.id; l1.textContent = title;
          const jobHint = document.createElement('span'); jobHint.className = 'srow-hint'; jobHint.textContent = job;
          jobCell.appendChild(l1); jobCell.appendChild(jobHint);
          // Provider
          const provCell = document.createElement('div'); provCell.className = 'seat-prov';
          provCell.appendChild(sel);
          // Model: the pick + (for "Custom…") the text input that holds the saved value
          const retry = mkBtn('Retry', 'btn btn-secondary btn-sm');
          retry.style.display = 'none';
          const mdl = document.createElement('input');
          mdl.type = 'text'; mdl.id = 'set-seat-' + name + '-model'; mdl.autocomplete = 'off'; mdl.spellcheck = false;
          mdl.placeholder = 'model id'; mdl.style.display = 'none';
          const l2 = document.createElement('label'); l2.className = 'sr-only'; l2.htmlFor = pick.id; l2.textContent = title + ' model';
          const aliasHint = document.createElement('p');
          aliasHint.className = 'srow-hint'; aliasHint.id = 'set-seat-' + name + '-alias-hint';
          aliasHint.textContent = ALIAS_HINT; aliasHint.style.display = 'none';
          const codexHint = document.createElement('p');
          codexHint.className = 'srow-hint'; codexHint.id = 'set-seat-' + name + '-codex-hint';
          codexHint.textContent = CODEX_HINT; codexHint.style.display = 'none';
          const keyNote = document.createElement('div'); keyNote.className = 'seat-key-note'; keyNote.id = 'set-seat-' + name + '-keynote'; keyNote.hidden = true;
          const keyNoteTxt = document.createElement('span'); keyNoteTxt.textContent = 'needs a key — ';
          const keyNoteBtn = mkBtn('add it in Cloud & keys', 'btn btn-ghost btn-sm');
          keyNoteBtn.addEventListener('click', function () { showSection('keys', true); const k = setById('set-key-openai'); if (k && k.focus) k.focus(); });
          keyNote.appendChild(keyNoteTxt); keyNote.appendChild(keyNoteBtn);
          const modelCell = document.createElement('div'); modelCell.className = 'seat-model';
          modelCell.appendChild(l2); modelCell.appendChild(pick); modelCell.appendChild(retry); modelCell.appendChild(mdl);
          // R2b: the long hints leave the narrow Model cell: one full-width notes line under the grid row (key note · codex hint · alias hint)
          const notesCell = document.createElement('div'); notesCell.className = 'seat-notes'; notesCell.hidden = true;
          notesCell.appendChild(keyNote); notesCell.appendChild(codexHint); notesCell.appendChild(aliasHint);
          // Check: Test / Bench + the last result
          const checkCell = document.createElement('div'); checkCell.className = 'seat-check';
          // the seat's one status / error line (shared by "checking…" and every refusal; keeps its height)
          const lineWrap = document.createElement('div'); lineWrap.className = 'seat-line';
          const lineEl = document.createElement('div'); lineEl.className = 'srow-err'; lineEl.id = 'set-seat-' + name + '-line'; lineEl.setAttribute('role', 'status');
          lineWrap.appendChild(lineEl);
          // R2b: the caps line + bench summary + the status line share ONE full-width status line under the tile (the Check cell keeps only the buttons)
          const statusCell = document.createElement('div'); statusCell.className = 'seat-status';
          statusCell.appendChild(lineWrap);
          row.appendChild(jobCell); row.appendChild(provCell); row.appendChild(modelCell); row.appendChild(checkCell); row.appendChild(notesCell); row.appendChild(statusCell);
          const ctl = { sel, pick, mdl, retry, aliasHint, codexHint, keyNote, notesCell, row, lineEl, claudeDefault, endpoint: 'local', token: 0, probe: null, bench: null, savedKey: '', serverCaps: null,
            savedChoice: 'claude-cli', savedModel: '', savedEndpoint: 'local', saving: false };
          if (PROBED_SEATS.includes(name) || name === 'vision') {
            // Tool-protocol test status + a real Test button; the troubleshooter may be forced past a failure.
            // The vision row gets the same pair, but its test is the colour-card vision test (M3), never forced.
            const capsEl = document.createElement('p');
            capsEl.className = 'srow-hint'; capsEl.id = 'set-seat-' + name + '-caps'; capsEl.textContent = 'not tested yet';
            const btns = document.createElement('div'); btns.className = 'seat-btns';
            const probeBtn = mkBtn('Test', 'btn btn-secondary btn-sm', 'set-seat-' + name + '-probe');
            probeBtn.addEventListener('click', function () { runProbe(name); });
            btns.appendChild(probeBtn);
            checkCell.appendChild(btns); statusCell.insertBefore(capsEl, lineWrap);
            ctl.capsEl = capsEl; ctl.probeBtn = probeBtn;
            if (name === 'orchestrator') {
              // Competence benchmark (M2.1): 5 real Blender tasks in a throw-away headless Blender.
              const benchEl = document.createElement('p');
              benchEl.className = 'srow-hint'; benchEl.id = 'set-seat-orchestrator-bench'; benchEl.textContent = 'Benchmark: not run';
              const benchBtn = mkBtn('Bench', 'btn btn-secondary btn-sm', 'set-seat-orchestrator-benchbtn');
              benchBtn.addEventListener('click', function () { runBenchClick(name); });
              // R2b: the per-task list folds away: a full-width <details> under the tile (closed by default, hidden while there is no result, open state not saved)
              const benchList = document.createElement('div');
              benchList.id = 'set-seat-orchestrator-benchlist';
              const benchDetails = document.createElement('details');
              benchDetails.className = 'seat-benchdetails'; benchDetails.id = 'set-seat-orchestrator-benchdetails'; benchDetails.hidden = true;
              const benchSum = document.createElement('summary'); benchSum.textContent = 'Benchmark details';
              benchDetails.appendChild(benchSum); benchDetails.appendChild(benchList);
              row.appendChild(benchDetails);
              btns.appendChild(benchBtn); statusCell.insertBefore(benchEl, lineWrap);
              ctl.benchEl = benchEl; ctl.benchBtn = benchBtn; ctl.benchList = benchList; ctl.benchDetails = benchDetails; ctl.benchSum = benchSum;
            }
            if (name === 'troubleshooter') {
              // after a failed tool test the troubleshooter (only) can be saved anyway; its answers are then marked as unverified
              const forceBtn = mkBtn('Use it anyway', 'btn btn-secondary btn-sm', 'set-seat-troubleshooter-force');
              forceBtn.hidden = true;
              forceBtn.title = 'Answers are marked as unverified';
              forceBtn.addEventListener('click', function () { forceBtn.hidden = true; saveSeat(name, { force: true }); });
              checkCell.appendChild(forceBtn);
              ctl.forceBtn = forceBtn;
            }
          }
          seatHost.appendChild(row);
          seatCtl[name] = ctl;
          sel.addEventListener('change', function () {
            const isClaudeModel = mdl.value.trim().toLowerCase().startsWith('claude') || CLAUDE_ALIASES.some(a => a.value === mdl.value.trim());
            if (sel.value === 'claude-cli' && !isClaudeModel) mdl.value = claudeDefault;
            else if (sel.value !== 'claude-cli' && isClaudeModel) mdl.value = '';
            ctl.switching = true;   // renderPick drops a stale id once the new provider's list is known
            renderPick(name).then(function () { saveSeat(name); });
          });
          pick.addEventListener('change', function () {
            if (pick.value === '__custom__') { mdl.style.display = ''; mdl.focus(); return; }
            mdl.style.display = 'none';
            mdl.value = pick.value;
            renderCaps(name);
            ctl.aliasHint.style.display = sel.value === 'claude-cli' && CLAUDE_ALIASES.some(a => a.value === pick.value) ? '' : 'none';
            syncNotes(ctl);
            saveSeat(name);
          });
          retry.addEventListener('click', function () { renderPick(name); });
          mdl.addEventListener('input', function () { renderCaps(name); });
          mdl.addEventListener('change', function () { saveSeat(name); });
          mdl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { if (e.preventDefault) e.preventDefault(); saveSeat(name); } });
        }

        // The seat as the server wants it: { provider, model, endpoint? } (the picker's choice → API form).
        function seatCand(name) {
          const ctl = seatCtl[name];
          const o = { model: ctl.mdl.value.trim() };
          if (ctl.sel.value === 'claude-cli') o.provider = 'claude-cli';
          else if (ctl.sel.value === 'codex') o.provider = 'codex-cli';
          else { o.provider = 'openai-compat'; o.endpoint = ctl.sel.value === 'openai' ? 'openai' : ctl.endpoint; }
          return o;
        }
        // Sweep 2 G2/G3: the candidate LOCAL endpoint (the URL typed in this dialog, maybe not saved yet) travels with every picker / probe / bench
        // request, and the local URL is part of the key — a different server is a different test result.
        function localVal() { const li = document.getElementById('set-local'); return li ? String(li.value || '').trim() : ''; }   // the local-server field of Connections (maybe typed, not left yet)
        function candEndpoints() { const u = localVal(); return u ? { local: u } : undefined; }
        function candKey(o) { return [o.provider, o.endpoint || '-', o.model || '-'].concat(o.endpoint === 'local' ? [localVal() || '-'] : []).join('|'); }
        function capsDate(iso) { try { return new Date(iso).toLocaleDateString(); } catch (_) { return ''; } }
        // <lc2d-t811> A PERSISTED tool-test pass (capabilities.json, younger than 14 days) for exactly this candidate counts like a test run now: Save sends no /seat-probe, the caps line shows it.
        // Read-only lookup through GET /seat-caps; anything else (old, failed, missing, no answer) = today's behaviour.
        const PASS_MS = 14 * 86400000;
        function persistedFresh(c) { const t = c && c.tools === 'pass' && c.probedAt ? Date.parse(c.probedAt) : NaN; return isFinite(t) && Date.now() - t < PASS_MS; }
        async function lookupPersisted(name, key, cand, fresh) {
          const ctl = seatCtl[name];
          if (!ctl.persisted) ctl.persisted = new Map();
          if (!fresh && ctl.persisted.has(key)) return ctl.persisted.get(key);
          let v = null;
          try {
            const q = new URLSearchParams({ seat: name, provider: cand.provider || '', model: cand.model || '', endpoint: cand.endpoint || '' });
            const eps = candEndpoints(); if (eps && eps.local) q.set('local', eps.local);
            const r = await fetch('/seat-caps?' + q.toString());
            if (r && r.ok) { const j = await r.json(); if (persistedFresh(j)) v = { key: key, tools: 'pass', why: '', probedAt: j.probedAt, persisted: true }; }
          } catch (_) { v = null; }
          ctl.persisted.set(key, v);
          return v;
        }
        function renderCaps(name) {
          const ctl = seatCtl[name];
          if (!ctl || !ctl.capsEl) return;
          const key = candKey(seatCand(name));
          if (name === 'vision') { ctl.capsEl.textContent = visionCapsText(ctl, key); return; }
          let text = 'not tested yet';
          if (ctl.probe && ctl.probe.key === key) {
            text = ctl.probe.tools === 'pass' ? '✓ tool test passed (' + capsDate(ctl.probe.probedAt) + ')' : '✗ tool test failed: ' + ctl.probe.why;
          } else if (ctl.serverCaps && ctl.savedKey === key) {
            const c = ctl.serverCaps;
            if (c.tools === 'pass') text = '✓ tool test passed (' + capsDate(c.probedAt) + ')';
            else if (c.tools === 'fail') text = c.forced ? '⚠ forced — tool test failed' : '✗ tool test failed';   // a vision-only entry has no tools verdict
          } else if (PROBED_SEATS.indexOf(name) >= 0 && ctl.persisted && ctl.persisted.get(key)) {
            text = '✓ tool test passed (' + capsDate(ctl.persisted.get(key).probedAt) + ')';   // T8-11: the candidate was tested before (persisted, < 14 days)
          } else if (PROBED_SEATS.indexOf(name) >= 0 && key !== ctl.savedKey && !(ctl.persisted && ctl.persisted.has(key)) && !(ctl.looking && ctl.looking.has(key))) {
            if (!ctl.looking) ctl.looking = new Set();
            ctl.looking.add(key);
            lookupPersisted(name, key, seatCand(name)).then(function () { ctl.looking.delete(key); if (candKey(seatCand(name)) === key) renderCaps(name); });
          }
          ctl.capsEl.textContent = text;
          renderBench(name);
        }
        // Vision row status (M3). Claude reads images through the CLI (nothing to test); local/OpenAI/ChatGPT plan
        // show the colour-card test. Everything via textContent — `why` can be model output.
        function visionCapsText(ctl, key) {
          if (ctl.sel.value === 'claude-cli') return '';
          if (ctl.probe && ctl.probe.key === key) {
            return ctl.probe.vision === 'pass' ? '✓ vision test passed (' + capsDate(ctl.probe.probedAt) + ')' : '✗ vision test failed: ' + ctl.probe.why;
          }
          if (ctl.serverCaps && ctl.savedKey === key && ctl.serverCaps.vision) {
            const c = ctl.serverCaps;
            if (c.vision === 'pass') return '✓ vision test passed (' + capsDate(c.visionProbedAt) + ')';
            return '✗ vision test failed: ' + (((c.visionTrials || []).find(t => !t.ok) || {}).why || 'failed');
          }
          return 'not tested yet';
        }
        // Benchmark line + per-task list (orchestrator only). Local models run 3x and are gated (>= 80%, 12/15);
        // every other provider runs once and is only graded. An old-shape entry (score/of, no runs) counts as not run.
        function benchView(b) {
          if (!b || typeof b !== 'object') return { state: 'none' };
          if (b.unavailable) return { state: 'unavailable', reason: String(b.unavailable) };
          if (!Number.isInteger(b.passed) || !Number.isInteger(b.total) || !Number.isInteger(b.runs) || b.runs < 1 || b.total < 1) return { state: 'none' };
          const need = Math.ceil(0.8 * b.total - 1e-9);
          return { state: b.passed >= need ? 'pass' : 'fail', passed: b.passed, total: b.total, runs: b.runs, need,
                   weak: (b.tasks || []).filter(t => t && t.passes < t.runs).map(t => t.id + ' ' + t.passes + '/' + t.runs) };
        }
        // Everything below goes in via textContent — `sample` and `whys` are MODEL OUTPUT (never innerHTML).
        function renderBenchList(ctl, b) {
          const box = ctl.benchList;
          while (box.firstChild) box.removeChild(box.firstChild);
          const has = !!b && Array.isArray(b.tasks);
          if (ctl.benchDetails) { ctl.benchDetails.hidden = !has; if (!has) ctl.benchDetails.open = false; }   // never reappears open
          if (ctl.benchSum) ctl.benchSum.textContent = 'Benchmark details' + (has ? ' · ' + b.tasks.length + (b.tasks.length === 1 ? ' task' : ' tasks') : '');
          if (!has) return;
          for (const t of b.tasks) {
            const row = document.createElement('div');
            row.className = 'set-hint bench-task';
            const ok = t.passes === t.runs;
            row.textContent = t.id + ' ' + t.passes + '/' + t.runs + (ok ? ' ✓' : (t.whys && t.whys.length ? ' — ' + t.whys.join('; ') : ' ✗'));
            if (!ok && typeof t.sample === 'string' && t.sample) {
              const det = document.createElement('details');
              const sum = document.createElement('summary');
              sum.textContent = 'show what the model did';
              const pre = document.createElement('pre');
              pre.textContent = t.sample;
              det.appendChild(sum); det.appendChild(pre);
              row.appendChild(det);
            }
            box.appendChild(row);
          }
        }
        function renderBench(name) {
          const ctl = seatCtl[name];
          if (!ctl || !ctl.benchEl) return;
          const key = candKey(seatCand(name));
          let b = null;
          if (ctl.bench && ctl.bench.key === key) b = ctl.bench;
          else if (ctl.serverCaps && ctl.savedKey === key && ctl.serverCaps.bench) b = ctl.serverCaps.bench;
          const isLocal = ctl.sel.value === 'local';
          const v = benchView(b);
          let text = 'Benchmark: not run';
          if (v.state === 'unavailable') text = /^Blender did not start/.test(v.reason) ? 'competence not tested — ' + v.reason.replace(/^Blender did not start for the benchmark/, 'Blender did not start') : 'competence not tested — Blender not found';
          else if (v.state !== 'none') {
            if (!isLocal) text = 'Benchmark: ' + v.passed + '/' + v.total + ' (grade, ' + v.runs + (v.runs === 1 ? ' run)' : ' runs)');
            else if (v.state === 'pass') text = 'Benchmark: ' + v.passed + '/' + v.total + ' ✓ (' + v.runs + ' runs)';
            else text = 'Benchmark: ' + v.passed + '/' + v.total + ' ✗ — needs ' + v.need + ' for local models';
          }
          ctl.benchEl.textContent = text;
          renderBenchList(ctl, v.state === 'none' || v.state === 'unavailable' ? null : b);
        }
        // Run the benchmark of the seat as currently picked → { key, score, of, tasks, unavailable?, transient?, why? } (never throws).
        async function runBenchUI(name) {
          const ctl = seatCtl[name];
          const cand = seatCand(name), key = candKey(cand);
          ctl.benchBtn.disabled = true;
          ctl.benchEl.textContent = 'Benchmark: starting…';
          if (ctl.benchDetails) { ctl.benchDetails.hidden = true; ctl.benchDetails.open = false; }   // the old list is stale while a new run is going
          let poll = null;
          const tick = async function () {
            try {
              const sr = await fetch('/seat-bench-status');
              const sj = await sr.json();
              if (sj && sj.running && sj.task) ctl.benchEl.textContent = 'Benchmark: ' + (sj.runs > 1 ? 'run ' + sj.run + '/' + sj.runs + ' · ' : '') + 'task ' + sj.task + '/' + (sj.of || 5) + ' …';
            } catch (_) {}
          };
          poll = setInterval(tick, 1500);
          let out;
          try {
            const r = await fetch('/seat-bench', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seat: name, provider: cand.provider, model: cand.model, endpoint: cand.endpoint, endpoints: candEndpoints() }) });
            const j = await r.json();
            if (!r.ok) out = { key, transient: true, why: j.error || 'benchmark could not run' };
            else out = { key, passed: j.passed, total: j.total, runs: j.runs, tasks: j.tasks || [], unavailable: j.unavailable, ranAt: j.ranAt };
          } catch (e) { out = { key, transient: true, why: e.message }; }
          clearInterval(poll);
          ctl.benchBtn.disabled = false;
          if (out.transient) ctl.benchEl.textContent = '✗ ' + out.why;   // not a verdict about the model — don't remember it
          else { ctl.bench = out; renderBench(name); }
          return out;
        }
        async function runBenchClick(name) {
          const ctl = seatCtl[name];
          const key = candKey(seatCand(name));
          const known = (ctl.probe && ctl.probe.key === key) ? ctl.probe
            : ((ctl.serverCaps && ctl.savedKey === key) ? { tools: ctl.serverCaps.tools } : null);
          const pr = known || await runProbe(name);   // the benchmark only follows a passed tool test
          if (pr.tools !== 'pass') { ctl.benchEl.textContent = 'Benchmark: run the tool test first (it did not pass)'; return; }
          await runBenchUI(name);
        }
        // Run the 3-try tool test of the seat as currently picked → { key, tools, why, probedAt } (never throws).
        async function runProbe(name) {
          const ctl = seatCtl[name];
          const cand = seatCand(name), key = candKey(cand);
          if (name === 'vision') return runVisionProbe(ctl, cand, key);
          ctl.capsEl.textContent = 'Testing ' + (cand.model || 'Codex default') + '… (3 tries, up to a few minutes)';
          ctl.probeBtn.disabled = true;
          let out;
          try {
            const r = await fetch('/seat-probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seat: name, provider: cand.provider, model: cand.model, endpoint: cand.endpoint, endpoints: candEndpoints() }) });
            const j = await r.json();
            if (!r.ok) out = { key, tools: 'fail', why: j.error || 'test could not run', transient: true };
            else {
              const bad = (j.trials || []).find(t => !t.ok);
              out = { key, tools: j.tools, why: bad ? bad.why : '', probedAt: j.probedAt };
            }
          } catch (e) { out = { key, tools: 'fail', why: e.message, transient: true }; }
          ctl.probeBtn.disabled = false;
          if (out.transient) ctl.capsEl.textContent = '✗ ' + out.why;   // not a verdict about the model — don't remember it
          else { ctl.probe = out; renderCaps(name); }
          return out;
        }

        // The vision test (M3): two colour cards through /seat-probe → { key, vision, why, probedAt } (never throws).
        // Claude is decided here without a call (the server would answer the same).
        async function runVisionProbe(ctl, cand, key) {
          if (ctl.sel.value === 'claude-cli') { renderCaps('vision'); return { key, vision: 'n/a' }; }
          ctl.capsEl.textContent = 'Testing ' + (cand.model || 'Codex default') + ' with a colour test card… (2 tries, up to a few minutes)';
          ctl.probeBtn.disabled = true;
          let out;
          try {
            const r = await fetch('/seat-probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seat: 'vision', provider: cand.provider, model: cand.model, endpoint: cand.endpoint, endpoints: candEndpoints() }) });
            const j = await r.json();
            if (!r.ok) out = { key, vision: 'fail', why: j.error || 'test could not run', transient: true };
            else {
              const bad = (j.trials || []).find(t => !t.ok);
              out = { key, vision: j.vision, why: bad ? bad.why : '', probedAt: j.probedAt };
            }
          } catch (e) { out = { key, vision: 'fail', why: e.message, transient: true }; }
          ctl.probeBtn.disabled = false;
          if (out.transient) ctl.capsEl.textContent = '✗ ' + out.why;   // not a verdict about the model — don't remember it
          else { ctl.probe = out; renderCaps('vision'); }
          return out;
        }


        // ── Seat saves (rules §6): a seat saves when its pick is complete; the server-gated ones show "checking…" and keep the stored value if the check fails ──
        // One line per seat (set-seat-<name>-line) says what is going on; a failure puts the controls back to the stored seat and names what helps.
        function seatLine(name, msg, kind, action) {
          const el = seatCtl[name].lineEl;
          el.className = 'srow-err' + (kind === 'busy' ? ' srow-busy' : '');
          el.textContent = msg || '';
          if (msg && action) { const b = mkBtn(action.label, 'btn btn-ghost btn-sm'); b.addEventListener('click', action.run); el.appendChild(b); }
        }
        function updateKeyNote(name) {
          const ctl = seatCtl[name];
          if (!ctl) return;
          const need = ctl.sel.value === 'openai' && !_keySet;
          ctl.keyNote.hidden = !need;
          syncNotes(ctl);
          ctl.row.className = 'seat-row srow' + (need ? ' seat-needs-key' : '');
        }
        function revertSeat(name) {
          const ctl = seatCtl[name];
          ctl.sel.value = ctl.savedChoice; ctl.endpoint = ctl.savedEndpoint; ctl.mdl.value = ctl.savedModel;
          renderPick(name);
        }
        async function saveSeat(name, opts) {
          const ctl = seatCtl[name];
          opts = opts || {};
          if (ctl.saving || (seatChecks.get(name) && seatChecks.get(name).phase === 'running')) { ctl.again = true; return; }
          const cand = seatCand(name), key = candKey(cand);
          if (ctl.forceBtn && !opts.force) ctl.forceBtn.hidden = true;
          if (key === ctl.savedKey && !opts.force) { seatLine(name, ''); return; }
          if (!cand.model && cand.provider !== 'codex-cli') { seatLine(name, 'Pick a model — not saved yet.'); return; }
          if (cand.endpoint === 'openai' && !_keySet) { seatLine(name, ''); updateKeyNote(name); return; }   // the row already says "needs a key — add it in Cloud & keys"
          ctl.saving = true;
          seatCheckUpdate(name, { phase: 'running', title: SEAT_ROWS.find(function (r) { return r[0] === name; })[1], model: cand.model, tested: PROBED_SEATS.includes(name) || (name === 'vision' && cand.provider !== 'claude-cli'), probe: ctl.probe, candidate: { choice: ctl.sel.value, model: ctl.mdl.value, endpoint: ctl.endpoint }, why: '', saved: null, force: false, tried: null, again: false });
          seatLine(name, 'checking…', 'busy');
          try { await trySaveSeat(name, cand, key, opts); } catch (e) { revertSeat(name); seatLine(name, e.message); seatCheckUpdate(name, { phase: 'refused', probe: ctl.probe, why: e.message }); } finally { ctl.saving = false; }
          if (ctl.again) { ctl.again = false; if (candKey(seatCand(name)) !== ctl.savedKey) saveSeat(name); }
        }
        async function trySaveSeat(name, cand, key, opts) {
          const ctl = seatCtl[name];
          const body = Object.assign({}, cand);
          // a refused check puts the controls back to the stored seat; "Run the test again" re-picks what was tried and checks it once more
          const refuse = function (msg, again) {
            const tried = { choice: ctl.sel.value, model: ctl.mdl.value, endpoint: ctl.endpoint };
            revertSeat(name);
            seatLine(name, msg, null, again ? { label: 'Run the test again', run: function () {
              ctl.sel.value = tried.choice; ctl.mdl.value = tried.model; ctl.endpoint = tried.endpoint; ctl.probe = null; ctl.bench = null;
              renderPick(name).then(function () { saveSeat(name); });
            } } : null);
            seatCheckUpdate(name, { phase: 'refused', probe: ctl.probe, why: msg, tried: tried, again: again });
          };
          // Honest gating (M2): a CHANGED orchestrator/troubleshooter must pass the tool test first - run it now if it has not been run for exactly this model.
          // The orchestrator has no override; the troubleshooter can be saved anyway ("Use it anyway", answers marked as unverified).
          if (PROBED_SEATS.includes(name)) {
            const pr = (ctl.probe && ctl.probe.key === key) ? ctl.probe : ((await lookupPersisted(name, key, cand, true)) || await runProbe(name));   // T8-11: a persisted pass (< 14 days) for exactly this candidate replaces the 3-try run
            if (pr.persisted) ctl.probe = pr;
            if (pr.tools === 'pass') {
              // Local orchestrator: format test (above) -> competence benchmark -> save. Cloud/CLI seats are only graded.
              if (name === 'orchestrator' && ctl.sel.value === 'local') {
                const bo = (ctl.bench && ctl.bench.key === key) ? ctl.bench : await runBenchUI(name);
                if (bo.transient) return refuse('Benchmark could not run: ' + bo.why, true);
                const bv = benchView(bo);
                if (bv.state === 'none') return refuse('Benchmark gave no usable result.', true);
                if (bv.state === 'fail') return refuse((cand.model || 'This model') + ' solved ' + bv.passed + '/' + bv.total + ' benchmark tasks over ' + bv.runs + ' runs (needs ' + bv.need + '): ' + bv.weak.join(', '), true);
              }
            } else if (name === 'troubleshooter' && !pr.transient) {
              if (opts.force) body.force = true;
              else {
                seatCheckUpdate(name, { phase: 'refused', probe: ctl.probe, why: 'Tool test failed: ' + pr.why + ' — you can still use it; its answers are then marked as unverified.', force: true });
                ctl.forceBtn.hidden = false;
                seatLine(name, 'Tool test failed: ' + pr.why + ' — you can still use it; its answers are then marked as unverified.');
                return;
              }
            } else {
              return refuse((cand.model || 'Codex default') + ' ' + (pr.transient ? 'could not be tested: ' : 'did not drive the tool protocol: ') + pr.why, true);
            }
          }
          // Vision gating (M3): a CHANGED non-Claude vision seat must have read the colour card. No force: a judge that cannot see is not allowed to judge.
          if (name === 'vision' && ctl.sel.value !== 'claude-cli') {
            const pr = (ctl.probe && ctl.probe.key === key) ? ctl.probe : await runVisionProbe(ctl, cand, key);
            if (pr.vision !== 'pass') return refuse('Vision: ' + (cand.model || 'this model') + ' ' + (pr.transient ? 'could not be tested: ' : 'did not read the test card: ') + pr.why, true);
          }
          const seats = {}; seats[name] = body;
          const res = await settingsFields.save('seats.' + name, null, null, { path: '/config', body: { seats: seats } });
          if (!res.ok) return refuse(res.error, false);
          seatLine(name, '');
          ctl.savedKey = key; ctl.savedChoice = ctl.sel.value; ctl.savedModel = ctl.mdl.value; ctl.savedEndpoint = ctl.endpoint; ctl.savedOpenai = ctl.sel.value === 'openai';
          if (PROBED_SEATS.includes(name)) {   // the saved seat is now what the server judges
            ctl.serverCaps = (ctl.probe && ctl.probe.key === ctl.savedKey) ? { tools: ctl.probe.tools, probedAt: ctl.probe.probedAt, forced: !!body.force, bench: (ctl.bench && ctl.bench.key === ctl.savedKey) ? ctl.bench : null } : ctl.serverCaps;
            renderCaps(name);
          }
          if (name === 'vision') {
            if (ctl.probe && ctl.probe.key === ctl.savedKey && ctl.probe.vision === 'pass') ctl.serverCaps = { vision: 'pass', visionProbedAt: ctl.probe.probedAt };
            renderCaps('vision');
          }
          SET_STORE['seats.openai'] = Object.keys(seatCtl).some(function (n) { return seatCtl[n].savedOpenai; });
          updateMissingBadge();
          seatCheckUpdate(name, { phase: 'saved', probe: ctl.probe, saved: { key: ctl.savedKey, choice: ctl.savedChoice, model: ctl.savedModel, endpoint: ctl.savedEndpoint, openai: ctl.savedOpenai, caps: ctl.serverCaps } });
        }
        settingsHooks.keyChanged = function (ref, on) { if (ref === 'openai') { _keySet = !!on; refreshOpenaiPicks(); for (const [n] of SEAT_ROWS) updateKeyNote(n); } };

        // Prefill from server (the other sections are filled by loadGates / fillSettings)
        try {
          const vh = document.getElementById('set-vision-hint'); if (vh) vh.textContent = ALIAS_HINT;
          const r = await fetch('/config');
          const c = await r.json();
          // The server owns the defaults (GET /config fills them in), so nothing is guessed here.
          // Providers: resolved per seat by the server, so old configs show their inferred provider.
          const sv = c.seats || {};
          for (const [name] of SEAT_ROWS) {
            const v = sv[name]; if (!v) continue;
            const ctl = seatCtl[name];
            const choice = v.provider === 'claude-cli' ? 'claude-cli' : v.provider === 'codex-cli' ? 'codex' : (v.endpoint === 'openai' ? 'openai' : 'local');
            ctl.sel.value = choice;
            ctl.endpoint = (v.endpoint && v.endpoint !== 'openai') ? v.endpoint : 'local';
            ctl.mdl.value = v.model || '';
            ctl.savedKey = candKey(seatCand(name));   // what is saved now - unchanged seats need no new test
            ctl.savedChoice = choice; ctl.savedModel = ctl.mdl.value; ctl.savedEndpoint = ctl.endpoint; ctl.savedOpenai = choice === 'openai';
            ctl.serverCaps = v.caps || null;
          }
          _keySet = !!(c.keys && c.keys.openai);
          for (const [name] of SEAT_ROWS) {
            const ctl = seatCtl[name];
            const follow = function (c, rebuilding) {
              ctl.saving = c.phase === 'running';
              if (c.probe) ctl.probe = c.probe;
              ctl.sel.disabled = ctl.pick.disabled = ctl.mdl.disabled = ctl.saving;
              if (c.saved) {
                ctl.savedKey = c.saved.key; ctl.savedChoice = c.saved.choice; ctl.savedModel = c.saved.model; ctl.savedEndpoint = c.saved.endpoint; ctl.savedOpenai = c.saved.openai; ctl.serverCaps = c.saved.caps;
              }
              const pick = (ctl.saving || c.force) ? c.candidate : { choice: ctl.savedChoice, model: ctl.savedModel, endpoint: ctl.savedEndpoint };
              const changed = ctl.sel.value !== pick.choice || ctl.mdl.value !== pick.model || ctl.endpoint !== pick.endpoint;
              ctl.sel.value = pick.choice; ctl.mdl.value = pick.model; ctl.endpoint = pick.endpoint;
              if (changed || rebuilding) renderPick(name); else renderCaps(name);
              if (ctl.saving) seatLine(name, 'checking…', 'busy');
              else {
                if (c.phase === 'saved') seatLine(name, '');
                else {
                  seatLine(name, c.why, null, c.again ? { label: 'Run the test again', run: function () {
                    ctl.sel.value = c.tried.choice; ctl.mdl.value = c.tried.model; ctl.endpoint = c.tried.endpoint; ctl.probe = null; ctl.bench = null;
                    renderPick(name).then(function () { saveSeat(name); });
                  } } : null);
                  if (ctl.forceBtn && c.force) ctl.forceBtn.hidden = false;
                }
              }
            };
            seatCheckRows.set(name, follow);
            const check = seatChecks.get(name);
            if (check && !(check.phase === 'refused' && check.rowShown)) {
              follow(check, true);
              // A rebuilt row acknowledges this refusal, including the troubleshooter override.
              if (check.phase === 'refused') { check.rowShown = true; check.visible = false; seatCheckRender(); }
            } else renderPick(name);
            if (seatCheckFocus === name) { ctl.row.scrollIntoView({ block: 'nearest', inline: 'nearest' }); seatCheckFocus = null; }
          }
        } catch (_) {}
      }

      // ── Themes picker (R1/R2b: the Theme row of General; the pick saves at once through the shared write helper) ──────────────

      let themeNoteText = '';
      function renderThemeRows(host, keepNote) {
        if (!keepNote) themeNoteText = '';   // the note belongs to the pick just made in this view
        while (host.firstChild) host.removeChild(host.firstChild);

        // R2b: the list comes first (its first row lines up with the "Theme" label), then the hint and the reserved status note underneath
        for (const [key, theme] of Object.entries(THEMES)) {
          const row = document.createElement('div');
          row.className = 'theme-row' + (key === _currentTheme ? ' theme-row-active' : '');
          row.title = theme.name;

          // Colour swatches: bg, panel, accent
          const swatchWrap = document.createElement('span');
          swatchWrap.className = 'theme-swatches';
          ['--ground', '--surface', '--accent'].forEach(function (v) {
            const sw = document.createElement('span');
            sw.className = 'theme-swatch';
            sw.style.background = theme.vars[v];
            swatchWrap.appendChild(sw);
          });

          const nameEl = document.createElement('span');
          nameEl.className = 'theme-name';
          nameEl.textContent = theme.name;

          const checkEl = document.createElement('span');
          checkEl.className = 'theme-check';
          checkEl.textContent = key === _currentTheme ? '✓' : '';

          row.appendChild(swatchWrap);
          row.appendChild(nameEl);
          row.appendChild(checkEl);

          row.addEventListener('click', (function (k) {
            return async function () {
              _themePicked = true;
              applyTheme(k);
              themeNoteText = '';
              renderThemeRows(host, true);
              const res = await settingsFields.save('ui.theme', k, null);
              themeNoteText = res.ok ? '' : 'Not saved in Phoenix - this browser still uses it. Pick the theme again to retry.';
              renderThemeRows(host, true);
            };
          })(key));

          host.appendChild(row);
        }

        const hint = document.createElement('p');
        hint.className = 'srow-hint';
        hint.textContent = 'Theme is saved in Phoenix and used in every browser.';
        host.appendChild(hint);

        const note = document.createElement('p');
        note.className = 'set-hint';
        note.id = 'theme-note';
        note.setAttribute('role', 'status');
        note.textContent = themeNoteText;
        host.appendChild(note);
      }

      // ── init: build the field components once (after everything above is defined: the theme rows read themeNoteText) ──
      // the field components of Cloud & keys and Connections (Onboarding renders the same ones with mirror:true)
      settingsFields.renderEndpointField(setById('ep-local-host'), 'local', { id: 'set-local', placeholder: 'http://localhost:1234/v1' });
      settingsFields.renderEndpointField(setById('ep-comfyui-host'), 'comfyui', { id: 'set-comfyui', placeholder: 'http://localhost:8188' });
      settingsFields.renderKeyField(setById('key-openai-host'), 'openai', { id: 'set-key-openai', onChange: function (on) { if (settingsHooks.keyChanged) settingsHooks.keyChanged('openai', on); updateMissingBadge(); } });
      settingsFields.renderKeyField(setById('key-meshy-host'), 'meshy', { id: 'remesh-key', onChange: function () { updateMissingBadge(); if (typeof refreshRemeshBalance === 'function') refreshRemeshBalance(); } });
      settingsFields.renderKeyField(setById('key-fal-host'), 'fal', { id: 'video-fal-key', onChange: function () { updateMissingBadge(); } });
      renderThemeRows(setById('set-theme-host'));

      // <r4e-brush-save>
      // R4e: "Brush from selection" row at the end of Quick switches. An ACTION, not a setting: it carries no settings key and is never shown in the Settings window.
      function makeBrushSaveRow(deps) {
        const doc = deps.doc;
        const NEW = '__new__';
        const DOWN = 'Blender is not reachable — open Blender with the Phoenix add-on, then try again.';
        const UNREAL = 'made in Unreal — save over it from Unreal';
        const CHECKING = 'Checking Blender…';
        const panel = doc.getElementById('settings-panel');
        if (!panel) return { refresh: function () { return Promise.resolve(); }, onResult: function () {}, ownsReply: function () { return false; } };
        const stale = doc.getElementById('qs-brush-save');
        if (stale) stale.remove();
        const state = { brushes: [], pending: null, confirming: false, down: true, checking: true, seq: 0, ownedText: null, filter: '' };
        const RECENT_KEY = 'phoenix.brush.recent', RECENT_MAX = 5, NAME_MAX = 36;
        let memRecent = [];   // no usable storage -> recents live in memory only
        function el(tag, cls, text) {
          const e = doc.createElement(tag);
          if (cls) e.className = cls;
          if (text != null) e.textContent = text;
          return e;
        }
        const box = el('div', 'qs-brush-save');
        box.id = 'qs-brush-save';
        box.appendChild(el('div', 'settings-title', 'Brush from selection'));
        const filterIn = el('input');
        filterIn.id = 'qs-brush-filter';
        filterIn.type = 'text';
        filterIn.placeholder = 'Find a brush';
        filterIn.setAttribute('aria-label', 'Find a brush');
        box.appendChild(filterIn);
        const sel = el('select');
        sel.id = 'qs-brush-target';
        sel.setAttribute('aria-label', 'Save the selection to');
        box.appendChild(sel);
        const nameIn = el('input');
        nameIn.id = 'qs-brush-name';
        nameIn.type = 'text';
        nameIn.placeholder = 'Name of the new brush';
        nameIn.setAttribute('aria-label', 'Name of the new brush');
        box.appendChild(nameIn);
        const hint = el('div', 'lib-inline-text');
        hint.id = 'qs-brush-hint';
        hint.setAttribute('role', 'status');
        box.appendChild(hint);
        const go = el('button', 'btn btn-secondary btn-sm', 'Save');
        go.id = 'qs-brush-go';
        go.type = 'button';
        box.appendChild(go);
        const ask = el('div');
        ask.id = 'qs-brush-confirm';
        ask.setAttribute('role', 'group');
        const askText = el('span', 'lib-inline-text');
        const yes = el('button', 'btn btn-danger btn-sm', 'Replace');
        yes.type = 'button';
        yes.setAttribute('data-confirm', 'replace');
        const no = el('button', 'btn btn-ghost btn-sm', 'Cancel');
        no.type = 'button';
        no.setAttribute('data-confirm', 'cancel');
        ask.appendChild(askText);
        ask.appendChild(yes);
        ask.appendChild(no);
        box.appendChild(ask);
        const why = el('div', 'lib-inline-text', DOWN);
        why.id = 'qs-brush-reason';
        why.setAttribute('role', 'status');
        box.appendChild(why);
        const result = el('div', 'lib-inline-text');
        result.id = 'qs-brush-result';
        result.setAttribute('role', 'status');
        result.setAttribute('aria-live', 'polite');
        box.appendChild(result);
        panel.appendChild(box);

        function slugOf(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_'); }
        function find(slug) { return state.brushes.filter(function (b) { return b.slug === slug; })[0] || null; }
        function label(b) { return b.display || b.slug; }
        function setTitle(node, text) { if (text) node.title = text; else node.removeAttribute('title'); }
        function shortName(s) { s = String(s); return s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '\u2026' : s; }
        function storage() { try { return deps.storage ? deps.storage() : null; } catch (_) { return null; } }
        function readRecent() {
          const st = storage();
          if (!st) return memRecent.slice();
          try { const a = JSON.parse(st.getItem(RECENT_KEY)); return Array.isArray(a) ? a.filter(function (s) { return typeof s === 'string' && s; }).slice(0, RECENT_MAX) : []; } catch (_) { return []; }
        }
        function noteRecent(slug) {
          if (!slug) return;
          const list = [String(slug)].concat(readRecent().filter(function (s) { return s !== slug; })).slice(0, RECENT_MAX);
          memRecent = list.slice();
          const st = storage();
          if (st) { try { st.setItem(RECENT_KEY, JSON.stringify(list)); } catch (_) {} }
          fillOptions();
          render();
        }
        function render() {
          const isNew = sel.value === NEW, b = isNew ? null : find(sel.value), busy = !!state.pending, down = state.down, why0 = state.checking ? CHECKING : DOWN;
          sel.disabled = down;
          filterIn.disabled = down;
          filterIn.hidden = down;
          nameIn.disabled = down;
          setTitle(sel, down ? why0 : '');
          setTitle(nameIn, down ? why0 : '');
          why.textContent = why0;
          why.hidden = !down;
          nameIn.hidden = !isNew;
          hint.hidden = !isNew;
          let blocked = false, blockedWhy = '';
          if (isNew) {
            const nm = nameIn.value.trim(), slug = slugOf(nm);
            if (!nm) { blocked = true; blockedWhy = 'Type a name for the new brush.'; }
            else if (find(slug)) { blocked = true; blockedWhy = 'Becomes "' + slug + '" — taken — pick another or choose it in the list to replace it.'; }
            else blockedWhy = 'Becomes "' + slug + '".';
            hint.textContent = blockedWhy;
            go.textContent = busy ? 'Saving…' : 'Save';
          } else {
            if (!b) blocked = true;
            go.textContent = busy ? 'Saving…' : 'Replace ' + (b ? label(b) : '') + '…';
          }
          go.disabled = down || busy || blocked;
          setTitle(go, down ? why0 : (blocked && !busy ? blockedWhy : ''));
          const asking = state.confirming && !isNew && !!b && !down && !busy;
          ask.hidden = !asking;
          go.hidden = asking;
          if (asking) askText.textContent = 'Replace ' + label(b) + ' with the selection? The old version goes to the trash.';
        }
        function fillOptions() {
          const keep = sel.value;
          sel.textContent = '';
          const first = el('option', null, 'New brush…');
          first.value = NEW;
          sel.appendChild(first);
          const q = state.filter.trim().toLowerCase();
          const shown = state.brushes.filter(function (b) { return !q || String(label(b)).toLowerCase().indexOf(q) >= 0 || String(b.slug).toLowerCase().indexOf(q) >= 0; });
          const recents = readRecent().map(function (s) { return shown.filter(function (b) { return b.slug === s && b.type === 'phoenix'; })[0]; }).filter(Boolean);
          function addOption(b) {
            const full = String(label(b)), o = el('option', null, shortName(full));
            o.value = b.slug;
            if (full.length > NAME_MAX) o.title = full;
            if (b.type !== 'phoenix') { o.disabled = true; o.textContent = shortName(full) + ' — ' + UNREAL; o.title = (full.length > NAME_MAX ? full + ' — ' : '') + UNREAL; o.setAttribute('data-reason', UNREAL); }
            sel.appendChild(o);
          }
          recents.forEach(addOption);
          if (recents.length) {
            const sep = el('option', null, 'All brushes');
            sep.value = '__sep__';
            sep.disabled = true;
            sep.setAttribute('data-sep', '');
            sel.appendChild(sep);
          }
          shown.filter(function (b) { return recents.indexOf(b) < 0; }).sort(function (a, b) { return String(label(a)).localeCompare(String(label(b)), undefined, { numeric: true, sensitivity: 'base' }); }).forEach(addOption);
          const kept = keep && keep !== NEW ? shown.filter(function (b) { return b.slug === keep; })[0] : null;
          sel.value = kept && kept.type === 'phoenix' ? keep : NEW;
        }
        async function refresh() {
          const my = ++state.seq;
          state.down = true;
          state.checking = true;
          render();
          let list = null, down = false;
          try { const r = await deps.fetch('/brushes'); const j = await r.json(); if (j && Array.isArray(j.brushes)) list = j.brushes; } catch (_) {}
          try { const r = await deps.fetch('/levels/open'); const j = await r.json(); down = !!(j && j.reachable === false); } catch (_) { down = true; }
          if (my !== state.seq) return;
          if (list) state.brushes = list;
          state.down = down;
          state.checking = false;
          if (down) state.confirming = false;
          fillOptions();
          render();
        }
        function send(input, kind, slug) {
          const id = deps.newRequestId ? deps.newRequestId() : null;
          state.pending = { kind: kind, slug: slug, id: id };
          state.confirming = false;
          result.textContent = '';
          result.removeAttribute('data-state');
          render();
          try {
            const r = deps.postAction('save_as_brush', input, undefined, id);
            if (r && typeof r.catch === 'function') r.catch(function () {});
          } catch (e) { onResult(String((e && e.message) || e), true, id); }
        }
        function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
        function onResult(text, isError, requestId) {
          if (!state.pending) return;
          if (state.pending.id && requestId !== state.pending.id) return;   // F2.6 / R2: only the answer to its own request (a pending one without an id takes any reply)
          const p = state.pending;
          state.pending = null;
          state.ownedText = String(text);
          const t = String(text == null ? '' : text);
          const m = /(?:^|\n)[ \t]*PHX_BRUSH_SAVED:(\{[^\r\n]*\})/.exec(t);
          let info = null;
          if (m) { try { info = JSON.parse(m[1]); } catch (_) { info = null; } }
          if (info) {
            const n = Number(info.meshes) || 0, k = Number(info.skipped) || 0, name = info.display || info.slug || p.slug || '';
            let line = info.replaced ? 'Replaced ' + name + ' — old version in the trash (' + plural(n, 'mesh', 'meshes') + ')' : 'Saved ' + name + ' (' + plural(n, 'mesh', 'meshes') + ')';
            if (k > 0) line += ' — ' + plural(k, 'non-mesh object', 'non-mesh objects') + ' skipped';
            if (info.keptCategory) line += ' — kept its registered category ' + info.keptCategory;
            result.textContent = line;
            result.dataset.state = 'ok';
            if (p.kind === 'new') { sel.value = NEW; nameIn.value = ''; }
            if (info.slug || p.slug) noteRecent(info.slug || p.slug);
            render();
            refresh();
            return;
          }
          let s = t.trim(), prev;
          do { prev = s; s = s.replace(/^ERROR \(exit \d+\):\s*/, '').replace(/^ERROR:\s*/, '').replace(/^BLENDER ERROR:\s*/, '').replace(/^BLENDER_UNREACHABLE:\s*/, ''); } while (s !== prev);
          const first = s.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean)[0] || (isError ? 'The save failed.' : 'No answer from the save.');
          result.textContent = first;
          result.dataset.state = 'error';
          render();
        }
        sel.addEventListener('change', function () { state.confirming = false; render(); });
        nameIn.addEventListener('input', function () { render(); });
        filterIn.addEventListener('input', function () { state.filter = filterIn.value; state.confirming = false; fillOptions(); render(); });
        go.addEventListener('click', function () {
          if (state.pending || state.down) return;
          if (sel.value === NEW) {
            const nm = nameIn.value.trim();
            if (!nm || find(slugOf(nm))) { render(); return; }
            send({ name: nm, overwrite: false }, 'new', slugOf(nm));
          } else if (find(sel.value)) { state.confirming = true; render(); }
        });
        no.addEventListener('click', function () { state.confirming = false; render(); });
        yes.addEventListener('click', function () {
          const b = find(sel.value);
          if (!b || state.pending || state.down || state.confirming !== true || ask.hidden) return;
          send({ name: b.slug, display: label(b), category: b.category || 'item', overwrite: true }, 'replace', b.slug);
        });
        fillOptions();
        render();
        function ownsReply(text) { const r = state.ownedText !== null && state.ownedText === String(text); state.ownedText = null; return r; }
        // R2: the stream dropped during a save and the server is idle again - the answer is lost; say so and read the list
        function reconnected() {
          if (!state.pending) return;
          state.pending = null;
          result.textContent = 'The connection dropped during the save. Check the list, then try again.';
          result.dataset.state = 'error';
          render();
          return refresh();
        }
        return { refresh: refresh, onResult: onResult, ownsReply: ownsReply, noteRecent: noteRecent, reconnected: reconnected, savePending: function () { return !!state.pending; } };
      }
      window.__brushSaveRow = makeBrushSaveRow({ doc: document, fetch: function (u, o) { return fetch(u, o); }, postAction: function (a, i, o, id) { return postAction(a, i, o, id); }, newRequestId: function () { return newRequestId(); }, storage: function () { try { return window.localStorage || null; } catch (_) { return null; } } });
      // </r4e-brush-save>

      // <fixlist-caches>
      // F2.9: Settings > Storage "Cached previews": orphaned poster JPEGs and preview GLBs. The server counts them (GET /storage/caches), Delete asks first.
      function makeCacheClean(deps) {
        const doc = deps.doc;
        const btn = doc.getElementById('set-clean-caches'), res = doc.getElementById('set-clean-result'), ask = doc.getElementById('set-clean-ask');
        if (!btn || !res || !ask) return { refresh: function () { return Promise.resolve(); } };
        const askText = ask.querySelector('[data-clean="text"]'), go = ask.querySelector('[data-clean="go"]'), cancel = ask.querySelector('[data-clean="cancel"]');
        let info = { count: 0, bytes: 0 }, busy = false;
        function mb(n) { return (Number(n || 0) / 1048576).toFixed(1); }
        function paint() {
          if (info.count > 0) { btn.textContent = 'Clean caches \u00b7 frees ' + mb(info.bytes) + ' MB'; btn.disabled = busy; btn.removeAttribute('title'); }
          else { btn.textContent = 'Nothing to clean'; btn.disabled = true; btn.title = 'No orphaned preview files: every cached preview still belongs to a brush, character or asset.'; }
        }
        async function refresh() {
          try {
            const r = await deps.fetch('/storage/caches');
            const j = await r.json();
            if (j && j.ok) info = { count: Number(j.count) || 0, bytes: Number(j.bytes) || 0 };
          } catch (_) { /* keep the last numbers */ }
          paint();
        }
        btn.addEventListener('click', function () {
          if (busy || info.count < 1) return;
          askText.textContent = 'Delete ' + info.count + ' cached file' + (info.count === 1 ? '' : 's') + ' (' + mb(info.bytes) + ' MB)? Phoenix rebuilds them when needed. Takes in sounds/vo are not touched.';
          ask.hidden = false;
        });
        cancel.addEventListener('click', function () { ask.hidden = true; });
        go.addEventListener('click', async function () {
          if (busy) return;
          busy = true; go.disabled = true; paint();
          let msg = '';
          try {
            const r = await deps.fetch('/storage/caches/clean', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const j = await r.json();
            if (r.ok && j && j.ok) {
              msg = 'Freed ' + mb(j.freed) + ' MB.';
              if (Array.isArray(j.failed) && j.failed.length) msg += ' ' + j.failed.length + ' could not be deleted: ' + String(j.failed[0].error || j.failed[0].file || '');
            } else msg = 'Could not clean: ' + ((j && j.error) || ('HTTP ' + r.status));
          } catch (e) { msg = 'Could not clean: ' + String((e && e.message) || e); }
          busy = false; go.disabled = false; ask.hidden = true;
          res.textContent = msg;
          await refresh();
        });
        return { refresh: refresh };
      }
      // </fixlist-caches>
      window.__cacheClean = makeCacheClean({ doc: document, fetch: function (u, o) { return fetch(u, o); } });
