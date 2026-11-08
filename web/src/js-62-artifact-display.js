      // ── Artifact display ─────────────────────────────────────────────────────

      // LC2f (AW-L2): the one word every 'not finished a run through Phoenix yet' badge shows (Library list, workflow window, ③). The ③ factory is evaluated on its own in the tests, so it reads this with a typeof fallback.
      const UNVERIFIED_BADGE = 'unverified';
      function setArtifact(obj) {
        if (obj.slot === 'prompt') {
          createPipe.set({ have: { prompt: !!obj.text }, approved: false });
          artPromptEl.textContent = obj.text || '';
          promptPlaceholder.style.display = obj.text ? 'none' : '';
          if (promptEditEl) promptEditEl.value = obj.text || '';
          if (imagePromptEditEl) imagePromptEditEl.value = obj.text || '';
          switchTab('prompt');
        } else if (obj.slot === 'image') {
          if (['library', 'upload', 'inspect'].indexOf(obj.source) < 0) createPipe.set({ have: { image: true }, approved: createPipe.view()[0].state === 'done' });
          artImageEl.src = obj.url;
          artImageEl.classList.add('loaded');
          imagePlaceholder.style.display = 'none';
          switchTab('image');
          imageFromUser = (obj.source === 'upload');
          updateRegenImageLock();
          // A generated/uploaded image becomes the i2i reference — but an inspect render-check must
          // NOT: it would silently hijack an in-progress edit chain so the next Apply edits the
          // diagnostic screenshot instead of the asset. (F3, 2026-08-06)
          if (obj.source !== 'inspect' && window.__i2iOnImage) window.__i2iOnImage(obj.url);
        } else if (obj.slot === 'video') {   // v1.10 VP1: the Video tab (preview only)
          videoTab.show(obj);
          switchTab('video');
        } else if (obj.slot === 'mesh') {
          createPipe.set({ have: { mesh: true, scene: false } });
          artMeshEl.src = obj.url;
          artMeshEl.classList.add('loaded');
          meshPlaceholder.style.display = 'none';
          switchTab('mesh');
          try {
            const pParam = new URL(obj.url, window.location.href).searchParams.get('p');
            if (pParam) {
              const relPath = decodeURIComponent(pParam);
              const parts = relPath.split('/');
              if (parts.length >= 2) {
                const fileName = parts[parts.length - 1];
                const category = parts[parts.length - 2];
                currentMesh = { name: fileName, category: category };
              }
            }
          } catch (_) {}
          if (meshFacesEl && !meshFacesEl.value && currentMesh && FACE_DEFAULTS[currentMesh.category]) {
            meshFacesEl.value = FACE_DEFAULTS[currentMesh.category];
          }
          meshFromLibrary = (obj.source === 'library');
          updateRegenLock();
        } else if (obj.slot === 'human') {
          if (window.__charactersWs) window.__charactersWs.previewReady(obj.url);
          switchTab('human');
        }
      }

      // ── Helpers ─────────────────────────────────────────────────────────────

      // M2 MINOR 9: the raw brush-save marker line is for the page's own save row, never for chat text.
      function stripBrushMarker(text) {
        return String(text == null ? '' : text).split(/\r?\n/).filter(function (l) { return !/^\s*PHX_BRUSH_SAVED/.test(l); }).join('\n');
      }

      function appendBubble(cls, text) {
        const div = document.createElement('div');
        div.className = 'bubble ' + cls;
        div.textContent = stripBrushMarker(text);
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return div;
      }

      // <a2-meter>
      // A2: the context meter under the chat input. Each reply carries context { used, limit, exchanges }; shown as
      // "3.2k / 16k · 4 exchanges" ("?" when the seat's context is unknown), warning colour above 90 % of the limit.
      // deps: { document }.
      function makeA2Meter(deps) {
        function k(n) {
          const v = Math.max(0, Number(n) || 0) / 1000;
          return (v < 9.95 ? v.toFixed(1) : String(Math.round(v))) + 'k';
        }
        function format(used, limit, exchanges) {
          const hasLimit = Number.isFinite(limit) && limit > 0;
          const ex = Math.max(0, Math.floor(Number(exchanges) || 0));
          return {
            text: k(used) + ' / ' + (hasLimit ? k(limit) : '?') + ' · ' + ex + ' exchanges',
            warn: hasLimit && Number(used) > 0.9 * limit,
          };
        }
        function update(ctx) {
          const el = deps.document.getElementById('ctx-meter');
          if (!el || !ctx || typeof ctx !== 'object') return null;
          const f = format(ctx.used, ctx.limit, ctx.exchanges);
          el.textContent = f.text;
          el.className = f.warn ? 'warn' : '';
          el.hidden = false;
          return f;
        }
        return { format: format, update: update };
      }
      // </a2-meter>
      const a2Meter = makeA2Meter({ document: document });

      // <remesh-ui>
      var remeshProgressEl = null;
      // M10: the % lives on the source asset's Library tile (badge), keyed by "<category>/<name>"; the state survives a Library re-render
      var remeshBadges = {};
      function applyRemeshBadges() {
        try {
          document.querySelectorAll('.lib-item[data-kind="asset"], .lib-tile[data-kind="asset"]').forEach(function (el) {
            const key = el.dataset.category + '/' + el.dataset.name;
            let b = el.querySelector('.lib-badge');
            if (Object.prototype.hasOwnProperty.call(remeshBadges, key)) {
              if (!b) { b = document.createElement('span'); b.className = 'lib-badge'; el.appendChild(b); }
              b.textContent = '⟳ ' + remeshBadges[key] + '%';
            } else if (b) b.remove();
          });
        } catch (_) {}
      }
      function setRemeshBadge(asset, pct) { if (!asset) return; remeshBadges[asset] = pct; applyRemeshBadges(); }
      function clearRemeshBadges() { remeshBadges = {}; applyRemeshBadges(); }
      function clearRemeshProgress() { try { if (remeshProgressEl && remeshProgressEl.parentNode) remeshProgressEl.parentNode.removeChild(remeshProgressEl); } catch (_) {} remeshProgressEl = null; clearRemeshBadges(); try { if (typeof refreshRemeshBalance === 'function') refreshRemeshBalance(); } catch (_) {} }
      // one handler for every remesh notice: progress (badge + the one chat line) or done (any end of the job: clears both)
      function onRemeshNotice(obj) {
        if (obj.done === true) { clearRemeshProgress(); try { if (typeof refreshLibrary === 'function') refreshLibrary(); } catch (_) {} return; }
        if (obj.asset) setRemeshBadge(obj.asset, Math.round(Number(obj.pct) || 0));
        if (!remeshProgressEl || !remeshProgressEl.isConnected) remeshProgressEl = appendBubble('phoenix', 'Remeshing ' + String(obj.asset || '').split('/').pop() + ' on Meshy…');   // one line, no percent (the % is on the tile)
      }
      // Sweep 2 G9: REMESH_ON / REMESH_DEFAULTS used to be set only when the gear or Settings was opened — after a reload the Library had no
      // "Remesh via Meshy…". Read them once at startup and re-render the Library entry (loadAssets).
      async function restoreRemeshConfig() {
        try {
          const c = await (await fetch('/config')).json();
          const rmc = (c && c.remesh) || {};
          REMESH_ON = rmc.enabled === true;
          REMESH_DEFAULTS = { topology: rmc.topology === 'triangle' ? 'triangle' : 'quad', targetPolycount: rmc.targetPolycount !== undefined ? rmc.targetPolycount : 20000 };
          if (typeof loadAssets === 'function') loadAssets();
        } catch (_) { /* the Library simply shows no Remesh entry until Settings is opened */ }
      }
      async function syncRemeshStatus() {
        try {
          const j = await (await fetch('/remesh-status')).json();
          if (j && j.running && j.asset) {
            setRemeshBadge(j.asset, Math.round(Number(j.progress) || 0));
            if (!remeshProgressEl) remeshProgressEl = appendBubble('phoenix', 'Remeshing ' + String(j.asset).split('/').pop() + ' on Meshy…');
          } else if (j && j.running === false && (remeshProgressEl || Object.keys(remeshBadges).length)) {
            clearRemeshProgress();   // R1: the job ended while the stream was down — drop the stale badge + line
          }
        } catch (_) {}
      }
      // </remesh-ui>

      function setInputEnabled(on) {
        inputEl.disabled  = !on;
        sendBtn.disabled  = !on;
        if (on) inputEl.focus();
      }

      function setActionsEnabled(on) {
        document.querySelectorAll('.art-btn').forEach(b => b.disabled = !on);
      }

      // hy_motion spends ~4 minutes generating in ComfyUI and only touches Blender at the very
      // end, which is why the server defers the lock for it (server.js, defersLock). Greying the
      // whole UI out for that whole time would contradict the three places that promise "Phoenix
      // stays usable meanwhile" — and would be a lie about a server that is genuinely free.
      // i2i_edit joins hy_motion here: it spends ~3–4 min generating in ComfyUI and never touches
      // Blender, so the server defers the lock for it too — the UI must stay live meanwhile (a tile
      // arrives via SSE when done), not grey out for the whole edit. (Q3, 2026-08-06)
      const NON_BLOCKING_ACTIONS = ['hy_motion', 'i2i_edit', 'generate_from_refs', 'remesh_asset'];   // remesh: cloud job, no lock held

      // How many blocking operations are in flight. A non-blocking action finishing must NOT
      // re-enable the UI while a blocking one is still running — otherwise the buttons light up
      // mid-flight and every click bounces off with "busy". Counted rather than a boolean because
      // a chat turn and an action can overlap.
      let blockingInFlight = 0;
      function releaseUi(action) {
        if (typeof noteActivity === 'function') noteActivity();
        if (stageOfAction(action)) createPipe.set({ running: null });
        if (action && NON_BLOCKING_ACTIONS.includes(action)) return;   // was never blocking
        blockingInFlight = Math.max(0, blockingInFlight - 1);
        if (blockingInFlight === 0) { setInputEnabled(true); setActionsEnabled(true); }
      }

      // <sse-sync>
      // Sweep 2 G12: a completion event lost while the stream was down leaves blockingInFlight > 0 and the controls disabled until a reload.
      // On every (re)open of the stream ask the server (GET /mcp/status: { job, busy }). `busy` is the chat/Blender LOCK = a blocking turn is running.
      // No blocking turn -> release the blocking state, whatever detached job (hy_motion, i2i, image/mesh) is still running: those are non-blocking.
      // R3: the page may still wait for a save whose answer was lost with the stream (window stubs may lack savePending -> false).
      let reconcileClock = null;
      function savesPending() {
        try { if (window.__charactersWs && window.__charactersWs.savePending && window.__charactersWs.savePending()) return true; } catch (_) {}
        try { if (window.__brushSaveRow && window.__brushSaveRow.savePending && window.__brushSaveRow.savePending()) return true; } catch (_) {}
        return false;
      }
      // What the page itself is doing right now (blocking operations in flight + whether a save waits for its answer): a /mcp/status answer is only trusted when this did not change while it was on its way.
      // G6: a monotonic generation, bumped on every blocking start / end (and so on every save start / answer, which ride on them); equal counts at two moments no longer look like the same state.
      let activityGen = 0;
      function noteActivity() { activityGen++; }
      function pageActivity() { return activityGen + ':' + blockingInFlight + ':' + (savesPending() ? 1 : 0); }
      function settleLostSaves() {
        try { if (window.__charactersWs && window.__charactersWs.reconnected) window.__charactersWs.reconnected(); } catch (_) {}
        try { if (window.__brushSaveRow && window.__brushSaveRow.reconnected) window.__brushSaveRow.reconnected(); } catch (_) {}
      }
      function stopReconcile() { if (reconcileClock) { try { reconcileClock.stop(); } catch (_) {} reconcileClock = null; } }
      // A job clock (it runs while a job runs): every 3 s ask whether the server is idle yet; then settle once and stop.
      async function reconcileTick() {
        if (!savesPending()) { stopReconcile(); return; }
        const was = pageActivity();
        try {
          const j = await (await fetch('/mcp/status')).json();
          if (pageActivity() !== was) return;   // G6: something started or ended while the answer was on its way - it describes an older state, the next tick asks again
          if (j && j.busy === false) { stopReconcile(); settleLostSaves(); }
        } catch (_) { /* a failed read keeps the clock running */ }
      }
      async function releaseStaleUi() {
        const was = pageActivity();
        try {
          const j = await (await fetch('/mcp/status')).json();
          if (pageActivity() !== was) return;   // G6: a newer action began (or one ended) while the answer was on its way: reconcile nothing from a reading older than the page's own state
          if (j && j.busy === false) {   // R2: nothing is running on the server, so a save the page still waits for lost its answer with the stream
            stopReconcile();
            settleLostSaves();
          } else if (j && j.busy === true && !reconcileClock && savesPending()) {
            reconcileClock = jobClock(reconcileTick, 3000);
          }
          if (j && j.busy === false && !j.job) createPipe.set({ running: null });
          if (j && j.busy === false && blockingInFlight > 0) { blockingInFlight = 0; setInputEnabled(true); setActionsEnabled(true); }
        } catch (_) { /* unknown: leave the UI as it is */ }
      }
      // </sse-sync>

      let pendingActionOrigin = null;
      // F2.6: every /action post carries an id; the server echoes it on the reply, so an answer is matched to its own request
      let requestSeq = 0;
      function newRequestId() { return 'r' + Date.now().toString(36) + '-' + (++requestSeq); }
      function settleActionOrigin(action, text, isError, requestId) {
        if (window.__charactersWs && window.__charactersWs.actionResult) window.__charactersWs.actionResult(action, text, !!isError, requestId);   // the card settles its own busy status
        if (action === 'save_character' && window.__charactersWs) window.__charactersWs.saveResult(text, !!isError, requestId);
        if ((action === 'sequence_animations' || action === 'sequence_clips') && window.__charactersWs && window.__charactersWs.sequenceResult) window.__charactersWs.sequenceResult(text, !!isError);
        if (action === 'save_as_brush' && window.__brushSaveRow) window.__brushSaveRow.onResult(text, !!isError, requestId);
        const pending = pendingActionOrigin;
        if (!pending || pending.action !== action) return;
        if (pending.requestId && pending.requestId !== requestId) return;   // an identified origin takes only the reply that carries its id (a pending one without an id takes any reply)
        const origin = pending.origin;
        origin.removeAttribute('aria-busy');
        if (pending.title == null) origin.removeAttribute('title'); else origin.setAttribute('title', pending.title);
        const tile = origin.closest('.lib-tile'), row = origin.closest('.lib-item, .lib-list-row');
        const anchor = tile || row || origin;
        const old = tile ? null : anchor.nextElementSibling;
        if (old && old.classList.contains('lib-msg')) old.remove();
        const message = String(text || '').split(/\r?\n/).filter(function (l) { return !/^\s*PHX_BRUSH_SAVED/.test(l); })[0] || '';   // M2 MINOR 9: never the raw marker line
        if (isError || /^(ERROR|[A-Z_]+_ERROR|BLENDER_UNREACHABLE|REJECTED)/.test(message)) {
          if (tile) {
            libTileProblem(tile, readableReply(text), /blender/i.test(message) ? { label: 'How to connect Blender', run: openTroubleshooter } : undefined, 'action');
            pendingActionOrigin = null; return;
          }
          const line = document.createElement('div'); line.className = 'lib-msg'; line.setAttribute('role', 'status'); line.textContent = readableReply(message);
          if (/blender/i.test(message)) {
            const how = document.createElement('button'); how.className = 'btn btn-secondary btn-sm'; how.textContent = 'How to connect Blender';
            how.addEventListener('click', function () { openTroubleshooter(); }); line.appendChild(how);
          }
          anchor.after(line);
        }
        if (tile && !(isError || /^(ERROR|[A-Z_]+_ERROR|BLENDER_UNREACHABLE|REJECTED)/.test(message))) libTileProblemClear(tile, 'action');
        // M2 MINOR 9: a tile / row Replace shows its result line right there (the chat bubble is not where the operator is looking)
        if (action === 'save_as_brush' && message && !(isError || /^(ERROR|[A-Z_]+_ERROR|BLENDER_UNREACHABLE|REJECTED)/.test(message))) {
          const okLine = document.createElement('div'); okLine.className = 'lib-msg lib-msg-ok'; okLine.setAttribute('role', 'status'); okLine.textContent = message;
          if (tile) { const o = tile.querySelector('.lib-msg-ok'); if (o) o.remove(); tile.appendChild(okLine); } else anchor.after(okLine);
        }
        pendingActionOrigin = null;
      }

      async function postAction(action, input, origin, requestId) {
        const rid = requestId || newRequestId();
        if (origin) {
          if (pendingActionOrigin) { const previous = pendingActionOrigin; previous.origin.removeAttribute('aria-busy'); if (previous.title == null) previous.origin.removeAttribute('title'); else previous.origin.setAttribute('title', previous.title); }
          pendingActionOrigin = { action: action, origin: origin, title: origin.getAttribute('title'), requestId: rid }; origin.setAttribute('aria-busy', 'true'); origin.setAttribute('title', 'Working…');
        }

        const blocking = !NON_BLOCKING_ACTIONS.includes(action);
        if (stageOfAction(action)) createPipe.set({ running: stageOfAction(action) });
        if (blocking) {
          blockingInFlight++; if (typeof noteActivity === 'function') noteActivity();
          setActionsEnabled(false);
          setInputEnabled(false);
        }
        clearGateWaiting();
        // Any early return here means the run never got queued — the i2i "Editing… ~3–4 min" status
        // (set in doApply BEFORE this call) would otherwise hang forever, since only a tile or an SSE
        // error clears it. Clear it on every non-queued exit. (F5, 2026-08-06)
        const bailI2i = () => { if (action === 'i2i_edit' && window.__i2iClearStatus) window.__i2iClearStatus(); };
        const bailHy = () => { if (action === 'hy_motion' && window.__phoenixStopGenClock) window.__phoenixStopGenClock(); };
        let res;
        try {
          res = await fetch('/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, input, requestId: rid }) });
        } catch (err) {
          appendBubble('error', 'Network error: ' + err.message);
          settleActionOrigin(action, 'Network error: ' + err.message, true, rid);
          bailI2i(); bailHy();
          releaseUi(action);
          return;
        }
        if (res.status === 409) {
          settleActionOrigin(action, 'Busy — another action is running', true, rid);
          appendBubble('busy-note', action === 'remesh_asset' ? 'A remesh is already running' : 'busy… try again in a moment');
          bailI2i(); bailHy();
          releaseUi(action);
          return;
        }
        if (!res.ok) {
          const b = await res.text();
          appendBubble('error', 'Server error ' + res.status + ': ' + b);
          settleActionOrigin(action, 'Server error ' + res.status + ': ' + b, true, rid);
          bailI2i(); bailHy();
          releaseUi(action);
          return;
        }
        // 202 — reply/error arrives via SSE, which re-enables.
      }

      function appendLogLine(rec) {
        const hms     = rec.ts ? rec.ts.slice(11, 19) : '??:??:??';
        const cat     = rec.cat || 'unknown';

        // Build compact fields object (exclude ts and cat)
        const fields = {};
        for (const k of Object.keys(rec)) {
          if (k !== 'ts' && k !== 'cat') fields[k] = rec[k];
        }
        let compact = JSON.stringify(fields);
        if (compact.length > 300) compact = compact.slice(0, 300) + '…';

        const line = document.createElement('div');
        line.className = 'log-line cat-' + cat;
        line.textContent = '[' + hms + '] [' + cat + '] ' + compact;
        consoleEl.appendChild(line);
        consoleEl.scrollTop = consoleEl.scrollHeight;
      }

