      // <create-pure>
      const CREATE_STAGES = [{ id: 'prompt', n: 1, label: 'Prompt' }, { id: 'image', n: 2, label: 'Image' }, { id: 'mesh', n: 3, label: 'Mesh' }, { id: 'scene', n: 4, label: 'Scene' }];
      const GATE_NEXT = { prompt: 'approve-prompt', image: 'make-3d', mesh: 'scene' };
      function stageOfAction(action) { if (action === 'generate_image' || action === 'generate_from_refs') return 'image'; if (action === 'image_to_3d') return 'mesh'; if (action === 'import_asset') return 'scene'; return null; }
      function pipelineView(s) {
        const out = [];
        CREATE_STAGES.forEach(function (e) {
          const state = s.running === e.id ? 'running' : (s.have || {})[e.id] ? 'done' : 'empty';
          const sub = e.id === 'scene' ? 'Blender' : e.id === 'prompt' ? '' : (s.engines || {})[e.id] || '';
          const line = state === 'running' ? 'working…' : state === 'done' ? (e.id === 'prompt' ? (s.approved ? '✓ approved' : '✓ ready') : '✓ ready · ' + sub) : sub || '—';
          const item = { kind: 'stage', stage: e.id, n: e.n, label: e.n + ' · ' + e.label, state: state, current: s.current === e.id, line: line };
          if (e.id === 'scene') item.dot = s.blender || 'unknown';
          out.push(item);
          if (GATE_NEXT[e.id] && (s.gates || {})[e.id] === true) {
            const waiting = s.awaiting === e.id;
            out.push({ kind: 'gate', gate: e.id, label: 'Gate · your OK', waiting: waiting, line: waiting ? ({ prompt: 'Prompt → Image', image: 'Image → Mesh', mesh: 'Mesh → Scene' })[e.id] : '', approve: waiting ? GATE_NEXT[e.id] : null });
          }
        });
        return out;
      }
      function engineOptions(stage, wfData, depData) {
        if (!wfData || !wfData.workflows) return [];
        return Object.keys(wfData.workflows).filter(function (id) { return wfData.workflows[id].stage === stage; }).map(function (id) {
          const e = wfData.workflows[id];
          const disabled = !!(depData && depData.reachable === true && depData.deps && depData.deps[id] && depData.deps[id].ready === false);
          return { id: id, label: (e.label || id) + (disabled ? ' · not installed' : ''), disabled: disabled, active: !!(wfData.active && wfData.active[stage] === id) };
        });
      }
      function editKinds(wfData, depData) {
        const wfs = (wfData && wfData.workflows) || {}, opts = engineOptions('i2i', wfData, depData);
        const active = opts.find(function (o) { return o.active; });
        const out = { active: active ? wfs[active.id].mode || 'edit' : 'edit' };
        ['edit', 'segment'].forEach(function (mode) {
          const eligible = opts.filter(function (o) { return (wfs[o.id].mode || 'edit') === mode && !o.disabled; });
          const pick = eligible.find(function (o) { return o.active; }) || eligible[0];
          out[mode] = { id: pick ? pick.id : null, disabled: !pick, title: pick ? '' : 'No ' + (mode === 'edit' ? 'Change look' : 'Cut out part') + ' engine is installed — install one in Library ▸ Workflows.' };
        });
        return out;
      }
      function inspectorPanel(tab, sub) { return tab === 'image' ? (sub === 'edit' ? 'image-edit' : 'image-generate') : ['prompt', 'mesh', 'scene'].indexOf(tab) >= 0 ? tab : null; }
      function rightMode(workspace, createRight) { return workspace === 'create' ? (createRight === 'library' ? 'library' : 'inspector') : 'library'; }
      // </create-pure>

      // <create-ui>
      function renderPipelineBar(doc, root, items, on) {
        if (!root) return;
        root.textContent = '';
        function el(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
        items.forEach(function (item) {
          const stage = item.kind === 'stage';
          const card = el(stage ? 'button' : 'div', stage ? null : 'pipe-gate');
          if (stage) {
            card.type = 'button'; card.setAttribute('type', 'button'); card.setAttribute('data-stage', item.stage); card.setAttribute('data-state', item.state);
            if (item.current) card.setAttribute('aria-current', 'step');
            card.addEventListener('click', function () { on.stage(item.stage); });
          } else {
            card.setAttribute('data-gate', item.gate); card.setAttribute('data-waiting', String(item.waiting));
            card.setAttribute('title', 'Gate · your OK — ' + ({ prompt: 'Prompt → Image', image: 'Image → Mesh', mesh: 'Mesh → Scene' })[item.gate]);
            {
              const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
              svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('aria-hidden', 'true');
              const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M8 11V8a4 4 0 0 1 8 0v3M5 11h14v10H5z'); svg.appendChild(path); card.appendChild(svg);
            }
          }
          const text = stage ? card : el('span', 'pipe-gate-text');
          const label = el('span', 'pipe-label', stage ? item.label : 'Gate');
          if (!stage) label.appendChild(el('span', 'pipe-label-rest', ' · your OK'));
          text.appendChild(label);
          const line = el('span', 'pipe-line');
          if (item.stage === 'scene') { const dot = el('i', 'pipe-dot'); dot.setAttribute('data-state', item.dot); dot.setAttribute('aria-hidden', 'true'); line.appendChild(dot); }
          line.appendChild(el('span', null, item.line)); text.appendChild(line);
          if (!stage) card.appendChild(text);
          if (!stage && item.waiting) {
            const b = el('button', 'btn btn-primary btn-sm', 'Approve'); b.type = 'button'; b.setAttribute('type', 'button'); b.setAttribute('data-gate-approve', item.gate);
            b.addEventListener('click', function () { on.approve(item.gate); }); card.appendChild(b);
          }
          root.appendChild(card);
        });
      }
      function runGateApprove(gate, d) {
        if (gate === 'mesh') { d.switchTab('scene'); return; }
        const selector = gate === 'prompt' ? "#prompt-actions .art-btn[data-action=\"approve-prompt\"]" : gate === 'image' ? "#image-actions .art-btn[data-action=\"make-3d\"]" : null;
        const b = selector && d.doc.querySelector(selector); if (b) b.click();
      }
      function makeCreatePipeline(d) {
        const s = { current: 'prompt', running: null, have: {}, approved: false, gates: {}, awaiting: null, engines: {}, blender: 'unknown' };
        function view() { return pipelineView(s); }
        let renderedKey, waiting = null, deferred = null;
        function reveal() {
          if (!deferred || d.root.hidden) return;
          const card = d.root.querySelector('[data-gate="' + deferred + '"]');
          if (card) card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          deferred = null;
        }
        function render() { const items = view(), key = JSON.stringify(items); if (key === renderedKey) return; renderPipelineBar(d.doc, d.root, items, { stage: function (t) { d.switchTab(t); }, approve: function (g) { runGateApprove(g, d); } }); renderedKey = key;
          const next = items.find(function (i) { return i.kind === 'gate' && i.waiting; });
          const gate = next ? next.gate : null;
          if (gate !== waiting) { deferred = gate; reveal(); }
          waiting = gate;
        }
        function set(patch) { Object.keys(patch).forEach(function (k) { s[k] = ['have', 'gates', 'engines'].indexOf(k) >= 0 ? Object.assign({}, s[k], patch[k]) : patch[k]; }); render(); }
        render(); return { set: set, view: view, render: render, reveal: reveal };
      }
      async function saveEngine(stage, id, d) {
        const req = settingBody('workflows.' + stage, id);
        let r, j = {};
        try {
          r = await d.fetch(req.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
          try { j = await r.json(); } catch (_) {}
        } catch (_) { d.note('Phoenix is not reachable — not saved.', true); return false; }
        if (!r.ok) { d.note(((j && j.error) || ('The server refused it (' + r.status + ')')) + ' — not saved.', true); return false; }
        d.note('Saved ✓', false); d.after(stage); return true;
      }
      function wireInspectorDrop(root, note, isOn) {
        if (!root) return;
        function hasFiles(e) { return e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0; }
        root.addEventListener('dragover', function (e) {
          if ((isOn && !isOn()) || e.defaultPrevented || !hasFiles(e)) return;
          e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
        });
        root.addEventListener('drop', function (e) {
          if ((isOn && !isOn()) || e.defaultPrevented || !hasFiles(e)) return;
          e.preventDefault(); note('Images load in Image ▸ Generate — drop it there or on the Library.');
        });
      }
      // </create-ui>

      const createPipe = makeCreatePipeline({ doc: document, root: document.getElementById('create-pipeline'), switchTab: function (t) { switchTab(t); } });
      let currentTab = 'prompt', currentSub = 'view';
      function syncCreateRight() {
        const mode = rightMode(shellState.workspace, window.__createRight ? window.__createRight.get() : 'inspector');
        const sw = document.getElementById('right-switch'), inspector = document.getElementById('inspector');
        sw.hidden = shellState.workspace !== 'create'; inspector.hidden = mode !== 'inspector';
        document.getElementById('library-wrap').classList.toggle('in-create', shellState.workspace === 'create');
        document.getElementById('library-wrap').classList.toggle('show-inspector', mode === 'inspector');
        document.querySelectorAll('#right-switch [data-right]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.right === mode)); });
        const panel = inspectorPanel(currentTab, currentSub);
        document.querySelectorAll('.insp-panel').forEach(function (p) { p.hidden = p.dataset.insp !== panel; });
        createPipe.set({ current: currentTab });
      }
      ['inspector', 'library'].forEach(function (mode) {
        const b = document.createElement('button'); b.type = 'button'; b.dataset.right = mode; b.textContent = mode === 'inspector' ? 'Inspector' : 'Library';
        b.addEventListener('click', function () { if (window.__createRight) window.__createRight.set(mode); syncCreateRight(); }); document.getElementById('right-switch').appendChild(b);
      });
      window.__syncCreateRight = syncCreateRight;
      window.__openInCreate = function (stage) {
        if (stage === 'mesh') switchTab('mesh');
        else { switchTab('image'); if (window.__i2iSwitchSub) window.__i2iSwitchSub(stage === 'i2i' ? 'edit' : 'view'); }
        if (window.__createRight) window.__createRight.set('inspector');
        syncCreateRight();
      };
      const createEngines = {};
      let engineRefreshSeq = 0;
      function engineSaveDeps(sel) {
        const panel = sel.closest('.insp-panel'), saved = panel.querySelector('.insp-saved'), err = panel.querySelector('.insp-err');
        return { fetch: function (u, o) { return fetch(u, o); }, note: function (text, isError) {
          clearTimeout(sel._savedTimer); saved.textContent = isError ? '' : text; err.textContent = isError ? text : '';
          if (!isError) sel._savedTimer = setTimeout(function () { saved.textContent = ''; }, 2500);
        }, after: function (stage) {
          if (stage === 'image' && window.__refreshRefRow) window.__refreshRefRow();
          if (window.__refreshEngineLines) window.__refreshEngineLines();
          refreshEnginePickers(); if (window.__reloadLibraryWorkflows) window.__reloadLibraryWorkflows();
        } };
      }
      async function refreshEnginePickers() {
        const seq = ++engineRefreshSeq;
        try {
          const r = await fetch('/workflows'); if (!r.ok) return; const wf = await r.json();
          let dep = null; try { const dr = await fetch('/workflows/deps'); if (dr.ok) dep = await dr.json(); } catch (_) {}
          if (seq !== engineRefreshSeq) return;
          document.querySelectorAll('.insp-engine').forEach(function (sel) {
            const stage = sel.dataset.setting.split('.')[1]; sel.textContent = '';
            engineOptions(stage, wf, dep).forEach(function (o) { const op = document.createElement('option'); op.value = o.id; op.textContent = o.label; op.disabled = o.disabled; op.selected = o.active; sel.appendChild(op); });
            createEngines[stage] = (wf.active || {})[stage] || ''; sel.value = createEngines[stage];
          });
          const wfs = wf.workflows || {};
          createPipe.set({ engines: { image: (wfs[createEngines.image] || {}).label || '', mesh: (wfs[createEngines.mesh] || {}).label || '' } });
          const kinds = editKinds(wf, dep), root = document.getElementById('i2i-kind'); root.textContent = '';
          ['edit', 'segment'].forEach(function (kind) {
            const b = document.createElement('button'); b.type = 'button'; b.dataset.kind = kind; b.textContent = kind === 'edit' ? 'Change look' : 'Cut out part'; b.disabled = kinds[kind].disabled; b.title = kinds[kind].title; b.setAttribute('aria-pressed', String(kinds.active === kind));
            b.addEventListener('click', async function () { b.disabled = true; try { await saveEngine('i2i', kinds[kind].id, engineSaveDeps(document.getElementById('insp-engine-i2i'))); await refreshEnginePickers(); } finally { b.disabled = kinds[kind].disabled; } }); root.appendChild(b);
          });
        } catch (_) { /* keep the last known engine choices */ }
      }
      document.querySelectorAll('.insp-engine').forEach(function (sel) {
        sel.addEventListener('change', async function () {
          const stage = sel.dataset.setting.split('.')[1], previous = createEngines[stage]; sel.disabled = true;
          try { const ok = await saveEngine(stage, sel.value, engineSaveDeps(sel)); if (!ok) sel.value = previous; } finally { sel.disabled = false; }
        });
      });
      document.querySelectorAll('.insp-adv button').forEach(function (btn) { btn.addEventListener('click', function () { const id = createEngines[btn.dataset.adv]; if (id && window.__openWorkflowWindow) window.__openWorkflowWindow(id, btn, { advanced: true }); }); });
      window.__refreshCreateEngines = refreshEnginePickers;
      refreshEnginePickers();
