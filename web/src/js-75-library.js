      // ── Library (right rail) ─────────────────────────────────────────────────

      const LIB_CAT_ORDER = ['flat', 'furniture', 'item', 'architecture', 'flora', 'fauna'];

      // v1.10.1 R4: the ONE stroke icon set of the Library (viewBox 24, stroke 1.8, currentColor) - self-contained: the path table lives in here.
      function libIcon(name) {
        const PATHS = {
          alert: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M12 7v6', 'M12 17h0'],
          edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13 7l4 4'],
          folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
          remesh: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M12 12l8-4.5', 'M12 12v9', 'M12 12L4 7.5'],
          trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
          plus: ['M12 5v14', 'M5 12h14'],
          check: ['M5 12l5 5 9-10'],
          unreal: ['M5 4v11a7 7 0 0 0 14 0V4', 'M9 4v11a3 3 0 0 0 6 0V4'],
          blender: ['M5 5h6', 'M5 5v14h14v-6', 'M12 12l8-8', 'M14 4h6v6'],
          retry: ['M20 7v5h-5', 'M20 12a8 8 0 1 1-2-5'],
          eye: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z', 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0'],
          person: ['M9 7a3 3 0 1 0 6 0a3 3 0 1 0-6 0', 'M5 21c0-4 3-7 7-7s7 3 7 7']
        };
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.8');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        (PATHS[name] || []).forEach(function (d) {
          const p = document.createElementNS(NS, 'path');
          p.setAttribute('d', d);
          svg.appendChild(p);
        });
        return svg;
      }

      // <r4b-posters>
      function makePosterRenderer(deps) {
        const queue = [], attempts = new Map(), completed = new Map(), pending = new Map(), failures = new Set();
        let active = false;
        const raf = deps.requestAnimationFrame || function (cb) { return requestAnimationFrame(cb); };
        const bitmapFrom = deps.createImageBitmap || function (blob) { return createImageBitmap(blob); };
        const toJpeg = deps.toJpeg || async function (viewer) {
          const png = await viewer.toBlob({ mimeType: 'image/png' });
          const bitmap = await bitmapFrom(png);
          try {
            const w = bitmap.width, h = bitmap.height;
            const check = deps.document.createElement('canvas'); check.width = w; check.height = h;
            const alpha = check.getContext('2d'); alpha.drawImage(bitmap, 0, 0);
            const pixels = alpha.getImageData(0, 0, w, h).data;
            let count = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) count++;
            if (!w || !h || count < 0.005 * w * h) throw new Error('Poster looks empty');
            const canvas = deps.document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = getComputedStyle(deps.document.documentElement).getPropertyValue('--surface').trim();
            ctx.fillRect(0, 0, 256, 256);
            const scale = Math.min(256 / w, 256 / h), dw = w * scale, dh = h * scale;
            ctx.drawImage(bitmap, (256 - dw) / 2, (256 - dh) / 2, dw, dh);
            return await new Promise(function (resolve, reject) { canvas.toBlob(function (blob) { if (blob) resolve(blob); else reject(new Error('Poster encoding failed')); }, 'image/jpeg', 0.85); });
          } finally { bitmap.close(); }
        };
        function request(job) {
          const id = job.key + '|' + job.stamp;
          if (completed.has(id)) { const url = completed.get(id); if (url) job.onDone(url); else job.onFail(); return; }
          if (job.retry === true) failures.delete(id);
          if (failures.has(id)) { job.onFail(); return; }
          if (pending.has(id)) { pending.get(id).push(job); return; }
          pending.set(id, [job]); queue.push(job); pump();
        }
        async function pump() {
          if (active || !queue.length) return;
          active = true;
          const job = queue.shift(), id = job.key + '|' + job.stamp;
          attempts.set(id, (attempts.get(id) || 0) + 1);
          let viewer, timer, onLoad, onError, onVisibility, cancelled = false;
          const q = '?key=' + encodeURIComponent(job.key) + '&stamp=' + encodeURIComponent(job.stamp);
          try {
            viewer = deps.makeViewer ? deps.makeViewer() : deps.document.createElement('model-viewer');
            if (!deps.makeViewer) {
              viewer.style.width = '512px'; viewer.style.height = '512px'; viewer.style.position = 'fixed'; viewer.setAttribute('loading', 'eager'); viewer.style.left = '0'; viewer.style.top = '0'; viewer.style.opacity = '0'; viewer.style.pointerEvents = 'none'; viewer.style.zIndex = '-1'; viewer.style.background = 'var(--surface)';
              deps.document.body.appendChild(viewer);
            }
            const render = async function () {
              await new Promise(function (resolve, reject) {
                let loaded = false, visible = false, started = false;
                const ready = function () {
                  if (!loaded || !visible || started || cancelled) return;
                  started = true;
                  raf(function () { if (!cancelled) raf(function () { if (!cancelled) resolve(); }); });
                };
                onLoad = function () { loaded = true; visible = visible || viewer.modelIsVisible === true; ready(); };
                onVisibility = function (ev) { if (ev.detail && ev.detail.visible === true) { visible = true; ready(); } };
                onError = function () { reject(new Error('Preview failed')); };
                viewer.addEventListener('error', onError); viewer.addEventListener('load', onLoad); viewer.addEventListener('model-visibility', onVisibility);
                viewer.setAttribute('src', job.glb);
              });
              const blob = await toJpeg(viewer);
              if (cancelled) return;
              const response = await deps.fetch('/posters' + q, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
              if (!response.ok) throw new Error('Poster upload failed');
            };
            { const job = render(); job.catch(function () {});
              await Promise.race([job, new Promise(function (_, reject) { timer = setTimeout(function () { reject(new Error('Poster timed out')); }, deps.timeoutMs || 20000); })]); }
            failures.delete(id); attempts.delete(id);
            completed.set(id, '/poster' + q); pending.get(id).forEach(function (j) { j.onDone('/poster' + q); }); pending.delete(id);
          } catch (_) {
            if (attempts.get(id) < 2) queue.unshift(job);
            else { failures.add(id); const waiting = pending.get(id); pending.delete(id); attempts.delete(id); waiting.forEach(function (j) { j.onFail(); }); }
          } finally { cancelled = true; clearTimeout(timer); if (viewer) { viewer.removeEventListener('load', onLoad); viewer.removeEventListener('error', onError); viewer.removeEventListener('model-visibility', onVisibility); viewer.remove(); } active = false; pump(); }
        }
        return { request: request };
      }
      // </r4b-posters>
      let libPosterRenderer = null;
      function renderTilePoster(tile) {
        const request = function (retry) {
          if (!libPosterRenderer) libPosterRenderer = makePosterRenderer({ document: document, fetch: function (u, o) { return fetch(u, o); } });
          const key = tile.dataset.posterKey, stamp = tile.dataset.posterStamp;
          const rel = tile.dataset.kind === 'asset' ? 'staging/' + tile.dataset.category + '/' + tile.dataset.name : 'brush-cache/' + tile.dataset.slug + '.glb';
          const glb = tile.dataset.kind === 'character' ? '/characters/preview-glb?name=' + encodeURIComponent(tile.dataset.charName) : tile.dataset.kind === 'brush' ? '/file?p=' + encodeURIComponent(rel) + '&v=' + encodeURIComponent(stamp) : '/file?p=' + encodeURIComponent(rel);   // R5a: characters render from their preview export; F2.2: a brush GLB URL carries the stamp so a replaced brush is not served from the browser cache
          libPosterRenderer.request({ key: key, stamp: stamp, retry: retry === true, glb: glb, onDone: function (url) {
            libTileProblemClear(tile, 'poster');
            const poster = tile.querySelector('.lib-tile-poster'); if (!poster) return;
            poster.textContent = ''; const im = document.createElement('img'); im.src = url; im.alt = ''; poster.appendChild(im);
          }, onFail: function () { libTileProblem(tile, 'No picture — the 3D preview could not render this model.', { label: 'Try again', run: function () { request(true); } }, 'poster'); } });
        };
        if (typeof IntersectionObserver === 'function') { const observer = new IntersectionObserver(function (entries) { entries.forEach(function (entry) { if (entry.isIntersecting) { observer.unobserve(tile); request(); } }); }); observer.observe(tile); }
      }
      // R5a: the cast list and the centre preview of Characters ask for a character poster when its JPEG is missing but the GLB is fresh.
      // Resolves with the poster URL, or null when the render failed.
      function renderCharacterPoster(o) {
        return new Promise(function (resolve) {
          try {
            if (!libPosterRenderer) libPosterRenderer = makePosterRenderer({ document: document, fetch: function (u, op) { return fetch(u, op); } });
            libPosterRenderer.request({ key: 'character:' + o.name, stamp: o.stamp, retry: false, glb: '/characters/preview-glb?name=' + encodeURIComponent(o.name),
              onDone: function (url) { resolve(url); }, onFail: function () { resolve(null); } });
          } catch (_) { resolve(null); }
        });
      }
      if (typeof window !== 'undefined') window.__renderCharacterPoster = renderCharacterPoster;
      // <r4b2-problem>
      function libTileProblemClear(tile, kind) {
        const problems = tile._libProblems || new Map();
        if (kind === undefined) problems.clear(); else problems.delete(kind);
        const btn = tile.querySelector('[data-act="problem"]');
        if (btn) btn.dataset.problem = Array.from(problems.keys()).join(' ');
        if (libTileProblem._open && libTileProblem._open.tile === tile) libTileProblem._open.close(false, problems.size > 0);
        if (!problems.size && btn) btn.remove();
      }
      function libTileProblem(tile, text, help, kind) {
        kind = kind || 'action';
        const problems = tile._libProblems || (tile._libProblems = new Map());
        if (libTileProblem._open && libTileProblem._open.tile === tile) libTileProblem._open.close(false);
        problems.set(kind, { text: text, help: help });
        let btn = tile.querySelector('[data-act="problem"]');
        if (btn) { btn.dataset.problem = Array.from(problems.keys()).join(' '); return; }
        btn = libActBtn('problem'); btn.setAttribute('type', 'button'); btn.setAttribute('aria-expanded', 'false');
        btn.dataset.problem = Array.from(problems.keys()).join(' '); tile.appendChild(btn);
        if (!libTileProblem._listening) {
          libTileProblem._listening = true;
          document.addEventListener('keydown', function (ev) {
            const open = libTileProblem._open; if (!open) return;
            if (ev.key === 'Escape') open.close(true);
            else if (!open.tile.isConnected) open.close(false);   // the tile is gone (list reload): do not leave its popover behind
          });
          document.addEventListener('click', function (ev) {
            const open = libTileProblem._open;
            if (open && ((!open.pop.contains(ev.target) && !open.btn.contains(ev.target)) || !open.tile.isConnected)) open.close(false);
          });
        }
        btn.addEventListener('click', function () {
          if (libTileProblem._open && libTileProblem._open.btn === btn) { libTileProblem._open.close(true); return; }
          if (libTileProblem._open) libTileProblem._open.close(false);
          const pop = document.createElement('div'); pop.className = 'lib-problem-pop'; pop.tabIndex = -1;
          const close = function (force, remains) {
            const restore = force || pop.contains(document.activeElement);
            pop.remove(); btn.setAttribute('aria-expanded', 'false'); libTileProblem._open = null;
            if (restore && remains !== false && btn.parentNode) btn.focus();
          };
          let focus = pop;
          const bodyBox = document.createElement('div'); bodyBox.className = 'lib-problem-body'; pop.appendChild(bodyBox);
          problems.forEach(function (problem, source) {
            const item = document.createElement('div'); item.className = 'lib-problem-item'; item.dataset.problem = source;
            const txt = document.createElement('div'); txt.className = 'lib-problem-text'; txt.textContent = problem.text; item.appendChild(txt);
            const help = problem.help;
            if (help) {
              const go = document.createElement('button'); go.type = 'button'; go.className = 'btn btn-secondary btn-sm'; go.textContent = help.label;
              go.addEventListener('click', function (ev) { ev.stopPropagation(); close(true); help.run(); }); item.appendChild(go);
              if (focus === pop) focus = go;
            }
            bodyBox.appendChild(item);
          });
          const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn btn-secondary btn-sm'; copy.setAttribute('data-copy', ''); copy.textContent = 'Copy';
          const copyMsg = document.createElement('span'); copyMsg.setAttribute('data-copy-msg', ''); copyMsg.setAttribute('role', 'status'); copyMsg.hidden = true;
          // plain-http remote access has no navigator.clipboard: fall back to a hidden textarea + execCommand('copy')
          const copyFallback = function (text) {
            try {
              const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
              document.body.appendChild(ta); ta.select();
              let ok = false; try { ok = !!document.execCommand('copy'); } finally { ta.remove(); }
              return ok;
            } catch (_) { return false; }
          };
          const copyDone = function (ok) { copy.textContent = ok ? 'Copied' : 'Copy failed'; copyMsg.hidden = ok; copyMsg.textContent = ok ? '' : 'Copy failed \u2014 select the text and press Ctrl+C.'; };
          copy.addEventListener('click', function () {
            const all = Array.from(problems.values()).map(function (problem) { return problem.text; }).join('\n\n');
            if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) Promise.resolve().then(function () { return navigator.clipboard.writeText(all); }).then(function () { copyDone(true); }, function () { copyDone(copyFallback(all)); });
            else copyDone(copyFallback(all));
          });
          const foot = document.createElement('div'); foot.className = 'lib-problem-foot'; foot.appendChild(copy); foot.appendChild(copyMsg); pop.appendChild(foot);
          // R4d3 P6: the popover lives on <body> (never clipped by the tile), fixed next to the "!"
          const rect = btn.getBoundingClientRect();
          const iw = typeof window !== 'undefined' ? Number(window.innerWidth) : NaN, ih = typeof window !== 'undefined' ? Number(window.innerHeight) : NaN;
          const vw = iw > 0 ? iw : 1024, vh = ih > 0 ? ih : 768;
          const width = Math.min(520, vw - 32), left = Math.max(16, Math.min(rect.right - width, vw - 16 - width));
          pop.style.width = width + 'px'; pop.style.left = left + 'px'; pop.style.maxHeight = (vh - 32) + 'px'; pop.style.top = (rect.bottom + 8) + 'px';
          document.body.appendChild(pop); btn.setAttribute('aria-expanded', 'true');
          // always inside the viewport: below the "!" if it fits, else above, else clamped; the items scroll in .lib-problem-body, Copy stays visible
          const popH = Math.min(pop.getBoundingClientRect().height, vh - 32), below = rect.bottom + 8;
          pop.style.top = (below + popH <= vh - 16 ? below : (rect.top - 8 - popH >= 16 ? rect.top - 8 - popH : Math.max(16, vh - 16 - popH))) + 'px';
          libTileProblem._open = { tile: tile, btn: btn, pop: pop, close: close }; focus.focus();
        });
      }
      // </r4b2-problem>
      let libPreviewStatus = { running: false, done: 0 };
      let libBrushesStale = false, libStaleSig = '';   // F2.2: the last loadBrushes drew an "Updating preview…" tile / the status seen when we reloaded for it
      function showBrushPreviewStatus(status) {
        let line = libBrushesBody.querySelector('.lib-previews-status');
        if (!line) { line = document.createElement('div'); line.className = 'lib-previews-status'; line.setAttribute('role', 'status'); libBrushesBody.prepend(line); }
        line.textContent = status.running ? 'Building previews ' + status.done + ' / ' + status.total : status.unavailable ? 'No previews: ' + status.unavailable : '';
      }
      // R5a: the character preview export reports progress like the brush one: when another character is done (or a run ended) the Characters
      // section (if open) and the cast list read their lists again - no polling
      let libCharPreviewStatus = { running: false, done: 0 };
      function onCharacterPreviews(status) {
        const reload = status.done > libCharPreviewStatus.done || (libCharPreviewStatus.running && !status.running);
        libCharPreviewStatus = status;
        if (!reload) return;
        try { if (typeof libraryPage !== 'undefined' && libraryPage && libraryPage.section() === 'characters') { const box = document.getElementById('lib-characters-body'); if (box) libraryPage.loadCharacters(box); } } catch (_) { /* the page is not there */ }
        if (window.__charactersWs) window.__charactersWs.refresh();
      }
      function onBrushPreviews(status) {
        let reload = status.done > libPreviewStatus.done || (libPreviewStatus.running && !status.running);
        // F2.2: nothing runs but a tile still says "Updating preview…" -> read the list once per distinct status (loadBrushes itself POSTs /brushes/previews, which emits again)
        const sig = status.done + '|' + status.total;
        if (!reload && !status.running && libBrushesStale && sig !== libStaleSig) { libStaleSig = sig; reload = true; }
        libPreviewStatus = status; showBrushPreviewStatus(status);
        if (reload) loadBrushes().then(function () { showBrushPreviewStatus(status); });
      }

      // R4e: a stale GLB without an error, while previews can be made at all, is still being rendered
      function brushTileUpdating(b, previews) { return !b.glbFresh && !b.previewError && !(previews && previews.unavailable); }
      function libTile(opts) {
        const tile = document.createElement('div'); tile.className = 'lib-tile'; tile.dataset.kind = opts.kind;
        Object.entries(opts.dataset || {}).forEach(function (kv) { tile.dataset[kv[0]] = kv[1]; });
        const poster = document.createElement('div'); poster.className = 'lib-tile-poster';
        if (opts.poster) { const im = document.createElement('img'); im.src = opts.poster; im.alt = ''; im.setAttribute('loading', 'lazy');
          im.addEventListener('error', function () { const ph = document.createElement('div'); ph.className = 'lib-tile-ph'; ph.textContent = opts.placeholder || 'No preview'; im.replaceWith(ph); if (opts.onPosterError) opts.onPosterError(tile); }); poster.appendChild(im); }
        else { const ph = document.createElement('div'); ph.className = opts.swatch ? 'lib-tile-swatch' : 'lib-tile-ph';
          if (opts.swatch) ph.style.background = opts.swatch; else ph.textContent = opts.placeholder || 'No preview'; poster.appendChild(ph); }
        tile.appendChild(poster);
        const name = document.createElement('div'); name.className = 'lib-tile-name'; name.textContent = opts.name; name.title = opts.name; tile.appendChild(name);
        if (opts.meta != null) { const meta = document.createElement('div'); meta.className = 'lib-tile-meta'; meta.textContent = opts.meta; tile.appendChild(meta); }
        const acts = document.createElement('div'); acts.className = 'lib-tile-actions';
        (opts.actions || []).forEach(function (a) { acts.appendChild(a); }); tile.appendChild(acts); return tile;
      }

      // v1.10.1 R4: the ONE inline row of the Library (replaces every native prompt / confirm there) - self-contained (the open row lives on libInlineRow._open).
      // opts: { doc?, anchor, trigger, kind: 'name' | 'confirm', label, value?, action, danger?, allowEmpty?, onDone(value), host? }. The row goes right after `anchor`
      // (or is appended into `host`); one row at a time. Enter in the input = action, Esc anywhere in the row = Cancel; an empty name does nothing (unless opts.allowEmpty).
      function libInlineRow(opts) {
        const doc = opts.doc || document;
        if (libInlineRow._open) { try { libInlineRow._open.close(true); } catch (_) {} }
        const isName = opts.kind === 'name';
        const row = doc.createElement('div');
        row.className = 'lib-inline';
        row.setAttribute('role', 'group');
        let input = null;
        if (isName) {
          libInlineRow._seq = (libInlineRow._seq || 0) + 1;
          const lab = doc.createElement('label');
          lab.className = 'lib-inline-label';
          lab.textContent = opts.label || '';
          input = doc.createElement('input');
          input.type = 'text';
          input.className = 'lib-inline-input';
          input.id = 'lib-inline-in-' + libInlineRow._seq;
          input.value = opts.value == null ? '' : String(opts.value);
          lab.htmlFor = input.id;
          row.appendChild(lab);
          row.appendChild(input);
        } else {
          const txt = doc.createElement('span');
          txt.className = 'lib-inline-text';
          txt.textContent = opts.label || '';
          row.appendChild(txt);
        }
        const go = doc.createElement('button');
        go.type = 'button';
        go.className = isName ? 'btn btn-primary btn-sm' : (opts.danger ? 'btn btn-danger btn-sm' : 'btn btn-secondary btn-sm');
        go.textContent = opts.action || 'OK';
        const no = doc.createElement('button');
        no.type = 'button';
        no.className = 'btn btn-secondary btn-sm';
        no.textContent = 'Cancel';
        row.appendChild(go);
        row.appendChild(no);
        let closed = false;
        const handle = { el: row, close: close };
        function close(quiet) {
          if (closed) return;
          closed = true;
          if (row.parentNode) row.parentNode.removeChild(row);
          if (libInlineRow._open === handle) libInlineRow._open = null;
          if (!quiet && opts.trigger && opts.trigger.focus) { try { opts.trigger.focus(); } catch (_) {} }
        }
        function act() {
          const v = input ? String(input.value).trim() : '';
          if (isName && !v && !opts.allowEmpty) return;
          close();
          if (typeof opts.onDone === 'function') opts.onDone(v);
        }
        go.addEventListener('click', act);
        no.addEventListener('click', function () { close(); });
        if (input) input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { if (ev.preventDefault) ev.preventDefault(); act(); } });
        row.addEventListener('keydown', function (ev) {
          if (ev.key !== 'Escape') return;
          if (ev.preventDefault) ev.preventDefault();
          if (ev.stopPropagation) ev.stopPropagation();
          close();
        });
        if (opts.host) opts.host.appendChild(row);
        else if (opts.anchor && opts.anchor.parentNode) opts.anchor.parentNode.insertBefore(row, opts.anchor.nextSibling);
        else doc.body.appendChild(row);
        libInlineRow._open = handle;
        const first = input || go;
        if (first.focus) first.focus();
        if (input && input.select) input.select();
        return handle;
      }

      // Item action buttons: data-act -> [icon, aria-label]. Every one is a real button with a stroke icon and a name (no glyphs).
      const LIB_ACTS = {
        open: ['blender', 'Open in Blender'], scene: ['plus', 'New scene from this level'], save: ['check', 'Save in Blender'],
        problem: ['alert', 'Show problem'],
        retry: ['retry', 'Retry preview'],
        replace: ['retry', 'Replace with selection'],
        unreal: ['unreal', 'Send to Unreal'],
        apply: ['check', 'Apply material'],
        blender: ['blender', 'Insert into the open Blender scene'],
        preview: ['eye', 'Preview'],
        move: ['folder', 'Move to folder'],
        rename: ['edit', 'Rename'],
        remesh: ['remesh', 'Remesh via Meshy\u2026'],
        delete: ['trash', 'Delete'],
        fnew: ['plus', 'New subfolder'],
        frename: ['edit', 'Rename folder'],
        fdelete: ['trash', 'Delete folder']
      };
      function libActBtn(act) {
        const spec = LIB_ACTS[act] || ['edit', act];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lib-act-btn';
        btn.dataset.act = act;
        btn.setAttribute('aria-label', spec[1]);
        btn.title = spec[1];
        btn.appendChild(libIcon(spec[0]));
        if (act === 'apply') { const label = document.createElement('span'); label.textContent = 'Apply'; btn.appendChild(label); }
        return btn;
      }

      function makeLibItem(opts) {
        const el = document.createElement('div');
        el.className = 'lib-item';
        el.dataset.kind = opts.kind;
        Object.entries(opts.dataset).forEach(([k, v]) => { el.dataset[k] = v; });
        const nm = document.createElement('span');
        nm.className = 'lib-item-name';
        nm.textContent = opts.label;
        el.title = opts.label;
        el.appendChild(nm);
        if (opts.actions && opts.actions.length) {
          const acts = document.createElement('span');
          acts.className = 'lib-actions';
          opts.actions.forEach(act => { acts.appendChild(libActBtn(act)); });
          el.appendChild(acts);
        }
        if (opts.kind === 'asset' && opts.dataset && Object.prototype.hasOwnProperty.call(remeshBadges, opts.dataset.category + '/' + opts.dataset.name)) {
          const bd = document.createElement('span'); bd.className = 'lib-badge'; bd.textContent = '⟳ ' + remeshBadges[opts.dataset.category + '/' + opts.dataset.name] + '%'; el.appendChild(bd);
        }
        return el;
      }

      // ── User folders over the library ──────────────────────────────────────
      // The folders are a VIEW (see library-folders.js): an item filed into one appears there, an
      // unfiled one stays under its palette category exactly as before. Nothing moves on disk, so
      // import_asset and the palette relationship are untouched.

      let LIB_FOLDERS = { folders: [], assignments: {}, collapsed: [] };

      async function fetchLibFolders() {
        try {
          const r = await fetch('/library-folders');
          if (r.ok) LIB_FOLDERS = await r.json();
        } catch (_) {}
      }

      // Every mutation goes through the server and adopts the state it returns, rather than
      // patching the local copy and hoping. A rejected move (e.g. a folder into its own subtree)
      // must not leave the rail showing something the file does not contain.
      async function libFolderOp(op) {
        try {
          const r = await fetch('/library-folders', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op),
          });
          const d = await r.json();
          if (!r.ok) { appendBubble('sys', 'Library folders: ' + (d.error || 'failed')); return false; }
          LIB_FOLDERS = d;
          return true;
        } catch (e) { appendBubble('sys', 'Library folders: ' + e.message); return false; }
      }

      // v1.10 LIB2: a folder may carry scope 'video' (the Videos tab's own tree); R4: 'brush' (the Brushes tree); no scope = the asset tree. Each tree shows only its own.
      const libChildren = (id, scope) => LIB_FOLDERS.folders.filter(f => (f.parent || null) === (id || null) && (f.scope || null) === (scope || null));
      const libIsCollapsed = id => (LIB_FOLDERS.collapsed || []).includes(id);

      // Flat, indented list of every folder — used by the picker so a deep tree stays choosable.
      function libFolderOptions(scope) {
        const out = [];
        (function walk(parent, depth) {
          for (const f of libChildren(parent, scope)) {
            out.push({ id: f.id, label: ' '.repeat(depth * 2) + f.name, depth });
            walk(f.id, depth + 1);
          }
        })(null, 0);
        return out;
      }

      // Remesh via Meshy (M9): topology + target polycount, then ONE postAction. The consent gates live on the server.
      function openRemeshDialog(category, name, sizeMB, origin) {
        const back = document.createElement('div');
        back.className = 'lib-pick-backdrop';
        const box = document.createElement('div');
        box.className = 'lib-pick';
        const close = () => { back.remove(); box.remove(); };
        const title = document.createElement('div');
        title.className = 'lib-pick-title';
        title.textContent = 'Remesh via Meshy';
        box.appendChild(title);
        const info = document.createElement('div');
        info.className = 'lib-pick-row';
        info.textContent = 'Uploads ' + name + (sizeMB ? ' (' + sizeMB + ' MB)' : '') + ' to Meshy · ~5 credits';
        box.appendChild(info);
        const bal = document.createElement('div');
        bal.className = 'lib-pick-row'; bal.id = 'remesh-dlg-balance';
        bal.textContent = 'Balance: …';
        box.appendChild(bal);
        (async function () {
          try {
            const j = await (await fetch('/remesh-balance')).json();
            bal.textContent = (j && j.ok && typeof j.balance === 'number') ? 'Balance: ' + j.balance + ' credits · this remesh ≈ 5' : 'Balance unavailable';
          } catch (_) { bal.textContent = 'Balance unavailable'; }
        })();
        const srcRow = document.createElement('div');
        srcRow.className = 'lib-pick-row'; srcRow.id = 'remesh-dlg-source'; srcRow.hidden = true;
        box.appendChild(srcRow);
        const warnRow = document.createElement('div');
        warnRow.className = 'lib-pick-row'; warnRow.id = 'remesh-dlg-warn'; warnRow.style.color = '#c98a2b'; warnRow.hidden = true;
        box.appendChild(warnRow);
        let srcTris = null;
        const updateWarn = function () {
          const n = parseInt(inpP.value, 10);
          const heavier = srcTris !== null && Number.isFinite(n) && n >= srcTris;
          warnRow.hidden = !heavier;
          warnRow.textContent = heavier ? 'Target is higher than the source — the result gets heavier, not cleaner.' : '';
        };
        (async function () {
          try {
            const j = await (await fetch('/asset-faces?category=' + encodeURIComponent(category) + '&name=' + encodeURIComponent(name))).json();
            if (j && j.ok && Number.isFinite(j.tris)) { srcTris = j.tris; srcRow.textContent = 'Source: ' + j.tris + ' triangles'; srcRow.hidden = false; updateWarn(); }
          } catch (_) { /* no count -> no line, Remesh stays allowed */ }
        })();
        const rowT = document.createElement('div');
        rowT.className = 'lib-pick-row';
        const selT = document.createElement('select');
        selT.id = 'remesh-dlg-topology';
        ['quad', 'triangle'].forEach(function (v) { const o = document.createElement('option'); o.value = v; o.textContent = v; selT.appendChild(o); });
        selT.value = REMESH_DEFAULTS.topology === 'triangle' ? 'triangle' : 'quad';
        rowT.appendChild(document.createTextNode('Topology '));
        rowT.appendChild(selT);
        box.appendChild(rowT);
        const rowP = document.createElement('div');
        rowP.className = 'lib-pick-row';
        const inpP = document.createElement('input');
        inpP.type = 'number'; inpP.id = 'remesh-dlg-polycount'; inpP.min = '100'; inpP.max = '300000'; inpP.step = '100';
        inpP.value = REMESH_DEFAULTS.targetPolycount || 20000; inpP.style.width = '90px';
        inpP.addEventListener('input', updateWarn);
        rowP.appendChild(document.createTextNode('Target polycount '));
        rowP.appendChild(inpP);
        box.appendChild(rowP);
        const rowB = document.createElement('div');
        rowB.className = 'lib-pick-row';
        const go = document.createElement('button');
        go.type = 'button'; go.className = 'modal-btn'; go.textContent = 'Remesh';
        const no = document.createElement('button');
        no.type = 'button'; no.className = 'modal-btn'; no.textContent = 'Cancel'; no.style.marginLeft = '8px';
        go.addEventListener('click', function () {
          const n = parseInt(inpP.value, 10);
          if (!Number.isInteger(n) || n < 100 || n > 300000) { info.textContent = 'Target polycount must be an integer between 100 and 300000.'; return; }
          close();
          REMESH_DEFAULTS = { topology: selT.value, targetPolycount: n };   // M10: the next dialog opens with the last used values
          try { fetch('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remesh: { topology: selT.value, targetPolycount: n } }) }).catch(function () {}); } catch (_) {}
          postAction('remesh_asset', { category, name, topology: selT.value, target_polycount: n }, origin);
        });
        no.addEventListener('click', close);
        rowB.appendChild(go); rowB.appendChild(no);
        box.appendChild(rowB);
        back.addEventListener('click', close);
        document.body.appendChild(back);
        document.body.appendChild(box);
      }

      function openFolderPicker(itemKey, currentFolder, scope) {
        const back = document.createElement('div');
        back.className = 'lib-pick-backdrop';
        const box = document.createElement('div');
        box.className = 'lib-pick';
        const title = document.createElement('div');
        title.className = 'lib-pick-title';
        title.textContent = 'Move to folder';
        box.appendChild(title);

        const close = () => { back.remove(); box.remove(); };
        const rows = [{ id: null, label: scope ? '— no folder —' : '— no folder (back to its category) —' }, ...libFolderOptions(scope)];
        for (const r of rows) {
          const row = document.createElement('div');
          row.className = 'lib-pick-row';
          row.textContent = (r.id === (currentFolder || null) ? '• ' : '  ') + r.label;
          row.addEventListener('click', async () => {
            close();
            if (await libFolderOp({ action: 'assign', key: itemKey, folder: r.id })) refreshLibraryTabs();
          });
          box.appendChild(row);
        }
        const mk = document.createElement('div');
        mk.className = 'lib-pick-row';
        mk.style.borderTop = '1px solid rgba(128,128,128,0.2)';
        mk.style.marginTop = '4px';
        mk.textContent = '+ new folder…';
        mk.addEventListener('click', () => {
          libInlineRow({
            host: box, trigger: mk, kind: 'name', label: 'New folder name', action: 'Create',
            onDone: async (n) => {
              close();
              if (await libFolderOp({ action: 'create', name: n, scope: scope || undefined })) {
                const created = LIB_FOLDERS.folders[LIB_FOLDERS.folders.length - 1];
                if (created && await libFolderOp({ action: 'assign', key: itemKey, folder: created.id })) refreshLibraryTabs();
              }
            },
          });
        });
        box.appendChild(mk);

        back.addEventListener('click', close);
        document.body.appendChild(back);
        document.body.appendChild(box);
      }

      /**
       * Render one library tab as folders + leftovers.
       * items: [{ key, label, kind, dataset }] — `key` is the namespaced folder key.
       * groupOf/groupOrder describe the fallback grouping for unfiled items.
       */
      function renderLibTree(container, items, groupOf, groupOrder, emptyText, opts) {
        // v1.10 LIB2: opts = { scope: 'video' (the Videos tab's own tree) | 'brush' (R4: the Brushes tree), grid: items go into .img-grid, mkItem(it, depth): element }
        const scope = (opts && opts.scope) || null;
        const kids = id => libChildren(id, scope);
        const inScope = f => (f.scope || null) === scope;
        container.innerHTML = '';
        // Empty message ONLY when there is genuinely nothing — with folders present the tree still
        // renders, otherwise an empty library would hide the folders the user built and offer no
        // way to make new ones.
        if (!items.length && !LIB_FOLDERS.folders.some(inScope)) {
          const empty = document.createElement('div');
          empty.className = 'lib-empty';
          empty.textContent = emptyText;
          container.appendChild(empty);
          const add0 = document.createElement('div');
          add0.className = 'lib-newfolder';
          add0.dataset.act = 'fcreate-root';
          if (scope) add0.dataset.scope = scope;
          add0.textContent = '+ new folder';
          container.appendChild(add0);
          return;
        }

        const byFolder = new Map();
        const loose = [];
        for (const it of items) {
          const fid = LIB_FOLDERS.assignments[it.key];
          // An assignment pointing at a folder that no longer exists must not swallow the item.
          if (fid && LIB_FOLDERS.folders.some(f => f.id === fid && inScope(f))) {
            if (!byFolder.has(fid)) byFolder.set(fid, []);
            byFolder.get(fid).push(it);
          } else {
            loose.push(it);
          }
        }

        const mkItem = (it, depth) => {
          if (opts && opts.mkItem) return opts.mkItem(it, depth);
          const el = makeLibItem({ kind: it.kind, label: it.label, dataset: it.dataset, actions: it.kind === 'asset' ? (REMESH_ON ? ['blender', 'preview', 'move', 'rename', 'remesh', 'delete'] : ['blender', 'preview', 'move', 'rename', 'delete']) : ['blender', 'unreal', 'preview', 'move', 'rename', 'delete'] });
          el.dataset.folderKey = it.key;
          if (depth !== null) { el.classList.add('in-folder'); el.style.setProperty('--depth', depth); }
          return el;
        };

        // Count everything below a folder, subfolders included — a collapsed folder showing "0"
        // when it holds twenty items nested one level down would read as empty.
        const deepCount = id => {
          let n = (byFolder.get(id) || []).length;
          for (const c of kids(id)) n += deepCount(c.id);
          return n;
        };

        let curGrid = null;   // grid mode: consecutive items share one .img-grid; any folder row / category header ends it
        const putRow = el => { curGrid = null; container.appendChild(el); };
        const putItem = (el, depth) => {
          if (!(opts && opts.grid)) { container.appendChild(el); return; }
          if (!curGrid) { curGrid = document.createElement('div'); curGrid.className = opts.tileGrid ? 'lib-tile-grid' : 'img-grid'; if (depth !== null && curGrid.style && curGrid.style.setProperty) curGrid.style.setProperty('--depth', depth); container.appendChild(curGrid); }
          curGrid.appendChild(el);
        };
        (function walk(parent, depth) {
          for (const f of kids(parent)) {
            const row = document.createElement('div');
            row.className = 'lib-folder' + (libIsCollapsed(f.id) ? ' collapsed' : '');
            row.style.setProperty('--depth', depth);
            row.dataset.folderId = f.id;
            if (scope) row.dataset.scope = scope;

            const tri = document.createElement('span');
            tri.className = 'lib-tri';
            tri.textContent = '▾';
            row.appendChild(tri);

            const nm = document.createElement('span');
            nm.className = 'lib-folder-name';
            nm.textContent = f.name;
            row.appendChild(nm);

            const cnt = document.createElement('span');
            cnt.className = 'lib-count';
            cnt.textContent = deepCount(f.id) || '';
            row.appendChild(cnt);

            const acts = document.createElement('span');
            acts.className = 'lib-actions';
            for (const act of ['fnew', 'frename', 'fdelete']) acts.appendChild(libActBtn(act));
            row.appendChild(acts);
            putRow(row);

            if (!libIsCollapsed(f.id)) {
              for (const it of (byFolder.get(f.id) || [])) putItem(mkItem(it, depth), depth);
              walk(f.id, depth + 1);
            }
          }
        })(null, 0);

        // Unfiled items keep the original category grouping — that is what makes filing optional
        // instead of a migration everything has to go through.
        const grouped = {};
        for (const it of loose) {
          const g = groupOf(it);
          (grouped[g] = grouped[g] || []).push(it);
        }
        const cats = [
          ...groupOrder.filter(c => grouped[c] && grouped[c].length),
          ...Object.keys(grouped).filter(c => !groupOrder.includes(c)),
        ];
        for (const cat of cats) {
          const hdr = document.createElement('div');
          hdr.className = 'lib-cat';
          hdr.textContent = cat;
          putRow(hdr);
          for (const it of grouped[cat]) putItem(mkItem(it, null), null);
        }

        const add = document.createElement('div');
        add.className = 'lib-newfolder';
        add.dataset.act = 'fcreate-root';
        if (scope) add.dataset.scope = scope;
        add.textContent = '+ new folder';
        container.appendChild(add);
      }

      function refreshLibraryTabs() {
        loadAssets(); loadBrushes();
        try { if (libImagesBody.classList.contains('visible')) loadImagesTab('images'); } catch (_) {}
        try { if (libVideosBody.classList.contains('visible')) loadImagesTab('videos'); } catch (_) {}   // v1.10 LIB2: the Videos tab is a folder tree too
      }

      async function loadAssets() {
        try {
          const data = await (await fetch('/assets')).json();
          await fetchLibFolders();
          const items = (data.assets || []).map(function (a) { return { key: 'asset:' + a.category + '/' + a.name, kind: 'asset', label: a.label || a.name, dataset: { name: a.name, category: a.category, sizeMB: a.sizeMB == null ? '' : String(a.sizeMB), posterKey: 'asset:' + a.category + '/' + a.name, posterStamp: a.posterStamp || '' } }; });
          renderLibTree(libAssetsBody, items, function (it) { return it.dataset.category; }, LIB_CAT_ORDER, 'no staged assets yet', { grid: true, tileGrid: true, mkItem: function (it) {
            const d = Object.assign({}, it.dataset, { folderKey: it.key });
            const actions = ['blender', 'unreal', 'preview', 'move', 'rename']; if (REMESH_ON) actions.push('remesh'); actions.push('delete');
            const tile = libTile({ kind: 'asset', name: it.label, dataset: d, poster: '/poster?key=' + encodeURIComponent(it.key) + '&stamp=' + encodeURIComponent(d.posterStamp), meta: d.category + (d.sizeMB === '' ? '' : ' · ' + d.sizeMB + ' MB'), actions: actions.map(libActBtn), onPosterError: renderTilePoster });
            if (Object.prototype.hasOwnProperty.call(remeshBadges, d.category + '/' + d.name)) { const badge = document.createElement('span'); badge.className = 'lib-badge'; badge.textContent = '⟳ ' + remeshBadges[d.category + '/' + d.name] + '%'; tile.appendChild(badge); }
            return tile;
          } });
          try { if (libraryPage) libraryPage.noteChange('assets'); } catch (_) {}
        } catch (_) {}
      }

      async function loadBrushes() {
        try {
          const data = await (await fetch('/brushes')).json();
          await fetchLibFolders();
          let stale = false;
          const items = (data.brushes || []).map(function (b) { return { key: 'brush:' + b.slug, kind: 'brush', label: b.display, category: b.category || '', error: b.previewError, dataset: { slug: b.slug, display: b.display, category: b.category || '', btype: b.type === 'sci_fi' ? 'Sci-Fi' : 'Phoenix', glbFresh: String(!!b.glbFresh), posterKey: 'brush:' + b.slug, posterStamp: b.posterStamp || '' } }; });
          renderLibTree(libBrushesBody, items, function (it) { return it.dataset.btype; }, ['Sci-Fi', 'Phoenix'], 'no brushes yet', { scope: 'brush', grid: true, tileGrid: true, mkItem: function (it) {
            const d = Object.assign({}, it.dataset, { folderKey: it.key }), fresh = d.glbFresh === 'true';
            const actions = ['blender', 'unreal', 'preview', 'move', 'rename', 'delete']; if (!fresh && it.error) actions.push('retry');
            if (d.btype === 'Phoenix') actions.splice(actions.indexOf('delete'), 0, 'replace');   // F2.4: only our own brushes can be replaced from a selection
            const tile = libTile({ kind: 'brush', name: it.label, dataset: d, poster: fresh ? '/poster?key=' + encodeURIComponent(it.key) + '&stamp=' + encodeURIComponent(d.posterStamp) : null, placeholder: 'No preview yet', meta: it.category, actions: actions.map(libActBtn), onPosterError: renderTilePoster });
            if (!fresh && it.error) libTileProblem(tile, 'Preview failed — ' + readableReply(it.error), { label: 'Retry', run: function () { tile.querySelector('[data-act="retry"]').click(); } }, 'export');
            if (brushTileUpdating({ glbFresh: fresh, previewError: it.error }, data.previews)) { const upd = document.createElement('div'); upd.className = 'lib-inline-text'; upd.setAttribute('role', 'status'); upd.dataset.hint = 'poster-updating'; upd.textContent = 'Updating preview…'; tile.appendChild(upd); stale = true; }
            return tile;
          } });
          libBrushesStale = stale;
          showBrushPreviewStatus(data.previews || {}); libPreviewStatus = data.previews || libPreviewStatus;
          fetch('/brushes/previews', { method: 'POST' }).catch(function () {});
          try { if (libraryPage) libraryPage.noteChange('brushes'); } catch (_) {}
        } catch (_) {}
      }

      async function loadMaterials() {
        try {
          const res = await fetch('/materials');
          const data = await res.json();
          const materials = data.materials || [];
          libMaterialsBody.innerHTML = '';
          if (materials.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'lib-empty';
            empty.textContent = 'no materials';
            libMaterialsBody.appendChild(empty);
            return;
          }
          const grid = document.createElement('div'); grid.className = 'lib-tile-grid';
          for (const m of materials) {
            const swatch = m.color ? 'rgb(' + m.color.map(function (v) { return Math.round(v * 255); }).join(',') + ')' : null;
            grid.appendChild(libTile({ kind: 'material', name: m.name, dataset: { name: m.name }, swatch: swatch, actions: [libActBtn('apply')] }));
          }
          libMaterialsBody.appendChild(grid);
          try { if (typeof libraryPage !== 'undefined' && libraryPage) libraryPage.noteChange('materials'); } catch (_) {}
        } catch (_) {}
      }

      // <lt2> one shared helper: a playing take must not be cut off by a rebuild (refresh or tab switch)
      function audioPlaying(root) { return !!root && Array.prototype.some.call(root.querySelectorAll('audio'), function (a) { return !a.paused && !a.ended; }); }
      function refreshLibrary() { loadAssets(); loadBrushes(); loadMaterials(); loadPaletteTab(); loadWorkflowsTab(); refreshImagesPanel(); }
      // <lt-fixes> reload Images/Videos only when that panel is the visible one (otherwise it loads on open); no polling
      function refreshImagesPanel() {
        try {
          if (libImagesBody.classList.contains('visible')) loadImagesTab('images');
          else if (libVideosBody.classList.contains('visible')) { if (typeof imagesTab === 'undefined' || !imagesTab.playing()) loadImagesTab('videos'); else imagesTab.deferUntilIdle(function () { refreshImagesPanel(); }); }   // v1.10 VP1: a tile playing in place is not cut off by a refresh
          else if (libSoundBody.classList.contains('visible')) { if (!audioPlaying(libSoundBody)) loadImagesTab('sound'); }   // <l1-library> a playing take is not cut off
          else if (libSfxBody.classList.contains('visible')) { if (!audioPlaying(libSfxBody)) loadImagesTab('sfx'); }
          else if (libStoryboardsBody.classList.contains('visible') && typeof storyboardsTab !== 'undefined') storyboardsTab.load(libStoryboardsBody);
        } catch (_) {}
      }

      // The delegated handlers sit on the docked list AND on the Library page (the bodies move between them): the SAME functions on both.
      const libRoot = document.getElementById('library-list');
      const libPageEl = document.getElementById('library-page');
      let _libClickTimer = null;

      // select = class + aria-selected, per body (never Library-wide)
      function libSelectItem(item, hostEl) {
        const scopeEl = (item.closest && item.closest('.lib-panel')) || hostEl;
        scopeEl.querySelectorAll('.lib-item, .lib-tile').forEach(function (el) { el.classList.remove('selected'); el.removeAttribute('aria-selected'); });
        item.classList.add('selected');
        item.setAttribute('aria-selected', 'true');
      }
      // the preview path (a single click in the docked Library; the Preview button everywhere): asset -> /show, brush -> brush_preview. Both land in Create > Mesh.
      let libInlinePending = null, libInlineItem = null;
      window.__libInlinePreview = { take: function (obj) {
        const page = document.getElementById('library-page');
        if (!libInlinePending || !page || page.hidden || obj.slot !== 'mesh' || !String(obj.url || '').includes(encodeURIComponent('brush-cache/' + libInlinePending + '.glb'))) return false;
        document.getElementById('lib-preview-mv').src = obj.url; libInlinePending = null; return true;
      } };
      function libPreviewItem(item, origin, openMesh) {
        const kind = item.dataset.kind;
        const page = item.closest('#library-page');
        if (page && !openMesh) {
          const preview = document.getElementById('lib-preview'); preview.hidden = false;
          libInlineItem = item; libInlinePending = null;
          document.getElementById('lib-preview-name').textContent = (item.querySelector('.lib-tile-name') || item.querySelector('.lib-item-name')).textContent;
          const mv = document.getElementById('lib-preview-mv');
          mv.removeAttribute('src');
          if (kind === 'asset') mv.src = '/file?p=' + encodeURIComponent('staging/' + item.dataset.category + '/' + item.dataset.name);
          else if (item.dataset.glbFresh === 'true') mv.src = '/file?p=' + encodeURIComponent('brush-cache/' + item.dataset.slug + '.glb');
          else { libInlinePending = item.dataset.slug; postAction('brush_preview', { name: item.dataset.slug }, origin); }
          const acts = document.getElementById('lib-preview-actions'); acts.textContent = '';
          ['blender', 'unreal'].forEach(function (act) { const btn = libActBtn(act); btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const action = kind === 'asset' ? (act === 'unreal' ? 'asset_to_unreal' : 'import_asset') : (act === 'unreal' ? 'brush_to_unreal' : 'use_brush');
            postAction(action, kind === 'asset' ? { category: item.dataset.category, name: item.dataset.name } : { name: item.dataset.slug }, btn);
          }); acts.appendChild(btn); });
          const open = document.getElementById('lib-preview-open-mesh'); if (open._libOpen) open.removeEventListener('click', open._libOpen); open._libOpen = function () { libPreviewItem(item, origin, true); }; open.addEventListener('click', open._libOpen);
          const close = document.getElementById('lib-preview-close'); if (close._libClose) close.removeEventListener('click', close._libClose); close._libClose = function () { preview.hidden = true; libInlinePending = null; }; close.addEventListener('click', close._libClose);
          return;
        }
        libInlinePending = null;
        if (kind === 'asset') {
          currentMesh = { name: item.dataset.name, category: item.dataset.category };
          const p = 'staging/' + item.dataset.category + '/' + item.dataset.name;
          fetch('/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot: 'mesh', p: p, source: 'library' }) }).catch(function () {});
        } else if (kind === 'brush') postAction('brush_preview', { name: item.dataset.slug }, origin);
      }

      async function libOnClick(e) {
        if (e.target.closest('[data-act="problem"], .lib-problem-pop')) return;
        const tile = e.target.closest('.lib-tile');
        if (tile && !['asset', 'brush', 'material'].includes(tile.dataset.kind)) return;
        const actBtn = e.target.closest('.lib-act-btn');
        const hostEl = (e.currentTarget && e.currentTarget.querySelectorAll) ? e.currentTarget : libRoot;

        // ── Folder rows and the "+ new folder" control ────────────────────────
        // Handled BEFORE the item branch: a folder row is not a .lib-item, so the early return
        // below would otherwise swallow every click on it.
        const newRoot = e.target.closest('.lib-newfolder');
        if (newRoot) {
          libInlineRow({
            anchor: newRoot, trigger: newRoot, kind: 'name', label: 'New folder name', action: 'Create',
            onDone: async (n) => { if (await libFolderOp({ action: 'create', name: n, scope: newRoot.dataset.scope || undefined })) refreshLibraryTabs(); },
          });
          return;
        }
        const folderRow = e.target.closest('.lib-folder');
        if (folderRow) {
          const fid = folderRow.dataset.folderId;
          const fname = folderRow.querySelector('.lib-folder-name').textContent;
          if (actBtn) {
            const act = actBtn.dataset.act;
            if (act === 'fnew') {
              libInlineRow({
                anchor: folderRow, trigger: actBtn, kind: 'name', label: 'New subfolder inside "' + fname + '"', action: 'Create',
                onDone: async (n) => { if (await libFolderOp({ action: 'create', name: n, parent: fid })) refreshLibraryTabs(); },
              });
            } else if (act === 'frename') {
              libInlineRow({
                anchor: folderRow, trigger: actBtn, kind: 'name', label: 'Rename folder', value: fname, action: 'Save',
                onDone: async (n) => { if (await libFolderOp({ action: 'rename', id: fid, name: n })) refreshLibraryTabs(); },
              });
            } else if (act === 'fdelete') {
              // Say what deleting does NOT do. "Delete folder" next to a list of assets reads like
              // it takes the assets with it, and it does not — nothing on disk is touched.
              libInlineRow({
                anchor: folderRow, trigger: actBtn, kind: 'confirm', action: 'Delete', danger: true,
                label: 'Delete folder "' + fname + '"? No files are deleted. Its items go back to their categories and any subfolders move up one level.',
                onDone: async () => { if (await libFolderOp({ action: 'delete', id: fid })) refreshLibraryTabs(); },
              });
            }
            return;
          }
          if (await libFolderOp({ action: 'collapse', id: fid })) refreshLibraryTabs();
          return;
        }

        const item = e.target.closest('.lib-item, .lib-tile');
        if (!item) return;
        if (actBtn) {
          clearTimeout(_libClickTimer);
          const act = actBtn.dataset.act;
          const kind = item.dataset.kind;
          if (act === 'apply' && kind === 'material') { postAction('apply_material', { name: item.dataset.name }, actBtn); return; }
          if (act === 'unreal' && kind === 'asset') { postAction('asset_to_unreal', { category: item.dataset.category, name: item.dataset.name }, actBtn); return; }
          if (act === 'retry') {
            if (libPreviewStatus.unavailable) postAction('brush_preview', { name: item.dataset.slug }, actBtn);
            else {
              actBtn.setAttribute('aria-busy', 'true'); actBtn.setAttribute('title', 'Preview queued');
              const unbusy = function () { actBtn.removeAttribute('aria-busy'); actBtn.removeAttribute('title'); };
              setTimeout(unbusy, 60000);
              fetch('/brushes/previews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retry: item.dataset.slug }) }).catch(unbusy);
            }
            return;
          }
          if (act === 'unreal' && kind === 'brush') { postAction('brush_to_unreal', { name: item.dataset.slug }, actBtn); return; }
          if (act === 'replace' && kind === 'brush') {
            const display = item.dataset.display || item.dataset.slug, slug = item.dataset.slug;
            libInlineRow({
              anchor: item, trigger: actBtn, kind: 'confirm', action: 'Replace', danger: true, label: 'Replace ' + display + ' with the selection? The old version goes to the trash.',
              onDone: () => { postAction('save_as_brush', { name: slug, display: display, category: item.dataset.category, overwrite: true }, actBtn); if (window.__brushSaveRow) window.__brushSaveRow.noteRecent(slug); },
            });
            return;
          }
          if (act === 'blender') {
            if (kind === 'brush') postAction('use_brush', { name: item.dataset.slug }, actBtn);
            // R4: the visible send button = today's double-click on an asset
            if (kind === 'asset') {
              currentMesh = { name: item.dataset.name, category: item.dataset.category };
              postAction('import_asset', { name: item.dataset.name, cleanup: false }, actBtn);
            }
            return;
          }
          if (act === 'preview') { libPreviewItem(item, actBtn); return; }
          if (act === 'move') {
            openFolderPicker(item.dataset.folderKey, LIB_FOLDERS.assignments[item.dataset.folderKey] || null, kind === 'brush' ? 'brush' : undefined);
            return;
          }
          if (act === 'rename') {
            if (kind === 'asset') {
              libInlineRow({
                anchor: item, trigger: actBtn, kind: 'name', label: 'Label for ' + item.dataset.name, value: item.querySelector('.lib-tile-name, .lib-item-name').textContent, action: 'Save', allowEmpty: true,
                onDone: (v) => postAction('rename_asset', { category: item.dataset.category, name: item.dataset.name, label: v }, actBtn),
              });
            } else if (kind === 'brush') {
              libInlineRow({
                anchor: item, trigger: actBtn, kind: 'name', label: 'Display name', value: item.dataset.display || '', action: 'Save',
                onDone: (v) => postAction('rename_brush', { slug: item.dataset.slug, display: v }, actBtn),
              });
            }
          } else if (act === 'remesh') {
            if (kind === 'asset') openRemeshDialog(item.dataset.category, item.dataset.name, item.dataset.sizeMB, actBtn);
          } else if (act === 'delete') {
            if (kind === 'asset') {
              libInlineRow({
                anchor: item, trigger: actBtn, kind: 'confirm', action: 'Delete', danger: true, label: 'Delete ' + item.dataset.category + '/' + item.dataset.name + '? This moves it to the trash.',
                onDone: () => postAction('delete_asset', { category: item.dataset.category, name: item.dataset.name }, actBtn),
              });
            } else if (kind === 'brush') {
              libInlineRow({
                anchor: item, trigger: actBtn, kind: 'confirm', action: 'Delete', danger: true, label: 'Move brush "' + (item.dataset.display || item.dataset.slug) + '" to the trash?',
                onDone: () => postAction('delete_brush', { slug: item.dataset.slug }, actBtn),
              });
            }
          }
          return;
        }
        clearTimeout(_libClickTimer);
        // On the Library page a single click on an asset / brush tile ONLY selects it: a preview switches to Create > Mesh, which would
        // pull the user out of the Library mid-browse. The Preview button is the visible way to ask for it. The docked Library keeps today's click.
        if ((item.dataset.kind === 'asset' || item.dataset.kind === 'brush') && item.closest && item.closest('#library-page')) { libSelectItem(item, hostEl); return; }
        if (item.dataset.kind === 'material') { libSelectItem(item, hostEl); return; }
        _libClickTimer = setTimeout(function () {
          libSelectItem(item, hostEl);
          const kind = item.dataset.kind;
          if (kind === 'asset' || kind === 'brush') {
            libPreviewItem(item);
          }
        }, 250);
      }

      async function libOnDblClick(e) {
        if (e.target.closest('[data-act="problem"], .lib-problem-pop')) return;
        const actBtn = e.target;
        const tile = e.target.closest('.lib-tile');
        if (tile && !['asset', 'brush', 'material'].includes(tile.dataset.kind)) return;
        if (e.target.closest('.lib-act-btn')) return;
        const item = e.target.closest('.lib-item, .lib-tile');
        if (!item) return;
        const hostEl = (e.currentTarget && e.currentTarget.querySelectorAll) ? e.currentTarget : libRoot;
        clearTimeout(_libClickTimer);
        libSelectItem(item, hostEl);
        const kind = item.dataset.kind;
        if (kind === 'asset') {
          currentMesh = { name: item.dataset.name, category: item.dataset.category };
          postAction('import_asset', { name: item.dataset.name, cleanup: false }, actBtn);
        } else if (kind === 'brush') {
          // Where a double-clicked brush lands is a SETTING (Settings → Unreal). Read it fresh on
          // every click instead of caching it: a cached copy that disagrees with what was saved is
          // the kind of bug that gets debugged in the wrong file. One tiny GET per double-click.
          let target = 'blender';
          try {
            const r = await fetch('/config');
            const c = await r.json();
            target = (c.unreal && c.unreal.brushTarget) || 'blender';
          } catch (_) { /* server unreachable → the historical behaviour, not a silent no-op */ }

          if (target === 'unreal') {
            postAction('brush_to_unreal', { name: item.dataset.slug }, actBtn);
          } else if (target === 'both') {
            // "both" means it stays in Blender AND lands in Unreal — so the Blender copy must be
            // kept explicitly; brush_to_unreal removes it by default.
            postAction('brush_to_unreal', { name: item.dataset.slug, keep_in_blender: true }, actBtn);
          } else {
            postAction('use_brush', { name: item.dataset.slug }, actBtn);
          }
        }
      }

      // F2.4: right-click on a Phoenix brush tile -> a small menu with the same Replace as the tile button
      let libCtxMenu = null;
      function libCtxClose() { if (libCtxMenu) { libCtxMenu.remove(); libCtxMenu = null; } }
      function libOnContext(e) {
        const tile = e.target.closest && e.target.closest('.lib-tile');
        if (!tile || tile.dataset.kind !== 'brush' || !tile.querySelector('[data-act="replace"]')) return;
        e.preventDefault();
        libCtxClose();
        const menu = document.createElement('div'); menu.className = 'lib-ctx-menu';
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-secondary btn-sm'; b.setAttribute('data-ctx', 'replace'); b.textContent = 'Replace with selection';
        b.addEventListener('click', function (ev) { ev.stopPropagation(); const t = tile.querySelector('[data-act="replace"]'); libCtxClose(); if (t) t.click(); });
        menu.appendChild(b); tile.appendChild(menu); libCtxMenu = menu;
        document.addEventListener('click', libCtxClose, { once: true });
      }
      [libRoot, libPageEl].forEach(function (r) {
        if (!r) return;
        r.addEventListener('contextmenu', libOnContext);
        r.addEventListener('click', libOnClick);
        r.addEventListener('dblclick', libOnDblClick);
      });

