      // ── Send ────────────────────────────────────────────────────────────────

      async function sendChat(message, noTool) {
        appendBubble('user', message);
        clearGateWaiting();
        // A chat turn holds the server lock for its whole duration, so it counts as blocking.
        // Its SSE reply carries no action name, which releaseUi treats as blocking by default.
        blockingInFlight++; if (typeof noteActivity === 'function') noteActivity();
        setInputEnabled(false);
        let res;
        try {
          res = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, noTool: !!noTool, mode: runMode }),
          });
        } catch (err) {
          appendBubble('error', 'Network error: ' + err.message);
          releaseUi();
          return;
        }
        if (res.status === 409) {
          appendBubble('busy-note', 'busy… try again in a moment');
          releaseUi();
          return;
        }
        if (!res.ok) {
          const body = await res.text();
          appendBubble('error', 'Server error ' + res.status + ': ' + body);
          releaseUi();
          return;
        }
        // 202 — reply/error arrives via SSE
      }

      async function sendMessage() {
        const text = inputEl.value.trim();
        if (!text) return;

        // Slash commands (client-side; bypass / augment the orchestrator)
        if (text[0] === '/') {
          const sp   = text.indexOf(' ');
          const cmd  = (sp === -1 ? text : text.slice(0, sp)).toLowerCase();
          const rest = sp === -1 ? '' : text.slice(sp + 1).trim();
          inputEl.value = '';
          if (window.__phoenixAutoGrowInput) window.__phoenixAutoGrowInput();
          if (cmd === '/notool') {
            const arg = rest.toLowerCase();
            if (rest === '') {
              appendBubble('phoenix', 'Blender-only mode is ' + (blenderOnly ? 'ON' : 'OFF') + '. Use "/notool on", "/notool off", or "/notool <description>" for a single message.');
            } else if (arg === 'on') {
              setBlenderOnly(true);
              appendBubble('phoenix', 'Blender-only mode ON — I will model meshes directly in Blender (bpy), without the image/3D generation tools.');
            } else if (arg === 'off') {
              setBlenderOnly(false);
              appendBubble('phoenix', 'Blender-only mode OFF — generation tools re-enabled.');
            } else {
              // one-shot: this single message runs Blender-only regardless of the toggle
              sendChat(rest, true);
            }
            return;
          }
          if (cmd === '/generate') {
            if (!rest) { appendBubble('phoenix', 'Usage: /generate <description>'); return; }
            postAction('generate_image', { description: rest });
            return;
          }
          if (cmd === '/regenerate') {
            postAction('generate_image', {}); // re-run from the last description, new seed
            return;
          }
          if (cmd === '/make3d') {
            postAction('image_to_3d', {});
            return;
          }
          if (cmd === '/import') {
            if (!currentMesh) { appendBubble('error', 'No staged mesh to import yet.'); return; }
            const cleanup = rest.toLowerCase() === 'cleaned';
            postAction('import_asset', { name: currentMesh.name, cleanup });
            return;
          }
          if (cmd === '/spawn') {
            const parts = rest.split(/\s+/).filter(Boolean);
            const slug = parts[0];
            if (!slug) { appendBubble('phoenix', 'Usage: /spawn <brush-slug> [x y z]'); return; }
            const input = { name: slug };
            const nx = parseFloat(parts[1]), ny = parseFloat(parts[2]), nz = parseFloat(parts[3]);
            if (Number.isFinite(nx)) input.x = nx;
            if (Number.isFinite(ny)) input.y = ny;
            if (Number.isFinite(nz)) input.z = nz;
            postAction('use_brush', input);
            return;
          }
          if (cmd === '/stop') {
            (async () => {
              try {
                const res  = await fetch('/stop', { method: 'POST' });
                const data = await res.json();
                if (data.stopped) {
                  appendBubble('phoenix', 'Stopped the ' + (data.stage || 'running') + ' stage. ComfyUI: ' + data.comfyui + '.');
                } else if (data.job) {
                  // A job in the slot with no live stage child: between stages, or parked
                  // at a gate. Say that, instead of claiming nothing is running.
                  var secs = Math.round((data.job.runningMs || 0) / 1000);
                  appendBubble('phoenix',
                    'Job #' + data.job.id + ' (' + data.job.label + ') is still in the slot after ' + secs +
                    's, but no compute stage is active right now — it is between stages or waiting at a gate. ' +
                    'Nothing to interrupt at this moment; try again once a stage is running.');
                } else {
                  appendBubble('phoenix', 'Nothing is running — no job, no stage.');
                }
              } catch (e) {
                appendBubble('error', 'Stop failed: ' + e.message);
              }
            })();
            return;
          }
          if (cmd === '/help') {
            appendBubble('phoenix', [
              'Commands:',
              '/generate <desc> — generate an image',
              '/regenerate — regenerate from the last description (new seed)',
              '/make3d — turn the current image into 3D',
              '/import [raw|cleaned] — import the current mesh (default raw)',
              '/spawn <slug> [x y z] — place a brush from the library',
              '/notool [on|off|<desc>] — Blender-only mode (model with bpy)',
              '/stop — abort the running stage (also interrupts ComfyUI)',
              '/help — this list',
            ].join('\n'));
            return;
          }
          appendBubble('phoenix', 'Unknown command. Available: /generate /regenerate /make3d /import /spawn /notool /stop /help');
          return;
        }

        inputEl.value = '';
        if (window.__phoenixAutoGrowInput) window.__phoenixAutoGrowInput();
        sendChat(text, blenderOnly);
      }

      sendBtn.addEventListener('click', sendMessage);

      // Grow the box to fit its content: reset to auto first, otherwise scrollHeight
      // only ever reports the current (already grown) height and it can never shrink.
      function autoGrowInput() {
        inputEl.style.height = 'auto';
        inputEl.style.height = inputEl.scrollHeight + 'px';
      }
      window.__phoenixAutoGrowInput = autoGrowInput;
      inputEl.addEventListener('input', autoGrowInput);
      autoGrowInput();

      inputEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
        // Shift+Enter falls through to the textarea's own newline handling.
      });

      // ── Action buttons ──────────────────────────────────────────────────────

      document.getElementById('prompt-actions').addEventListener('click', function (e) {
        const btn = e.target.closest('.art-btn'); if (!btn) return;
        const act = btn.dataset.action;
        if (act === 'approve-prompt') {
          const { pos, neg } = parsePromptText(promptEditEl ? promptEditEl.value : '');
          if (pos) postAction('generate_image', { prompt: pos, negative: neg });
          else postAction('generate_image', {});
        } else if (act === 'regen-prompt') {
          postAction('generate_image', {});
        }
      });

      // <i1-refs> v1.10 I1 — reference images row (Image sub-tab). Slots = maxRefs of the ACTIVE image workflow's `reference` block
      // (GET /workflows → active.image). Filled slot = relative path under output/ or staging/ (the server checks it again).
      function makeReferenceRow(d) {
        const slotsEl = d.doc.getElementById('ref-slots'), mutedEl = d.doc.getElementById('ref-muted');
        const changeEl = d.doc.getElementById('ref-change'), rangeEl = d.doc.getElementById('ref-change-input');
        const valEl = d.doc.getElementById('ref-change-val'), withEl = d.doc.getElementById('ref-with');
        let refs = [], block = null;
        function render() {
          slotsEl.textContent = '';
          const max = block ? block.maxRefs : 0;
          mutedEl.hidden = !!block;
          changeEl.hidden = !(block && block.mode === 'img2img');
          for (let i = 0; i < max; i++) {
            const slot = d.doc.createElement('span'); slot.className = 'ref-slot';
            if (refs[i]) {
              const img = d.doc.createElement('img'); img.src = '/file?p=' + encodeURIComponent(refs[i]); img.alt = 'reference ' + (i + 1);
              const x = d.doc.createElement('button'); x.className = 'ref-x'; x.dataset.act = 'remove'; x.dataset.i = String(i); x.textContent = '\u00d7'; x.title = 'Remove';
              slot.appendChild(img); slot.appendChild(x);
            } else {
              const add = d.doc.createElement('button'); add.dataset.act = 'add'; add.dataset.i = String(i); add.textContent = '+ Current image';
              slot.appendChild(add);
            }
            slotsEl.appendChild(slot);
          }
          valEl.textContent = Number(rangeEl.value).toFixed(2);
          if (d.onChange) d.onChange(refs.length);
          withEl.textContent = refs.length ? 'with ' + refs.length + ' reference' + (refs.length === 1 ? '' : 's') : '';
        }
        slotsEl.addEventListener('click', function (e) {
          const btn = e.target && e.target.closest ? e.target.closest('button') : null;
          if (!btn) return;
          const i = Number(btn.dataset.i);
          if (btn.dataset.act === 'remove') { refs.splice(i, 1); render(); }
          else if (btn.dataset.act === 'add') {
            const rel = d.currentRel();
            if (!rel) { if (d.notify) d.notify('No current image to use as a reference — generate or load one first.'); return; }
            refs[Math.min(i, refs.length)] = rel; render();
          }
        });
        rangeEl.addEventListener('input', function () { valEl.textContent = Number(rangeEl.value).toFixed(2); });
        // entry = the active image workflow entry from GET /workflows (or null). Extra slots are dropped, never remapped.
        function setWorkflow(entry) {
          block = entry && entry.reference && entry.reference.maxRefs > 0 ? entry.reference : null;
          const max = block ? block.maxRefs : 0;
          if (refs.length > max) refs.length = max;
          if (block && block.mode === 'img2img') rangeEl.value = String(block.denoiseDefault != null ? block.denoiseDefault : 0.6);
          render();
        }
        async function refresh() {
          try {
            const r = await d.fetch('/workflows');
            if (!r.ok) return;
            const reg = await r.json();
            const id = reg && reg.active && reg.active.image;
            const e = id && reg.workflows && reg.workflows[id];
            setWorkflow(e && e.stage === 'image' ? e : null);
          } catch (_) { /* leave the row as it was */ }
        }
        // → null (no slot filled: caller runs generate_image exactly as before) or { action, input } for POST /action
        function build(promptText) {
          if (!refs.length) return null;
          const input = { refs: refs.slice(), prompt: promptText };
          if (block && block.mode === 'img2img') input.denoise = Number(rangeEl.value);
          return { action: 'generate_from_refs', input: input };
        }
        render();
        return { setWorkflow: setWorkflow, refresh: refresh, build: build, refs: function () { return refs.slice(); } };
      }
      // </i1-refs>
      const refRow = makeReferenceRow({
        doc: document, fetch: fetch,
        currentRel: function () {
          if (!artImageEl.classList.contains('loaded') || !artImageEl.src) return '';
          try { return new URL(artImageEl.src, location.href).searchParams.get('p') || ''; } catch (_) { return ''; }
        },
        notify: function (t) { appendBubble('phoenix', t); },
        onChange: function (n) { refsFilled = n; updateRegenImageLock(); },
      });
      window.__refreshRefRow = refRow.refresh;
      refRow.refresh();

      document.getElementById('image-actions').addEventListener('click', function (e) {
        const btn = e.target.closest('.art-btn');
        if (!btn) return;
        const act = btn.dataset.action;
        if (act === 'load-image') {
          imageFileEl.click();
        } else if (act === 'regen-image') {
          // v1.10 I1: any filled reference slot → generate_from_refs with the prompt field text (literal). All empty → today's path.
          const refReq = refRow.build(imagePromptEditEl ? imagePromptEditEl.value : '');
          if (refReq) {
            if (!String(refReq.input.prompt).trim()) { appendBubble('phoenix', 'Type a prompt for the reference image first — it tells the model what to do with the reference(s).'); return; }
            postAction(refReq.action, refReq.input);
            return;
          }
          if (imageFromUser) { appendBubble('phoenix', 'Can’t regenerate a loaded image — it has no source prompt. Use "Make 3D" on it, or type a prompt in chat to generate a fresh image.'); return; }
          const src = imagePromptEditEl ? imagePromptEditEl.value : '';
          const { pos, neg } = parsePromptText(src);
          if (pos) postAction('generate_image', { prompt: pos, negative: neg });
          else postAction('generate_image', {});   // empty box → metaprompter from description
        } else if (act === 'make-3d') {
          postAction('image_to_3d', {});
        }
      });

      // One path for "Load image..." and a file dropped on the Image tab (LC1).
      async function uploadImageFile(file) {
        setActionsEnabled(false);
        try {
          const buf = await file.arrayBuffer();
          const res = await fetch('/upload?name=' + encodeURIComponent(file.name), {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: buf,
          });
          if (!res.ok) { const b = await res.text(); appendBubble('error', 'Upload failed ' + res.status + ': ' + b); setActionsEnabled(true); }
          // on success the SSE 'reply' re-enables buttons and the 'artifact' shows the image
        } catch (err) {
          appendBubble('error', 'Upload error: ' + err.message);
          setActionsEnabled(true);
        }
      }
      imageFileEl.addEventListener('change', async function () {
        const file = imageFileEl.files && imageFileEl.files[0];
        if (!file) return;
        try { await uploadImageFile(file); } finally { imageFileEl.value = ''; }   // allow re-selecting the same file
      });

      document.getElementById('panel-scene').addEventListener('click', function (e) {
        const btn = e.target.closest('.art-btn');
        if (!btn) return;
        const act = btn.dataset.action;
        if (act === 'import-raw') {
          if (!currentMesh) { appendBubble('error', 'No staged mesh to import yet.'); return; }
          if (currentMesh.category === 'brush-cache') { appendBubble('phoenix', 'That’s a brush preview, not a staged mesh — place it with the brush tools, not Import.'); return; }
          postAction('import_asset', { name: currentMesh.name, cleanup: false });
        } else if (act === 'import-cleaned') {
          if (!currentMesh) { appendBubble('error', 'No staged mesh to import yet.'); return; }
          if (currentMesh.category === 'brush-cache') { appendBubble('phoenix', 'That’s a brush preview, not a staged mesh — place it with the brush tools, not Import.'); return; }
          postAction('import_asset', { name: currentMesh.name, cleanup: true });
        }
      });

      document.getElementById('mesh-actions').addEventListener('click', function (e) {
        const btn = e.target.closest('.art-btn');
        if (!btn) return;
        const act = btn.dataset.action;
        if (act === 'regen-mesh') {
          if (meshFromLibrary) { appendBubble('phoenix', 'Can’t regenerate a library asset — it has no source image. Generate a new prop, or just import this one as-is.'); return; }
          const n = parseInt(meshFacesEl && meshFacesEl.value, 10);
          const input = (Number.isFinite(n) && n > 0) ? { target_face_num: n } : {};
          postAction('image_to_3d', input);
        } else if (act === 'save-brush') {
          if (!currentMesh) { appendBubble('error', 'Import the mesh first, then save it as a brush.'); return; }
          const nm = prompt('Brush name (slug):');
          if (nm) {
            // Merken, womit gespeichert wurde: kommt eine Namenskollision zurueck, kann
            // der Reply-Handler dieselbe Anfrage mit overwrite wiederholen. Ohne das
            // waere die vorgeschlagene Loesung ("ersetzen") aus der UI unerreichbar.
            window.__lastBrushSave = { name: nm.trim(), category: currentMesh.category };
            postAction('save_as_brush', window.__lastBrushSave);
          }
        }
      });

      // The way back from Unreal. Its own listener because the row is a separate container —
      // #mesh-actions' handler does not see it, and putting the field into that row would have
      // pushed the four existing buttons out of the panel.
      document.getElementById('mesh-unreal-row').addEventListener('click', function (e) {
        const btn = e.target.closest('.art-btn');
        if (!btn || btn.dataset.action !== 'from-unreal') return;
        const pathEl = document.getElementById('mesh-unreal-path');
        const asset  = (pathEl.value || '').trim();
        if (!asset) {
          appendBubble('error', 'Give the Unreal content path first, e.g. /Game/Props/SM_Crate.');
          return;
        }
        if (!asset.startsWith('/')) {
          appendBubble('error', 'An Unreal content path starts with a slash — /Game/… , not a file path.');
          return;
        }
        if (document.getElementById('mesh-unreal-target').value === 'brush') {
          // The asset's own name is the obvious default; asking with it prefilled keeps the
          // rename possible without making it a chore.
          const guess = asset.split('/').pop().split('.')[0];
          const nm = prompt('Brush name (slug):', guess);
          if (!nm) return;
          postAction('unreal_to_brush', { asset, name: nm.trim() });
        } else {
          postAction('unreal_to_blender', { asset });
        }
      });

