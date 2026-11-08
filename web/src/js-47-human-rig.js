      // ── Characters workspace (v1.10.1 R5a): MakeHuman and Custom rig as two sources of ONE workspace ─────────────────────────────────────
      // Cast list on the left, preview + the one animation sequencer in the centre, the controls of the active step on the right, the two-step card
      // (build a preview, then place it) at the bottom of the inspector. The markup is a single empty #panel-characters; this module builds all of it
      // with createElement + textContent (no HTML strings), so it runs in the fake DOM of the acceptance suite. The outside world comes in only through
      // deps: { document, root, steps, fetch, postAction(action, input), switchTab(tab), jobClock(fn, ms) -> { stop() }, onCrumb() }.
      // Polling: none. The lists are read when the workspace is entered and after an action changed them; the HY-Motion clock is a job clock.

      // <r5a-characters>
      function makeCharactersWs(deps) {
        const d = deps.document, root = deps.root, stepsEl = deps.steps;
        const STEPS = [['body', 'Body'], ['face', 'Face'], ['look', 'Look'], ['rig', 'Rig'], ['animate', 'Animate']];
        const MESH_STEPS = ['body', 'face', 'look'];
        const NO_MESH_WHY = 'Custom rigs bring their own mesh.';
        const SLIDERS = ['gender', 'age', 'muscle', 'weight', 'height', 'proportions', 'cupsize', 'firmness'];
        const SLIDER_INFO = { gender: ['Gender', 'F', 'M'], age: ['Age', '1', '90'], muscle: ['Muscle', '-', '+'], weight: ['Weight', '-', '+'], height: ['Height', '-', '+'],
          proportions: ['Proportions', '-', '+'], cupsize: ['Cup size', '-', '+'], firmness: ['Firmness', '-', '+'] };
        // Face detail sliders -> verified MakeHuman targets. Bidirectional: 0.5 = neutral, above drives the first list, below the second; magnitude 0..1.
        const FACE_TARGETS = {
          'head-width':   [['head/head-scale-horiz-incr'], ['head/head-scale-horiz-decr']],
          'head-length':  [['head/head-scale-vert-incr'], ['head/head-scale-vert-decr']],
          'nose-size':    [['nose/nose-volume-incr'], ['nose/nose-volume-decr']],
          'nose-width':   [['nose/nose-scale-horiz-incr'], ['nose/nose-scale-horiz-decr']],
          'nose-length':  [['nose/nose-scale-vert-incr'], ['nose/nose-scale-vert-decr']],
          'nose-bridge':  [['nose/nose-hump-incr'], ['nose/nose-hump-decr']],
          'mouth-width':  [['mouth/mouth-scale-horiz-incr'], ['mouth/mouth-scale-horiz-decr']],
          'lip-fullness': [['mouth/mouth-scale-vert-incr'], ['mouth/mouth-scale-vert-decr']],
          'mouth-height': [['mouth/mouth-trans-up'], ['mouth/mouth-trans-down']],
          'chin-height':  [['chin/chin-height-incr'], ['chin/chin-height-decr']],
          'chin-prom':    [['chin/chin-prominent-incr'], ['chin/chin-prominent-decr']],
          'cheeks':       [['cheek/l-cheek-volume-incr', 'cheek/r-cheek-volume-incr'], ['cheek/l-cheek-volume-decr', 'cheek/r-cheek-volume-decr']],
          'eye-spacing':  [['eyes/l-eye-trans-out', 'eyes/r-eye-trans-out'], ['eyes/l-eye-trans-in', 'eyes/r-eye-trans-in']],
        };
        const FACE_KEYS = Object.keys(FACE_TARGETS);
        const FACE_LABELS = { 'head-width': 'Head width', 'head-length': 'Face length', 'nose-size': 'Nose size', 'nose-width': 'Nose width', 'nose-length': 'Nose length',
          'nose-bridge': 'Nose bridge', 'mouth-width': 'Mouth width', 'lip-fullness': 'Lip fullness', 'mouth-height': 'Mouth height', 'chin-height': 'Chin height',
          'chin-prom': 'Chin forward', 'cheeks': 'Cheeks', 'eye-spacing': 'Eye spacing' };
        const OPT_RACE = [['caucasian', 'Caucasian'], ['asian', 'Asian'], ['african', 'African']];
        const OPT_SKIN = [['auto', 'Auto (match gender/age/race)'], ['procedural', 'Procedural (no textures)']];
        const OPT_EYE = [['', 'Default'], ['brown', 'Brown'], ['brownlight', 'Brown (light)'], ['blue', 'Blue'], ['lightblue', 'Blue (light)'], ['deepblue', 'Blue (deep)'],
          ['bluegreen', 'Blue-green'], ['green', 'Green'], ['grey', 'Grey'], ['ice', 'Ice']];
        const OPT_HAIR = [['', 'None'], ['short01', 'Short 1'], ['short02', 'Short 2'], ['long01', 'Long'], ['bob01', 'Bob 1'], ['bob02', 'Bob 2'], ['braid01', 'Braid'],
          ['ponytail01', 'Ponytail'], ['afro01', 'Afro']];
        const OPT_CLOTHES = [['', 'None'], ['male_casualsuit01', 'Male casual suit 1'], ['male_casualsuit02', 'Male casual suit 2'], ['female_casualsuit01', 'Female casual suit 1'],
          ['female_casualsuit02', 'Female casual suit 2'], ['female_elegantsuit01', 'Female elegant suit'], ['female_sportsuit01', 'Female sport suit'], ['fedora01', 'Fedora']];
        const OPT_RIG = [['', 'None'], ['default', 'Standard'], ['mixamo', 'Mixamo (animatable)']];

        // state -----------------------------------------------------------------------------------------------------------------------------
        const S = { source: 'makehuman', step: 'body', chars: [], folders: [], anims: [], sel: { makehuman: '', customrig: '' }, ghosts: [], rowUi: null, rowMsg: null,
          chain: [], played: false, playPending: false, posterDead: {}, chainKey: '', pickSig: null, buildUrl: '', buildKey: null, placeReady: false, clock: null, posterRes: {}, posterJobs: {}, posterShown: null,
          saving: '', buildRig: '', mixamoBuilt: false, draftOpen: false };
        let lastCrumb = null;
        const C = {};                       // id -> element
        const SECS = [];                    // inspector sections { el, source, step }

        // small builders ----------------------------------------------------------------------------------------------------------------------
        function el(tag, cls, text) { const e = d.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
        function reg(e, id) { e.id = id; C[id] = e; return e; }
        function mkBtn(kind, label, id) {
          let bt;
          if (kind === 'primary') { bt = d.createElement('button'); bt.className = 'btn btn-primary'; }
          else if (kind === 'primary-sm') { bt = d.createElement('button'); bt.className = 'btn btn-primary btn-sm'; }
          else if (kind === 'secondary') { bt = d.createElement('button'); bt.className = 'btn btn-secondary'; }
          else if (kind === 'secondary-sm') { bt = d.createElement('button'); bt.className = 'btn btn-secondary btn-sm'; }
          else if (kind === 'ghost') { bt = d.createElement('button'); bt.className = 'btn btn-ghost'; }
          else if (kind === 'danger') { bt = d.createElement('button'); bt.className = 'btn btn-danger'; }
          else if (kind === 'danger-sm') { bt = d.createElement('button'); bt.className = 'btn btn-danger btn-sm'; }
          else { bt = d.createElement('button'); bt.className = 'btn btn-ghost btn-sm'; }
          bt.type = 'button'; bt.textContent = label;
          if (id) reg(bt, id);
          return bt;
        }
        function actBtn(kind, label, act) { const b2 = mkBtn(kind, label); b2.setAttribute('data-act', act); return b2; }
        function onClick(b2, fn) { b2.addEventListener('click', function (ev) { fn(ev); }); return b2; }
        function field(label, control, id) {
          const row = el('div', 'ch-row'); const lab = el('label', 'ch-lab', label); if (id) lab.htmlFor = id;
          row.appendChild(lab); row.appendChild(control); return row;
        }
        function textInput(id, placeholder) { const i = el('input', 'ch-text'); i.type = 'text'; i.value = ''; if (placeholder) i.placeholder = placeholder; return reg(i, id); }
        function numInput(id, value, min, max, step) {
          const i = el('input', 'ch-num'); i.type = 'number'; i.value = String(value);
          if (min != null) i.setAttribute('min', String(min)); if (max != null) i.setAttribute('max', String(max)); if (step != null) i.setAttribute('step', String(step));
          return reg(i, id);
        }
        function fillSelect(sel, items, keep) {
          sel.textContent = '';
          items.forEach(function (it) { const o = d.createElement('option'); const v = Array.isArray(it) ? it[0] : it; o.value = v; o.textContent = Array.isArray(it) ? it[1] : it; sel.appendChild(o); });
          const first = items.length ? (Array.isArray(items[0]) ? items[0][0] : items[0]) : '';
          const has = keep != null && items.some(function (it) { return (Array.isArray(it) ? it[0] : it) === keep; });
          sel.value = has ? keep : first;
        }
        function selectInput(id, items, value) { const s2 = el('select', 'ch-select'); fillSelect(s2, items, value); return reg(s2, id); }
        function mkToggle(id, label, on) {
          const tgl = d.createElement('button'); tgl.setAttribute('class', 'toggle'); tgl.type = 'button'; tgl.setAttribute('role', 'switch');
          tgl.setAttribute('aria-checked', on ? 'true' : 'false'); tgl.setAttribute('aria-label', label);
          tgl.addEventListener('click', function () { tgl.setAttribute('aria-checked', tgl.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); });
          return reg(tgl, id);
        }
        const isOn = function (id) { return C[id].getAttribute('aria-checked') === 'true'; };
        function toggleRow(id, label, on) { const row = el('div', 'ch-row'); row.appendChild(el('span', 'ch-lab', label)); row.appendChild(mkToggle(id, label, on)); return row; }
        function sliderRow(id, label, lo, hi, withOut) {
          const row = el('div', 'ch-slider'); const lab = el('label', 'ch-lab', label); lab.htmlFor = id;
          const r = el('input', 'ch-range'); r.type = 'range'; r.setAttribute('min', '0'); r.setAttribute('max', '1'); r.setAttribute('step', '0.01'); r.value = '0.5'; reg(r, id);
          row.appendChild(lab); row.appendChild(el('span', 'ch-end', lo)); row.appendChild(r); row.appendChild(el('span', 'ch-end', hi));
          if (withOut) { const o = el('output', 'ch-out', ''); reg(o, id + '-v'); row.appendChild(o); }
          return row;
        }
        function section(source, step) { const s2 = el('div', 'ch-sec'); s2.setAttribute('data-step-panel', step); s2.setAttribute('data-source', source); s2.hidden = true; SECS.push({ el: s2, source: source, step: step }); return s2; }
        function inlineForm(id) { const f = el('div', 'ch-inline'); f.hidden = true; return reg(f, id); }
        function note(text, cls) { return el('p', cls || 'ch-note', text); }
        function setStatus(text) { const st = C['ch-status']; if (!st) return; st.textContent = text; st.classList.remove('ch-bad'); }
        function setBad(text) { const st = C['ch-status']; if (st) { st.textContent = text; st.classList.add('ch-bad'); } }
        const FAILED = /^(ERROR|[A-Z_]+_ERROR|BLENDER_UNREACHABLE|REJECTED|BUSY)/;
        // the readable text of an answer: no ERROR: / BLENDER_UNREACHABLE: prefixes, first line only
        const readable = function (t) { let s = String(t == null ? '' : t); let p; do { p = s; s = s.replace(/^\s*(?:ERROR|BLENDER_UNREACHABLE):\s*/, ''); } while (s !== p); return s.split('\n')[0].trim(); };
        // a busy status the action's own end event settles (reply / error / 409 / network), matched by request id where there is one
        function busy(text, action, input) {
          setStatus(text);
          const rid = deps.newRequestId ? deps.newRequestId() : null;
          S.busy = { action: action, id: rid };
          deps.postAction(action, input, undefined, rid);
        }
        const val = function (id) { return C[id].value; };
        const charName = function () { return String(val('ch-name') || '').trim(); };
        // the character an action targets: the selected cast row wins over whatever the Name field says (F3.6)
        const targetName = function () { return S.sel.makehuman || charName(); };
        const safeName = function (s) { return String(s || '').replace(/[^A-Za-z0-9 _\-]/g, '').slice(0, 60).trim(); };
        const lc = function (s) { return String(s).toLowerCase(); };
        function curFolder() { return S.folders.find(function (f) { return f.name === S.sel.customrig; }) || null; }
        function curSaved() { return S.chars.find(function (c) { return c.name === S.sel.makehuman; }) || null; }
        const curKey = function () { return S.source + ':' + S.sel[S.source]; };
        function posterUrl(c) { return '/poster?key=' + encodeURIComponent('character:' + c.name) + '&stamp=' + encodeURIComponent(c.posterStamp); }
        const posterKey = function (c) { return c.name + '|' + c.posterStamp; };
        const posterSrc = function (c) { return S.posterRes[posterKey(c)] || posterUrl(c); };
        // The GLB is fresh but the JPEG is missing: ask the browser renderer for it, once per name + stamp (the cast row and the centre share the job).
        function ensurePoster(c) {
          if (!deps.renderPoster || !c || !c.posterStamp) return;
          const k = posterKey(c);
          if (S.posterJobs[k]) return;
          S.posterJobs[k] = Promise.resolve().then(function () { return deps.renderPoster({ name: c.name, stamp: c.posterStamp }); })
            .then(function (url) { return url || null; }, function () { return null; })
            .then(function (url) { if (url) { S.posterRes[k] = url; renderCast(); renderPreview(); } else { S.posterDead[k] = true; renderCast(); renderPreview(); } return url; });
        }

        // network ---------------------------------------------------------------------------------------------------------------------------
        async function getJson(url) {
          try { const r = await deps.fetch(url); return await r.json(); } catch (_) { return null; }
        }
        async function postJson(url, body) {
          try {
            const r = await deps.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            let j = null; try { j = await r.json(); } catch (_) { j = null; }
            return { ok: !!(j && j.ok), json: j };
          } catch (_) { return { ok: false, json: null }; }
        }
        const errOf = function (r, fallback) { return (r && r.json && r.json.error) || fallback; };

        // data ------------------------------------------------------------------------------------------------------------------------------
        async function loadData() {
          const got = await Promise.all([getJson('/characters'), getJson('/custom-rigs'), getJson('/animations')]);
          if (got[0] && Array.isArray(got[0].characters)) S.chars = got[0].characters;
          if (got[1] && Array.isArray(got[1].folders)) S.folders = got[1].folders;
          if (got[2] && Array.isArray(got[2].animations)) S.anims = got[2].animations;
          if (S.sel.makehuman && !S.chars.some(function (c) { return c.name === S.sel.makehuman; })) S.sel.makehuman = '';
          if (S.sel.customrig && !S.folders.some(function (f) { return f.name === S.sel.customrig; })) S.sel.customrig = '';
        }
        async function refresh(selectName) {
          await loadData();
          if (selectName) {
            const inC = S.chars.some(function (c) { return c.name === selectName; }), inF = S.folders.some(function (f) { return f.name === selectName; });
            if (S.source === 'customrig' && inF) S.sel.customrig = selectName;
            else if (S.source === 'makehuman' && inC) S.sel.makehuman = selectName;
            else if (inC) { S.sel.makehuman = selectName; render(); deps.switchTab('human'); if (S.source !== 'makehuman') setSource('makehuman'); }
            else if (inF) { S.sel.customrig = selectName; render(); deps.switchTab('customrig'); if (S.source !== 'customrig') setSource('customrig'); }
          }
          render();
        }

        // cast list ---------------------------------------------------------------------------------------------------------------------------
        function draftName() { return charName() || 'New character'; }
        function entries() {
          const list = [];
          if (S.draftOpen) list.push({ source: 'makehuman', name: draftName(), draft: true });   // M1.4: one entry only - the draft row exists while + New character has started a MakeHuman draft
          S.chars.forEach(function (c) { list.push({ source: 'makehuman', name: c.name, data: c }); });
          S.folders.forEach(function (f) { list.push({ source: 'customrig', name: f.name, data: f }); });
          S.ghosts.slice().sort(function (a, b) { return a.index - b.index; }).forEach(function (g) { list.splice(Math.min(g.index, list.length), 0, { source: g.source, name: g.name, ghost: g }); });
          return list;
        }
        function isActive(e) {
          if (e.ghost) return false;
          if (e.draft) return S.source === 'makehuman' && S.sel.makehuman === '';
          return e.source === S.source && S.sel[S.source] === e.name;
        }
        function selectEntry(source, name) {
          S.sel[source] = name; S.rowUi = null; S.rowMsg = null;
          if (source !== S.source) { deps.switchTab(source === 'makehuman' ? 'human' : 'customrig'); if (S.source !== source) setSource(source); }
          render();
        }
        function rowEdit(e) {
          const box = el('div', 'ch-row-edit');
          const inp = el('input', 'ch-row-input'); inp.type = 'text'; inp.value = e.name; inp.setAttribute('aria-label', 'New name for ' + e.name);
          const go = actBtn('primary-sm', 'Rename', 'rename-go'); go.disabled = true;
          const cancel = actBtn('ghost-sm', 'Cancel', 'rename-cancel');
          const hint = el('div', 'ch-hint', ''); hint.setAttribute('data-hint', '');
          const check = function () {
            const safe = safeName(inp.value);
            const taken = (e.source === 'makehuman' ? S.chars : S.folders).some(function (x) { return x.name !== e.name && lc(x.name) === lc(safe); });
            if (!safe) { go.disabled = true; hint.textContent = 'Give it a name.'; }
            else if (safe === e.name) { go.disabled = true; hint.textContent = ''; }
            else if (taken) { go.disabled = true; hint.textContent = '"' + safe + '" is taken — pick another'; }
            else { go.disabled = false; hint.textContent = safe !== String(inp.value).trim() ? 'Renames to "' + safe + '".' : ''; }
          };
          inp.addEventListener('input', check);
          inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go.click(); else if (ev.key === 'Escape') cancel.click(); });
          onClick(go, async function () {
            const to = String(inp.value).trim();
            const r = await postJson(e.source === 'makehuman' ? '/character-rename' : '/custom-rig-rename', { from: e.name, to: to });
            if (r.ok) { const nn = (r.json.character && r.json.character.name) || (r.json.folder && r.json.folder.name) || to; S.rowUi = null; S.rowMsg = r.json.warning ? { key: e.source + ':' + nn, text: String(r.json.warning) } : null; await refresh(nn); }
            else hint.textContent = errOf(r, 'Could not rename.');
          });
          onClick(cancel, function () { S.rowUi = null; renderCast(); });
          box.appendChild(inp); box.appendChild(go); box.appendChild(cancel); box.appendChild(hint);
          return box;
        }
        function rowConfirm(e) {
          const box = el('div', 'ch-row-edit');
          box.appendChild(el('div', 'ch-confirm', 'Move ' + e.name + ' to the trash?'));
          const go = actBtn('danger-sm', 'Move to trash', 'trash-go'); const cancel = actBtn('ghost-sm', 'Cancel', 'trash-cancel');
          onClick(go, function () { doTrash(e); }); onClick(cancel, function () { S.rowUi = null; renderCast(); });
          box.appendChild(go); box.appendChild(cancel);
          return box;
        }
        async function doTrash(e) {
          const r = await postJson(e.source === 'makehuman' ? '/character-delete' : '/custom-rig-delete', { name: e.name });
          S.rowUi = null;
          if (r.ok) {
            const index = Math.max(0, entries().findIndex(function (x) { return !x.ghost && x.source === e.source && x.name === e.name && !x.draft; }));
            if (e.source === 'makehuman') { S.chars = S.chars.filter(function (c) { return c.name !== e.name; }); if (S.sel.makehuman === e.name) S.sel.makehuman = ''; }
            else { S.folders = S.folders.filter(function (f) { return f.name !== e.name; }); if (S.sel.customrig === e.name) S.sel.customrig = ''; }
            S.ghosts.push({ source: e.source, name: e.name, id: r.json.id, index: index });
            try { if (typeof libraryPage !== 'undefined' && libraryPage) libraryPage.noteChange('characters'); } catch (_) {}   // F4: the Library's count and Trash follow
            S.rowMsg = null; render();
          } else { S.rowMsg = { key: e.source + ':' + e.name, text: errOf(r, 'Could not move it to the trash.') }; renderCast(); }
        }
        function ghostResult(box, g, err) {
          box.textContent = '';
          box.appendChild(el('span', err ? 'ch-bad' : '', err ? 'Could not undo: ' + err + ' ' : 'Moved to the trash — '));
          const undo = actBtn('ghost-sm', 'Undo', 'undo'); onClick(undo, function () { doUndo(g, box); });
          box.appendChild(undo);
        }
        async function doUndo(g, box) {
          const r = await postJson('/library/trash/restore', { id: g.id });
          if (r.ok) {
            S.ghosts = S.ghosts.filter(function (x) { return x !== g; });
            try { if (typeof libraryPage !== 'undefined' && libraryPage) libraryPage.noteChange('characters'); } catch (_) {}
            await loadData();
            if ((g.source === 'makehuman' ? S.chars : S.folders).some(function (x) { return x.name === g.name; })) selectEntry(g.source, g.name); else render();
          } else ghostResult(box, g, errOf(r, 'The trash did not answer.'));
        }
        function castRow(e) {
          const row = el('div', 'ch-cast-row'); row.setAttribute('data-source', e.source); row.setAttribute('data-name', e.name); row.tabIndex = 0;
          if (e.draft) row.setAttribute('data-draft', 'true');
          const active = isActive(e);
          if (active) { row.classList.add('active'); row.setAttribute('aria-current', 'true'); }
          const poster = el('div', 'ch-cast-poster');
          const stamp = e.data && e.source === 'makehuman' && e.data.posterStamp && !S.posterDead[posterKey(e.data)] ? e.data.posterStamp : null;
          const avatar = function () { return el('div', 'ch-avatar', e.draft ? '+' : String(e.name).charAt(0).toUpperCase()); };
          if (stamp) {
            const im = el('img'); im.alt = ''; im.src = posterSrc(e.data);
            im.addEventListener('error', function () { poster.textContent = ''; poster.appendChild(avatar()); ensurePoster(e.data); });
            poster.appendChild(im);
          } else poster.appendChild(avatar());
          const text = el('div', 'ch-cast-text');
          text.appendChild(el('div', 'ch-cast-name', e.name));
          const srcLine = e.draft ? 'MakeHuman · unsaved' : e.source === 'makehuman' ? 'MakeHuman' : 'custom rig' + (e.data && !e.data.hasSkeleton ? ' · no skeleton' : '');
          text.appendChild(el('div', 'ch-cast-src', srcLine));
          row.appendChild(poster); row.appendChild(text);
          if (e.ghost) {
            row.setAttribute('data-removed', 'true');
            const res = el('div', 'ch-cast-result'); res.setAttribute('data-result', ''); ghostResult(res, e.ghost, ''); row.appendChild(res);
            return row;
          }
          row.addEventListener('click', function (ev) {
            if (ev && ev.target && ev.target.closest && ev.target.closest('button, input')) return;
            if (active) return;
            selectEntry(e.source, e.draft ? '' : e.name);
          });
          row.addEventListener('keydown', function (ev) { if (ev.target === row && (ev.key === 'Enter' || ev.key === ' ')) { if (!active) selectEntry(e.source, e.draft ? '' : e.name); } });
          if (active && !e.draft) {
            const acts = el('div', 'ch-cast-actions');
            const ui = S.rowUi && S.rowUi.key === e.source + ':' + e.name ? S.rowUi.mode : null;
            if (ui === 'rename') acts.appendChild(rowEdit(e));
            else if (ui === 'delete') acts.appendChild(rowConfirm(e));
            else {
              if (e.source === 'makehuman') onClick(acts.appendChild(actBtn('ghost-sm', 'Spawn', 'spawn')), function () { busy('Spawning "' + e.name + '"…', 'spawn_character', { name: e.name }); });
              onClick(acts.appendChild(actBtn('ghost-sm', 'Rename', 'rename')), function () { S.rowUi = { key: e.source + ':' + e.name, mode: 'rename' }; S.rowMsg = null; renderCast(); const fresh = C.__castList.querySelector('input.ch-row-input'); if (fresh && fresh.focus) fresh.focus(); });
              onClick(acts.appendChild(actBtn('ghost-sm', 'Delete', 'delete')), function () { S.rowUi = { key: e.source + ':' + e.name, mode: 'delete' }; S.rowMsg = null; renderCast(); });
            }
            row.appendChild(acts);
            if (S.rowMsg && S.rowMsg.key === e.source + ':' + e.name) { const m = el('div', 'ch-cast-result ch-bad', S.rowMsg.text); m.setAttribute('data-result', ''); row.appendChild(m); }
          }
          return row;
        }
        function renderCast() {
          const box = C.__castList; box.textContent = '';
          entries().forEach(function (e) { box.appendChild(castRow(e)); });
        }

        // steps -----------------------------------------------------------------------------------------------------------------------------
        const stepBtns = {};
        function buildSteps() {
          stepsEl.textContent = '';
          STEPS.forEach(function (s2) {
            const sb = d.createElement('button'); sb.className = 'btn btn-ghost btn-sm'; sb.type = 'button'; sb.textContent = s2[1]; sb.setAttribute('data-step', s2[0]); sb.setAttribute('aria-pressed', 'false');
            sb.addEventListener('click', function () { setStep(s2[0]); });
            stepBtns[s2[0]] = sb; stepsEl.appendChild(sb);
          });
        }
        function renderSteps() {
          STEPS.forEach(function (s2) {
            const b2 = stepBtns[s2[0]], blocked = S.source === 'customrig' && MESH_STEPS.indexOf(s2[0]) >= 0;
            b2.disabled = blocked; b2.title = blocked ? NO_MESH_WHY : '';
            b2.setAttribute('aria-pressed', S.step === s2[0] ? 'true' : 'false');
          });
        }
        function setStep(id) {
          if (!stepBtns[id]) return;
          if (S.source === 'customrig' && MESH_STEPS.indexOf(id) >= 0) return;
          S.step = id; render();
        }
        function setSource(src) {
          if (src !== 'makehuman' && src !== 'customrig') return;
          if (src === S.source) return;               // idempotent: switchTab calls this back
          S.source = src; S.rowUi = null; S.rowMsg = null;
          if (src === 'customrig') S.step = 'rig';
          C['ch-new-form'].hidden = true;
          render();
        }

        // inspector -------------------------------------------------------------------------------------------------------------------------
        const lerpPts = function (pts, x) {
          if (x <= pts[0][0]) return pts[0][1];
          for (let i = 1; i < pts.length; i++) { if (x <= pts[i][0]) { const a = pts[i - 1], b2 = pts[i]; return a[1] + (b2[1] - a[1]) * (x - a[0]) / (b2[0] - a[0]); } }
          return pts[pts.length - 1][1];
        };
        // Age anchors from MPFB age.json (1yr@0, 25yr@0.5, 90yr@1); the height curve + age/gender factors were measured off the generated mesh.
        const H_CURVE = [[0, 1.30], [0.25, 1.48], [0.5, 1.66], [0.75, 2.01], [1.0, 2.37]], G_FAC = [[0, 0.959], [0.5, 1.0], [1, 1.042]], A_FAC = [[0, 0.402], [0.5, 1.0], [1, 0.987]];
        const ageYears = function (a) { return a < 0.5 ? Math.round(1 + 48 * a) : Math.round(25 + 130 * (a - 0.5)); };
        const heightM = function () { return lerpPts(H_CURVE, +val('ch-height')) * lerpPts(A_FAC, +val('ch-age')) * lerpPts(G_FAC, +val('ch-gender')); };
        function readout(id) {
          const out = C[id + '-v']; if (!out) return;
          out.textContent = id === 'ch-age' ? ageYears(+val('ch-age')) + ' y' : id === 'ch-height' ? heightM().toFixed(2) + ' m' : (+val(id)).toFixed(2);
        }
        function buildFaceTargets() {
          const t2 = {};
          FACE_KEYS.forEach(function (key) {
            const dd = parseFloat(val('ch-face-' + key)) - 0.5;
            if (Math.abs(dd) < 0.02) return;          // near-centre = neutral, skip
            const mag = Math.min(1, Math.abs(dd) * 2);
            (dd > 0 ? FACE_TARGETS[key][0] : FACE_TARGETS[key][1]).forEach(function (n) { t2[n] = mag; });
          });
          return t2;
        }
        function resetGenerator() {
          SLIDERS.forEach(function (k) { C['ch-' + k].value = '0.5'; });
          FACE_KEYS.forEach(function (k) { C['ch-face-' + k].value = '0.5'; });
          C['ch-name'].value = ''; C['ch-race'].value = 'caucasian'; C['ch-skin'].value = 'auto'; C['ch-eyecolor'].value = ''; C['ch-hair'].value = ''; C['ch-clothes'].value = ''; C['ch-rig'].value = '';
          ['ch-eyes', 'ch-teeth', 'ch-brows', 'ch-lashes'].forEach(function (id) { C[id].setAttribute('aria-checked', 'true'); });
          SLIDERS.forEach(function (k) { readout('ch-' + k); });
        }
        function buildMakeHumanInspector(host) {
          const body = section('makehuman', 'body');
          body.appendChild(field('Name', textInput('ch-name', 'Human'), 'ch-name'));
          SLIDERS.forEach(function (k) { body.appendChild(sliderRow('ch-' + k, SLIDER_INFO[k][0], SLIDER_INFO[k][1], SLIDER_INFO[k][2], true)); });
          body.appendChild(field('Race', selectInput('ch-race', OPT_RACE, 'caucasian'), 'ch-race'));
          host.appendChild(body);
          const face = section('makehuman', 'face');
          FACE_KEYS.forEach(function (k) { face.appendChild(sliderRow('ch-face-' + k, FACE_LABELS[k], k === 'mouth-height' ? 'low' : '-', k === 'mouth-height' ? 'high' : '+', false)); });
          const fr = el('div', 'ch-actions'); fr.appendChild(onClick(mkBtn('ghost-sm', 'Reset face', 'ch-face-reset'), function () { FACE_KEYS.forEach(function (k) { C['ch-face-' + k].value = '0.5'; }); }));
          face.appendChild(fr); host.appendChild(face);
          const look = section('makehuman', 'look');
          look.appendChild(field('Skin', selectInput('ch-skin', OPT_SKIN, 'auto'), 'ch-skin'));
          look.appendChild(field('Eye colour', selectInput('ch-eyecolor', OPT_EYE, ''), 'ch-eyecolor'));
          look.appendChild(field('Hair', selectInput('ch-hair', OPT_HAIR, ''), 'ch-hair'));
          look.appendChild(field('Clothes', selectInput('ch-clothes', OPT_CLOTHES, ''), 'ch-clothes'));
          look.appendChild(toggleRow('ch-eyes', 'Eyes', true)); look.appendChild(toggleRow('ch-teeth', 'Teeth', true));
          look.appendChild(toggleRow('ch-brows', 'Brows', true)); look.appendChild(toggleRow('ch-lashes', 'Lashes', true));
          host.appendChild(look);
          const rig = section('makehuman', 'rig');
          rig.appendChild(field('Rig', selectInput('ch-rig', OPT_RIG, ''), 'ch-rig'));
          rig.appendChild(note('Animations need Rig = Mixamo. The same skeleton lets every clip in the list play on every saved character.'));
          host.appendChild(rig);
          const anim = section('makehuman', 'animate');
          const ar = el('div', 'ch-actions');
          ar.appendChild(onClick(mkBtn('secondary-sm', 'Add FBX', 'ch-anim-add'), function () { C['ch-anim-file'].click(); }));
          ar.appendChild(onClick(mkBtn('secondary-sm', 'Save FBX', 'ch-anim-save'), function () { const f = C['ch-anim-save-form']; f.hidden = !f.hidden; if (!f.hidden) { C['ch-anim-save-name'].value = 'my_clip'; C['ch-anim-save-name'].focus(); } }));
          anim.appendChild(ar);
          const file = el('input'); file.type = 'file'; file.setAttribute('accept', '.fbx'); file.hidden = true; reg(file, 'ch-anim-file');
          file.addEventListener('change', async function () {
            const f = file.files && file.files[0]; if (!f) return;
            setStatus('Uploading ' + f.name + '…');
            try {
              const buf = await f.arrayBuffer();
              const r = await deps.fetch('/upload-animation?name=' + encodeURIComponent(f.name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf });
              const j = await r.json();
              if (j && j.ok) { await loadData(); render(); setStatus('Added ' + j.name); } else setStatus('Upload failed: ' + ((j && j.error) || 'error'));
            } catch (_) { setStatus('Upload failed'); }
            file.value = '';
          });
          anim.appendChild(file);
          const sf = inlineForm('ch-anim-save-form');
          sf.appendChild(field('Clip name', textInput('ch-anim-save-name', 'my_clip'), 'ch-anim-save-name'));
          const sfa = el('div', 'ch-actions');
          sfa.appendChild(onClick(mkBtn('primary-sm', 'Save', 'ch-anim-save-go'), function () {
            const name = String(val('ch-anim-save-name')).trim(); if (!name) { C['ch-anim-save-name'].focus(); return; }
            const input = { name: name }; if (targetName()) input.character = targetName();
            sf.hidden = true; busy('Saving "' + name + '"…', 'save_animation', input);
          }));
          sfa.appendChild(onClick(mkBtn('ghost-sm', 'Cancel', 'ch-anim-save-cancel'), function () { sf.hidden = true; }));
          sf.appendChild(sfa); anim.appendChild(sf);
          anim.appendChild(note('The sequence, Animate and Describe a motion are in the middle column. Save FBX stores the animation on the selected character as a reusable clip.'));
          host.appendChild(anim);
        }
        function buildCustomRigInspector(host) {
          const rig = section('customrig', 'rig');
          const none = note('Pick a rig folder in the list, or + New character.'); reg(none, 'ch-cr-none'); rig.appendChild(none);
          const locked = el('div', 'ch-block'); reg(locked, 'ch-cr-locked');
          locked.appendChild(note('This folder has no skeleton yet. Select an armature in the scene (a rigged creature, a custom rig), then assign it. Every clip and mesh in this folder gets bound to that skeleton.'));
          locked.appendChild(onClick(mkBtn('secondary-sm', 'Assign selected skeleton', 'ch-cr-assign'), doAssign));
          rig.appendChild(locked);
          const un = el('div', 'ch-block'); reg(un, 'ch-cr-unlocked');
          const info = el('div', 'ch-info', ''); reg(info, 'ch-cr-info'); un.appendChild(info);
          const vr = selectInput('ch-cr-variant', [['rig', 'bare rig']], 'rig');
          const spawnRow = field('Spawn', vr, 'ch-cr-variant'); spawnRow.appendChild(onClick(mkBtn('secondary-sm', 'Spawn', 'ch-cr-spawn'), function () {
            const f = curFolder(); if (!f) return noFolder();
            const variant = val('ch-cr-variant') || 'rig';
            busy('Spawning ' + (variant === 'rig' ? 'bare rig' : variant) + ' from "' + f.name + '"…', 'spawn_rig', { folder: f.name, variant: variant });
          }));
          un.appendChild(spawnRow);
          const ra = el('div', 'ch-actions');
          ra.appendChild(onClick(mkBtn('ghost-sm', 'Re-assign skeleton', 'ch-cr-reassign'), function () { C['ch-cr-reassign-ask'].hidden = false; }));
          const ask = inlineForm('ch-cr-reassign-ask');
          ask.appendChild(el('span', 'ch-confirm', 'Re-assign this folder to the armature currently selected in the scene?'));
          ask.appendChild(onClick(mkBtn('primary-sm', 'Re-assign', 'ch-cr-reassign-yes'), function () { ask.hidden = true; doAssign(); }));
          ask.appendChild(onClick(mkBtn('ghost-sm', 'Cancel', 'ch-cr-reassign-no'), function () { ask.hidden = true; }));
          ra.appendChild(ask); un.appendChild(ra);
          un.appendChild(el('div', 'ch-label', 'Rig to mesh'));
          un.appendChild(field('Voxel', numInput('ch-cr-voxel', 0, 0, null, 0.001), 'ch-cr-voxel'));
          un.appendChild(toggleRow('ch-cr-remesh', 'Remesh', true));
          const ma = el('div', 'ch-actions');
          ma.appendChild(onClick(mkBtn('secondary-sm', 'Prepare', 'ch-cr-prepare'), function () {
            const f = curFolder(); if (!f) return noFolder();
            const voxel = parseFloat(val('ch-cr-voxel')), remesh = isOn('ch-cr-remesh');
            busy('Preparing the selected mesh' + (remesh ? ' (join + voxel remesh — can take minutes on a dense mesh)' : ' (join only)') + '…', 'prepare_mesh', { folder: f.name, voxel: isNaN(voxel) ? 0 : voxel, remesh: remesh });
          }));
          ma.appendChild(onClick(mkBtn('secondary-sm', 'Bind', 'ch-cr-bind'), function () {
            const f = curFolder(); if (!f) return noFolder();
            busy('Binding… (select the mesh AND this folder\'s rig; the rig must be in rest pose)', 'bind_mesh', { folder: f.name });
          }));
          ma.appendChild(onClick(mkBtn('secondary-sm', 'Save mesh', 'ch-cr-savemesh'), function () { const f2 = C['ch-cr-savemesh-form']; f2.hidden = !f2.hidden; if (!f2.hidden) C['ch-cr-savemesh-name'].focus(); }));
          un.appendChild(ma);
          const sm = inlineForm('ch-cr-savemesh-form');
          sm.appendChild(field('Variant name', textInput('ch-cr-savemesh-name', 'deer_hurt'), 'ch-cr-savemesh-name'));
          const sma = el('div', 'ch-actions');
          sma.appendChild(onClick(mkBtn('primary-sm', 'Save', 'ch-cr-savemesh-go'), function () {
            const f = curFolder(); if (!f) return noFolder();
            const name = String(val('ch-cr-savemesh-name')).trim(); if (!name) { C['ch-cr-savemesh-name'].focus(); return; }
            sm.hidden = true; busy('Saving mesh "' + name + '" to "' + f.name + '"… (select the mesh bound to this rig first)', 'save_mesh', { folder: f.name, name: name });
          }));
          sma.appendChild(onClick(mkBtn('ghost-sm', 'Cancel', 'ch-cr-savemesh-cancel'), function () { sm.hidden = true; }));
          sm.appendChild(sma); un.appendChild(sm);
          un.appendChild(note('Rig to mesh binds a bare mesh to this folder\'s skeleton in two steps, with your own work in between: Prepare joins the selected mesh pieces and voxel-remeshes them (Voxel 0 = derive it from the mesh size), Bind binds the result to the rig.'));
          rig.appendChild(un); host.appendChild(rig);
          const anim = section('customrig', 'animate');
          const nf = note('Pick a rig folder in the list, or + New character.'); reg(nf, 'ch-cr-none-animate'); anim.appendChild(nf);
          const ab = el('div', 'ch-block'); reg(ab, 'ch-cr-animate-block');
          ab.appendChild(onClick(mkBtn('secondary-sm', 'Save clip', 'ch-cr-saveclip'), function () { const f2 = C['ch-cr-saveclip-form']; f2.hidden = !f2.hidden; if (!f2.hidden) C['ch-cr-saveclip-name'].focus(); }));
          const sc = inlineForm('ch-cr-saveclip-form');
          sc.appendChild(field('Clip name', textInput('ch-cr-saveclip-name', 'walk'), 'ch-cr-saveclip-name'));
          const sca = el('div', 'ch-actions');
          sca.appendChild(onClick(mkBtn('primary-sm', 'Save', 'ch-cr-saveclip-go'), function () {
            const f = curFolder(); if (!f) return noFolder();
            const name = String(val('ch-cr-saveclip-name')).trim(); if (!name) { C['ch-cr-saveclip-name'].focus(); return; }
            sc.hidden = true; busy('Saving "' + name + '" to "' + f.name + '"… (select the animated rig in the scene first)', 'save_clip', { folder: f.name, name: name });
          }));
          sca.appendChild(onClick(mkBtn('ghost-sm', 'Cancel', 'ch-cr-saveclip-cancel'), function () { sc.hidden = true; }));
          sc.appendChild(sca); ab.appendChild(sc);
          ab.appendChild(note('Spawn the rig, keyframe your animation, then Save clip to store it in this folder. The sequence and Animate are in the middle column.'));
          anim.appendChild(ab); host.appendChild(anim);
        }
        function noFolder() { setStatus('Pick a rig folder in the list, or + New character.'); }
        function doAssign() {
          const f = curFolder(); if (!f) return noFolder();
          busy('Assigning the selected armature to "' + f.name + '"… (select the rig in the scene first)', 'assign_skeleton', { folder: f.name });
        }
        function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
        function renderInspector() {
          SECS.forEach(function (s2) { s2.el.hidden = !(s2.source === S.source && s2.step === S.step); });
          C['ch-card'].hidden = S.source !== 'makehuman';
          const f = curFolder();
          C['ch-cr-none'].hidden = !!f; C['ch-cr-none-animate'].hidden = !!f;
          C['ch-cr-locked'].hidden = !(f && !f.hasSkeleton); C['ch-cr-unlocked'].hidden = !(f && f.hasSkeleton);
          C['ch-cr-animate-block'].hidden = !f;
          if (f && f.hasSkeleton) {
            C['ch-cr-info'].textContent = plural(f.boneCount || 0, 'bone', 'bones') + ' · ' + plural((f.variants || []).length, 'variant', 'variants') + ' · ' + plural((f.clips || []).length, 'clip', 'clips');
            fillSelect(C['ch-cr-variant'], [['rig', 'bare rig']].concat((f.variants || []).map(function (v) { return [v, 'rig + ' + v]; })), val('ch-cr-variant'));
          }
        }

        // two-step card (MakeHuman) -----------------------------------------------------------------------------------------------------------
        function markMixamo() { if (S.buildRig === 'mixamo') { S.mixamoBuilt = true; if (C['ch-save-need']) C['ch-save-need'].hidden = true; } }
        function syncPlace() { const p = C['ch-place']; p.disabled = !S.placeReady; p.title = S.placeReady ? '' : 'Build a preview first.'; }
        function saveCheck() {
          const safe = safeName(val('ch-save-name')), hint = C['ch-save-hint'], go = C['ch-save-go'];
          const taken = S.chars.some(function (c) { return lc(c.name) === lc(safe); });
          if (!safe) { go.disabled = true; hint.textContent = 'Give the character a name.'; }
          else if (taken) { go.disabled = true; hint.textContent = '"' + safe + '" is taken — pick another'; }
          else { go.disabled = false; hint.textContent = 'Saves as "' + safe + '".'; }
        }
        function buildCard(host) {
          const card = el('div', 'ch-card'); reg(card, 'ch-card');
          card.appendChild(el('div', 'ch-label', '1 · Build preview'));
          card.appendChild(onClick(mkBtn('secondary', 'Rebuild preview', 'ch-rebuild'), function () {
            const input = {};
            SLIDERS.forEach(function (k) { input[k] = parseFloat(val('ch-' + k)); });
            input.race = {}; input.race[val('ch-race')] = 1;
            if (charName()) input.name = charName();
            if (val('ch-skin') === 'procedural') input.skin = false;   // "auto" = default -> omitted
            if (val('ch-eyecolor')) input.eyeColor = val('ch-eyecolor');
            if (val('ch-hair')) input.hair = val('ch-hair');
            if (val('ch-clothes')) input.clothes = val('ch-clothes');
            input.eyes = isOn('ch-eyes'); input.teeth = isOn('ch-teeth'); input.eyebrows = isOn('ch-brows'); input.eyelashes = isOn('ch-lashes');
            if (val('ch-rig')) input.rig = val('ch-rig');
            input.staged = true;   // build hidden, show the preview, commit on Place
            const ft = buildFaceTargets();
            if (Object.keys(ft).length) input.targets = ft;
            S.buildKey = curKey(); S.buildRig = val('ch-rig');
            S.placeReady = false; syncPlace();   // the rebuild replaces the staged figure; a refused one leaves nothing to place
            busy('Generating… (this can take a few seconds)', 'make_human', input);
          }));
          card.appendChild(el('div', 'ch-label', '2 · Place in scene'));
          const place = onClick(mkBtn('primary', 'Place in scene', 'ch-place'), function () {
            if (!S.placeReady) return;
            S.placeReady = false; syncPlace(); busy('Placing in scene…', 'place_human', {});
          });
          card.appendChild(place);
          const links = el('div', 'ch-actions');
          links.appendChild(onClick(mkBtn('ghost-sm', 'Save to saved characters', 'ch-save-open'), function () {
            const f = C['ch-save-form']; f.hidden = !f.hidden;
            if (!f.hidden) { C['ch-save-name'].value = safeName(charName()); saveCheck(); C['ch-save-name'].focus(); }
          }));
          links.appendChild(onClick(mkBtn('ghost-sm', 'Send to Unreal…', 'ch-unreal'), function () {
            busy('Sending the character in the scene to Unreal…', 'character_to_unreal', { name: curSaved() ? curSaved().name : undefined });
          }));
          card.appendChild(links);
          const sf = inlineForm('ch-save-form');
          const sn = textInput('ch-save-name', 'hero'); sn.addEventListener('input', saveCheck);
          sn.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') C['ch-save-go'].click(); });
          const need = el('div', 'ch-hint', 'Needs a Mixamo rig in the scene: Rig step = Mixamo, then Rebuild preview and Place in scene.'); reg(need, 'ch-save-need'); need.hidden = S.mixamoBuilt; sf.appendChild(need);
          sf.appendChild(field('Name', sn, 'ch-save-name'));
          const hint = el('div', 'ch-hint', ''); reg(hint, 'ch-save-hint'); hint.setAttribute('role', 'status'); sf.appendChild(hint);
          const sa = el('div', 'ch-actions');
          sa.appendChild(onClick(mkBtn('primary-sm', 'Save', 'ch-save-go'), function () {
            const safe = safeName(val('ch-save-name')); if (!safe) return;
            const rid = deps.newRequestId ? deps.newRequestId() : null;   // F2.6: the reply is matched to this save
            sf.hidden = true; S.saving = safe; S.savingId = rid; setStatus('Saving "' + safe + '"…'); deps.postAction('save_character', { name: safe }, undefined, rid);
          }));
          sa.appendChild(onClick(mkBtn('ghost-sm', 'Cancel', 'ch-save-cancel'), function () { sf.hidden = true; }));
          sf.appendChild(sa); card.appendChild(sf);
          host.appendChild(card);
        }

        // centre: preview + the one sequencer -------------------------------------------------------------------------------------------------
        function renderPreview() {
          const img = C['ch-preview-img'], ph = C['ch-preview-ph'];
          let url = '';
          S.posterShown = null;
          if (S.source === 'makehuman') {
            if (S.buildUrl && S.buildKey === curKey()) url = S.buildUrl;
            else { const c = curSaved(); if (c && c.posterStamp && !S.posterDead[posterKey(c)]) { url = posterSrc(c); S.posterShown = c; } }
          }
          ph.textContent = S.source === 'makehuman' ? 'No preview yet — build one on the right.' : 'Custom rigs have no preview image.';
          img.hidden = !url; ph.hidden = !!url;
          if (url && img.getAttribute('src') !== url) img.src = url;
        }
        function clips() { return S.source === 'makehuman' ? S.anims.slice() : (curFolder() ? (curFolder().clips || []).slice() : []); }
        function renderClipPick() {
          const items = clips(), sig = S.source + '|' + (S.source === 'customrig' ? S.sel.customrig : '') + '|' + items.join('\n');
          if (sig === S.pickSig) return;
          S.pickSig = sig;
          fillSelect(C['ch-seq-pick'], items.length ? items : [['', '— no clips —']], val('ch-seq-pick'));
        }
        function chainChanged() { S.played = false; }
        function renderChips() {
          const box = C['ch-seq-chips']; box.textContent = '';
          if (!S.chain.length) { box.appendChild(el('span', 'ch-note', 'No clips yet — pick one and press + clip.')); return; }
          S.chain.forEach(function (name, i) {
            if (i > 0) box.appendChild(el('span', 'ch-blend-mark', 'blend'));
            const chip = el('span', 'ch-chip'); chip.setAttribute('data-clip', name);
            chip.appendChild(el('span', 'ch-chip-name', name));
            const mk = function (act, label, aria, disabled, fn) {
              const cb = d.createElement('button'); cb.className = 'btn btn-ghost btn-sm'; cb.type = 'button'; cb.textContent = label; cb.setAttribute('data-act', act); cb.setAttribute('aria-label', aria + ' ' + name);
              cb.disabled = disabled; cb.addEventListener('click', fn); chip.appendChild(cb);
            };
            mk('up', 'Up', 'Move earlier:', i === 0, function () { const t2 = S.chain[i - 1]; S.chain[i - 1] = S.chain[i]; S.chain[i] = t2; chainChanged(); renderChips(); });
            mk('down', 'Down', 'Move later:', i === S.chain.length - 1, function () { const t2 = S.chain[i + 1]; S.chain[i + 1] = S.chain[i]; S.chain[i] = t2; chainChanged(); renderChips(); });
            mk('remove', 'Remove', 'Remove', false, function () { S.chain.splice(i, 1); chainChanged(); renderChips(); });
            box.appendChild(chip);
          });
        }
        function seqParams() {
          const blend = parseInt(val('ch-seq-blend'), 10);
          return { blend: isNaN(blend) ? 8 : blend };
        }
        function seqInput(clipList, append) {
          const base = seqParams();
          if (S.source === 'makehuman') {
            const sp = parseFloat(val('ch-seq-drift'));
            const input = { blend: base.blend, speed: isNaN(sp) ? 0 : sp };
            if (targetName()) input.character = targetName();
            input.fbxs = clipList; input.append = append; return input;
          }
          return { folder: S.sel.customrig, clips: clipList, blend: base.blend, append: append };
        }
        function sendSeq(clipList, append) { deps.postAction(S.source === 'makehuman' ? 'sequence_animations' : 'sequence_clips', seqInput(clipList, append)); }
        function buildMotionForm(host) {
          const mo = inlineForm('ch-mo'); mo.classList.add('ch-card');
          mo.appendChild(note('In English, describe the motion, not the character. It runs on your GPU (about 4 min for 6 s) and Phoenix stays usable meanwhile. The clip is saved and reusable. A hunched figure with bent forearms comes from the T-pose template, not your prompt (see Text to motion in the README).'));
          const ta = el('textarea', 'ch-text'); ta.value = ''; ta.placeholder = 'a person walks forward, stops and looks around'; ta.setAttribute('rows', '3'); reg(ta, 'ch-mo-prompt');
          mo.appendChild(field('Motion', ta, 'ch-mo-prompt'));
          mo.appendChild(field('Length (s)', numInput('ch-mo-secs', 6, 1, 20, 1), 'ch-mo-secs'));
          const ma = el('div', 'ch-actions');
          ma.appendChild(onClick(mkBtn('primary-sm', 'Generate and animate', 'ch-mo-go'), function () {
            const desc = String(val('ch-mo-prompt') || '').trim();
            if (!desc) { C['ch-mo-prompt'].focus(); return; }
            const secs = parseInt(val('ch-mo-secs'), 10);
            const input = { prompt: desc, duration: secs || 6 };
            if (targetName()) input.character = targetName();
            mo.hidden = true;
            startGenClock(desc, input.duration);
            deps.postAction('hy_motion', input);
          }));
          ma.appendChild(onClick(mkBtn('ghost-sm', 'Cancel', 'ch-mo-cancel'), function () { mo.hidden = true; }));
          mo.appendChild(ma); host.appendChild(mo);
        }
        // Text to motion takes minutes, so the status line gets a running clock: elapsed time only, no invented percentage. A job clock runs until its job ends.
        function stopGenClock() { if (S.clock) { S.clock.stop(); S.clock = null; } }
        function startGenClock(desc, secs) {
          stopGenClock();
          const t0 = Date.now(), eta = Math.max(120, Math.round(secs * 38));   // measured: ~230 s for 6 s
          const tick = function () {
            const e = Math.round((Date.now() - t0) / 1000);
            setStatus('Generating "' + desc + '" — ' + Math.floor(e / 60) + ':' + String(e % 60).padStart(2, '0') + ' of ~' + Math.round(eta / 60) + ' min. Phoenix stays usable.');
          };
          tick();
          S.clock = deps.jobClock(tick, 1000);
        }
        function buildCentre(host) {
          const pv = el('div', 'ch-preview'); reg(pv, 'ch-preview');
          const img = el('img', 'ch-preview-img'); img.alt = 'Preview'; img.hidden = true; reg(img, 'ch-preview-img');
          img.addEventListener('error', function () { img.hidden = true; C['ch-preview-ph'].hidden = false; if (S.posterShown) ensurePoster(S.posterShown); });
          pv.appendChild(img); pv.appendChild(reg(el('div', 'ch-preview-ph', 'No preview yet — build one on the right.'), 'ch-preview-ph'));
          host.appendChild(pv);
          const seq = el('section', 'ch-seq'); reg(seq, 'ch-seq');
          seq.appendChild(el('h3', 'ch-label', 'Animation sequence'));
          seq.appendChild(reg(el('div', 'ch-chips'), 'ch-seq-chips'));
          const row = el('div', 'ch-actions');
          row.appendChild(selectInput('ch-seq-pick', [['', '— no clips —']], ''));
          row.appendChild(onClick(mkBtn('secondary-sm', '+ clip', 'ch-seq-add'), function () {
            const clip = val('ch-seq-pick'); if (!clip) { setStatus('Pick a clip first.'); return; }
            S.chain.push(clip);
            if (S.played) { setStatus('Appending ' + clip + '… (to the end of the sequence)'); sendSeq([clip], true); }
            renderChips();
          }));
          row.appendChild(onClick(mkBtn('secondary-sm', 'Animate', 'ch-animate'), function () {
            const clip = val('ch-seq-pick'); if (!clip) { setStatus('Pick a clip, or use Describe a motion.'); return; }
            if (S.source === 'makehuman') {
              const input = { fbx: clip }; if (targetName()) input.character = targetName();
              busy('Animating from ' + clip + '… (retarget + bake)', 'animate_human', input);
            } else {
              const f = curFolder(); if (!f) return noFolder();
              busy('Applying "' + clip + '" onto the rig… (select the target rig in the scene first)', 'animate_clip', { folder: f.name, clip: clip });
            }
          }));
          seq.appendChild(row);
          const params = el('div', 'ch-actions');
          const bl = el('span', 'ch-param'); const bll = el('label', 'ch-lab', 'Blend'); bll.htmlFor = 'ch-seq-blend';
          bl.appendChild(bll); bl.appendChild(numInput('ch-seq-blend', 8, 0, 60, 1)); bl.appendChild(el('span', 'ch-unit', 'f'));
          params.appendChild(bl);
          const dr = el('span', 'ch-param'); reg(dr, 'ch-seq-drift-wrap'); const drl = el('label', 'ch-lab', 'Drift'); drl.htmlFor = 'ch-seq-drift';
          dr.appendChild(drl); const dri = numInput('ch-seq-drift', 0, null, null, 0.01); dri.title = 'Only for Mixamo "In Place" clips that carry no root motion. Leave at 0 for normal clips.';
          dr.appendChild(dri); dr.appendChild(el('span', 'ch-unit', 'm/f'));
          params.appendChild(dr); seq.appendChild(params);
          const go = el('div', 'ch-actions');
          go.appendChild(onClick(mkBtn('secondary-sm', 'Describe a motion…', 'ch-seq-describe'), function () {
            if (C['ch-seq-describe'].disabled) return;
            C['ch-mo-prompt'].value = ''; C['ch-mo-secs'].value = '6'; C['ch-mo'].hidden = false; C['ch-mo-prompt'].focus();
          }));
          go.appendChild(onClick(mkBtn('primary', 'Play sequence', 'ch-seq-play'), function () {
            if (!S.chain.length) { setStatus('Add clips to the sequence first.'); return; }
            if (S.source === 'customrig' && !curFolder()) return noFolder();
            setStatus('Building sequence (' + S.chain.length + ' clips)… ' + (S.source === 'makehuman' ? '(retarget + bake each)' : '(import + bake each — this takes a while)'));
            sendSeq(S.chain.slice(), false); S.played = true; S.playPending = true;
          }));
          seq.appendChild(go);
          buildMotionForm(seq);
          host.appendChild(seq);
        }
        function renderSeq() {
          const key = S.source + ':' + (S.source === 'customrig' ? S.sel.customrig : '');
          if (key !== S.chainKey) { S.chainKey = key; S.chain = []; S.played = false; renderChips(); }
          renderClipPick();
          const mh = S.source === 'makehuman';
          C['ch-seq-drift-wrap'].hidden = !mh; C['ch-seq-drift'].hidden = !mh;
          const ds = C['ch-seq-describe'];
          ds.disabled = !mh; ds.title = mh ? '' : 'Describe a motion works on MakeHuman characters (Mixamo skeleton).';
          if (!mh) C['ch-mo'].hidden = true;
        }

        // cast column + whole render --------------------------------------------------------------------------------------------------------
        function buildCast(host) {
          host.appendChild(el('h2', 'ch-label', 'Saved characters'));
          C.__castList = el('div', 'ch-cast-list'); host.appendChild(C.__castList);
          const wrap = el('div', 'ch-new-wrap');
          // M1.4: + New character always asks first: MakeHuman (a body from sliders) or Custom rig (a folder for your own creature)
          const closeChoice = function () { C['ch-new-choice'].hidden = true; C['ch-new'].setAttribute('aria-expanded', 'false'); };
          wrap.appendChild(onClick(mkBtn('secondary-sm', '+ New character', 'ch-new'), function () {
            const ch = C['ch-new-choice'];
            if (!ch.hidden) { closeChoice(); return; }
            C['ch-new-form'].hidden = true; ch.hidden = false; C['ch-new'].setAttribute('aria-expanded', 'true');
          }));
          C['ch-new'].setAttribute('aria-expanded', 'false');
          const choice = el('div', 'ch-choice'); choice.hidden = true; reg(choice, 'ch-new-choice');
          const opt = function (id, label, text, fn) {
            const o = el('div', 'ch-choice-opt');
            o.appendChild(onClick(mkBtn('secondary-sm', label, id), fn)); o.appendChild(el('div', 'ch-choice-line', text));
            choice.appendChild(o);
          };
          opt('ch-new-mh', 'MakeHuman', 'A human body from sliders, ready to rig and animate.', function () {
            closeChoice();
            if (S.source !== 'makehuman') { deps.switchTab('human'); if (S.source !== 'makehuman') setSource('makehuman'); }
            S.draftOpen = true;
            resetGenerator(); selectEntry('makehuman', ''); S.step = 'body'; render();
          });
          opt('ch-new-cr', 'Custom rig', 'A folder for your own rigged creature or mesh.', function () {
            closeChoice();
            if (S.source !== 'customrig') { deps.switchTab('customrig'); if (S.source !== 'customrig') setSource('customrig'); }
            const f = C['ch-new-form']; f.hidden = false; C['ch-new-name'].value = ''; C['ch-new-name'].focus();
          });
          wrap.appendChild(choice);
          wrap.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !choice.hidden) { closeChoice(); C['ch-new'].focus(); } });
          const nf = inlineForm('ch-new-form');
          const nn = textInput('ch-new-name', 'deer'); nn.setAttribute('aria-label', 'New rig folder name');
          nn.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') C['ch-new-go'].click(); else if (ev.key === 'Escape') nf.hidden = true; });
          nf.appendChild(nn);
          nf.appendChild(onClick(mkBtn('primary-sm', 'Create', 'ch-new-go'), async function () {
            const name = String(val('ch-new-name')).trim(); if (!name) { nn.focus(); return; }
            const r = await postJson('/custom-rig-create', { name: name });
            if (r.ok) { nf.hidden = true; S.draftOpen = false; await refresh((r.json.folder && r.json.folder.name) || name); } else setStatus(errOf(r, 'Could not create the rig folder.'));
          }));
          nf.appendChild(onClick(mkBtn('ghost-sm', 'Cancel', 'ch-new-cancel'), function () { nf.hidden = true; }));
          wrap.appendChild(nf); host.appendChild(wrap);
        }
        function crumbName() {
          if (S.source === 'customrig') return S.sel.customrig || 'Custom rig';
          return S.sel.makehuman || draftName();
        }
        function notifyCrumb() {
          const t2 = crumbName();
          if (lastCrumb === null) { lastCrumb = t2; return; }
          if (t2 !== lastCrumb) { lastCrumb = t2; deps.onCrumb(); }
        }
        function render() {
          renderSteps(); renderCast(); renderInspector(); renderSeq(); renderPreview(); syncPlace(); notifyCrumb();
        }

        // build -------------------------------------------------------------------------------------------------------------------------------
        root.textContent = '';
        const cast = el('aside', 'ch-col ch-cast'); reg(cast, 'ch-cast'); buildCast(cast);
        const centre = el('main', 'ch-col ch-centre'); reg(centre, 'ch-centre'); buildCentre(centre);
        const insp = el('aside', 'ch-col ch-inspector'); reg(insp, 'ch-inspector');
        const secHost = el('div', 'ch-secs'); buildMakeHumanInspector(secHost); buildCustomRigInspector(secHost);
        insp.appendChild(secHost); buildCard(insp);
        const st = el('div', 'ch-status', 'Rebuild preview builds a hidden preview. Place in scene drops it into the scene.'); st.setAttribute('role', 'status'); reg(st, 'ch-status'); insp.appendChild(st);
        root.appendChild(cast); root.appendChild(centre); root.appendChild(insp);
        buildSteps();
        SLIDERS.forEach(function (k) {
          C['ch-' + k].addEventListener('input', function () { readout('ch-' + k); if (k === 'age' || k === 'gender') readout('ch-height'); });
          readout('ch-' + k);
        });
        C['ch-name'].addEventListener('input', function () { renderCast(); notifyCrumb(); });
        render();

        const api = {
          refresh: refresh,
          setSource: setSource,
          source: function () { return S.source; },
          setStep: setStep,
          step: function () { return S.step; },
          crumbName: crumbName,
          previewReady: function (url) {
            S.buildUrl = url; if (S.buildKey === null) S.buildKey = curKey();
            S.placeReady = true; syncPlace(); renderPreview(); markMixamo();
            setStatus('Preview ready — press Place in scene to commit it.');
          },
          builtWithoutPreview: function (text) {
            if (FAILED.test(String(text || ''))) {   // a refused or failed build stages nothing: Place stays locked
              if (S.busy && S.busy.action === 'make_human') S.busy = null;
              setBad(readable(text)); return;
            }
            markMixamo();
            if (!S.placeReady) { S.placeReady = true; syncPlace(); setStatus('Built, but the preview render failed — press Place in scene to commit it anyway.'); }
          },
          // P5: the end event of a busy card action (reply / error / refusal), matched by action and, when it has one, by request id
          actionResult: function (action, text, isError, requestId) {
            const b = S.busy;
            if (!b || b.action !== action || (b.id && requestId !== b.id)) return;
            S.busy = null; text = String(text == null ? '' : text);
            if (isError || FAILED.test(text)) { setBad(readable(text)); return; }
            if (action === 'make_human') return;   // previewReady / builtWithoutPreview own the line
            setStatus(readable(text));
          },
          saveResult: function (text, isError, requestId) {
            const name = S.saving; if (!name) return;
            if (S.savingId && requestId !== S.savingId) return;   // F2.6 / R2: only the answer to this save's own request (a pending save without an id takes any reply)
            S.saving = ''; S.savingId = null; text = String(text == null ? '' : text);
            if (isError || text.indexOf('Saved character "') !== 0) {
              const st = C['ch-status']; if (st) { st.textContent = readable(text); st.classList.add('ch-bad'); }
              C['ch-save-form'].hidden = false; C['ch-save-name'].value = name; saveCheck();
              return;
            }
            setStatus(text); S.draftOpen = false; return refresh(name);
          },
          // R2: the stream dropped during a save and the server is idle again - the answer is lost, so look at the cast list instead of waiting
          reconnected: async function () {
            const name = S.saving;
            if (!name) {
              if (!S.busy) return;
              S.busy = null;   // the answer of a busy action was lost with the stream: read the lists again instead of waiting
              await refresh();
              setStatus('The connection dropped while Phoenix was working - check the scene and the list before trying again.');
              return;
            }
            S.saving = ''; S.savingId = null;
            const j = await getJson('/characters'); const ok = j && Array.isArray(j.characters);
            if (!ok) {
              const st0 = C['ch-status']; if (st0) { st0.textContent = 'The connection dropped during the save. Phoenix could not read the list, so "' + name + '" may have been saved. Look at the cast list before saving again.'; st0.classList.add('ch-bad'); }
              C['ch-save-form'].hidden = false; C['ch-save-name'].value = name; saveCheck();
              return;
            }
            S.chars = j.characters;
            if ((S.chars || []).some(function (c) { return c.name === name; })) { setStatus('Saved "' + name + '".'); S.draftOpen = false; return refresh(name); }
            const st = C['ch-status']; if (st) { st.textContent = 'The connection dropped during the save and "' + name + '" is not in the list. Save it again.'; st.classList.add('ch-bad'); }
            C['ch-save-form'].hidden = false; C['ch-save-name'].value = name; saveCheck();
          },
          savePending: function () { return !!S.saving || !!S.busy; },
          // F3.2: the answer to Play sequence. A failed Play means nothing was built, so + clip must not append to it.
          sequenceResult: function (text, isError) {
            if (!S.playPending) return;
            S.playPending = false;
            if (isError || /^(ERROR|[A-Z_]+_ERROR|BLENDER_UNREACHABLE|REJECTED|BUSY)/.test(String(text == null ? '' : text))) S.played = false;
          },
          stopGenClock: stopGenClock,
          openCharacter: async function (name) {
            if (S.source !== 'makehuman') { deps.switchTab('human'); if (S.source !== 'makehuman') setSource('makehuman'); }
            await refresh(name);
          },
          enter: function () { S.ghosts = []; return refresh(); },
        };
        return api;
      }
      // </r5a-characters>

      // The one instance of the page. window.__charactersWs is what the shell (crumb), switchTab (source), the Library (Open in Characters) and
      // the reply handlers (preview, clock) talk to; the three refresh hooks of the old tabs stay, and the replies that call all of them in one go
      // cost ONE read of the lists.
      (function wireCharactersWorkspace() {
        const root = document.getElementById('panel-characters'), steps = document.getElementById('char-steps');
        if (!root || !steps) return;
        const api = makeCharactersWs({
          document: document, root: root, steps: steps,
          fetch: function (u, o) { return fetch(u, o); },
          postAction: function (a, i, o, id) { return postAction(a, i, o, id); },
          newRequestId: function () { return newRequestId(); },
          switchTab: function (t) { return switchTab(t); },
          jobClock: function (fn, ms) { return jobClock(fn, ms); },
          renderPoster: function (o) { return window.__renderCharacterPoster ? window.__renderCharacterPoster(o) : Promise.resolve(null); },
          onCrumb: function () { shellRender(); },
        });
        window.__charactersWs = api;
        let pending = null, pendingName = '';
        function refreshSoon(name) {
          if (name) pendingName = name;
          if (!pending) pending = Promise.resolve().then(function () { const n = pendingName; pendingName = ''; pending = null; return api.refresh(n); });
          return pending;
        }
        window.__phoenixRefreshChars = refreshSoon;
        window.__phoenixRefreshRigs = refreshSoon;
        window.__phoenixRefreshAnims = refreshSoon;
        window.__phoenixStopGenClock = api.stopGenClock;
      })();

