      // ── i2i / Edit sub-tab (v1.8) ─────────────────────────────────────────────
      (function initI2I() {
        const subBtns   = document.querySelectorAll('.img-subtab-btn');
        const subView   = document.getElementById('imgsub-view');
        const subEdit   = document.getElementById('imgsub-edit');
        const refImg    = document.getElementById('i2i-ref-img');
        const refPh     = document.getElementById('i2i-ref-ph');
        // <b2r-engine-line> the engine is the ACTIVE i2i workflow (cfg.workflows.i2i) — a read-only line; it is changed in Library → Workflows
        const activeEngine = { id: '', mode: 'edit' };
        const freetext  = document.getElementById('i2i-freetext');
        const cfgInput  = document.getElementById('i2i-cfg');
        const cfgVal    = document.getElementById('i2i-cfg-val');
        const applyBtn  = document.getElementById('i2i-apply');
        const statusEl  = document.getElementById('i2i-status');
        const gallery   = document.getElementById('i2i-gallery');
        const galleryPh = document.getElementById('i2i-gallery-ph');
        const artImg    = document.getElementById('artImage');
        const presetsEl = document.getElementById('i2i-presets');
        const cfgRow    = cfgInput ? cfgInput.closest('.i2i-cfg-row') : null;
        if (!subEdit) return;   // defensive: markup not present

        // Presets per engine MODE. edit = appearance/material quick-starts (fill the free-text and run);
        // segment = common isolation targets (the prompt for SAM3 IS the thing to cut out).
        const PRESETS = {
          edit: [
            ['Rusty / weathered', 'make the surface rusty, weathered and oxidized, keep the exact same shape and background'],
            ['Bronze metal',      'change the material to dark oxidized bronze metal, keep the exact same shape and background'],
            ['Carved stone',      'change the material to carved grey stone, keep the exact same shape and background'],
          ],
          segment: [
            ['Isolate subject', 'the main subject'],
            ['Clothing',        'the clothing'],
            ['Held item',       'the held item'],
            ['Head',            'the head'],
          ],
        };
        function renderPresets(mode) {
          if (!presetsEl) return;
          presetsEl.innerHTML = '';
          (PRESETS[mode === 'segment' ? 'segment' : 'edit'] || []).forEach(function (p) {
            const b = document.createElement('button');
            b.className = 'i2i-preset'; b.textContent = p[0]; b.dataset.instr = p[1];
            b.addEventListener('click', function () { freetext.value = p[1]; doApply(p[1]); });
            presetsEl.appendChild(b);
          });
        }
        // Swap settings + text when the engine changes: an edit engine has a CFG/strength knob and
        // appearance presets; a segmenter has neither — it takes only "what to isolate".
        function applyEngineMode(mode) {
          const seg = (mode === 'segment');
          if (cfgRow) cfgRow.style.display = seg ? 'none' : '';
          freetext.placeholder = seg
            ? 'what to isolate, e.g. "the clothing", "a held weapon", "the head" — the segmenter cuts it out on white'
            : 'free-text edit, e.g. "turn the cloak deep red" or "make it glow" — appearance / material / style (NOT removing parts or a new camera angle)';
          renderPresets(mode);
        }
        let refPath = null;     // the `p` path of the current reference image (server-relative)

        function pOf(url) {
          try { return decodeURIComponent(new URL(url, window.location.href).searchParams.get('p') || ''); }
          catch (_) { return ''; }
        }

        function setReference(url) {
          if (!url) return;
          refImg.src = url;
          refImg.classList.add('loaded');
          if (refPh) refPh.style.display = 'none';
          refPath = pOf(url) || null;
        }
        // Called from setArtifact when a fresh main image lands — the newest image becomes the
        // reference (and resets any refine chain). Exposed so setArtifact can reach it.
        window.__i2iOnImage = function (url) { setReference(url); document.getElementById('i2i-src-from').textContent = 'From: the current image'; };

        function switchSub(which) {
          if (typeof currentSub !== 'undefined') currentSub = which;
          if (window.__syncCreateRight) window.__syncCreateRight();
          subBtns.forEach(function (b) { const chosen = b.dataset.subtab === which; b.classList.toggle('active', chosen); b.setAttribute('aria-pressed', String(chosen)); });
          subView.classList.toggle('visible', which === 'view');
          subEdit.classList.toggle('visible', which === 'edit');
          // Entering Edit with no reference yet but a main image present → adopt it.
          if (which === 'edit' && !refPath && artImg && artImg.src && artImg.classList.contains('loaded')) {
            setReference(artImg.src);
            document.getElementById('i2i-src-from').textContent = 'From: the current image';
          }
        }
        window.__i2iSwitchSub = switchSub;
        document.getElementById('i2i-src-replace').addEventListener('click', function () { document.getElementById('image-file').click(); });
        subBtns.forEach(b => b.addEventListener('click', () => switchSub(b.dataset.subtab)));

        // LC2h: the slider only overrides the saved CFG (Advanced) once the user has moved it since the last refresh; until then Apply sends no cfg
        let cfgTouched = false;
        cfgInput.addEventListener('input', () => { cfgTouched = true; cfgVal.textContent = Number(cfgInput.value).toFixed(1); });

        // Read the active i2i workflow (GET /workflows → active.i2i) and sync the line + presets/CFG to its mode. Called on load and again
        // after a Library activation (activateWorkflow). SAM3 / any other i2i entry works the same — no UI change needed.
        window.__refreshEngineLines = async function () {
          cfgTouched = false;   // LC2h: every refresh drops an earlier slider override - even when the fetches below fail
          try {
            const r = await fetch('/workflows');
            if (!r.ok) return;
            const reg = await r.json();
            const wfs = (reg && reg.workflows) || {};
            const id = reg && reg.active && reg.active.i2i;
            const e = id && wfs[id] && wfs[id].stage === 'i2i' ? wfs[id] : null;
            activeEngine.id   = e ? id : '';
            activeEngine.mode = (e && e.mode) || 'edit';
            applyEngineMode(activeEngine.mode);   // sync settings+text to the active engine
            // LC2h: show the workflow's saved CFG (Advanced) on the slider; a failed fetch changes nothing and never blocks the tab
            if (e) {
              try {
                const pr = await fetch('/workflows/params?id=' + encodeURIComponent(id));
                if (pr.ok) {
                  const pv = await pr.json();
                  const cp = ((pv && pv.params) || []).find(function (x) { return x && x.key === 'cfg'; });
                  if (cp && typeof cp.value === 'number' && Number.isFinite(cp.value)) { cfgInput.value = String(cp.value); cfgVal.textContent = Number(cfgInput.value).toFixed(1); }
                }
              } catch (_) { /* keep the slider as it was */ }
            }
          } catch (_) { /* leave the line as it was */ }
        };
        window.__refreshEngineLines();

        function doApply(instruction) {
          const prompt = (instruction != null ? instruction : freetext.value).trim();
          if (!refPath) { statusEl.textContent = 'No reference image — generate or load one in the Image sub-tab first.'; return; }
          if (!prompt)  { statusEl.textContent = 'Type an instruction or pick a preset first.'; return; }
          const input = { image: refPath, prompt };
          if (cfgTouched) input.cfg = Number(cfgInput.value);   // untouched slider → the stored CFG is used server-side
          if (activeEngine.id) input.workflowId = activeEngine.id;
          statusEl.textContent = 'Editing… Qwen-Image-Edit takes a few minutes (≈3–4 min on a 10 GB card). A new tile appears when done.';
          postAction('i2i_edit', input);
        }
        window.__i2iClearStatus = function () { statusEl.textContent = ''; };

        applyBtn.addEventListener('click', () => doApply(null));

        // A finished edit arrives as {kind:'artifact', slot:'i2i-tile', url, meta}. Add a tile —
        // additive, never replacing. Exposed so the SSE handler can reach it.
        const results = []; let selectedResult = null;
        const meshResult = document.getElementById('i2i-act-mesh'), sourceResult = document.getElementById('i2i-act-source'), storyboardResult = document.getElementById('i2i-act-storyboard');
        function selectResult(result) {
          selectedResult = result;
          results.forEach(function (r) { r.tile.classList.toggle('selected', r === result); r.pick.setAttribute('aria-pressed', String(r === result)); });
          [meshResult, sourceResult, storyboardResult].forEach(function (b) { b.disabled = !result; b.title = result ? '' : 'Pick a result first'; });
        }
        meshResult.addEventListener('click', function () { if (selectedResult) postAction('image_to_3d', { image: pOf(selectedResult.url) }); });
        sourceResult.addEventListener('click', function () { if (selectedResult) { setReference(selectedResult.url); document.getElementById('i2i-src-from').textContent = 'From: edit result'; } });
        storyboardResult.addEventListener('click', function () { if (selectedResult) imagesTab.addToStoryboard(pOf(selectedResult.url), document.getElementById('i2i-result-status')); });
        window.__i2iAddTile = function (obj) {
          if (galleryPh) galleryPh.style.display = 'none';
          statusEl.textContent = '';
          const meta = obj.meta || {};
          const tile = document.createElement('div');
          tile.className = 'i2i-tile';
          const img = document.createElement('img');
          img.src = obj.url; img.alt = meta.prompt || 'edit';
          const label = document.createElement('div');
          label.className = 'i2i-tile-meta';
          label.textContent = (meta.workflowId || 'edit') + (meta.seconds ? ' · ' + meta.seconds + 's' : '');
          const pick = document.createElement('button'); pick.type = 'button'; pick.setAttribute('type', 'button'); pick.setAttribute('aria-pressed', 'false');
          pick.appendChild(img); tile.appendChild(pick); tile.appendChild(label);
          const result = { tile: tile, pick: pick, url: obj.url };
          results.push(result);
          pick.addEventListener('click', function () { selectResult(result); });
          gallery.appendChild(tile);
          document.getElementById('i2i-count').textContent = String(results.length);
          selectResult(result);
        };
      })();

      // Wording stays with each tab — R5b: the Audio card line (and its visiblePoll) lives in the Audio module (js-45).

