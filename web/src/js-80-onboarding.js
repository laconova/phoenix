      // ── Onboarding wizard ────────────────────────────────────────────────────
      let _onbStatus = null;
      let _onbStep = 0;

      async function fetchOnbStatus() {
        try { const r = await fetch('/onboarding/status'); return await r.json(); } catch (e) { return null; }
      }
      // <g3-onb-comfy>
      // G3 / R2: onboarding step 1 shows the probed ComfyUI address and, when unreachable, lets the user fix it. The input is the SAME component as
      // Settings -> Connections -> ComfyUI (renderEndpointField, mirror mode): it saves on Enter / leaving the field, then the re-check runs.
      // deps: { document, fetch, apply(st), fields, openConnections() }.
      function makeG3OnbComfy(deps) {
        function base(st) { return (st && st.comfyui && st.comfyui.base) || 'http://localhost:8188'; }
        function hint(text, st) { return text + ' Checked at ' + base(st) + '.'; }
        // the fix-it input row for the ComfyUI row; null when ComfyUI is reachable
        function fix(st) {
          if (st && st.comfyui && st.comfyui.reachable) return null;
          const wrap = deps.document.createElement('div'); wrap.style.marginTop = '6px';
          deps.fields.renderEndpointField(wrap, 'comfyui', {
            mirror: true, id: 'onb-comfy-url', value: base(st), helpSection: deps.openConnections,
            onSaved: async function () {
              let ns = null;
              try { const sr = await deps.fetch('/onboarding/status'); if (sr.ok) ns = await sr.json(); } catch (_) {}
              if (!ns) return 'Saved — could not re-check, press Re-check.';
              deps.apply(ns);
              return '';
            },
          });
          return wrap;
        }
        return { base: base, hint: hint, fix: fix };
      }
      // </g3-onb-comfy>
      const g3OnbComfy = makeG3OnbComfy({ document: document, fetch: function (u, o) { return fetch(u, o); }, apply: function (st) { _onbStatus = st; renderOnb(); }, fields: settingsFields, openConnections: function () { closeOnboarding(); shellOpenSettings('connections'); } });
      // <g6-onb-brain>
      // G6: onboarding "Brain" step - Claude CLI / Codex CLI login state (copy-the-command only, Phoenix starts no login) and write-only OpenAI / Meshy
      // key fields (the Settings -> Cloud & keys components). deps: { document, fetch, clipboard, apply(st), fields }.
      function makeG6OnbBrain(deps) {
        const d = deps.document;
        function mk(tag, cls, text) { const e = d.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
        function pill(text, cls) { return mk('span', 'onb-pill ' + cls, text); }
        function copyBtn(id, text) {
          const b = mk('button', 'modal-btn onb-secondary', 'Copy'); b.id = id; b.style.marginLeft = '6px';
          b.addEventListener('click', async function () {
            try { await deps.clipboard.writeText(text); b.textContent = 'Copied ✓'; } catch (_) { b.textContent = 'Copy failed'; }
          });
          return b;
        }
        function cmdBox(cmd) {
          const i = mk('input'); i.type = 'text'; i.readOnly = true; i.value = cmd; i.style.width = '200px'; i.style.fontFamily = 'monospace';
          return i;
        }
        // state: 'in' | 'out' | 'unknown' (installed, login state not reported) | 'none' (not installed)
        function cliRow(name, state, cmd, copyId, afterCmd, installHint, installLink) {
          const row = mk('div', 'onb-row'), top = mk('div', 'onb-row-top');
          top.appendChild(mk('span', 'onb-name', name));
          if (state === 'in') top.appendChild(pill('✓ logged in', 'onb-ok'));
          else if (state === 'out') top.appendChild(pill('✗ not logged in', 'onb-bad'));
          else if (state === 'unknown') top.appendChild(pill('✓ installed', 'onb-ok'));
          else top.appendChild(pill('— not installed', 'onb-opt'));
          row.appendChild(top);
          if (state === 'out') {
            const w = mk('div', 'onb-hint');
            w.appendChild(cmdBox(cmd)); w.appendChild(copyBtn(copyId, cmd)); w.appendChild(mk('span', null, ' ' + afterCmd));
            row.appendChild(w);
          } else if (state === 'none') {
            const w = mk('div', 'onb-hint');
            if (installLink) { const a = mk('a', 'onb-link', 'Install →'); a.href = installLink; a.target = '_blank'; a.rel = 'noopener'; w.appendChild(a); }
            if (installHint) { w.appendChild(cmdBox(installHint)); w.appendChild(copyBtn(copyId.replace(/-copy$/, '-install-copy'), installHint)); }
            row.appendChild(w);
          }
          return row;
        }
        // write-only key row: the SAME component as Settings -> Cloud & keys (renderKeyField, mirror mode) - Enter / leaving the field saves, the field empties
        function keyRow(ref, label, st) {
          const base = 'onb-key-' + ref;
          const row = mk('div', 'onb-row'), top = mk('div', 'onb-row-top');
          const lab = mk('label', 'onb-name', label); lab.htmlFor = base;
          top.appendChild(lab); row.appendChild(top);
          const w = mk('div', 'onb-hint');
          const f = deps.fields.renderKeyField(w, ref, { mirror: true, id: base, statusId: base + '-status', onChange: function (on) { st.keys = Object.assign({}, st.keys, { [ref]: !!on }); } });
          f.set(!!(st.keys && st.keys[ref]));
          row.appendChild(w);
          return row;
        }
        // the whole step body
        function render(st) {
          st = st || {};
          const wrap = mk('div');
          wrap.appendChild(mk('h2', null, 'Brain'));
          wrap.appendChild(mk('p', null, 'Phoenix needs one brain. Any one of these is enough — a local model needs none of them.'));
          const list = mk('div', 'onb-list');
          const cc = st.claudeCli || {}, cx = st.codexCli || {};
          const ccState = !cc.present ? 'none' : (cc.loggedIn === false ? 'out' : (cc.loggedIn === true ? 'in' : 'unknown'));
          const cxState = !cx.present ? 'none' : (cx.loggedIn ? 'in' : 'out');
          list.appendChild(cliRow('Claude CLI', ccState, 'claude', 'onb-claude-copy', 'run it in a terminal and type /login', null, 'https://docs.claude.com/en/docs/claude-code'));
          list.appendChild(cliRow('Codex CLI', cxState, 'codex login', 'onb-codex-copy', 'run it in a terminal', 'npm install -g @openai/codex', null));
          list.appendChild(keyRow('openai', 'OpenAI API key', st));
          list.appendChild(keyRow('meshy', 'Meshy API key (optional, paid remesh)', st));
          wrap.appendChild(list);
          const re = mk('button', 'modal-btn', 'Re-check'); re.id = 'onb-brain-recheck'; re.style.marginTop = '10px';
          re.addEventListener('click', async function () {
            re.disabled = true; re.textContent = 'Checking…';
            let ns = null;
            try { const r = await deps.fetch('/onboarding/status'); if (r.ok) ns = await r.json(); } catch (_) {}
            if (ns) deps.apply(ns); else { re.disabled = false; re.textContent = 'Re-check'; }
          });
          wrap.appendChild(re);
          wrap.appendChild(mk('p', 'onb-hint', 'Which brain does what is set in Settings → Brains. These key fields are the same ones as in Settings → Cloud & keys.'));
          return wrap;
        }
        return { render: render, keyRow: keyRow };
      }
      // </g6-onb-brain>
      const g6OnbBrain = makeG6OnbBrain({ document: document, fetch: function (u, o) { return fetch(u, o); }, clipboard: navigator.clipboard, apply: function (st) { _onbStatus = st; renderOnb(); }, fields: settingsFields });
      async function initOnboarding() {
        const st = await fetchOnbStatus();
        if (st && !st.completed) { _onbStatus = st; openOnboarding(); }
      }
      function _wfReady(st) {
        if (!(st && st.comfyui && st.comfyui.reachable && st.comfyui.deps && st.comfyui.active)) return false;
        const di = st.comfyui.deps[st.comfyui.active.image];
        const dm = st.comfyui.deps[st.comfyui.active.mesh];
        return !!(di && di.ready && dm && dm.ready);
      }
      function _modelsHint(st) {
        if (!(st && st.comfyui && st.comfyui.reachable)) return 'Models for the active workflow (checked once ComfyUI is up).';
        const miss = [];
        if (st.comfyui.deps && st.comfyui.active) {
          for (const id of [st.comfyui.active.image, st.comfyui.active.mesh]) {
            const d = st.comfyui.deps[id];
            if (d && !d.ready) { (d.missing_models || []).forEach(m => miss.push(m)); (d.missing_nodes || []).forEach(m => miss.push(m)); }
          }
        }
        return miss.length ? ('Missing: ' + miss.join(', ')) : 'All models for the active workflow are present.';
      }
      // Sweep 2 G11: the first prop also needs the metaprompter and the category provider (utility) seats, not just the orchestrator
      function _seatsReady(st) { const s = st && st.seats; return !s || Object.keys(s).every(function (k) { return !!(s[k] && s[k].ok); }); }
      function _seatsHint(st) {
        const s = (st && st.seats) || {}, bad = Object.keys(s).filter(function (k) { return !(s[k] && s[k].ok); });
        if (!bad.length) return 'The prompt-writing (metaprompter) and category-provider seats answer too.';
        return bad.map(function (k) { return (k === 'utility' ? 'Category provider' : 'Metaprompter') + ': ' + ((s[k] && s[k].how) || 'not ready'); }).join(' · ') + ' — set them in Settings → Brains.';
      }
      function _coreReady(st) {
        return !!(st && st.comfyui && st.comfyui.reachable && st.brain && st.brain.ok && _wfReady(st) && _seatsReady(st));
      }
      function _onbPill(ok, optional) {
        const s = document.createElement('span');
        s.className = 'onb-pill ' + (ok ? 'onb-ok' : (optional ? 'onb-opt' : 'onb-bad'));
        s.textContent = ok ? '✓ ready' : (optional ? '— optional' : '✗ missing');
        return s;
      }
      async function openOnboarding() {
        let ov = document.getElementById('onboarding-overlay');
        if (ov) ov.remove();
        ov = document.createElement('div'); ov.id = 'onboarding-overlay';
        document.body.appendChild(ov);
        _onbStep = 0;
        if (!_onbStatus) _onbStatus = await fetchOnbStatus();
        renderOnb();
      }
      function closeOnboarding() { const ov = document.getElementById('onboarding-overlay'); if (ov) ov.remove(); }
      function renderOnb() {
        const ov = document.getElementById('onboarding-overlay'); if (!ov) return;
        const st = _onbStatus || {};
        ov.innerHTML = '';
        const card = document.createElement('div'); card.className = 'onb-card';

        const prog = document.createElement('div'); prog.className = 'onb-prog';
        ['Welcome', 'Setup', 'Brain', 'First prop', 'Done'].forEach((lbl, i) => {
          const d = document.createElement('span');
          d.className = 'onb-dot' + (i === _onbStep ? ' active' : '') + (i < _onbStep ? ' done' : '');
          d.textContent = String(i + 1); d.title = lbl; prog.appendChild(d);
        });
        card.appendChild(prog);

        const body = document.createElement('div'); body.className = 'onb-body';

        if (_onbStep === 0) {
          body.innerHTML = '<h2>Welcome to Phoenix</h2>'
            + '<p>Phoenix is a creative\'s control room for local AI — one window that runs your whole local toolchain: ComfyUI images, 3D meshes, Blender, Unreal and voice, driven by an assistant you choose.</p>'
            + '<p><b>What you\'ll need:</b> a running <b>ComfyUI</b> (+ models), <b>Node</b>, and <b>one brain</b> — the Claude CLI, the Codex CLI (ChatGPT plan), a local model server (LM Studio / llama.cpp), or an API key. This wizard checks each and helps you fix anything missing. Optional: Blender.</p>';
        } else if (_onbStep === 1) {
          const h = document.createElement('h2'); h.textContent = 'Prerequisites'; body.appendChild(h);
          const list = document.createElement('div'); list.className = 'onb-list';
          const rows = [
            ['Node.js', !!(st.node && st.node.present), false, 'Runtime — already running' + (st.node && st.node.version ? ' (' + st.node.version + ')' : '') + '.', null],
            ['ComfyUI', !!(st.comfyui && st.comfyui.reachable), false, g3OnbComfy.hint('The local generation backend Phoenix talks to.', st), 'https://github.com/comfyanonymous/ComfyUI'],
            ['Models / workflow', _wfReady(st), false, _modelsHint(st), 'https://github.com/comfyanonymous/ComfyUI#installing'],
            ['Brain', !!(st.brain && st.brain.ok), false, (st.brain && st.brain.ok && st.brain.how) ? st.brain.how : ((st.brain && st.brain.how ? st.brain.how + '. ' : '') + 'Pick one in Settings → Brains: Claude CLI, Codex CLI, a local model server, or an API key.'), null],
            ['Prompt + category seats', _seatsReady(st), false, _seatsHint(st), null],
            ['LM Studio', !!(st.lmstudio && st.lmstudio.reachable), true, 'Optional — local model for the metaprompter (or as the brain).', 'https://lmstudio.ai/'],
            ['Blender', !!(st.blender && st.blender.present), true, 'Optional — for import / scene sync.', 'https://www.blender.org/'],
          ];
          rows.forEach(function (r) {
            const name = r[0], ok = r[1], opt = r[2], hint = r[3], link = r[4];
            const row = document.createElement('div'); row.className = 'onb-row';
            const top = document.createElement('div'); top.className = 'onb-row-top';
            const nm = document.createElement('span'); nm.className = 'onb-name'; nm.textContent = name;
            top.appendChild(nm); top.appendChild(_onbPill(ok, opt));
            row.appendChild(top);
            const hd = document.createElement('div'); hd.className = 'onb-hint'; hd.textContent = hint;
            if (link && !ok) { const a = document.createElement('a'); a.href = link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = ' Get it →'; a.className = 'onb-link'; hd.appendChild(a); }
            row.appendChild(hd);
            if (name === 'ComfyUI') { const fx = g3OnbComfy.fix(st); if (fx) row.appendChild(fx); }
            list.appendChild(row);
          });
          body.appendChild(list);
          const reBtn = document.createElement('button'); reBtn.className = 'modal-btn'; reBtn.style.marginTop = '10px'; reBtn.textContent = 'Re-check';
          reBtn.addEventListener('click', async function () { reBtn.disabled = true; reBtn.textContent = 'Checking…'; _onbStatus = await fetchOnbStatus(); renderOnb(); });
          body.appendChild(reBtn);
          const tsLink = document.createElement('button'); tsLink.className = 'modal-btn onb-secondary'; tsLink.style.marginTop = '10px'; tsLink.style.marginLeft = '8px'; tsLink.textContent = 'Stuck? Open Troubleshooter';
          tsLink.addEventListener('click', function () { closeOnboarding(); openTroubleshooter(); });
          body.appendChild(tsLink);
        } else if (_onbStep === 2) {
          body.appendChild(g6OnbBrain.render(st));
        } else if (_onbStep === 3) {
          if (_coreReady(st)) {
            body.innerHTML = '<h2>Your first prop</h2><p>Everything\'s ready ✓</p>'
              + '<p>Close this wizard, type a prompt in the chat (e.g. <i>"a wooden treasure chest"</i>), and Phoenix generates a reference image, then a 3D mesh. Approve each gate as it appears.</p>';
          } else {
            const h = document.createElement('h2'); h.textContent = 'Your first prop'; body.appendChild(h);
            const p = document.createElement('p'); p.textContent = 'Almost — finish the required items on the Setup and Brain steps first (ComfyUI, a brain, and a runnable workflow must be green), then come back.'; body.appendChild(p);
            const re = document.createElement('button'); re.className = 'modal-btn'; re.style.marginTop = '8px'; re.textContent = 'Re-check';
            re.addEventListener('click', async function () { _onbStatus = await fetchOnbStatus(); renderOnb(); });
            body.appendChild(re);
          }
        } else if (_onbStep === 4) {
          body.innerHTML = '<h2>You\'re set up 🎉</h2><p>Phoenix is ready. A quick map of how it works:</p>'
            + '<ul class="onb-cats">'
            + '<li><b>You stay in control</b> — Phoenix (the chat on the left) drives the pipeline, but the modules are yours to steer: approve or skip each gate, edit the prompt, regenerate, or run a step yourself.</li>'
            + '<li><b>Generate</b> — type a prompt in chat; Phoenix runs prompt → image → mesh with optional approval gates.</li>'
            + '<li><b>Workflows</b> — pick which generator runs, or add your own (Verified + Custom).</li>'
            + '<li><b>Palette</b> — per-category style presets that shape the look.</li>'
            + '<li><b>Library</b> — your staged assets, brushes, materials.</li>'
            + '<li><b>Troubleshooter</b> — checks your stack and helps fix what\'s missing.</li>'
            + '</ul><p class="onb-hint">Reopen this anytime from the menu → Setup.</p>';
        }
        card.appendChild(body);

        const nav = document.createElement('div'); nav.className = 'onb-nav';
        const left = document.createElement('div');
        if (_onbStep > 0) { const b = document.createElement('button'); b.className = 'modal-btn onb-secondary'; b.textContent = 'Back'; b.addEventListener('click', function () { _onbStep--; renderOnb(); }); left.appendChild(b); }
        const right = document.createElement('div'); right.style.display = 'flex'; right.style.gap = '8px';
        const skip = document.createElement('button'); skip.className = 'modal-btn onb-secondary'; skip.textContent = 'Skip for now'; skip.addEventListener('click', closeOnboarding); right.appendChild(skip);
        if (_onbStep < 4) { const n = document.createElement('button'); n.className = 'modal-btn'; n.textContent = 'Next'; n.addEventListener('click', function () { _onbStep++; renderOnb(); }); right.appendChild(n); }
        else { const f = document.createElement('button'); f.className = 'modal-btn'; f.textContent = 'Finish'; f.addEventListener('click', async function () { try { await fetch('/onboarding/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completed: true }) }); } catch (e) {} closeOnboarding(); }); right.appendChild(f); }
        nav.appendChild(left); nav.appendChild(right);
        card.appendChild(nav);

        ov.appendChild(card);
      }

