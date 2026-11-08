      // ── Palette tab ──────────────────────────────────────────────────────────

      let paletteParamDefs = {};   // v1.10 ADV: the declared params of the ACTIVE image + mesh workflows (GET /palette → paramDefs)
      async function loadPaletteTab() {
        try {
          const res = await fetch('/palette');
          const data = await res.json();
          const categories = data.categories || {};
          paletteParamDefs = data.paramDefs || {};
          refreshFaceDefaults(categories);
          libPaletteBody.innerHTML = '';

          // "+ Add category" button at the top
          const addBtn = document.createElement('button');
          addBtn.className = 'modal-btn';
          addBtn.style.margin = '8px 12px 4px';
          addBtn.style.fontSize = '12px';
          addBtn.style.padding = '5px 10px';
          addBtn.textContent = '+ Add category';
          addBtn.addEventListener('click', function () { openPaletteEditor(null, null); });
          libPaletteBody.appendChild(addBtn);

          // Builtins first (in LIB_CAT_ORDER), then custom keys
          const builtinOrder = LIB_CAT_ORDER.filter(function (k) { return k in categories; });
          const customKeys   = Object.keys(categories).filter(function (k) { return !LIB_CAT_ORDER.includes(k); });
          const allKeys      = builtinOrder.concat(customKeys);

          if (allKeys.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'lib-empty';
            empty.textContent = 'no categories';
            libPaletteBody.appendChild(empty);
            return;
          }

          for (var i = 0; i < allKeys.length; i++) {
            (function (k) {
              const cat = categories[k];
              const row = document.createElement('div');
              row.className = 'lib-item lib-list-row';

              const nameSpan = document.createElement('span');
              nameSpan.className = 'lib-item-name';
              nameSpan.textContent = k;

              const markerSpan = document.createElement('span');
              markerSpan.className = 'pal-marker';
              markerSpan.textContent = cat.builtin ? 'builtin' : 'custom';

              row.appendChild(nameSpan);
              row.appendChild(markerSpan);

              row.addEventListener('click', function () { openPaletteEditor(k, cat); });
              libPaletteBody.appendChild(row);
            })(allKeys[i]);
          }
        } catch (_) {
          libPaletteBody.innerHTML = '';
          const empty = document.createElement('div');
          empty.className = 'lib-empty';
          empty.textContent = 'could not load palette';
          libPaletteBody.appendChild(empty);
        }
      }

      // <b2r-rows>
      // v1.10 B2r: Library → Workflows. A row = name button (opens the detail window) · state badge · tier · (custom: edit / delete) ·
      // on the right the quick-select button or the ● active mark. The row itself is NOT a click target (only the buttons act) and the
      // Install (acquire) flow no longer lives in the row — it moved into the detail window below. While an acquire runs the badge says "installing…".
      // dep state for one workflow off GET /workflows/deps: ready | missing (+ what) | offline (ComfyUI unreachable, or its instance is)
      function wfDepState(depData, id) {
        if (!depData || !depData.reachable) return { kind: 'offline', missing: [] };
        const d = (depData.deps && depData.deps[id]) || null;
        if (d && d.ready) return { kind: 'ready', missing: [] };
        const missing = [].concat((d && d.missing_nodes) || []).concat((d && d.missing_models) || []);
        if (missing.length && missing.every(function (m) { return /^ComfyUI .* offline$/.test(String(m)); })) return { kind: 'offline', missing: [] };
        return { kind: 'missing', missing: missing };
      }
      // A voice engine's real installed-vs-not, off its acquire-plan (one round trip): a resolved (non-manual) target where every step is
      // already "skip" (or there are no steps) means it is really on disk, not just declared in the manifest.
      function wfVoicePlanState(planData) {
        const target = planData && planData.target;
        if (!target || target.kind === 'manual') return 'no-target';
        const steps = Array.isArray(planData.steps) ? planData.steps : [];
        return steps.every(function (s) { return s.action === 'skip'; }) ? 'installed' : 'not-installed';
      }
      const wfRowErr = {};   // M1.1: the refusal of the last row select, per workflow id, shown at the row until a later select succeeds
      // Quick-select, shared by the row button and the window's Select. POST /workflows stays the only gate (validateActivate).
      async function activateWorkflow(stage, id) {
        let r;
        try {
          r = await fetch('/workflows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: stage, id: id }) });
        } catch (err) {
          return { ok: false, error: (err && err.message) || String(err) };
        }
        let error = null;
        if (!r.ok) { try { const j = await r.json(); error = (j && j.error) || null; } catch (_) {} }
        // Push a Library activation straight into the SAME voice state / i2i engine line instead of a disconnected second selection —
        // only once the server actually accepted + persisted it.
        if (r.ok && stage === 'voice' && window.__setVoiceEngineActive) window.__setVoiceEngineActive(id);
        if (r.ok && stage === 'i2i' && window.__refreshEngineLines) window.__refreshEngineLines();
        if (r.ok && stage === 'image' && window.__refreshRefRow) window.__refreshRefRow();   // I1: slots follow the active image workflow
        if (r.ok && (stage === 'image' || stage === 'video')) { try { if (typeof storyboardTab !== 'undefined') storyboardTab.load(document.getElementById('sb-root'), true); } catch (_) {} }   // F6.6: Story shows the new workflow's state (soft refresh)
        loadWorkflowsTab();
        if (wfWin) refreshWorkflowWindow();
        return { ok: !!r.ok, error: error };
      }

      window.__reloadLibraryWorkflows = loadWorkflowsTab;
      async function loadWorkflowsTab() {
        try {
          const [wfRes, depRes] = await Promise.all([fetch('/workflows'), fetch('/workflows/deps')]);
          const wfData  = await wfRes.json();
          const depData = await depRes.json().catch(function () { return { reachable: false }; });
          const workflowsMap = wfData.workflows || {};
          const active       = wfData.active || {};
          libWorkflowsBody.innerHTML = '';

          const addBtn = document.createElement('div');
          addBtn.className = 'lib-item wf-add-row';   // R4: the Library page has its own "+ Add" in the list header, so this row is not shown there (CSS)
          addBtn.style.cursor = 'pointer';
          addBtn.style.fontWeight = '700';
          addBtn.style.color = 'var(--accent)';
          addBtn.textContent = '+ Add workflow';
          addBtn.addEventListener('click', function () { openWorkflowEditor(null); });
          libWorkflowsBody.appendChild(addBtn);

          for (const stage of ['image', 'mesh', 'i2i', 'voice', 'video']) {
            const ids = Object.keys(workflowsMap).filter(function (id) { return workflowsMap[id].stage === stage; });
            const hdr = document.createElement('div');
            hdr.className = 'lib-cat';
            hdr.setAttribute('data-wf-stage', stage);   // M1.1: the jump from Story scrolls this group bar into view
            hdr.textContent = stage === 'image' ? 'Image' : (stage === 'mesh' ? '3D / Mesh' : (stage === 'i2i' ? 'i2i / Edit' : (stage === 'video' ? 'Video (local)' : 'Voice')));
            { const cnt = document.createElement('span'); cnt.className = 'lib-cat-count'; cnt.textContent = String(ids.length); hdr.appendChild(cnt); }   // R4: the group bar carries its row count
            libWorkflowsBody.appendChild(hdr);

            if (ids.length === 0) {
              const empty = document.createElement('div');
              empty.className = 'lib-empty';
              empty.textContent = 'no workflows';
              libWorkflowsBody.appendChild(empty);
              continue;
            }

            for (var wi = 0; wi < ids.length; wi++) {
              (function (id) {
                const e        = workflowsMap[id];
                // "active" (cfg.workflows.<stage>) also covers voice, persisted + guarded the same way as image/mesh/i2i
                // (POST /workflows, server.js) — a `blocked` voice engine can never BE active (the server refuses to persist
                // it). A NOT-YET-CONFIRMED-INSTALLED one (e.g. chatterbox before its acquire-plan check below resolves)
                // starts inert too and is upgraded to selectable only once that check confirms it's really on disk — a
                // not-installed engine must never become the persisted default (it would set a default that can't speak).
                // validateActivate (server.js) has no cheap way to confirm real install status itself (that's an ssh
                // `test -d`), so this gate stays client-side: such a row never gets a select button.
                const isActive   = active[stage] === id || (stage === 'video' && !active.video && ids[0] === id);   // v1.10 V2: no explicit choice = the default (first) local video model
                const installing = !!(window.__acqRows && window.__acqRows[id] && window.__acqRows[id].jobId != null);

                const row = document.createElement('div');
                row.className = 'lib-item wf-row lib-list-row';
                if (wfWin && wfWin.id === id) row.setAttribute('aria-current', 'true');

                const nameBtn = document.createElement('button');
                nameBtn.setAttribute('type', 'button');
                nameBtn.className = 'lib-item-name wf-name-btn';
                nameBtn.setAttribute('data-wf-id', id);
                nameBtn.setAttribute('title', e.label);
                nameBtn.textContent = e.label;
                nameBtn.addEventListener('click', function (ev) { ev.stopPropagation(); openWorkflowWindow(id, nameBtn); });

                const badge = document.createElement('span');
                badge.className = 'wf-badge';
                function setBadge(text, color, title) {
                  badge.textContent = text;
                  badge.style.color = color;
                  if (title) badge.setAttribute('title', title);
                }

                // right-hand slot: the ● active mark, or (once allowed) the quick-select button
                const slot = document.createElement('span');
                slot.className = 'wf-slot';
                let hasSelect = false;
                // Factored out so the voice branch can call it a second time, later — asynchronously, once the acquire-plan check
                // confirms the engine is installed. image/mesh/i2i call it once, synchronously. Self-guards on isActive / hasSelect.
                function makeActivatable() {
                  if (workflowHome(stage) === 'create' || isActive || hasSelect) return;
                  hasSelect = true;
                  const selBtn = document.createElement('button');
                  selBtn.setAttribute('type', 'button');
                  selBtn.className = 'lib-act-btn wf-select';
                  selBtn.setAttribute('aria-label', 'Select ' + e.label + ' as the active ' + stage + ' workflow');
                  selBtn.style.color = 'var(--accent)';
                  selBtn.style.fontWeight = '700';
                  selBtn.textContent = 'select';
                  selBtn.addEventListener('click', async function (ev) { ev.stopPropagation(); const r = await activateWorkflow(stage, id); wfRowErr[id] = r.ok ? '' : (r.error || 'Could not select this workflow.'); loadWorkflowsTab(); });
                  slot.appendChild(selBtn);
                }

                if (workflowHome(stage) === 'create') {
                  if (isActive) { const note = document.createElement('span'); note.className = 'wf-create-note'; note.textContent = 'Active in Create'; slot.appendChild(note); }
                  {
                    const link = document.createElement('button'); link.type = 'button'; link.className = 'btn btn-ghost btn-sm'; link.textContent = 'Switch it in Create ▸ Inspector'; link.setAttribute('data-open-create', stage);
                    link.addEventListener('click', function (ev) { ev.stopPropagation(); window.__openInCreate(stage); }); slot.appendChild(link);
                  }
                } else if (isActive) {
                  const mark = document.createElement('span');
                  mark.className = 'pal-marker';
                  mark.style.fontStyle = 'normal';
                  mark.style.fontWeight = '700';
                  mark.style.color = '#4caf50';
                  mark.textContent = '● active';
                  slot.appendChild(mark);
                  row.style.background = 'rgba(76,175,80,0.10)';
                } else if (stage !== 'voice') {
                  makeActivatable();
                }
                // stage==='voice', not active: no button yet — crispasr claims it below immediately (synchronously); an installable
                // engine claims it only if/when the acquire-plan check confirms "installed"; blocked never claims it at all.

                if (installing) {
                  setBadge('installing…', '#c98a2b');
                } else if (stage === 'voice') {
                  // Voice engines don't run on ComfyUI — GET /workflows/deps has nothing meaningful to say about them. No install
                  // block = ships integrated (crispasr); `blocked` = not available yet and must NOT be selectable; anything else
                  // with an install block is UNKNOWN until the acquire-plan check resolves — real filesystem status, never a guess.
                  if (!e.install) {
                    setBadge('✓ integrated', '#4caf50');
                    makeActivatable();
                  } else if (e.blocked) {
                    setBadge('⛔ ' + (e.blockedReason || 'blocked'), '#e06c6c');
                  } else {
                    setBadge('checking…', '#888');
                    (async function () {
                      let planData = null;
                      try {
                        const r = await fetch('/workflows/acquire-plan?id=' + encodeURIComponent(id));
                        planData = await r.json();
                      } catch (_) { /* stays not installed */ }
                      if (wfVoicePlanState(planData) === 'installed') {
                        setBadge('✓ installed', '#4caf50');
                        makeActivatable();
                      } else {
                        setBadge('not installed', '#c98a2b');
                      }
                    })();
                  }
                } else {
                  const st = wfDepState(depData, id);
                  if (st.kind === 'ready') setBadge('✓ ready', '#4caf50');
                  else if (st.kind === 'offline') setBadge('offline', '#888', 'deps: ComfyUI offline');
                  else setBadge('✗ missing', '#e06c6c', st.missing.join(', ') || 'missing deps');
                }

                const tierSpan = document.createElement('span');
                tierSpan.className = 'pal-marker';
                tierSpan.style.marginLeft = '6px';
                tierSpan.textContent = e.builtin ? (e.status === 'unverified' ? 'Built-in' : 'Verified') : 'Custom';   // LC2d: an unverified built-in is not called "Verified"
                tierSpan.style.color = e.builtin ? 'var(--muted)' : 'var(--accent)';

                row.appendChild(nameBtn);
                row.appendChild(badge);
                row.appendChild(tierSpan);
                if (e.status === 'unverified') {   // LC2d/LC2e: any workflow (builtin or custom) that has not finished a run through Phoenix yet
                  const uv = document.createElement('span');
                  uv.className = 'wf-unverified';
                  uv.style.fontSize = '11px'; uv.style.marginLeft = '6px'; uv.style.color = '#c98a2b';
                  uv.textContent = (typeof UNVERIFIED_BADGE === 'string' ? UNVERIFIED_BADGE : 'unverified');   // LC2f: the shared one-word badge (the typeof guard: this region is also evaluated on its own in the tests)
                  uv.setAttribute('title', 'This workflow has not finished a run through Phoenix yet. Choosing it works normally; it may need a small fix.');
                  row.appendChild(uv);
                }

                if (!e.builtin) {
                  const editBtn = document.createElement('button');
                  editBtn.setAttribute('type', 'button');
                  editBtn.className = 'lib-act-btn'; editBtn.appendChild(libIcon('edit')); editBtn.setAttribute('title', 'Edit ' + e.label);
                  editBtn.setAttribute('aria-label', 'Edit ' + e.label);
                  editBtn.style.marginLeft = '4px';
                  editBtn.addEventListener('click', function (ev) { ev.stopPropagation(); openWorkflowEditor(id); });
                  row.appendChild(editBtn);
                  const delBtn = document.createElement('button');
                  delBtn.setAttribute('type', 'button');
                  delBtn.className = 'lib-act-btn'; delBtn.appendChild(libIcon('trash')); delBtn.setAttribute('title', 'Delete ' + e.label);
                  delBtn.setAttribute('aria-label', 'Delete ' + e.label);
                  delBtn.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    libInlineRow({   // R4: asks inline under the row (Delete / Cancel), no native dialog
                      anchor: row, trigger: delBtn, kind: 'confirm', action: 'Delete', danger: true, label: 'Delete ' + e.label + '?',
                      onDone: async function () {
                        await fetch('/workflows/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) });
                        loadWorkflowsTab();
                      },
                    });
                  });
                  row.appendChild(delBtn);
                }

                row.appendChild(slot);
                libWorkflowsBody.appendChild(row);
                if (wfRowErr[id]) { const er = document.createElement('div'); er.className = 'wf-row-err'; er.setAttribute('role', 'alert'); er.textContent = wfRowErr[id]; libWorkflowsBody.appendChild(er); }
              })(ids[wi]);
            }
          }
          const wfFilterEl = document.getElementById('wf-filter');
          if (wfFilterEl && wfFilterEl.value) wfFilterRows(wfFilterEl.value);   // R4: a rebuild keeps the filter that is typed
          try { if (typeof libraryPage !== 'undefined' && libraryPage) libraryPage.fitWorkflows(); } catch (_) {}
        } catch (_) {
          libWorkflowsBody.innerHTML = '';
          const empty = document.createElement('div');
          empty.className = 'lib-empty';
          empty.textContent = 'could not load workflows';
          libWorkflowsBody.appendChild(empty);
        }
      }
      // R4: the list filter of the Library page. Rows whose label does not contain the query (case-insensitive) get .hidden; a stage group with no visible row
      // hides its header (and its "no workflows" line); each group bar shows how many rows it shows. Returns the number of rows left visible.
      function wfFilterRows(query) {
        const q = String(query == null ? '' : query).trim().toLowerCase();
        let total = 0, cat = null, shown = 0, empties = [];
        const flush = function () {
          if (!cat) return;
          cat.hidden = q !== '' && shown === 0;
          const cnt = cat.querySelector('.lib-cat-count');
          if (cnt) cnt.textContent = String(shown);
          empties.forEach(function (n) { n.hidden = q !== ''; });
          total += shown; shown = 0; empties = [];
        };
        Array.prototype.forEach.call(libWorkflowsBody.children, function (c) {
          if (c.classList.contains('lib-cat')) { flush(); cat = c; }
          else if (c.classList.contains('wf-row')) {
            const nm = c.querySelector('.wf-name-btn');
            const hit = q === '' || String(nm ? nm.textContent : c.textContent).toLowerCase().indexOf(q) >= 0;
            c.hidden = !hit;
            if (hit) shown++;
          } else if (c.classList.contains('lib-empty')) empties.push(c);
        });
        flush();
        return total;
      }
      { const wfFilterIn = document.getElementById('wf-filter'), wfAddBtn = document.querySelector('[data-wf-add]');
        if (wfFilterIn) wfFilterIn.addEventListener('input', function () { wfFilterRows(wfFilterIn.value); });
        if (wfAddBtn) wfAddBtn.addEventListener('click', function () { openWorkflowEditor(null); }); }
      // </b2r-rows>

      // <b2r-window>
      // The workflow detail PAGE (v1.10.1 R4; it was an overlay window in B2r - the names stayed): Library > Workflows shows the list on the left and the
      // detail of the picked workflow on the right (#wf-page). Back (button) returns to where it was opened from and puts the focus back on what opened it;
      // Esc on the page goes back to the list. Everything is DOM APIs + textContent. It reads GET /workflows, /workflows/deps, /acquire-plan,
      // /uninstall-plan and (live) /workflows/env; the Install flow is the old row-level Acquire flow, moved here unchanged.
      let wfWin = null;   // { id, opener, from, root, advanced, gen, notice, failEvt, uninstResult, rendered, advScrolled, refocus }
      const WF_STAGE_NAMES = { image: 'Image', mesh: '3D / Mesh', i2i: 'i2i / Edit', video: 'Video (local)', voice: 'Voice' };
      function wfEl(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
      }
      function wfBtn(label, aria) {
        const b = wfEl('button', 'wfw-btn', label);
        b.setAttribute('type', 'button');
        if (aria) b.setAttribute('aria-label', aria);
        return b;
      }
      async function wfGetJSON(url) {
        try { const r = await fetch(url); return await r.json(); } catch (_) { return null; }
      }
      function wfMajorMinor(v) {
        const m = /^(\d+)\.(\d+)/.exec(String(v == null ? '' : v));
        return m ? m[1] + '.' + m[2] : null;
      }
      function wfDiffers(tested, live) {
        const a = wfMajorMinor(tested), b = wfMajorMinor(live);
        return !!(a && b && a !== b);
      }
      function wfRepoName(git) {
        return String(git || '').replace(/\/+$/, '').split('/').pop().replace(/\.git$/, '') || 'node';
      }
      function wfGb(n) { return (typeof n === 'number' && isFinite(n)) ? (Math.round(n * 10) / 10) + ' GB' : '?'; }

      // <adv-controls>
      // v1.10 ADV: the value controls shared by the workflow window (Advanced) and the palette editor - two views of ONE store
      // (workflow-params.json). advControl(p, value, onSet, ctx) builds the control for a declared param (number input, enum <select>,
      // size = preset <select> + Custom fields) and calls onSet(newValue) on `change`. Plain DOM APIs + textContent only.
      function advFmt(p, v) {
        if (v == null) return '—';
        if (p.type === 'size') return v.w + ' × ' + v.h;
        if (p.type === 'float' && typeof v === 'number' && Number.isInteger(v)) return v.toFixed(1);
        return String(v);
      }
      function advCap(s) { s = String(s); return s.charAt(0).toUpperCase() + s.slice(1); }
      function advControl(p, value, onSet, ctx) {
        ctx = ctx || {};
        const label = p.label || p.key;
        if (p.type === 'size') {
          const wrap = wfEl('span', 'wfw-adv-size');
          const presets = Array.isArray(p.presets) ? p.presets : [];
          const sel = wfEl('select', 'wfw-adv-in');
          sel.setAttribute('aria-label', label + ' preset');
          let cur = 'custom';
          presets.forEach(function (pr, i) {
            const o = wfEl('option', null, pr.label); o.value = String(i); sel.appendChild(o);
            if (value && pr.w === value.w && pr.h === value.h) cur = String(i);
          });
          const oc = wfEl('option', null, 'Custom'); oc.value = 'custom'; sel.appendChild(oc);
          sel.value = cur;
          const custom = wfEl('span', 'wfw-adv-custom');
          custom.hidden = cur !== 'custom';
          const mkNum = function (v, aria) {
            const n = wfEl('input', 'wfw-adv-in wfw-adv-num');
            n.type = 'number'; n.min = String(p.min != null ? p.min : 256); n.max = String(p.max != null ? p.max : 2048); n.step = String(p.step != null ? p.step : 16);
            n.value = value ? String(v) : ''; n.setAttribute('aria-label', label + ' ' + aria);
            return n;
          };
          const wIn = mkNum(value && value.w, 'width'), hIn = mkNum(value && value.h, 'height');
          custom.appendChild(wIn); custom.appendChild(wfEl('span', null, ' × ')); custom.appendChild(hIn);
          const fire = function () {
            if (wIn.value === '' || hIn.value === '') return;
            const w = Number(wIn.value), h = Number(hIn.value);
            if (isFinite(w) && isFinite(h)) onSet({ w: w, h: h });
          };
          wIn.addEventListener('change', fire); hIn.addEventListener('change', fire);
          sel.addEventListener('change', function () {
            if (sel.value === 'custom') { custom.hidden = false; return; }
            const pr = presets[Number(sel.value)];
            custom.hidden = true;
            if (pr) onSet({ w: pr.w, h: pr.h });
          });
          wrap.appendChild(sel); wrap.appendChild(custom);
          return wrap;
        }
        if (p.type === 'enum') {
          const sel = wfEl('select', 'wfw-adv-in');
          sel.setAttribute('aria-label', label);
          const opts = Array.isArray(p.options) ? p.options.slice() : (Array.isArray(ctx.samplers) ? ctx.samplers.slice() : []);
          if (value != null && opts.indexOf(value) < 0) opts.unshift(value);
          opts.forEach(function (o) { const op = wfEl('option', null, String(o)); op.value = String(o); sel.appendChild(op); });
          sel.value = value == null ? '' : String(value);
          sel.addEventListener('change', function () {
            const hit = opts.filter(function (o) { return String(o) === sel.value; })[0];
            onSet(hit === undefined ? sel.value : hit);
          });
          return sel;
        }
        const inp = wfEl('input', 'wfw-adv-in wfw-adv-num');
        inp.type = 'number';
        if (p.min != null) inp.min = String(p.min);
        if (p.max != null) inp.max = String(p.max);
        if (p.step != null) inp.step = String(p.step);
        inp.value = value == null ? '' : String(value);
        inp.setAttribute('aria-label', label);
        inp.addEventListener('change', function () {
          const n = Number(inp.value);
          if (inp.value === '' || !isFinite(n)) { inp.value = value == null ? '' : String(value); return; }
          onSet(n);
        });
        return inp;
      }
      // </adv-controls>

      // <adv-window>
      // The Advanced section of the workflow window (v1.10 ADV): a collapsed <details> after the facts, before the actions. Workflow value per
      // param + category override tags + Reset + seed lock. Every change saves on `change` (POST) and the section re-renders from the store's
      // answer - nothing is cached client side. Hidden until the server says this workflow declares params (sam3 / voice: never shown).
      function wfAdvanced(id, wfLabel, isStale, onShow) {
        const enc = encodeURIComponent(id);
        const det = wfEl('details', 'wfw-adv');
        det.hidden = true;
        det.appendChild(wfEl('summary', null, 'Advanced'));
        const box = wfEl('div', 'wfw-adv-body');
        det.appendChild(box);
        const ctx = { samplers: undefined };   // undefined: not asked yet · null: ComfyUI unreachable · [names]
        let st = null, asked = false;
        let msg = '';
        async function post(url, body) {
          try {
            const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            let j = null; try { j = await r.json(); } catch (_) {}
            return { ok: !!r.ok, j: j };
          } catch (_) { return { ok: false, j: null }; }
        }
        async function save(url, body) {
          const r = await post(url, body);
          if (isStale()) return;
          if (r.ok && r.j && Array.isArray(r.j.params)) { st = r.j; msg = ''; }
          else msg = (r.j && r.j.error) ? r.j.error : 'Could not save this change.';
          render();
        }
        const isLive = function (p) { return p.type === 'enum' && !Array.isArray(p.options); };
        function ask() {
          if (asked || !st || !st.params.some(isLive)) return;
          asked = true;
          wfGetJSON('/workflows/samplers?id=' + enc).then(function (s) {
            if (isStale()) return;
            ctx.samplers = (s && s.reachable && Array.isArray(s.samplers)) ? s.samplers : null;
            render();
          });
        }
        function render() {
          box.textContent = '';
          if (!st || !Array.isArray(st.params) || !st.params.length) { det.hidden = true; return; }
          det.hidden = false;
          if (typeof onShow === 'function') onShow(det);   // R4: the page scrolls it into view when it was opened with "Advanced"

          st.params.forEach(function (p) {
            const row = wfEl('div', 'wfw-adv-row');
            row.setAttribute('data-param', p.key);
            row.appendChild(wfEl('span', 'wfw-adv-label', p.label || p.key));
            const wv = p.value != null ? p.value : p.default;
            row.appendChild(advControl(p, wv, function (v) { save('/workflows/params', { id: id, key: p.key, value: v }); }, ctx));
            const tags = wfEl('span', 'wfw-adv-tags');
            (p.overrides || []).forEach(function (o) {
              const tag = wfEl('span', 'wfw-tag');
              tag.setAttribute('data-category', o.category);
              tag.appendChild(wfEl('span', 'wfw-tag-cat', advCap(o.category)));
              tag.appendChild(advControl(p, o.value, function (v) { save('/workflows/params/override', { id: id, category: o.category, key: p.key, value: v }); }, ctx));
              const x = wfEl('button', 'wfw-tag-x', '✕');
              x.setAttribute('type', 'button');
              x.setAttribute('aria-label', 'Remove the ' + o.category + ' override of ' + (p.label || p.key));
              x.addEventListener('click', function () { save('/workflows/params/override/remove', { id: id, category: o.category, key: p.key }); });
              tag.appendChild(x);
              tags.appendChild(tag);
            });
            const free = (st.categories || []).filter(function (c) { return !(p.overrides || []).some(function (o) { return o.category === c; }); });
            let picking = false;
            const add = wfEl('button', 'wfw-btn wfw-adv-add', '+ category');
            add.setAttribute('type', 'button');
            add.setAttribute('aria-label', 'Add a category override for ' + (p.label || p.key));
            if (!free.length) add.disabled = true;
            add.addEventListener('click', function () {
              if (picking) return;
              picking = true;
              const pick = wfEl('select', 'wfw-adv-in wfw-adv-picker');
              pick.setAttribute('aria-label', 'Category for the ' + (p.label || p.key) + ' override');
              const ph = wfEl('option', null, 'Choose category…'); ph.value = ''; pick.appendChild(ph);
              free.forEach(function (c) { const o = wfEl('option', null, advCap(c)); o.value = c; pick.appendChild(o); });
              pick.value = '';
              pick.addEventListener('change', function () {
                if (!pick.value) return;
                save('/workflows/params/override', { id: id, category: pick.value, key: p.key, value: wv });   // seeded with the current workflow value
              });
              tags.appendChild(pick);
            });
            tags.appendChild(add);
            row.appendChild(tags);
            if (isLive(p) && ctx.samplers === null) row.appendChild(wfEl('div', 'wfw-note', 'ComfyUI not reachable — sampler list unavailable'));
            box.appendChild(row);
          });
          if (st.seed) {
            const row = wfEl('div', 'wfw-adv-row wfw-adv-seed');
            row.appendChild(wfEl('span', 'wfw-adv-label', 'Seed'));
            const chk = wfEl('input', 'wfw-adv-lock');
            chk.type = 'checkbox'; chk.checked = !!st.seed.locked; chk.setAttribute('aria-label', 'Lock the seed');
            const num = wfEl('input', 'wfw-adv-in wfw-adv-num');
            num.type = 'number'; num.min = '0'; num.max = '2147483647'; num.step = '1';
            num.value = st.seed.value != null ? String(st.seed.value) : '';
            num.setAttribute('aria-label', 'Locked seed');
            const lock = function () {
              let v = num.value === '' ? NaN : Number(num.value);
              if (!isFinite(v)) v = Math.floor(Math.random() * 2147483647);
              save('/workflows/params/seed', { id: id, locked: true, value: Math.round(v) });
            };
            chk.addEventListener('change', function () {
              if (chk.checked) lock();
              else save('/workflows/params/seed', { id: id, locked: false });
            });
            num.addEventListener('change', function () { if (chk.checked) lock(); });
            const lbl = wfEl('label', 'wfw-adv-locklbl');
            lbl.appendChild(chk); lbl.appendChild(wfEl('span', null, ' Lock seed'));
            row.appendChild(lbl); row.appendChild(num);
            row.appendChild(wfEl('div', 'wfw-note', st.seed.locked ? 'Every run uses this seed.' : 'Random seed each run.'));
            box.appendChild(row);
          }
          if (msg) box.appendChild(wfEl('div', 'wfw-note wfw-adv-err', msg));
          const reset = wfBtn('Reset to workflow defaults');
          reset.addEventListener('click', function () {
            // R4: asks inline under the button (Reset / Cancel), no native dialog
            libInlineRow({ anchor: reset, trigger: reset, kind: 'confirm', action: 'Reset', danger: true,
              label: 'Reset "' + wfLabel + '" to its workflow defaults? Its values, category overrides and seed lock are removed.',
              onDone: function () { save('/workflows/params/reset', { id: id }); } });
          });
          box.appendChild(reset);
        }
        det.addEventListener('toggle', function () { if (det.open) ask(); });
        wfGetJSON('/workflows/params?id=' + enc).then(function (r) {
          if (isStale()) return;
          if (r && Array.isArray(r.params)) { st = r; render(); if (det.open) ask(); }
        });
        return det;
      }
      // </adv-window>

      const wfPageRoot = function () { return document.getElementById('wf-page'); };
      function wfEmptyState(root) {
        root.textContent = '';
        root.appendChild(wfEl('p', 'wf-page-empty', 'Pick a workflow from the list to see its details.'));
      }
      function wfBackButton() {
        if (!wfWin) return null;
        if (!wfWin.from || wfWin.from === 'library') {
          const b = wfEl('button', 'btn btn-ghost btn-sm wf-back-list', '\u2190 Back to list');
          b.type = 'button'; b.setAttribute('data-wf-back-list', '');
          b.addEventListener('click', wfBackToList); return b;
        }
        const label = window.__libraryPage.label(wfWin.from);
        const b = wfEl('button', 'btn btn-ghost btn-sm', label ? '\u2190 Back to ' + label : '\u2190 Back');
        b.type = 'button';
        b.setAttribute('data-wf-back', '');
        b.addEventListener('click', function () { closeWorkflowWindow(); });
        return b;
      }
      function wfRowBtn(id) {   // the rows are rebuilt on every refresh -> find the name button again by id
        try { return libWorkflowsBody.querySelector('[data-wf-id="' + id + '"]'); } catch (_) { return null; }
      }

      // Back: the page empties, a page opened from another workspace goes back there (its remembered mode), the focus returns to what opened it.
      // closeWorkflowWindow(true) only empties it (Edit, "Switch it in Create", the Library being left).
      function closeWorkflowWindow(noFocus) {
        const w = wfWin;
        if (!w) return;
        wfWin = null;
        libWorkflowsBody.querySelectorAll('.wf-row').forEach(function (row) { row.removeAttribute('aria-current'); });
        const root = wfPageRoot();
        if (root) wfEmptyState(root);
        if (noFocus) return;
        if (w.from && w.from !== 'library' && window.__libraryPage && typeof window.__libraryPage.back === 'function') { try { window.__libraryPage.back(w.from); } catch (_) {} }
        let target = w.opener || null;
        try {
          if (!target || String(target.className || '').indexOf('wf-name-btn') >= 0) {
            const again = wfRowBtn(w.id);
            if (again) target = again;
          }
        } catch (_) {}
        if (target && target.focus) target.focus();
      }
      // Esc on the page = back to the LIST: the detail empties, the Library stays where it is, the focus goes to this workflow's row
      function wfBackToList() {
        const w = wfWin;
        if (!w) return;
        wfWin = null;
        libWorkflowsBody.querySelectorAll('.wf-row').forEach(function (row) { row.removeAttribute('aria-current'); });
        const root = wfPageRoot();
        if (root) wfEmptyState(root);
        const row = wfRowBtn(w.id);
        if (row && row.focus) row.focus();
      }
      { const wfRoot = wfPageRoot();
        if (wfRoot) wfRoot.addEventListener('keydown', function (ev) {   // on the page itself, not on the document
          if (ev.key !== 'Escape' || !wfWin) return;
          if (ev.preventDefault) ev.preventDefault();
          if (ev.stopPropagation) ev.stopPropagation();
          wfBackToList();
        }); }

      // renders the page (no navigation); `from` = the workspace a Back goes to (null/'library' = stay)
      function wfShowPage(id, opener, from, opts) {
        const root = wfPageRoot();
        if (!root) return;
        root.textContent = '';
        root.appendChild(wfEl('p', 'wfw-loading', 'loading…'));
        wfWin = { advanced: !!(opts && opts.advanced), id: id, opener: opener || null, from: from || null, root: root, gen: 0, notice: null, failEvt: null, uninstResult: null, rendered: false, advScrolled: false, refocus: false };
        libWorkflowsBody.querySelectorAll('.wf-row').forEach(function (row) { const b = row.querySelector('[data-wf-id]'); if (b && b.getAttribute('data-wf-id') === id) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current'); });
        refreshWorkflowWindow();
      }
      function openWorkflowWindow(id, opener, opts) {
        let from = null;
        try { from = window.__libraryPage ? window.__libraryPage.workspace() : null; } catch (_) { from = null; }   // where it is opened from: read BEFORE the Library opens
        try { if (window.__libraryPage && typeof window.__libraryPage.open === 'function') window.__libraryPage.open('workflows'); } catch (_) {}
        wfShowPage(id, opener || null, from, opts);
      }
      window.__openWorkflowWindow = function (id, opener, opts) { openWorkflowWindow(id, opener || null, opts); };
      // the SSE terminal event of an acquire: rebuild the page (deps changed) and, on failure, show the FAQ / Copy log / Open issue row in it
      window.__onAcquireTerminal = function (evt) {
        if (!wfWin || !evt || wfWin.id !== evt.id) return;
        wfWin.failEvt = evt.phase === 'failed' ? evt : null;
        refreshWorkflowWindow();
        if (window.__refreshCreateEngines) window.__refreshCreateEngines();
      };

      async function refreshWorkflowWindow() {
        const w = wfWin;
        if (!w) return;
        const gen = ++w.gen;
        const id = w.id;
        const stale = function () { return wfWin !== w || gen !== w.gen; };
        const enc = encodeURIComponent(id);
        const [wfData, depData0] = await Promise.all([wfGetJSON('/workflows'), wfGetJSON('/workflows/deps')]);
        if (stale()) return;
        const e = wfData && wfData.workflows && wfData.workflows[id];
        if (!e) {
          w.root.textContent = '';
          w.root.appendChild(wfEl('p', 'wfw-note', wfData ? 'This workflow no longer exists.' : 'Could not load this workflow.'));
          { const back = wfBackButton(); if (back) w.root.appendChild(back); }
          return;
        }
        const depData = depData0 || { reachable: false };
        const [planData, uPlan] = await Promise.all([
          e.install ? wfGetJSON('/workflows/acquire-plan?id=' + enc) : Promise.resolve(null),
          wfGetJSON('/workflows/uninstall-plan?id=' + enc),
        ]);
        if (stale()) return;

        const stage    = e.stage;
        const isActive = !!(wfData.active && wfData.active[stage] === id);
        const inst     = (e.install && typeof e.install === 'object') ? e.install : null;
        const st       = stage === 'voice' ? null : wfDepState(depData, id);
        const d        = (depData.deps && depData.deps[id]) || null;
        const missingNodes  = (d && d.missing_nodes) || [];
        const missingModels = (d && d.missing_models) || [];
        const voiceState    = stage === 'voice' && inst && !e.blocked ? wfVoicePlanState(planData) : null;
        const installing    = !!(window.__acqRows && window.__acqRows[id] && window.__acqRows[id].jobId != null);

        const view = wfEl('div', 'wfw-view');
        const section = function (title) {
          const s = wfEl('div', 'wfw-sec');
          if (title) s.appendChild(wfEl('div', 'wfw-h', title));
          view.appendChild(s);
          return s;
        };
        const line = function (parent, text, cls) { const n = wfEl('div', cls || 'wfw-line', text); parent.appendChild(n); return n; };

        // 0 · head: Back · title · state pill
        const head = wfEl('div', 'wfw-head');
        const titleEl = wfEl('h2', 'wfw-title', e.label || id);
        titleEl.setAttribute('tabindex', '-1');
        let pillText = '', pillTone = 'muted';
        if (stage === 'voice') {
          if (!inst) { pillText = 'integrated'; pillTone = 'ok'; }
          else if (e.blocked) { pillText = 'blocked'; pillTone = 'bad'; }
          else if (voiceState === 'installed') { pillText = 'installed'; pillTone = 'ok'; }
          else if (voiceState === 'not-installed') { pillText = 'not installed'; pillTone = 'warn'; }
          else { pillText = 'no install target'; }
          if (isActive) { pillText = '● active'; pillTone = 'ok'; }
        } else if (installing) { pillText = 'installing…'; pillTone = 'warn'; }
        else if (isActive) { pillText = '● active' + (st.kind === 'missing' ? ' · missing' : ''); pillTone = st.kind === 'missing' ? 'warn' : 'ok'; }
        else if (st.kind === 'ready') { pillText = 'ready'; pillTone = 'ok'; }
        else if (st.kind === 'offline') { pillText = 'offline'; }
        else { pillText = 'missing'; pillTone = 'bad'; }
        { const back = wfBackButton(); if (back) head.appendChild(back); }
        head.appendChild(titleEl);
        head.appendChild(wfEl('span', 'wfw-pill wfw-pill-' + pillTone, pillText));
        view.appendChild(head);

        // 1 · meta chips: stage · licence · VRAM
        const meta = section('');
        const metaRow = wfEl('div', 'wfw-meta');
        const lic = inst && typeof inst.license === 'string' ? inst.license : '';
        metaRow.appendChild(wfEl('span', 'wfw-badge', WF_STAGE_NAMES[stage] || stage));
        if (lic) {
          const lb = wfEl('span', 'wfw-badge', lic.split(' — ')[0].slice(0, 24));
          lb.setAttribute('title', lic);
          metaRow.appendChild(lb);
        }
        if (inst && typeof inst.vram_gb === 'number') metaRow.appendChild(wfEl('span', 'wfw-badge', 'VRAM ' + wfGb(inst.vram_gb)));
        if (e.status === 'unverified') { const uv = wfEl('span', 'wfw-badge wfw-unverified', (typeof UNVERIFIED_BADGE === 'string' ? UNVERIFIED_BADGE : 'unverified')); uv.setAttribute('title', 'This workflow has not finished a run through Phoenix yet. Choosing it works normally; it may need a small fix.'); metaRow.appendChild(uv); }   // LC2d (decision 1)
        meta.appendChild(metaRow);

        // 2 · description
        if (e.description) line(meta, e.description, 'wfw-desc');
        // LC2f (D3): a video workflow says which ComfyUI it runs on and why (only with two ComfyUI endpoints; the route answers two:false otherwise)
        if (stage === 'video') {
          const instEl = wfEl('div', 'wfw-note wfw-instance', ''); instEl.hidden = true; meta.appendChild(instEl);
          const sugEl = wfEl('div', 'wfw-note wfw-instance-suggest', ''); sugEl.hidden = true; meta.appendChild(sugEl);   // LC2f r2: a different fresh pick is a separate line, the first line is always the stored target
          wfGetJSON('/workflows/instance-probe?id=' + enc).then(function (ip) { if (!stale() && ip && ip.two && ip.line) { instEl.textContent = ip.line; instEl.hidden = false; if (ip.suggest && ip.suggest.line) { sugEl.textContent = ip.suggest.line; sugEl.hidden = false; } } }).catch(function () {});
        }

        // 4 · what it needs
        const needSec = section('What it needs');
        if (stage === 'voice' && !inst) {
          line(needSec, 'Ships with Phoenix — nothing to install.');
        } else {
          const offline = !!(st && st.kind === 'offline');
          const stateWord = function (missing) { return offline ? 'not checked (ComfyUI offline)' : (missing ? 'missing' : 'ready'); };
          const seenRepos = {};
          const nodeList = [];
          if (inst && Array.isArray(inst.custom_nodes) && inst.custom_nodes.length) {
            inst.custom_nodes.forEach(function (n) {
              if (!n || !n.git) return;
              const nm = wfRepoName(n.git);
              let rec = seenRepos[nm];
              if (!rec) { rec = seenRepos[nm] = { name: nm, types: [] }; nodeList.push(rec); }
              if (n.classType) rec.types.push(n.classType);
            });
          } else if (e.deps && Array.isArray(e.deps.custom_nodes)) {
            e.deps.custom_nodes.forEach(function (t) { nodeList.push({ name: String(t), types: [String(t)] }); });
          }
          const modelList = (inst && Array.isArray(inst.models) && inst.models.length)
            ? inst.models.map(function (m) { return { name: m.filename, size: m.size_gb }; })
            : ((e.deps && Array.isArray(e.deps.models)) ? e.deps.models.map(function (m) { return { name: String(m), size: null }; }) : []);
          if (nodeList.length) {
            needSec.appendChild(wfEl('div', 'wfw-sub', 'Custom nodes'));
            nodeList.forEach(function (n) {
              const miss = n.types.some(function (t) { return missingNodes.indexOf(t) >= 0; });
              line(needSec, n.name + ' · ' + stateWord(miss));
            });
          }
          if (modelList.length) {
            needSec.appendChild(wfEl('div', 'wfw-sub', 'Models'));
            modelList.forEach(function (m) {
              line(needSec, m.name + (typeof m.size === 'number' ? ' · ' + wfGb(m.size) : '') + ' · ' + stateWord(missingModels.indexOf(m.name) >= 0));
            });
          }
          if (inst && (!Array.isArray(inst.models) || inst.models.length === 0) && Array.isArray(inst.custom_nodes) && inst.custom_nodes.length) {
            line(needSec, 'Model weights download on first run.');
          }
          if (!nodeList.length && !modelList.length && !(inst && Array.isArray(inst.custom_nodes) && inst.custom_nodes.length)) line(needSec, 'No custom nodes or model files declared.');
          line(needSec, 'Disk ' + wfGb(e.disk_gb) + ' · VRAM ' + wfGb(inst ? inst.vram_gb : null));
        }

        const faqLink = function (parent) {
          if (typeof e.faq_url !== 'string' || e.faq_url.indexOf('https://') !== 0) return;
          const a = document.createElement('a');
          a.textContent = 'FAQ';
          a.setAttribute('href', e.faq_url);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener');
          parent.appendChild(a);
        };
        let failHost = null;   // where the Copy log / FAQ / Open issue row of a failed install goes (On your ComfyUI)

        // 6 · on your ComfyUI (live; hidden for voice)
        if (stage !== 'voice') {
          const envSec = section('On your ComfyUI');
          const envBody = wfEl('div', 'wfw-line', 'checking…');
          envSec.appendChild(envBody);
          const envRow = wfEl('div', 'wfw-envrow');
          const recheck = wfEl('button', 'btn btn-secondary btn-sm', 'Check again');
          recheck.type = 'button';
          recheck.setAttribute('data-wf-recheck', '');
          recheck.addEventListener('click', function () { w.refocus = true; refreshWorkflowWindow(); });
          envRow.appendChild(recheck);
          faqLink(envRow);
          envSec.appendChild(envRow);
          failHost = wfEl('div', 'wfw-envfail');
          envSec.appendChild(failHost);
          const instance = e.instance || 'trellis';
          // Amendment 1 (5): no call for an instance neither profiled nor configured — say so instead of showing another base's address
          // <lt2> always ask the server (it knows TESTED_PROFILES and comfyInstall); the 400 body carries the unknown-instance error
          wfGetJSON('/workflows/env?instance=' + encodeURIComponent(instance)).then(function (env) {
            if (stale()) return;
            envBody.textContent = '';
            if (!env) { line(envBody, 'Could not ask ComfyUI.'); return; }
            if (env.error && env.reachable == null && /unknown instance/.test(String(env.error))) { line(envBody, 'unknown instance ' + instance + ' — add it under comfyInstall in the config'); return; }
            if (env.reachable == null) { line(envBody, 'Could not ask ComfyUI.'); return; }   // <lt2-a1> any other error body
            if (!env || env.reachable !== true) {
              line(envBody, 'ComfyUI not reachable at ' + ((env && env.base) || depData.base || '?'));
              return;
            }
            const addLine = function (label, value, testedValue) {
              const n = wfEl('div', 'wfw-line', label + ' ' + (value == null ? '—' : value));
              if (testedValue != null && value != null && wfDiffers(testedValue, value)) {
                n.appendChild(wfEl('span', 'wfw-differs', ' — differs (tested with ' + testedValue + ')'));
              }
              envBody.appendChild(n);
            };
            addLine('ComfyUI', env.comfyui, null);
            addLine('Python', env.python, tested && tested.python);
            addLine('torch', env.torch, tested && tested.torch);
            addLine('CUDA', env.cuda, tested && tested.cuda);
            addLine('GPU', env.gpu, null);
            addLine('VRAM', env.vram_gb != null ? wfGb(env.vram_gb) : null, null);
          });
        }

        // 5 · tested with (hidden for voice / no profile)
        const tested = (stage !== 'voice' && e.tested && typeof e.tested === 'object') ? e.tested : null;
        if (tested) {
          const tSec = section('Tested with');
          line(tSec, 'ComfyUI ' + (tested.comfyui || '?'));
          line(tSec, 'Python ' + (tested.python || '?') + ' · torch ' + (tested.torch || '?') + ' · CUDA ' + (tested.cuda || '?'));
          const wheels = tested.wheels && typeof tested.wheels === 'object' ? Object.keys(tested.wheels).map(function (k) { return k + ' ' + tested.wheels[k]; }) : [];
          if (wheels.length) line(tSec, 'Wheels: ' + wheels.join(' · '));
          line(tSec, 'These are the versions Phoenix has run and knows work — not minimums.', 'wfw-note');
        }

        // 7 · FAQ
        if (stage === 'voice' && typeof e.faq_url === 'string' && e.faq_url.indexOf('https://') === 0) { const fSec = section(''); faqLink(fSec); }
        // 7b · Advanced (v1.10 ADV) - collapsed; one store, two views (the palette editor shows the same overrides). Never for voice engines;
        // hidden by itself when the workflow declares no params (SAM3 Isolate).
        if (stage !== 'voice') { const advanced = wfAdvanced(id, e.label || id, stale, function (det) { if (w.advanced && !w.advScrolled) { w.advScrolled = true; if (det.scrollIntoView) det.scrollIntoView({ block: 'nearest' }); } }); if (w.advanced) advanced.open = true; view.appendChild(advanced); }

        // 3 · example
        const exSec = section('Example');
        const exBox = wfEl('div', 'wfw-example');
        exSec.appendChild(exBox);
        const showNoExample = function () { exBox.textContent = ''; exBox.appendChild(wfEl('div', 'wfw-noex', 'No example yet')); };
        const showImage = function (url) {
          exBox.textContent = '';
          const img = document.createElement('img');
          img.setAttribute('src', url);
          img.setAttribute('alt', (e.label || id) + ' example');
          img.addEventListener('error', showNoExample);
          exBox.appendChild(img);
        };
        if (e.example && e.example.url) {
          if (e.example.kind === 'mesh') {
            const mv = document.createElement('model-viewer');
            mv.setAttribute('src', e.example.url);
            mv.setAttribute('alt', (e.label || id) + ' example');
            mv.setAttribute('camera-controls', '');
            mv.setAttribute('auto-rotate', '');
            mv.setAttribute('interaction-prompt', 'none');
            exBox.appendChild(mv);
          } else {
            showImage(e.example.url);
          }
        } else {
          showNoExample();
          if (!e.builtin) {   // a custom workflow shows its own newest output
            wfGetJSON('/images?kind=image,i2i').then(function (j) {
              if (stale() || !j || !Array.isArray(j.items)) return;
              const it = j.items.find(function (r) { return r && r.workflow === id && r.exists && r.url; });
              if (it) showImage(it.url);
            });
          }
        }

        // compare: the other workflows of the same stage open their page here (same place to go Back to, same opener)
        const others = Object.keys(wfData.workflows).filter(function (oid) { return oid !== id && wfData.workflows[oid] && wfData.workflows[oid].stage === stage; });
        if (others.length) {
          const cmp = wfEl('div', 'wfw-compare');
          cmp.appendChild(wfEl('span', 'wfw-note', 'Compare with'));
          others.forEach(function (oid) {
            const cb = wfEl('button', 'btn btn-ghost btn-sm', wfData.workflows[oid].label || oid);
            cb.type = 'button';
            cb.setAttribute('data-wf-compare', oid);
            cb.addEventListener('click', function () { wfShowPage(oid, w.opener, w.from, null); });
            cmp.appendChild(cb);
          });
          exSec.appendChild(cmp);
        }

        // 8 · actions. Install = the old row-level Acquire flow (plan, licence, progress, cancel, fail actions), moved here unchanged.
        const instSlot = wfEl('div', 'wfw-install');
        view.appendChild(instSlot);
        const clearInstallError = function () { const old = instSlot.querySelector('.wfw-err'); if (old && old.parentNode) old.parentNode.removeChild(old); };
        const showInstallError = function (msg) {   // an inline error line on the page (no alert)
          clearInstallError();
          const n = wfEl('div', 'wfw-note wfw-err', msg);
          n.setAttribute('role', 'alert');
          instSlot.appendChild(n);
        };
        const reasons = wfEl('div', 'wfw-reasons');
        const actions = wfEl('div', 'wfw-actions');
        const uninstSlot = wfEl('div', 'wfw-uninst');

        if (workflowHome(stage) === 'create') {
          if (isActive) actions.appendChild(wfEl('span', 'wf-create-note', '● Active in Create'));
          const link = wfEl('button', 'btn btn-ghost btn-sm', 'Switch it in Create ▸ Inspector'); link.type = 'button'; link.setAttribute('data-open-create', stage);
          link.addEventListener('click', function (ev) { ev.stopPropagation(); closeWorkflowWindow(true); window.__openInCreate(stage); }); actions.appendChild(link);
        } else {
        const selectBtn = wfBtn('Select');
        let selectReason = null;
        if (isActive) selectReason = 'Already the active ' + (WF_STAGE_NAMES[stage] || stage) + ' workflow.';
        else if (stage === 'voice' && e.install && e.blocked) selectReason = 'Not available: ' + (e.blockedReason || 'blocked') + '.';
        else if (stage === 'voice' && e.install && voiceState !== 'installed') selectReason = 'Not installed — install it first.';
        else if (st && st.kind === 'missing') selectReason = 'Not ready — install it first (missing: ' + (st.missing.join(', ') || 'deps') + ').';
        if (selectReason) { selectBtn.disabled = true; selectBtn.setAttribute('title', selectReason); line(reasons, 'Select: ' + selectReason, 'wfw-note'); }
        selectBtn.addEventListener('click', async function () {
          selectBtn.disabled = true;
          const r = await activateWorkflow(stage, id);
          if (wfWin === w && !r.ok) { w.notice = r.error || 'Could not select this workflow.'; refreshWorkflowWindow(); }
        });
        actions.appendChild(selectBtn);

        }

        const installBtn = wfBtn('Install');
        let installReason = null;
        const target = planData && planData.target;
        if (!inst) installReason = stage === 'voice' ? 'Ships with Phoenix.' : 'No install recipe for this workflow.';
        else if (stage === 'voice' && e.blocked) installReason = 'Not available: ' + (e.blockedReason || 'blocked') + '.';
        else if (stage === 'voice' ? voiceState === 'installed' : st.kind === 'ready') installReason = 'Already installed.';
        else if (!planData || !target || target.kind === 'manual') installReason = (target && target.reason) || 'No install target configured.';
        else if (st && st.kind === 'offline') installReason = 'ComfyUI is offline — start it first.';
        if (installReason && !installing) { installBtn.disabled = true; installBtn.setAttribute('title', installReason); line(reasons, 'Install: ' + installReason, 'wfw-note'); }
        if (inst && target && target.kind !== 'manual' && (!installReason || installing)) {
          line(instSlot, 'Install target: ' + (target.kind === 'supervisor' ? 'remote' : 'local ComfyUI'), 'wfw-note');
          const warnings = (planData.preflight && Array.isArray(planData.preflight.warnings)) ? planData.preflight.warnings : [];
          if (warnings.length) { const ws = line(instSlot, '⚠ ' + warnings.join(' · '), 'wfw-note'); ws.style.color = '#c98a2b'; ws.setAttribute('title', warnings.join(' · ')); }
        }
        // FIX #2 progress/cancel UI — shared by the Install click and the re-attach below (the Library row rebuilds on every SSE notice; the
        // registry entry under window.__acqRows[id] survives and keeps the running jobId).
        function attachAcqUI(jobId) {
          window.__acqRows = window.__acqRows || {};
          installBtn.style.display = 'none';
          const lineEl = wfEl('div', 'wfw-progress', 'running…');
          instSlot.appendChild(lineEl);
          const cancelBtn = wfBtn('✕ Cancel');
          cancelBtn.setAttribute('title', 'Stop this download');
          cancelBtn.addEventListener('click', async function () {
            cancelBtn.disabled = true; cancelBtn.textContent = 'Cancelling…';
            try {
              await fetch('/workflows/acquire/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: jobId }) });
            } catch (_) { /* the terminal SSE event still cleans up */ }
          });
          instSlot.appendChild(cancelBtn);
          window.__acqRows[id] = { lineEl: lineEl, cancelBtn: cancelBtn, acqBtn: installBtn, jobId: jobId };
        }
        if (installing) attachAcqUI(window.__acqRows[id].jobId);
        if (w.failEvt && w.failEvt.id === id) {
          try { const failRow = acquireFailActions.render(w.failEvt); if (failRow) (failHost || instSlot).appendChild(failRow); } catch (_) {}
        }
        const startInstall = async function () {
          installBtn.disabled = true;
          installBtn.textContent = 'Installing…';
          const failed = function (msg) { installBtn.textContent = 'Install'; installBtn.disabled = false; showInstallError(msg); };
          try {
            const r = await fetch('/workflows/acquire', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) });
            const data = await r.json();
            if (!r.ok) { failed(data.error || 'Could not start acquire.'); return; }
            clearInstallError();
            w.failEvt = null;
            attachAcqUI(data.id);   // live progress line + Cancel, fed by `acquire-progress` SSE events
            loadWorkflowsTab();     // the row badge now says "installing…"
          } catch (err) {
            failed('Network error: ' + err.message);
          }
        };
        installBtn.addEventListener('click', function () {
          clearInstallError();
          const isNC = lic.toLowerCase() === 'non-commercial';
          let acked = [];
          if (isNC) { try { acked = JSON.parse(localStorage.getItem('phx-nc-acquire-ack') || '[]'); } catch (_) {} }
          if (isNC && !acked.includes(id)) {   // asked inline (Continue / Cancel), once per workflow
            libInlineRow({
              anchor: actions, trigger: installBtn, kind: 'confirm', action: 'Continue',
              label: '"' + e.label + '" is licensed ' + lic + ' (non-commercial). Phoenix ships zero weights — this downloads it to YOUR machine, and your own use governs its licence. Continue?',
              onDone: function () {
                acked.push(id);
                try { localStorage.setItem('phx-nc-acquire-ack', JSON.stringify(acked)); } catch (_) {}
                startInstall();
              },
            });
            return;
          }
          startInstall();
        });
        actions.appendChild(installBtn);

        // Uninstall: plan first (what moves / what stays / what Phoenix cannot do), then one explicit confirm. Nothing is ever deleted.
        const uninstBtn = wfBtn('Uninstall');
        const uReason = (!uPlan || uPlan.ok === false) ? ((uPlan && uPlan.reason) || 'Could not work out an uninstall plan.') : null;
        if (uReason) { uninstBtn.disabled = true; uninstBtn.setAttribute('title', uReason); line(reasons, 'Uninstall: ' + uReason, 'wfw-note'); }
        function renderUninstallPlan(plan) {
          uninstSlot.textContent = '';
          if (!plan || plan.ok === false) { line(uninstSlot, (plan && plan.reason) || 'Could not work out an uninstall plan.', 'wfw-note'); return; }
          const listBlock = function (title, items, fmt) {
            if (!items || !items.length) return;
            uninstSlot.appendChild(wfEl('div', 'wfw-sub', title));
            items.forEach(function (it) { line(uninstSlot, fmt(it)); });
          };
          listBlock('Will be moved to the trash folder', plan.remove, function (it) { return it.path + (typeof it.size_gb === 'number' ? ' · ' + wfGb(it.size_gb) : ''); });
          listBlock('Stays (still used)', plan.keep, function (it) { return it.path + ' — ' + it.why; });
          listBlock('Phoenix cannot do this for you', plan.manual, function (it) { return it.what + ' — ' + it.why; });
          if (plan.warning) line(uninstSlot, plan.warning, 'wfw-note');   // once, above the move button
          if (plan.remove && plan.remove.length) {
            const total = plan.remove.reduce(function (s, it) { return s + (typeof it.size_gb === 'number' ? it.size_gb : 0); }, 0);
            line(uninstSlot, 'Total about ' + wfGb(total) + ' (folders not counted).', 'wfw-note');
            const n = plan.remove.length;
            const goBtn = wfBtn('Move ' + n + (n === 1 ? ' item' : ' items') + ' to the trash folder');
            goBtn.addEventListener('click', async function () {
              goBtn.disabled = true;
              let data = null, ok = false;
              try {
                const r = await fetch('/workflows/uninstall', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, confirm: true }) });
                ok = r.ok;
                data = await r.json();
              } catch (err) { data = { error: (err && err.message) || String(err) }; }
              w.uninstResult = { ok: ok, data: data };
              loadWorkflowsTab();
              refreshWorkflowWindow();   // refresh deps in the window; the result list below survives the rebuild
            });
            if (plan.unsafe) {   // <lt2> the server refuses the whole run on an unsafe path - say so instead of offering the move
              goBtn.disabled = true;
              const why = "Phoenix will not move anything: the workflow's manifest has an unsafe path.";
              goBtn.title = why;
              uninstSlot.appendChild(goBtn);
              line(uninstSlot, why, 'wfw-note');
              return;
            }
            uninstSlot.appendChild(goBtn);
          } else {
            line(uninstSlot, 'Nothing to move.', 'wfw-note');
            if (plan.unsafe) line(uninstSlot, "Phoenix will not move anything: the workflow's manifest has an unsafe path.", 'wfw-note');   // <lt2-a1> the note does not depend on remove.length
          }
        }
        function renderUninstallResult(res) {
          uninstSlot.textContent = '';
          const data = res.data || {};
          if (!res.ok) line(uninstSlot, 'Uninstall stopped: ' + (data.error || 'unknown error'), 'wfw-note');
          const moved = Array.isArray(data.moved) ? data.moved : [];
          if (moved.length) {
            uninstSlot.appendChild(wfEl('div', 'wfw-sub', 'Moved'));
            moved.forEach(function (m) { line(uninstSlot, m.from + ' → ' + m.to); });
          }
          if (data.trash) line(uninstSlot, 'Trash folder: ' + data.trash + ' — delete it there to free the space.', 'wfw-note');
        }
        uninstBtn.addEventListener('click', async function () {
          w.uninstResult = null;
          renderUninstallPlan(await wfGetJSON('/workflows/uninstall-plan?id=' + enc));
        });
        actions.appendChild(uninstBtn);
        if (w.uninstResult) renderUninstallResult(w.uninstResult);

        if (!e.builtin) {
          const editBtn = wfBtn('Edit');
          editBtn.addEventListener('click', function () { closeWorkflowWindow(true); openWorkflowEditor(id); });
          actions.appendChild(editBtn);
        }
        if (w.notice) { line(reasons, w.notice, 'wfw-note'); w.notice = null; }
        view.appendChild(actions);
        view.appendChild(reasons);
        view.appendChild(uninstSlot);

        const hadFocus = !!(w.root.contains && w.root.contains(document.activeElement));
        w.root.textContent = '';
        w.root.appendChild(view);
        if (!w.rendered) { w.rendered = true; titleEl.focus(); }   // a page that was just opened: the focus goes to its heading
        else if (hadFocus) { const rc = w.refocus ? view.querySelector('[data-wf-recheck]') : null; w.refocus = false; (rc || titleEl).focus(); }   // a rebuild must not drop the keyboard
      }
      // </b2r-window>

      async function openWorkflowEditor(editId) {
        const isEdit = !!editId;
        openModal(isEdit ? ('Edit workflow: ' + editId) : 'Add workflow');
        toolBody.innerHTML = '';

        function makeRow(labelText, inputEl) {
          const row = document.createElement('div'); row.className = 'set-row';
          const lbl = document.createElement('label'); lbl.className = 'set-label'; lbl.textContent = labelText;
          row.appendChild(lbl); row.appendChild(inputEl); return row;
        }

        var uploadedJson = null;
        var stage = 'image';
        var nodeChoices = [];
        var slotControls = {};
        const nodeMapContainer = document.createElement('div');
        const statusEl = document.createElement('span'); statusEl.className = 'set-status';

        const idInput = document.createElement('input'); idInput.type = 'text';
        idInput.placeholder = 'workflow_id (lowercase a-z 0-9 _)';
        const labelInput = document.createElement('input'); labelInput.type = 'text';
        labelInput.placeholder = 'Display label';

        var stageControl;
        if (isEdit) {
          stageControl = document.createElement('input'); stageControl.type = 'text'; stageControl.disabled = true;
        } else {
          stageControl = document.createElement('select');
          [['image', 'Image'], ['mesh', '3D / Mesh'], ['i2i', 'i2i / Edit'], ['video', 'Video (local)']].forEach(function (o) {
            const op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; stageControl.appendChild(op);
          });
          stageControl.addEventListener('change', function () { stage = stageControl.value; rebuildNodeMap({}); showVideoBox(); refreshInstance(); });   // LC2f r5: leaving Video hides the "Runs on" box
        }

        function slotsFor(s) {
          if (s === 'video') return ['image', 'positive', 'negative', 'length', 'width', 'height', 'seed', 'output'];
          if (s === 'mesh') return ['image', 'seed', 'target_face_num', 'output_prefix', 'output'];
          if (s === 'i2i')  return ['input_image', 'prompt', 'cfg', 'seed', 'output'];
          return ['positive', 'negative', 'cfg', 'steps', 'seed', 'output'];
        }

        function rebuildNodeMap(prefill) {
          nodeMapContainer.innerHTML = '';
          slotControls = {};
          slotsFor(stage).forEach(function (slot) {
            const sel = document.createElement('select');
            const none = document.createElement('option'); none.value = ''; none.textContent = '- none -'; sel.appendChild(none);
            nodeChoices.forEach(function (nc) {
              const op = document.createElement('option'); op.value = nc.id;
              op.textContent = nc.id + ' - ' + nc.class_type + (nc.title ? ' - ' + nc.title : '');
              sel.appendChild(op);
            });
            const fld = document.createElement('input'); fld.type = 'text'; fld.placeholder = 'field (optional)';
            fld.style.marginLeft = '4px'; fld.style.width = '120px';
            if (prefill && prefill[slot] != null) {
              const v = prefill[slot];
              if (v && typeof v === 'object') { sel.value = String(v.node); fld.value = v.field || ''; }
              else { sel.value = String(v); }
            }
            const wrap = document.createElement('div'); wrap.style.display = 'flex'; wrap.style.alignItems = 'center';
            wrap.appendChild(sel); wrap.appendChild(fld);
            slotControls[slot] = { select: sel, field: fld };
            nodeMapContainer.appendChild(makeRow(slot, wrap));
          });
        }

        function readNodes() {
          const nodes = {};
          Object.keys(slotControls).forEach(function (slot) {
            const c = slotControls[slot]; const nid = c.select.value; if (!nid) return;
            const f = c.field.value.trim(); nodes[slot] = f ? { node: nid, field: f } : nid;
          });
          return nodes;
        }

        // AW1: Video settings (stage "video" only) - the frame rule / fps / sizes / limits the local video backend reads from the entry.
        const videoBox = document.createElement('div'); videoBox.style.display = 'none';
        const vIn = {}, vNote = {};
        var videoExpect = null;   // an entry's "expect" hint has no field here; it travels through an edit unchanged
        const VSRC = { graph: 'from the workflow', comfyui: 'from ComfyUI', 'default': 'default — check this' };
        function vInput(key, type, width) {
          const i = document.createElement('input'); i.type = type || 'number'; if (width) i.style.width = width + 'px'; vIn[key] = i; return i;
        }
        function vRow(label, els, noteKey) {
          const wrap = document.createElement('div'); wrap.style.display = 'flex'; wrap.style.alignItems = 'center'; wrap.style.flexWrap = 'wrap';
          els.forEach(function (e) { wrap.appendChild(e); });
          const n = document.createElement('span'); n.className = 'wf-vnote'; n.style.fontSize = '11px'; n.style.color = 'var(--muted)'; n.style.marginLeft = '8px';
          vNote[noteKey] = n; wrap.appendChild(n);
          videoBox.appendChild(makeRow(label, wrap));
        }
        function vTimes() { const t = document.createElement('span'); t.textContent = ' × '; return t; }
        const vMaxInfo = document.createElement('span'); vMaxInfo.className = 'wf-vmaxinfo'; vMaxInfo.style.fontSize = '11px'; vMaxInfo.style.marginLeft = '8px';
        const vLtxNote = document.createElement('span'); vLtxNote.className = 'wf-vltxnote'; vLtxNote.style.fontSize = '11px'; vLtxNote.style.marginLeft = '8px'; vLtxNote.style.color = 'var(--muted)';   // LC2f (D1): grey note above 73 frames on an LTX graph
        const LTX_NOTE = 'LTX-2 tends to stand still after ~3 s (measured)', LTX_NOTE_ABOVE = 73;
        const vHdr = document.createElement('div'); vHdr.className = 'lib-cat'; vHdr.textContent = 'Video settings'; videoBox.appendChild(vHdr);
        vRow('Frames per second', [vInput('fps', 'number', 70)], 'fps');
        vRow('Frame step', [vInput('step', 'number', 70)], 'frames.step');
        vRow('Frame offset', [vInput('offset', 'number', 70)], 'frames.offset');
        vRow('Min frames', [vInput('min', 'number', 70)], 'frames.min');
        vRow('Max frames', [vInput('max', 'number', 70), vMaxInfo, vLtxNote], 'frames.max');
        vRow('Size 16:9 (w × h)', [vInput('w169', 'number', 70), vTimes(), vInput('h169', 'number', 70)], 'sizes.16:9');
        vRow('Size 9:16 (w × h)', [vInput('w916', 'number', 70), vTimes(), vInput('h916', 'number', 70)], 'sizes.9:16');
        vRow('Size 1:1 (w × h)', [vInput('w11', 'number', 70), vTimes(), vInput('h11', 'number', 70)], 'sizes.1:1');
        vRow('Timeout (minutes)', [vInput('timeoutMin', 'number', 70)], 'timeoutMin');
        vRow('Model writes sound', [vInput('audio', 'checkbox')], 'audio');
        function vNum(key) { const s = String(vIn[key].value == null ? '' : vIn[key].value).trim(); return s === '' ? null : Number(s); }
        function updateVideoMaxInfo() {
          const mx = vNum('max'), fps = vNum('fps');
          vMaxInfo.textContent = (mx != null && fps > 0 && isFinite(mx) && isFinite(fps)) ? (mx + ' frames = ' + (Math.round(mx / fps * 10) / 10) + ' s at ' + fps + ' fps') : '';
          let ltx = false; try { ltx = /"class_type"\s*:\s*"[^"]*LTX/i.test(String(uploadedJson || '')); } catch (_) { ltx = false; }
          vLtxNote.textContent = (ltx && mx != null && isFinite(mx) && mx > LTX_NOTE_ABOVE) ? LTX_NOTE : '';
        }
        ['max', 'fps'].forEach(function (k) { vIn[k].addEventListener('input', updateVideoMaxInfo); });
        function setVideo(v, from) {
          v = v || {};
          const f = v.frames || {}, s = v.sizes || {};
          function put(key, val) { vIn[key].value = (val == null) ? '' : String(val); }
          put('fps', v.fps); put('step', f.step); put('offset', f.offset); put('min', f.min); put('max', f.max);
          [['16:9', '169'], ['9:16', '916'], ['1:1', '11']].forEach(function (p) { const wh = s[p[0]]; put('w' + p[1], wh && wh[0]); put('h' + p[1], wh && wh[1]); });
          put('timeoutMin', v.timeoutMin); vIn.audio.checked = v.audio === true;
          videoExpect = (v.expect && typeof v.expect === 'object') ? v.expect : null;
          Object.keys(vNote).forEach(function (k) {
            var t = from ? (VSRC[from[k]] || '') : '';
            if (from && k === 'frames.max' && from[k] === 'default') t = 'default 5 s — raise it if your model can do more';
            vNote[k].textContent = t;
          });
          updateVideoMaxInfo();
        }
        function readVideo() {
          const sizes = {};
          [['16:9', '169'], ['9:16', '916'], ['1:1', '11']].forEach(function (p) {
            const w = vNum('w' + p[1]), h = vNum('h' + p[1]);
            if (w != null || h != null) sizes[p[0]] = [w, h];
          });
          const v = { fps: vNum('fps'), frames: { step: vNum('step'), offset: vNum('offset'), min: vNum('min'), max: vNum('max') }, sizes: sizes, audio: !!vIn.audio.checked };
          const tm = vNum('timeoutMin'); if (tm != null) v.timeoutMin = tm;
          if (videoExpect) v.expect = videoExpect;
          return v;
        }
        function showVideoBox() { videoBox.style.display = stage === 'video' ? '' : 'none'; }

        // LC2f (D3): where a video workflow runs - Phoenix measures it (every configured ComfyUI: all models there? which PyTorch?) and says so in one line; the override is under Advanced.
        // Only with TWO ComfyUI endpoints (the route answers two:false otherwise and the box stays hidden).
        const instBox = document.createElement('div'); instBox.style.display = 'none';
        const instLine = document.createElement('div'); instLine.className = 'set-hint wf-instance-line'; instBox.appendChild(instLine);
        const instAdv = document.createElement('details'); instAdv.className = 'wfw-adv';
        const instSum = document.createElement('summary'); instSum.textContent = 'Advanced'; instAdv.appendChild(instSum);
        const instSel = document.createElement('select'); instSel.className = 'wf-instance-select';
        const INST_OPTS = [
          ['auto', 'Automatic (recommended)', 'Phoenix picks the ComfyUI that has all the models and the newer PyTorch; on a tie it keeps the main one.'],
          ['main', 'Main ComfyUI', 'Always runs on the main ComfyUI (endpoints.comfyui), whatever the measurement says.'],
          ['second', 'Second ComfyUI', 'Always runs on the second ComfyUI (endpoints.comfyui_bild), whatever the measurement says.'],
        ];
        INST_OPTS.forEach(function (o) { const op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; instSel.appendChild(op); });
        const instHelp = document.createElement('div'); instHelp.className = 'set-hint wf-instance-help';
        function paintInstHelp() { const o = INST_OPTS.find(function (x) { return x[0] === instSel.value; }); instHelp.textContent = o ? o[2] : ''; }
        instAdv.appendChild(instSel); instAdv.appendChild(instHelp); instBox.appendChild(instAdv); paintInstHelp();
        let instSeq = 0;   // LC2f r5: answers (and failures) of an older probe are ignored - the newest request decides what the box shows
        async function refreshInstance() {
          const mySeq = ++instSeq;
          if (stage !== 'video') { instBox.style.display = 'none'; return; }
          try {
            const body = isEdit ? { id: editId, deps: readDeps() } : { deps: readDeps() };   // LC2f r2: edit mode probes with the fields as they are NOW, like Save will store
            body.instance_mode = instSel.value;
            const r = await fetch('/workflows/instance-probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const d = await r.json();
            if (mySeq !== instSeq) return;
            if (r.ok && d && d.two) { instLine.textContent = d.line || ''; instBox.style.display = ''; } else instBox.style.display = 'none';
          } catch (_) { if (mySeq === instSeq) instBox.style.display = 'none'; }
        }
        instSel.addEventListener('change', function () { paintInstHelp(); refreshInstance(); });

        const customNodesEl = document.createElement('textarea'); customNodesEl.rows = 2; customNodesEl.className = 'pal-textarea'; customNodesEl.placeholder = 'custom node class names, one per line';
        const modelsEl = document.createElement('textarea'); modelsEl.rows = 2; modelsEl.className = 'pal-textarea'; modelsEl.placeholder = 'model filenames, one per line';
        function readDeps() {
          function lines(t) { return t.split('\n').map(function (x) { return x.trim(); }).filter(Boolean); }
          return { custom_nodes: lines(customNodesEl.value), models: lines(modelsEl.value) };
        }

        toolBody.appendChild(makeRow('Stage', stageControl));

        if (!isEdit) {
          const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.accept = '.json,application/json';
          const fileName = document.createElement('span'); fileName.style.marginLeft = '6px'; fileName.style.fontSize = '12px'; fileName.style.color = 'var(--muted)';
          fileInput.addEventListener('change', function () {
            const f = fileInput.files && fileInput.files[0]; if (!f) return;
            const reader = new FileReader();
            reader.onload = function () { uploadedJson = String(reader.result); fileName.textContent = f.name; statusEl.textContent = 'File loaded - click "Analyze with Phoenix".'; };
            reader.readAsText(f);
          });
          const fileWrap = document.createElement('div'); fileWrap.style.display = 'flex'; fileWrap.style.alignItems = 'center';
          fileWrap.appendChild(fileInput); fileWrap.appendChild(fileName);
          toolBody.appendChild(makeRow('Workflow JSON (API format)', fileWrap));

          const analyzeBtn = document.createElement('button'); analyzeBtn.className = 'modal-btn'; analyzeBtn.style.fontSize = '12px'; analyzeBtn.style.padding = '5px 10px';
          analyzeBtn.textContent = 'Analyze with Phoenix';
          analyzeBtn.style.marginBottom = '8px';
          analyzeBtn.addEventListener('click', async function () {
            if (!uploadedJson) { statusEl.textContent = 'Upload a workflow JSON first.'; return; }
            stage = stageControl.value;
            // LC2f (AW-L1): the house busy pattern - disabled button, label "Analyzing… m:ss" ticking once a second; LC2g (L9): ONE timer, in the button only (no second line)
            const t0 = Date.now();
            const paintBusy = function () { const sec = Math.floor((Date.now() - t0) / 1000); const t = 'Analyzing… ' + Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); analyzeBtn.textContent = t; };
            analyzeBtn.disabled = true; statusEl.textContent = 'Analyzing... (Phoenix)'; paintBusy();
            const busyTimer = setInterval(paintBusy, 1000);
            try {
              const r = await fetch('/workflows/infer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: stage, json: uploadedJson }) });
              const d = await r.json();
              if (r.ok) {
                nodeChoices = d.nodeChoices || [];
                rebuildNodeMap(d.nodes || {});
                if (d.label && !labelInput.value) labelInput.value = d.label;
                if (!idInput.value && d.label) idInput.value = d.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
                customNodesEl.value = ((d.deps && d.deps.custom_nodes) || []).join('\n');
                modelsEl.value = ((d.deps && d.deps.models) || []).join('\n');
                if (stage === 'video' && d.video) setVideo(d.video, d.from);
                showVideoBox(); refreshInstance();
                statusEl.textContent = 'Proposal inserted - review + save.';
              } else {
                statusEl.textContent = (d.error || 'Infer failed.');
              }
            } catch (e) { statusEl.textContent = 'Network error: ' + e.message; }
            finally { clearInterval(busyTimer); analyzeBtn.disabled = false; analyzeBtn.textContent = 'Analyze with Phoenix'; }
          });
          toolBody.appendChild(analyzeBtn);
        }

        toolBody.appendChild(makeRow('Workflow id', idInput));
        toolBody.appendChild(makeRow('Label', labelInput));

        const nmHdr = document.createElement('div'); nmHdr.className = 'lib-cat'; nmHdr.textContent = 'Node map'; toolBody.appendChild(nmHdr);
        toolBody.appendChild(nodeMapContainer);
        toolBody.appendChild(videoBox);

        const depHdr = document.createElement('div'); depHdr.className = 'lib-cat'; depHdr.textContent = 'Dependencies'; toolBody.appendChild(depHdr);
        toolBody.appendChild(makeRow('Custom nodes', customNodesEl));
        toolBody.appendChild(makeRow('Models', modelsEl));
        toolBody.appendChild(instBox);
        modelsEl.addEventListener('change', function () { refreshInstance(); }); customNodesEl.addEventListener('change', function () { refreshInstance(); });

        const actRow = document.createElement('div'); actRow.className = 'modal-actions';
        const saveBtn = document.createElement('button'); saveBtn.className = 'modal-btn'; saveBtn.textContent = 'Save'; actRow.appendChild(saveBtn);
        if (isEdit) {
          const delBtn = document.createElement('button'); delBtn.className = 'modal-btn'; delBtn.style.background = '#c0392b'; delBtn.textContent = 'Delete'; actRow.appendChild(delBtn);
          const doDelete = async function () {
            delBtn.disabled = true; statusEl.textContent = 'Deleting...';
            try {
              const r = await fetch('/workflows/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: editId }) });
              const d = await r.json();
              if (r.ok) { loadWorkflowsTab(); closeModal(); } else { statusEl.textContent = (d.error || 'Delete failed.'); delBtn.disabled = false; }
            } catch (e) { statusEl.textContent = e.message; delBtn.disabled = false; }
          };
          delBtn.addEventListener('click', function () {   // R4: asked inline under the buttons (Delete / Cancel), no native dialog
            libInlineRow({ anchor: actRow, trigger: delBtn, kind: 'confirm', action: 'Delete', danger: true, label: 'Delete custom workflow "' + editId + '"?', onDone: doDelete });
          });
        }
        actRow.appendChild(statusEl);
        toolBody.appendChild(actRow);

        saveBtn.addEventListener('click', async function () {
          const nodes = readNodes(); const deps = readDeps(); const label = labelInput.value.trim();
          const videoPart = stage === 'video' ? { video: readVideo(), instance_mode: instSel.value } : {};
          saveBtn.disabled = true; statusEl.textContent = 'Saving...';
          try {
            var r, d;
            if (isEdit) {
              r = await fetch('/workflows/custom/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ id: editId, label: label, nodes: nodes, deps: deps }, videoPart)) });
            } else {
              const idv = idInput.value.trim();
              if (!idv) { statusEl.textContent = 'Workflow id is required.'; saveBtn.disabled = false; return; }
              if (!uploadedJson) { statusEl.textContent = 'Upload + analyze a workflow first.'; saveBtn.disabled = false; return; }
              r = await fetch('/workflows/custom', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ id: idv, label: label, stage: stage, nodes: nodes, deps: deps, json: uploadedJson }, videoPart)) });
            }
            d = await r.json();
            if (r.ok) { loadWorkflowsTab(); closeModal(); } else { statusEl.textContent = (d.error || 'Save failed.'); saveBtn.disabled = false; }
          } catch (e) { statusEl.textContent = 'Network error: ' + e.message; saveBtn.disabled = false; }
        });

        if (isEdit) {
          statusEl.textContent = 'Loading...';
          try {
            const r = await fetch('/workflows/raw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: editId }) });
            const d = await r.json();
            if (r.ok) {
              uploadedJson = d.json; stage = d.entry.stage;
              stageControl.value = stage === 'mesh' ? '3D / Mesh' : (stage === 'i2i' ? 'i2i / Edit' : (stage === 'video' ? 'Video (local)' : 'Image'));
              nodeChoices = d.nodeChoices || [];
              idInput.value = editId; idInput.disabled = true;
              labelInput.value = d.entry.label || '';
              rebuildNodeMap(d.entry.nodes || {});
              if (stage === 'video') { setVideo(d.entry.video, null); instSel.value = d.entry.instance_pinned ? (d.entry.instance === 'bild' ? 'second' : 'main') : 'auto'; paintInstHelp(); }
              showVideoBox();
              customNodesEl.value = ((d.entry.deps && d.entry.deps.custom_nodes) || []).join('\n');
              modelsEl.value = ((d.entry.deps && d.entry.deps.models) || []).join('\n');
              if (stage === 'video') refreshInstance();
              statusEl.textContent = '';
            } else { statusEl.textContent = (d.error || 'Load failed.'); }
          } catch (e) { statusEl.textContent = e.message; }
        } else {
          rebuildNodeMap({});
        }
      }

      function openPaletteEditor(key, cat) {
        const isNew     = !key;
        const isBuiltin = cat && cat.builtin === true;
        openModal(isNew ? 'New category' : ('Edit: ' + key));
        toolBody.innerHTML = '';

        function makeRow(labelText, inputEl) {
          const row = document.createElement('div');
          row.className = 'set-row';
          const lbl = document.createElement('label');
          lbl.className = 'set-label';
          lbl.textContent = labelText;
          row.appendChild(lbl);
          row.appendChild(inputEl);
          return row;
        }

        // ── New category: key name + Phoenix helps affordance ──
        var nameInput = null;
        var hintEl, styleEl;
        const paramState = {}, paramRows = {};   // v1.10 ADV: per declared param { on, value, wfValue } and its redraw()

        if (isNew) {
          nameInput = document.createElement('input');
          nameInput.type = 'text';
          nameInput.placeholder = 'category_key (lowercase, a–z 0–9 _)';
          toolBody.appendChild(makeRow('Category key', nameInput));

          // Description + "Phoenix helps" button
          const descInput = document.createElement('input');
          descInput.type = 'text';
          descInput.placeholder = 'Describe this category…';

          const draftBtn = document.createElement('button');
          draftBtn.className = 'modal-btn';
          draftBtn.style.marginTop = '6px';
          draftBtn.style.fontSize = '12px';
          draftBtn.style.padding = '5px 10px';
          draftBtn.textContent = 'Phoenix helps — draft it';

          const draftStatus = document.createElement('span');
          draftStatus.className = 'set-status';

          const draftRow = document.createElement('div');
          draftRow.className = 'set-row';
          const draftLbl = document.createElement('label');
          draftLbl.className = 'set-label';
          draftLbl.textContent = 'Description (for Phoenix)';
          draftRow.appendChild(draftLbl);
          draftRow.appendChild(descInput);
          draftRow.appendChild(draftBtn);
          draftRow.appendChild(draftStatus);
          toolBody.appendChild(draftRow);

          draftBtn.addEventListener('click', async function () {
            const nm   = nameInput.value.trim();
            const desc = descInput.value.trim();
            if (!desc) { draftStatus.textContent = '⚠️ Enter a description first.'; return; }
            draftBtn.disabled = true;
            draftStatus.textContent = 'Drafting…';
            try {
              const r = await fetch('/palette/draft', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: nm, description: desc }),
              });
              const d = await r.json();
              if (r.ok) {
                if (d.hint  !== undefined) hintEl.value  = d.hint;
                if (d.style !== undefined) styleEl.value = d.style;
                // a drafted cfg / steps / faces that differs from the active workflow's value becomes this category's own value; an equal one creates none
                ['cfg', 'steps', 'target_face_num'].forEach(function (k) {
                  const s = paramState[k];
                  if (s && d[k] !== undefined && JSON.stringify(d[k]) !== JSON.stringify(s.wfValue)) { s.on = true; s.value = d[k]; if (paramRows[k]) paramRows[k](); }
                });
                draftStatus.textContent = '✅ Form prefilled — review and save.';
              } else {
                draftStatus.textContent = '⚠️ ' + (d.error || 'Draft failed.');
              }
            } catch (e) {
              draftStatus.textContent = '⚠️ Network error: ' + e.message;
            }
            draftBtn.disabled = false;
          });
        }

        // ── Fields ──
        hintEl = document.createElement('textarea');
        hintEl.rows = 2;
        hintEl.className = 'pal-textarea';
        hintEl.placeholder = 'Brief categorization hint (one sentence)';
        if (cat && cat.hint  !== undefined) hintEl.value  = cat.hint;
        toolBody.appendChild(makeRow('Hint', hintEl));

        styleEl = document.createElement('textarea');
        styleEl.rows = 3;
        styleEl.className = 'pal-textarea';
        styleEl.placeholder = 'Detailed style rules for this category';
        if (cat && cat.style !== undefined) styleEl.value = cat.style;
        toolBody.appendChild(makeRow('Style', styleEl));

        // ── The params of the ACTIVE image + mesh workflows (v1.10 ADV) - the second view of workflow-params.json ──
        // One toggle per declared param, OFF by default: off shows the workflow value greyed; on creates this category's own value (seeded
        // with the workflow value). A param the active workflow does not declare is not shown. Same entry the Advanced tags show.
        const palCtx = { samplers: undefined };   // undefined: not asked · null: ComfyUI unreachable · [names]
        Object.keys(paletteParamDefs || {}).forEach(function (k) {
          const def = paletteParamDefs[k];
          const cur = cat && cat.params && cat.params[k];
          const wfValue = cur ? (cur.workflowValue !== undefined ? cur.workflowValue : cur.value) : def.value;
          const s = paramState[k] = { on: !!(cur && cur.overridden), value: cur ? cur.value : def.value, wfValue: wfValue };
          const holder = document.createElement('span');
          const chk = document.createElement('input');
          chk.type = 'checkbox';
          chk.checked = s.on;
          chk.setAttribute('aria-label', 'Own value for this category: ' + def.label + ' — ' + def.workflowLabel);
          const chkLbl = document.createElement('label');
          chkLbl.textContent = ' Own value for this category ';
          const valBox = document.createElement('span');
          const live = def.type === 'enum' && !Array.isArray(def.options);   // sampler: the real list comes from the workflow's ComfyUI
          function draw() {
            chk.checked = s.on;
            valBox.textContent = '';
            if (s.on) {
              valBox.appendChild(advControl(def, s.value, function (v) { s.value = v; }, palCtx));
              if (live && palCtx.samplers === null) { const nt = document.createElement('div'); nt.className = 'pal-wfvalue'; nt.textContent = 'ComfyUI not reachable — sampler list unavailable'; valBox.appendChild(nt); }
            }
            else {
              const g = document.createElement('span');
              g.className = 'pal-wfvalue';
              g.textContent = advFmt(def, s.wfValue) + ' · workflow value';
              valBox.appendChild(g);
            }
          }
          chk.addEventListener('change', function () {
            s.on = chk.checked;
            if (s.on) s.value = s.wfValue;   // seeded with the current workflow value
            draw();
          });
          holder.appendChild(chk); holder.appendChild(chkLbl); holder.appendChild(valBox);
          paramRows[k] = draw;
          draw();
          toolBody.appendChild(makeRow(def.label + ' — ' + def.workflowLabel, holder));
        });
        // the sampler options: one GET per editor open (same route the Advanced section uses)
        Object.keys(paletteParamDefs || {}).filter(function (k) { const d = paletteParamDefs[k]; return d.type === 'enum' && !Array.isArray(d.options); }).slice(0, 1).forEach(function (k) {
          fetch('/workflows/samplers?id=' + encodeURIComponent(paletteParamDefs[k].workflow))
            .then(function (r) { return r.json(); })
            .then(function (j) { return (j && j.reachable && Array.isArray(j.samplers)) ? j.samplers : null; }, function () { return null; })
            .then(function (list) { palCtx.samplers = list; Object.keys(paramRows).forEach(function (kk) { paramRows[kk](); }); });
        });

        // ── Actions row ──
        const actRow  = document.createElement('div');
        actRow.className = 'modal-actions';

        const saveBtn  = document.createElement('button');
        saveBtn.className = 'modal-btn';
        saveBtn.textContent = 'Save';
        actRow.appendChild(saveBtn);

        if (isBuiltin) {
          const resetBtn = document.createElement('button');
          resetBtn.className = 'modal-btn';
          resetBtn.style.background = 'var(--muted)';
          resetBtn.textContent = 'Reset to default';
          actRow.appendChild(resetBtn);

          resetBtn.addEventListener('click', async function () {
            if (!confirm('Reset "' + key + '" to its default style + params?')) return;
            resetBtn.disabled = true;
            statusEl.textContent = 'Resetting…';
            try {
              const r = await fetch('/palette/reset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: key }),
              });
              const d = await r.json();
              if (r.ok) {
                if (d.paramDefs) paletteParamDefs = d.paramDefs;
                loadPaletteTab();
                const freshCat = d.categories && d.categories[key];
                openPaletteEditor(key, freshCat || cat);
              } else {
                statusEl.textContent = '⚠️ ' + (d.error || 'Reset failed.');
                resetBtn.disabled = false;
              }
            } catch (e) {
              statusEl.textContent = '⚠️ Network error: ' + e.message;
              resetBtn.disabled = false;
            }
          });
        }

        if (!isNew && !isBuiltin) {
          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'modal-btn';
          deleteBtn.style.background = '#c0392b';
          deleteBtn.textContent = 'Delete';
          actRow.appendChild(deleteBtn);

          deleteBtn.addEventListener('click', async function () {
            if (!confirm('Delete category "' + key + '"?')) return;
            deleteBtn.disabled = true;
            statusEl.textContent = 'Deleting…';
            try {
              const palRes  = await fetch('/palette');
              const palData = await palRes.json();
              const cats    = palData.categories || {};
              delete cats[key];
              const r = await fetch('/palette', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ categories: cats }),
              });
              const d = await r.json();
              if (r.ok) {
                loadPaletteTab();
                closeModal();
              } else {
                statusEl.textContent = '⚠️ ' + (d.error || 'Delete failed.');
                deleteBtn.disabled = false;
              }
            } catch (e) {
              statusEl.textContent = '⚠️ Network error: ' + e.message;
              deleteBtn.disabled = false;
            }
          });
        }

        const statusEl = document.createElement('span');
        statusEl.className = 'set-status';
        actRow.appendChild(statusEl);
        toolBody.appendChild(actRow);

        // ── Save handler ──
        saveBtn.addEventListener('click', async function () {
          saveBtn.disabled = true;
          statusEl.textContent = 'Saving…';
          try {
            const palRes  = await fetch('/palette');
            const palData = await palRes.json();
            const cats    = palData.categories || {};
            const thatKey = isNew ? (nameInput ? nameInput.value.trim() : '') : key;
            if (!thatKey) {
              statusEl.textContent = '⚠️ Category key is required.';
              saveBtn.disabled = false;
              return;
            }
            const palParams = {};
            Object.keys(paramState).forEach(function (k) {
              const s = paramState[k];
              palParams[k] = s.on ? { override: true, value: s.value } : { override: false };
            });
            cats[thatKey] = {
              hint:   hintEl.value,
              style:  styleEl.value,
              params: palParams,
            };
            const r = await fetch('/palette', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ categories: cats }),
            });
            const data = await r.json();
            if (r.ok) {
              statusEl.textContent = '✅ Saved.';
              loadPaletteTab();
              closeModal();
            } else {
              statusEl.textContent = '⚠️ ' + (data.error || 'Save failed.') + (data.field ? ' (field: ' + data.field + ')' : '');
            }
          } catch (e) {
            statusEl.textContent = '⚠️ Network error: ' + e.message;
          }
          saveBtn.disabled = false;
        });
      }

