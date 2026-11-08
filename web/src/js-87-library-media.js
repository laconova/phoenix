      // ── Library Images / Videos tabs (v1.10 C1) ──────────────────────────────────────────────────
      // A thumbnail grid of what Phoenix generated, read from GET /images (the output record) when the
      // tab is opened - no polling. Use / Mesh it go through POST /images/use (the same state /upload sets),
      // Mesh it then runs image_to_3d only if that succeeded. All record strings are rendered via
      // textContent / title. The factory takes its collaborators so it is testable with fakes.
      // <c1-images>
      function makeImagesTab(deps) {
        const doc = deps.document;
        function el(tag, cls, text) {
          const e = doc.createElement(tag);
          if (cls) e.className = cls;
          if (text != null) e.textContent = text;
          return e;
        }
        function note(root, text) { root.textContent = ''; root.appendChild(el('div', 'lib-empty', text)); }
        async function useImage(path) {
          const r = await deps.fetch('/images/use', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path }) });
          return r && r.ok;
        }
        // <lt-fixes> inline stroke icons; "3D" is literal text
        const ICONS = {
          Use: [['path', { d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1' }], ['path', { d: 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' }]],
          Open: [['circle', { cx: '11', cy: '11', r: '6' }], ['path', { d: 'M20 20l-4.5-4.5' }]],
        };
        function svgEl(tag) { return doc.createElementNS ? doc.createElementNS('http://www.w3.org/2000/svg', tag) : doc.createElement(tag); }
        function setLabel(b, label, title) {
          b.setAttribute('title', title || label);
          b.setAttribute('aria-label', title || label);
          if (!ICONS[label]) { b.textContent = label === 'Mesh it' ? '3D' : label; return; }   // v1.10 V1: any other unknown label renders as text
          const svg = svgEl('svg');
          svg.setAttribute('viewBox', '0 0 24 24');
          svg.setAttribute('fill', 'none');
          svg.setAttribute('stroke', 'currentColor');
          svg.setAttribute('stroke-width', '2');
          svg.setAttribute('stroke-linecap', 'round');
          svg.setAttribute('stroke-linejoin', 'round');
          svg.setAttribute('aria-hidden', 'true');
          ICONS[label].forEach(function (p) {
            const n = svgEl(p[0]);
            Object.keys(p[1]).forEach(function (k) { n.setAttribute(k, p[1][k]); });
            svg.appendChild(n);
          });
          b.appendChild(svg);
        }
        function actionBtn(label, fn, title) {
          const b = el('button', 'img-tile-btn');
          setLabel(b, label, title);
          b.setAttribute('type', 'button');
          b.addEventListener('click', function () { Promise.resolve(fn()).catch(function () {}); });
          return b;
        }
        // v1.10 V1b-1: Use is context-sensitive. Storyboard tab visible -> "Add to storyboard" (one POST /storyboard/shot on the active board);
        // otherwise the old Use (POST /images/use). The label follows the top tab (refreshUse, called by switchTab).
        const useBtns = [];
        let sbTitle = '';   // title of the active board, fetched when the Storyboard tab is the visible one
        function sbVisible() { try { return !!(deps.activeTopTab && deps.activeTopTab() === 'storyboard'); } catch (_) { return false; } }
        function useTitle() { return sbVisible() ? (sbTitle ? 'Add to storyboard "' + sbTitle + '"' : 'Add to storyboard') : 'Use in the Image panel'; }
        function paintUse() { const t = useTitle(); useBtns.forEach(function (b) { b.setAttribute('title', t); b.setAttribute('aria-label', t); }); }
        let sbTitleSeq = 0;
        async function refreshUse() {
          paintUse();
          if (!sbVisible() || !useBtns.length) return;
          const seq = ++sbTitleSeq;
          if (deps.boardTitle) {   // the open Storyboard tab already knows the active board: no second request
            const t0 = deps.boardTitle();
            if (t0) { sbTitle = String(t0); paintUse(); return; }
            if (deps.boardLoading && deps.boardLoading()) return;   // its load is on the way; onBoard repaints
          }
          try {
            const r = await deps.fetch('/storyboards');
            const j = r && r.ok ? await r.json() : null;
            const b = j && Array.isArray(j.boards) ? j.boards.find(function (x) { return x.id === j.active; }) : null;
            if (b && seq === sbTitleSeq) { sbTitle = String(b.title || ''); paintUse(); }
          } catch (_) {}
        }
        async function useOrAdd(rec, status) {
          if (!sbVisible()) { status.textContent = ''; return useImage(rec.path); }
          return addToStoryboard(rec.path, status);
        }
        async function addToStoryboard(path, status) {
          try {
            const r = await deps.fetch('/storyboard/shot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: path }) });   // LC2d (T8-5): the shot starts from the IMAGE only - the picture's generation prompt is not the shot's prompt
            let j = null;
            try { j = await r.json(); } catch (_) {}
            if (r && r.ok) {
              if (j && j.board && j.board.title) { sbTitle = String(j.board.title); paintUse(); }
              if (deps.reloadStoryboard) { try { deps.reloadStoryboard(); } catch (_) {} }   // the open Storyboard tab shows the new shot
              status.textContent = 'Added to ' + ((j && j.board && j.board.title) || 'the storyboard') + ' as shot ' + ((j && j.board && j.board.shots && j.board.shots.length) || '?');
            } else status.textContent = (j && j.error) || ('HTTP ' + (r && r.status));
          } catch (err) { status.textContent = (err && err.message) || String(err); }
          return false;
        }
        // <lib2-undo-toast> (T6-6) One toast at a time, 10 s, with Undo; it lives at the bottom of the panel it was raised in (load() re-attaches it after a rebuild).
        // The ONE timer of this tab; a new toast / a rebuilt panel / Undo clears it first.
        let toastEl = null, toastRoot = null, toastTimer = null;
        function clearToast() {
          if (toastTimer) { (deps.clearTimer || clearTimeout)(toastTimer); toastTimer = null; }
          if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
          toastEl = null; toastRoot = null;
        }
        const showToast = function (ctx, text, undoId) {
          clearToast();
          const t = el('div', 'lib-toast');
          t.setAttribute('role', 'status');
          t.appendChild(el('span', 'lib-toast-text', text));
          if (undoId) {
            const u = el('button', 'lib-toast-undo', 'Undo');
            u.setAttribute('type', 'button');
            u.setAttribute('aria-label', 'Undo');
            u.addEventListener('click', function () { Promise.resolve(restoreEntry(ctx, undoId)).catch(function () {}); });
            t.appendChild(u);
          }
          ctx.root.appendChild(t);
          toastEl = t; toastRoot = ctx.root;
          const timer = deps.timer || setTimeout;
          toastTimer = timer(function () { toastTimer = null; clearToast(); }, 10000);
        };
        // </lib2-undo-toast>
        function adoptToast(root) { if (toastEl && toastRoot === root) root.appendChild(toastEl); }   // a rebuilt panel keeps its running toast
        const trashOpen = {};   // kind key -> the Trash (n) list is expanded
        const kindsOf = function (kind) { return String(kind || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean); };
        async function postJson(url, payload) {
          const r = await deps.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          let j = null;
          try { j = await r.json(); } catch (_) {}
          return { ok: !!(r && r.ok), status: r && r.status, json: j };
        }
        async function trashRec(rec, ctx) {
          try {
            const r = await postJson('/images/trash', { path: rec.path });
            if (!r.ok) { showToast(ctx, 'Could not move to the trash: ' + ((r.json && r.json.error) || ('HTTP ' + r.status)), null); return false; }
            await ctx.reload();
            showToast(ctx, 'Moved to the trash.', r.json && r.json.id);
            return true;
          } catch (err) { showToast(ctx, 'Could not move to the trash: ' + ((err && err.message) || String(err)), null); return false; }
        }
        async function restoreEntry(ctx, id) {
          try {
            const r = await postJson('/images/restore', { id: id });
            if (!r.ok) { showToast(ctx, 'Could not restore: ' + ((r.json && r.json.error) || ('HTTP ' + r.status)), null); return false; }
            clearToast();
            await ctx.reload();
            if (r.json && r.json.warning) showToast(ctx, String(r.json.warning), null);   // LC2d: the clip is back but its twin is not - say so
            return true;
          } catch (err) { showToast(ctx, 'Could not restore: ' + ((err && err.message) || String(err)), null); return false; }
        }
        // R4: "Empty trash" asks with an inline row under its button (deps.inlineRow = libInlineRow), never with a native dialog; emptyTrash runs after "Delete"
        function askEmptyTrash(ctx, n, btn) {
          const ask = deps.inlineRow || (typeof libInlineRow === 'function' ? libInlineRow : null);
          if (!ask) return;
          ask({ doc: doc, anchor: btn, trigger: btn, kind: 'confirm', action: 'Delete', danger: true,
            label: 'Permanently delete ' + n + ' trashed file' + (n === 1 ? '' : 's') + '? This cannot be undone.',
            onDone: function () { Promise.resolve(emptyTrash(ctx)).catch(function () {}); } });
        }
        async function emptyTrash(ctx) {
          try {
            const r = await postJson('/images/trash/empty', { kinds: kindsOf(ctx.kind) });
            if (!r.ok) { showToast(ctx, 'Could not empty the trash: ' + ((r.json && r.json.error) || ('HTTP ' + r.status)), null); return false; }
            clearToast();
            await ctx.reload();
            const failed = (r.json && Array.isArray(r.json.failed)) ? r.json.failed : [];
            if (failed.length) { showToast(ctx, failed.length + ' file' + (failed.length === 1 ? '' : 's') + ' could not be deleted and stay in the trash: ' + String(failed[0].error || ''), null); return false; }
            return true;
          } catch (err) { showToast(ctx, 'Could not empty the trash: ' + ((err && err.message) || String(err)), null); return false; }
        }
        function trashBtn(rec, ctx) {
          const b = el('button', 'img-tile-x', '\u2715');
          b.setAttribute('type', 'button');
          b.setAttribute('title', 'Move to trash');
          b.setAttribute('aria-label', 'Move to trash');
          b.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); Promise.resolve(trashRec(rec, ctx)).catch(function () {}); });
          return b;
        }
        function trashBlock(ctx, entries) {
          const box = el('div', 'lib-trash');
          const open = !!trashOpen[ctx.kind];
          const head = el('button', 'lib-trash-head', 'Trash (' + entries.length + ')');
          head.setAttribute('type', 'button');
          head.setAttribute('aria-expanded', open ? 'true' : 'false');
          const body = el('div', 'lib-trash-body');
          body.hidden = !open;
          entries.forEach(function (x) {
            const row = el('div', 'lib-trash-row');
            const nm = el('span', 'lib-trash-name', String(x.from || '').split('/').pop());
            nm.setAttribute('title', String(x.from || ''));
            const rb = el('button', 'lib-trash-restore', 'Restore');
            rb.setAttribute('type', 'button');
            rb.setAttribute('aria-label', 'Restore ' + String(x.from || '').split('/').pop());
            rb.addEventListener('click', function () { Promise.resolve(restoreEntry(ctx, x.id)).catch(function () {}); });
            row.appendChild(nm); row.appendChild(rb);
            body.appendChild(row);
          });
          const eb = el('button', 'lib-trash-empty', 'Empty trash');
          eb.setAttribute('type', 'button');
          eb.addEventListener('click', function () { askEmptyTrash(ctx, entries.length, eb); });
          body.appendChild(eb);
          head.addEventListener('click', function () {
            const o = head.getAttribute('aria-expanded') !== 'true';
            head.setAttribute('aria-expanded', o ? 'true' : 'false');
            body.hidden = !o; trashOpen[ctx.kind] = o;
          });
          box.appendChild(head); box.appendChild(body);
          return box;
        }
        function tail(ctx, trash) {   // what every successfully loaded panel ends with: Trash (n) when there is any, then the running toast
          if (trash && trash.length) ctx.root.appendChild(trashBlock(ctx, trash));
          adoptToast(ctx.root);
        }
        // <lib2-video> (T6-23) a video tile shows its poster (GET /thumb) with a play overlay; no poster / the poster 404s -> a neutral play placeholder (never the mp4 as an <img>)
        function videoPlaceholder() { return el('div', 'img-tile-vph', '\u25B6'); }
        function videoFace(wrap, rec) {
          if (!rec.thumb) { wrap.appendChild(videoPlaceholder()); return; }
          const im = el('img');
          im.setAttribute('loading', 'lazy');
          im.setAttribute('alt', '');
          im.setAttribute('src', rec.thumb);
          const play = el('span', 'img-tile-play', '\u25B6');
          im.addEventListener('error', function () { try { wrap.removeChild(im); wrap.removeChild(play); } catch (_) {} wrap.appendChild(videoPlaceholder()); });
          wrap.appendChild(im); wrap.appendChild(play);
        }
        // <vp1-inline> a video tile plays in place: the thumb is replaced by an inline <video> (controls, sound on); only one at a time
        let inline = null;   // { wrap, nodes, vid }
        let deferred = null; // R3-B2: the (latest) refresh that arrived while a tile player existed; survives tile switches
        function isPlaying() { return !!inline && !inline.vid.ended; }   // a tile player that exists (playing or paused) holds refreshes; an ended one does not
        function stopInline(keep) {
          const c = inline; inline = null;
          if (!c) { if (!keep) runDeferred(); return; }
          const hadFocus = doc.activeElement === c.vid;
          try { c.vid.pause(); } catch (_) {}
          try { c.wrap.removeChild(c.vid); c.nodes.forEach(function (n) { c.wrap.appendChild(n); }); } catch (_) {}
          if (hadFocus) { try { c.wrap.focus(); } catch (_) {} }   // a removed focused <video> would drop focus to the body
          if (!keep) runDeferred();   // the tile player is gone: apply the pending refresh (never on a mere pause)
        }
        function runDeferred() { const f = deferred; deferred = null; if (f) { try { f(); } catch (_) {} } }
        function playInline(wrap, rec) {
          if (inline && inline.wrap === wrap) return;   // clicks on the player's own controls bubble up here
          stopInline(true);   // switching tiles: the pending refresh stays pending
          const op = deps.onPlay || api.onPlay; if (op) { try { op(); } catch (_) {} }   // one audible video at a time: the Video tab's player pauses
          const nodes = Array.prototype.slice.call(wrap.children);
          const vid = el('video', 'img-tile-video');
          vid.setAttribute('controls', '');
          vid.setAttribute('preload', 'metadata');
          vid.muted = false;
          vid.src = rec.url;
          nodes.forEach(function (n) { wrap.removeChild(n); });
          wrap.appendChild(vid);
          inline = { wrap: wrap, nodes: nodes, vid: vid };
          vid.addEventListener('error', function () { if (inline && inline.vid === vid) stopInline(); });
          vid.addEventListener('ended', function () { if (inline && inline.vid === vid) runDeferred(); });
          try { const p = vid.play(); if (p && p.catch) p.catch(function () {}); } catch (_) {}
        }
        function tile(rec, ctx) {
          const t = el('div', 'img-tile');
          if (rec.prompt) t.setAttribute('title', String(rec.prompt));
          if (!rec.exists) { t.classList.add('missing'); t.appendChild(el('div', 'img-tile-missing', 'missing')); return t; }
          if (rec.url) {
            const wrap = el('div', 'img-tile-img');
            if (rec.kind === 'video') {
              videoFace(wrap, rec);
              wrap.setAttribute('role', 'button');
              wrap.setAttribute('tabindex', '0');
              wrap.setAttribute('title', 'Play here');
              wrap.addEventListener('click', function () { playInline(wrap, rec); });
              wrap.addEventListener('keydown', function (e) { if (e && (e.key === 'Enter' || e.key === ' ') && !(inline && inline.wrap === wrap)) { if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); playInline(wrap, rec); } });
            } else {
              const im = el('img');
              im.setAttribute('loading', 'lazy');
              im.setAttribute('alt', '');
              im.setAttribute('src', rec.url);
              wrap.appendChild(im);
            }
            if (rec.kind === 'i2i') wrap.appendChild(el('span', 'img-tile-tag', 'i2i'));
            t.appendChild(wrap);
            if (ctx) t.appendChild(trashBtn(rec, ctx));   // v1.10 LIB2: the corner cross (outside the action bar)
          } else { t.classList.add('nopreview'); t.appendChild(el('div', 'img-tile-nopreview', 'no preview')); return t; }
          const bar = el('div', 'img-tile-actions');
          const useStatus = el('span', 'img-tile-status');   // short result text of Use / Add to storyboard (kept until the next click or reload, no timer)
          if (rec.kind !== 'video') {
            const useBtn = actionBtn('Use', function () { return useOrAdd(rec, useStatus); }, useTitle());
            useBtns.push(useBtn);
            bar.appendChild(useBtn);
            bar.appendChild(actionBtn('Mesh it', async function () { if (await useImage(rec.path)) await deps.postAction('image_to_3d', {}); }));
          }
          if (rec.kind === 'video' && rec.url) bar.appendChild(actionBtn('View', function () { stopInline(); const ov = deps.openVideo || api.openVideo; if (ov) ov(rec); return Promise.resolve(); }, 'View in the Video tab'));   // v1.10 VP1
          if (rec.url) {
            const a = el('a', 'img-tile-btn');
            setLabel(a, 'Open');
            a.setAttribute('href', rec.url);
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener');
            bar.appendChild(a);
          }
          t.appendChild(bar);
          if (rec.kind !== 'video') t.appendChild(useStatus);   // F6.4: below the button bar, not squeezed into it (the space is reserved in CSS)
          return t;
        }
        // <l1-library> group key of a record: category, else the folder after output/, i2i -> edits, upload -> imported, else other
        function groupOf(rec) {
          if (rec && rec.kind === 'upload') return 'imported';
          if (rec && rec.kind === 'i2i') return 'edits';
          if (rec && typeof rec.category === 'string' && rec.category) return rec.category;
          const m = rec && typeof rec.path === 'string' ? /^output\/([^/]+)\//.exec(rec.path.replace(/\\/g, '/')) : null;
          return m ? m[1] : 'other';
        }
        // newest first inside a group (items arrive newest first), groups ordered by their newest item
        function groupRecords(items) {
          const map = new Map();   // prototype-safe: a category like __proto__ is an ordinary group
          items.forEach(function (rec) {
            const k = groupOf(rec);
            if (!map.has(k)) map.set(k, []);
            map.get(k).push(rec);
          });
          return Array.from(map.entries()).map(function (e) { return { name: e[0], items: e[1] }; });
        }
        // "+ Add" and drag & drop: every file -> POST /upload?add=1 (store + record only), then the panel reloads
        const ADD_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
        const ADD_EXT = /\.(png|jpe?g|webp)$/i;
        let addErrors = [];
        let addRunning = 0;      // batches in flight: a quick second drop appends to the errors instead of overwriting them
        let internalDrag = false;   // a drag that started inside this page (e.g. an image tile) is never an import
        let dragArmed = false;      // an in-page dragstart happened since the last clear (its own first dragenter has relatedTarget null)
        let dropWasInternal = false;   // snapshot for the panel's drop handler, which runs after the window capture clear
        if (doc.addEventListener) {
          doc.addEventListener('dragstart', function () { internalDrag = true; dragArmed = true; });
          doc.addEventListener('dragend', function () { internalDrag = false; dragArmed = false; });
          // amendment 2: the flag must not stick (a tile detached mid-drag never delivers dragend to the document)
          doc.addEventListener('dragenter', function (e) {
            if (!e || e.relatedTarget) return;
            if (dragArmed) dragArmed = false;      // the in-page drag's own entry
            else internalDrag = false;             // a drag entering the window from outside
          });
        }
        const win = deps.window || (typeof window !== 'undefined' ? window : null);
        if (win && win.addEventListener) {
          win.addEventListener('drop', function () { dropWasInternal = internalDrag; internalDrag = false; dragArmed = false; }, true);
          win.addEventListener('dragend', function () { internalDrag = false; dragArmed = false; }, true);
        }
        async function addFiles(files, reload) {
          if (!addRunning) addErrors = [];
          addRunning++;
          try { await addBatch(files); } finally { addRunning--; }
          await reload(true);   // the reload that follows this Add/drop shows its errors; the next ordinary reload clears them
        }
        async function addBatch(files) {
          const list = Array.prototype.slice.call(files || []);
          for (let i = 0; i < list.length; i++) {
            const f = list[i];
            const nm = String((f && f.name) || 'file');
            const typeOk = !f.type || ADD_TYPES.indexOf(f.type) >= 0;
            if (!typeOk || !ADD_EXT.test(nm)) { addErrors.push(nm + ': unsupported type (png, jpg, webp only)'); continue; }
            if (f.size > 50 * 1024 * 1024) { addErrors.push(nm + ': file too large (max 50 MB)'); continue; }
            try {
              const r = await deps.fetch('/upload?add=1&name=' + encodeURIComponent(nm), { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f });
              if (!r || !r.ok) {
                let msg = 'HTTP ' + (r && r.status);
                try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (_) {}
                addErrors.push(nm + ': ' + msg);
              }
            } catch (err) { addErrors.push(nm + ': ' + ((err && err.message) || String(err))); }
          }
        }
        // <lc2a-r3> B2: ONE rule + ONE note for "this drop had files that are not images", shared by the Images zone (wireDrop) and the Library-wide zone (wireLibraryDrop)
        let dropNote = null;   // set by wireLibraryDrop (o.note)
        const isImageFile = function (f) { return !!f && ADD_EXT.test(String(f.name || '')) && (!f.type || ADD_TYPES.indexOf(f.type) >= 0); };
        function noteSkipped(files) {
          const list = Array.prototype.slice.call(files || []);
          if (list.some(function (f) { return !isImageFile(f); }) && dropNote) { try { dropNote('Only images can be dropped here (png, jpg, webp).'); } catch (_) {} }
        }
        const dropRoots = [];
        // LC1: while the Images tab is visible the drop zone is the whole Library column (#library-list), not just the tiles' height;
        // the frame sits on the column (the panel keeps its own class so the "Drop images" hint shows). On the other tabs this zone stays
        // out of it (the window guard cancels what nobody handles); wireLibraryDrop below imports there.
        // R4: the body lives either in the docked column (#library-list) or in the Library page (#lib-page-view); one zone per place, and the one that
        // holds the body NOW is the one that acts (resolved per event). The page's zone is #lib-page-view - a child of #library-page - so this zone always runs before wireLibraryDrop's.
        function wireDrop(root, reload) {
          const zones = ['library-list', 'lib-page-view'].map(function (id) { return doc.getElementById && doc.getElementById(id); }).filter(Boolean);
          if (!zones.length) zones.push(root);
          zones.forEach(function (zone) { wireZone(zone, root, reload); });
        }
        function wireZone(zone, root, reload) {
          if (dropRoots.indexOf(zone) >= 0) return;
          dropRoots.push(zone);
          const hasFiles = function (e) { const t = e && e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0; };
          const holdsRoot = function () { return zone === root || !zone.contains || zone.contains(root); };
          // the Images tab is the one showing when no OTHER panel next to it (in the column / the page view) is visible - in the page it must also be visible itself
          const imagesShown = function () {
            if (!holdsRoot()) return false;
            if (zone === root) return true;
            const host = root.parentNode || zone;
            const others = Array.prototype.some.call(host.children || [], function (c) { return c !== root && c.classList && c.classList.contains('visible'); });
            return !others && (host === zone || host.id === 'library-list' || !!(root.classList && root.classList.contains('visible')));
          };
          const setDrop = function (on) { if (root.classList) root.classList.toggle('drop-active', !!on); if (zone !== root && zone.classList) zone.classList.toggle('drop-active', !!on); };
          // amendment 3: an in-page drag carrying Files is cancelled (no navigation) with dropEffect 'none' and no drop hint; an external file drag is accepted
          const onDragOver = function (e) {
            if (!hasFiles(e)) return;
            if (!imagesShown()) return;   // another Library tab: not ours - the window guard cancels it (no navigation, no import)
            e.preventDefault();
            if (internalDrag) { try { e.dataTransfer.dropEffect = 'none'; } catch (_) {} return; }
            setDrop(true);
          };
          zone.addEventListener('dragenter', onDragOver);
          zone.addEventListener('dragover', onDragOver);
          zone.addEventListener('dragleave', function (e) { if (!e.relatedTarget || !zone.contains || !zone.contains(e.relatedTarget)) setDrop(false); });
          zone.addEventListener('drop', function (e) {
            setDrop(false);
            if (!imagesShown()) return;   // the window guard takes it
            const internal = internalDrag || dropWasInternal;
            internalDrag = false; dropWasInternal = false;
            if (internal && hasFiles(e)) e.preventDefault();   // amendment 3: an in-page drag carrying a file never navigates either
            if (internal || !hasFiles(e)) return;   // a drag from inside the page is not an import
            e.preventDefault();   // amendment 2: any other file drop on this panel never navigates the browser away
            noteSkipped(e.dataTransfer.files);
            addFiles(e.dataTransfer.files, reload).catch(function () {});
          });
        }
        // <lc2a-libdrop> (T6-5) The WHOLE Library column (#library-wrap: tab bar + every tab) takes an external file drag, so Chrome never opens a dropped
        // image. The Images tab's own zone (wireDrop) runs first and has already imported when it was visible; here an unhandled drag over any other tab
        // is accepted ('copy'), and its image files are imported through the same addFiles path after the Images tab is switched on.
        // o = { switchToImages(), reload(fromAdd) -> Promise (reloads the Images tab), note(text) }
        function wireLibraryDrop(wrap, o) {
          if (!wrap || !wrap.addEventListener) return;
          dropNote = o.note || null;
          const hasFiles = function (e) { const t = e && e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0; };
          const over = function (e) {
            if (!hasFiles(e) || e.defaultPrevented) return;   // not a file drag, or the Images zone took it
            e.preventDefault();
            try { e.dataTransfer.dropEffect = internalDrag ? 'none' : 'copy'; } catch (_) {}   // an in-page drag carrying a file is never an import
          };
          wrap.addEventListener('dragenter', over);
          wrap.addEventListener('dragover', over);
          wrap.addEventListener('drop', function (e) {
            if (!hasFiles(e) || e.defaultPrevented) return;
            e.preventDefault();   // never navigate
            const internal = internalDrag || dropWasInternal;
            internalDrag = false; dropWasInternal = false;
            if (internal) return;
            const files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
            const imgs = files.filter(isImageFile);
            noteSkipped(files);   // <lc2a-r2> M4: a mixed drop imports the images AND says what was left out
            if (!imgs.length) return;
            const run = addFiles(imgs, o.reload);   // started first: its addRunning keeps the tab switch's reload from clearing the errors
            try { if (o.expand) o.expand(); } catch (_) {}   // <lc2a-r2> M5: a collapsed Library strip is opened first, so the import is seen
            try { o.switchToImages(); } catch (_) {}
            run.catch(function () {});
          });
        }
        function addBar(reload) {
          const bar = el('div', 'lib-addbar');
          const input = el('input');
          input.setAttribute('type', 'file');
          input.setAttribute('accept', 'image/png,image/jpeg,image/webp');
          input.setAttribute('multiple', '');
          input.hidden = true;
          input.addEventListener('change', function () {
            const files = Array.prototype.slice.call(input.files || []);
            try { input.value = ''; } catch (_) {}
            if (files.length) addFiles(files, reload).catch(function () {});
          });
          const btn = el('button', 'lib-add-btn', '+ Add');
          btn.setAttribute('type', 'button');
          btn.setAttribute('aria-label', 'Add images to the gallery');
          btn.addEventListener('click', function () { input.click(); });
          bar.appendChild(btn);
          bar.appendChild(el('span', 'lib-drophint', 'Drop images to add them'));
          bar.appendChild(input);
          return bar;
        }
        function errorsBlock() {
          const box = el('div', 'lib-adderrs');
          addErrors.forEach(function (m) { const d = el('div', 'lib-adderr', m); d.setAttribute('role', 'alert'); box.appendChild(d); });
          return box;
        }
        // folder-style collapsible group (same look as the Assets folders)
        function groupBlock(g, ctx) {
          const box = el('div', 'img-group');
          const head = el('button', 'lib-folder');
          head.setAttribute('type', 'button');
          head.style.width = '100%'; head.style.border = 'none'; head.style.textAlign = 'left'; head.style.fontFamily = 'inherit';
          head.setAttribute('aria-expanded', 'true');
          head.appendChild(el('span', 'lib-tri', '\u25BE'));
          head.appendChild(el('span', 'lib-folder-name', g.name));
          head.appendChild(el('span', 'lib-count', String(g.items.length)));
          const grid = el('div', 'img-grid');
          g.items.forEach(function (rec) { grid.appendChild(tile(rec, ctx)); });
          head.addEventListener('click', function (e) {
            if (e && e.stopPropagation) e.stopPropagation();   // amendment 1 (1): the delegated Assets folder handler on #library-list must not see this click
            const open = head.getAttribute('aria-expanded') !== 'true';
            head.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (head.classList) head.classList.toggle('collapsed', !open);
            grid.hidden = !open;
          });
          box.appendChild(head);
          box.appendChild(grid);
          return box;
        }
        async function load(kind, root, emptyText, opts, fromAdd) {
          const grouped = !!(opts && opts.grouped);
          const reload = function (fromAdd) { return load(kind, root, emptyText, opts, fromAdd === true); };
          const ctx = { kind: kind, root: root, reload: reload };
          useBtns.length = 0;   // the tiles are rebuilt below
          stopInline(true); deferred = null;   // VP1: so is a tile that plays in place; this load IS the refresh, so a pending one is moot (R4-M3)
          if (grouped) wireDrop(root, reload);
          if (grouped && !fromAdd && !addRunning) addErrors = [];   // an ordinary reload clears the last Add's errors
          // R5-B1: the ONE guard for every path that touches the container after an await (render, empty state, error note): if a tile
          // player started while the request was out, leave the container alone and park this refresh until that player goes away
          function parked() { if (!isPlaying()) return false; deferred = function () { reload(); }; return true; }
          let items = [], trash = [], failure = null;
          try {
            const r = await deps.fetch('/images?kind=' + encodeURIComponent(kind));
            if (!r.ok) failure = 'Could not load (HTTP ' + r.status + ').';
            else {
              const j = await r.json();
              items = (j && Array.isArray(j.items)) ? j.items : [];
              trash = (j && Array.isArray(j.trash)) ? j.trash : [];   // v1.10 LIB2: what is in the trash for these kinds
            }
          } catch (err) { failure = 'Could not load: ' + ((err && err.message) || String(err)); }
          if (parked()) return;
          try { if (typeof libraryPage !== 'undefined' && libraryPage) libraryPage.noteChange(kind === 'video' ? 'videos' : 'images'); } catch (_) {}   // R4: the Library page's count (and Trash) follow this rebuild - also after a trash / restore / empty
          if (failure !== null) { note(root, failure); return; }
          if (grouped && !(opts && opts.tree)) {
            root.textContent = '';
            root.appendChild(addBar(reload));
            root.appendChild(errorsBlock());
            if (!items.length) { root.appendChild(el('div', 'lib-empty', emptyText)); tail(ctx, trash); return; }
            groupRecords(items).forEach(function (g) { root.appendChild(groupBlock(g, ctx)); });
            tail(ctx, trash);
            return;
          }
          const tree = opts && opts.tree;   // v1.10 LIB2 (T6-21): the Videos tab renders through the folder tree (video folders only)
          if (tree) {
            try { await tree.refresh(); } catch (_) {}
            if (parked()) return;   // (second await)
            const entries = items.map(function (rec) { return { key: (tree && tree.key ? tree.key(rec) : 'video:' + rec.path), rec: rec, label: String(rec.path || '') }; });
            tree.render(root, entries, function (it) { return groupOf(it.rec); }, emptyText, function (it) {
              const slot = el('div', 'vtree-item');
              slot.appendChild(tile(it.rec, ctx));
              if (it.rec.exists && it.rec.url) {
                const mv = el('button', 'img-tile-move', '\uD83D\uDDC0');
                mv.setAttribute('type', 'button');
                mv.setAttribute('title', 'Move to folder');
                mv.setAttribute('aria-label', 'Move to folder');
                mv.addEventListener('click', function () { tree.pick(it.key, tree.assigned(it.key)); });
                slot.appendChild(mv);
              }
              return slot;
            });
            if (grouped) { root.prepend(errorsBlock()); root.prepend(addBar(reload)); }
            tail(ctx, trash);
            return;
          }
          if (!items.length) { note(root, emptyText); tail(ctx, trash); return; }
          root.textContent = '';
          const grid = el('div', 'img-grid');
          items.forEach(function (rec) { grid.appendChild(tile(rec, ctx)); });
          root.appendChild(grid);
          tail(ctx, trash);
        }
        const api = { load: load, groupOf: groupOf, groupRecords: groupRecords, addFiles: addFiles, refreshUse: refreshUse, addToStoryboard: addToStoryboard, wireLibraryDrop: wireLibraryDrop, stopPlayback: stopInline, playing: isPlaying, deferUntilIdle: function (f) { deferred = f; }, openVideo: null, onPlay: null };   // openVideo: set by the page (View -> the Video tab)
        return api;
      }
      // </c1-images>
      const imagesTab = makeImagesTab({ fetch: function (u, o) { return fetch(u, o); }, document: document, postAction: postAction, inlineRow: (typeof libInlineRow === 'function' ? libInlineRow : null), activeTopTab: function () { const b = Array.from(tabBtns).find(function (x) { return x.classList.contains('active'); }); return b ? b.dataset.tab : null; }, reloadStoryboard: function () { if (typeof storyboardTab !== 'undefined') storyboardTab.load(document.getElementById('sb-root')); }, boardTitle: function () { return typeof storyboardTab !== 'undefined' ? storyboardTab.title() : ''; }, boardLoading: function () { return typeof storyboardTab !== 'undefined' && storyboardTab.loading(); } });
      imagesTab.onPlay = function () { videoTab.pause(); };   // F2
      if (typeof videoTab !== 'undefined') videoTab.onPlay = function () { imagesTab.stopPlayback(); };   // R3-M2: and the other way round
      imagesTab.openVideo = function (rec) { setArtifact({ slot: 'video', url: rec.url, path: rec.path, fps: rec.fps, source: 'library' }); };   // v1.10 VP1: a video tile's View button
      // <v1-storyboard> Storyboard workbench (v1.10 V1 + V1b-2): preview with the ① References / ② Keyframe / ③ Clip switch and a
      // client-side animatic, the inspector (shot form) on the right, the filmstrip (width ~ duration, status dots) and the Voice + SFX
      // lanes underneath. Loaded when the tab is opened and after each action (from the route response, no polling). All text via
      // textContent; the factory takes its collaborators ({ fetch, document, deadline?, now?, raf?, cancelRaf?, Audio? }) so a suite can
      // drive it on a fake DOM with fake timers.
      // ONE request at a time: every storyboard request goes through a FIFO queue, so a response is always the newest truth (no
      // stale responses to reason about). Request bodies are built when the request LEAVES the queue (a text save sends the field as it
      // is then, and is skipped when it equals the server's text or the shot is gone); only server boards are ever rendered.
      // Every shot has its inspector pane in the DOM (only the selected one is visible), so a draft in any text field survives a rebuild.
      // The animatic's single animation-frame loop is the only timing in this region (cancelled on stop and on leaving the tab).
      // R6 (Story on the new shell): the animatic plays the SERVER's timeline (lastData.timeline = what the MP4 export renders); a shot is
      // removed only after an inline confirm and the Undo row mirrors the one remove the server can still undo (it goes with the next write,
      // a board switch, a reload or a server-side change); own camera tags live in a shared list (lastData.camera_tags). Buttons are `btn` +
      // one variant, their identity is ONE data-sb attribute, their state aria-pressed / aria-current.
      function makeStoryboardTab(deps) {
        const doc = deps.document;
        const REQUEST_MS = 20000;           // a request that has not answered by then is a failure (the queue must never wedge)
        // deps.deadline(ms) -> an AbortSignal that fires after ms; the real default is AbortSignal.timeout (a suite injects a fake one)
        const deadline = deps.deadline || (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? function (ms) { return AbortSignal.timeout(ms); } : null);
        const nowMs = deps.now || function () { return Date.now(); };
        const raf = deps.raf || function (f) { return requestAnimationFrame(f); };
        const cancelRaf = deps.cancelRaf || function (h) { return cancelAnimationFrame(h); };
        const AudioCtor = deps.Audio || (typeof Audio !== 'undefined' ? Audio : null);
        const HELP_TEXT = '① References — who, where, what: images from your Library. ② Keyframe — the first frame of the shot, made from the references. ③ Clip — the video made from the keyframe, the action and the camera.';
        const SPEAK_MS = 180000;            // a voice take can take a while; the request deadline of Speak line
        const TAKE_MS = 3000;               // <lc2b> how long "Take ready" shows after a Speak line
        const later = function (f, ms) { const t = deps.later || api.later; return t ? t(f, ms) : null; };   // the page hands in a timer (api.later); without one the note ends with the next rebuild after its time
        const takeReady = new Map();        // shot id -> until when (ms) the "Take ready" note shows
        let lastPd = null;                  // { key, t }: the action a pointerdown just ran - the click that follows is the same gesture
        const MAX_REFS = 6, MAX_CAST = 12, MAX_LINES = 8;
        const CAM_ROWS = [
          { key: 'size',  label: 'Size',  opts: [['wide', 'Wide'], ['medium', 'Medium'], ['close', 'Close'], ['extreme-close', 'Extreme close']] },
          { key: 'angle', label: 'Angle', opts: [['eye', 'Eye level'], ['low', 'Low'], ['high', 'High'], ['birds-eye', 'Bird’s-eye']] },
          { key: 'move',  label: 'Move',  opts: [['static', 'Static'], ['push-in', 'Push-in'], ['orbit', 'Orbit'], ['handheld', 'Handheld'], ['tilt', 'Tilt']] },
        ];
        const STATUS_TEXT = { draft: 'Draft', keyframe: 'Keyframe ok', video: 'Video ok' };
        // V1b-3: what the three buttons do (each goes through the serial queue, one request at a time)
        const ACT_URL = { keyframe: '/storyboard/shot/keyframe', speak: '/storyboard/shot/speak', video: '/storyboard/shot/clip' };
        const ACT_SEC = { keyframe: 'refs', speak: 'dialogue', video: 'acts' };
        const UNVERIFIED_TEXT = (typeof UNVERIFIED_BADGE === 'string') ? UNVERIFIED_BADGE : 'unverified';   // LC2d/LC2f: workflow manifest status:'unverified' - the shared one-word badge; the tooltip says what it means
        const UNVERIFIED_TIP = 'This workflow has not finished a run through Phoenix yet. Choosing it works normally; it may need a small fix.';
        const actBusy = new Set();            // '<kind>:<shotId>' while the request of a button is in the queue / in flight (the button is disabled meanwhile)
        // <v2-choice> v1.10 V2: which backend a click of Make video uses. null = the config's choice (nothing is sent); 'auto' | '<id>' = the selector's pick (sent as body.backend).
        let vpick = null;   // F6.7: remembered in localStorage['phoenix.storyboard.videoBackend'] (per browser)
        try { vpick = localStorage.getItem('phoenix.storyboard.videoBackend') || null; } catch (_) { vpick = null; }
        function vcOf(d) { return (d && d.video_choice && Array.isArray(d.video_choice.backends)) ? d.video_choice : null; }
        function vEffId(d) {   // the id this click would run on (null when none)
          const vc = vcOf(d);
          if (vpick === 'auto') return vc && vc.auto ? vc.auto : null;
          if (vpick) return vpick;
          return d && d.video && d.video.backend ? d.video.backend.id : null;
        }
        function vEff(sh) {   // { id, est }: that backend and ITS price for this shot (null = free)
          const id = vEffId(lastData);
          if (!vpick) return { id: id, est: sh.video_estimate || null };
          const o = (sh.video_options || []).find(function (x) { return x.id === id; });
          return { id: id, est: o ? o.estimate : null };
        }
        function vReady(d) {   // can Make video start with the pick (or the config's choice when nothing is picked)?
          const base = (d && d.video) || { available: false, reason: '' };
          const vc = vcOf(d);
          if (!vpick || !vc) return { available: !!base.available, reason: base.reason || '' };
          if (vpick === 'auto') return vc.auto ? { available: true, reason: '' } : { available: false, reason: base.reason || 'No video backend is available' };
          const b = vc.backends.find(function (x) { return x.id === vpick; });
          return b ? { available: !!b.available, reason: b.reason || '' } : { available: !!base.available, reason: base.reason || '' };
        }
        function vEffLocal(d) { const vc = vcOf(d), id = vEffId(d), b = vc ? vc.backends.find(function (x) { return x.id === id; }) : null; return !!(b && b.gpu); }
        // M4: Stop for a reference keyframe run - the same queue path stopVideo uses; the server only ends THAT job id
        function stopKeyframe(sid) { const sh0 = lastData && lastData.shots ? lastData.shots.find(function (x) { return x.id === sid; }) : null; return enqueue({ build: function () { return { url: '/stop', method: 'POST', body: { kind: 'keyframe', job: sh0 ? sh0.keyframe_job : null }, plain: true }; }, staleDone: function () {}, done: function () { refreshNow(); } }); }
        function stopVideo(sid) { const sh0 = lastData && lastData.shots ? lastData.shots.find(function (x) { return x.id === sid; }) : null; const fal0 = !!(sh0 && sh0.video_job == null && !sh0.video_stoppable); return enqueue({ build: function () { return fal0 ? { url: '/video/cancel', method: 'POST', body: {}, plain: true } : { url: '/stop', method: 'POST', body: { kind: 'video', job: sh0 ? sh0.video_job : null }, plain: true }; }, staleDone: function () {}, done: function () { refreshNow(); } }); }
        const ACTIONS = {
          keyframe: function (id) { return runAct('keyframe', id); },
          speak: function (id, extra) { return runAct('speak', id, extra); },   // <sb3> extra = { lid } speaks one line; none = every line without a take
          video: async function (id) {
            if (vconf && vconf.id === id && vconf.board === bidNow()) return;   // <lc2a-r2> M2: the row is already open for this shot - a second click keeps it (checkbox state, no second row)
            await refreshNow();   // saves queued before the click leave the queue first: the price the user confirms is the price of the shot as it is NOW
            const i = shotIndex(id), sh = i >= 0 ? lastData.shots[i] : null;
            if (!sh) return;
            if (vconf && vconf.id === id && vconf.board === bidNow()) return;   // …also when the first click's row opened while this one was refreshing
            const est = vEff(sh).est;
            if (!est) return runAct('video', id, vpick ? { backend: vpick } : {});
            // <lc2a-fal-audio> a paid backend: nothing starts without the user's yes - for exactly this price. The yes is an inline row under the button
            // (cost line, "with sound", Start / Cancel) instead of a bare confirm(); the shot's default (off when it has a voice take) comes from the server.
            const va = sh.video_audio || { on: true, reason: '' };
            vconf = { id: id, board: bidNow(), audio: va.on !== false, reason: va.reason || '', est: { line: est.line, usd: est.usd }, busy: false, err: '', rounds: 0, tok: 0, backend: vpick || null };
            render(lastData);
          },
        };
        // <lc2a-fal-audio> the inline confirm row of "Make video": { id, board, audio, reason, est, busy, err, rounds, tok } or null
        let vconf = null;
        function vconfCancel() { vconf = null; render(lastData); }
        // toggling "with sound": ask the server for the price of THIS choice (an unconfirmed POST never starts a paid video; it answers 409 needs_confirm + estimate)
        function vconfToggle(audio) {
          const vc = vconf;
          if (!vc || vc.busy) return Promise.resolve();
          vc.audio = audio; vc.busy = true; vc.err = ''; const tok = ++vc.tok;
          render(lastData);
          return enqueue({
            id: vc.id,
            build: function () { return { url: ACT_URL.video, method: 'POST', body: Object.assign({ id: vc.id, audio: audio, estimate_only: true }, vc.backend ? { backend: vc.backend } : {}) }; },   // <lc2a-r2> M1: a price question, the server can never start anything on it
            staleDone: function () { if (vconf === vc && vc.tok === tok) { vc.busy = false; render(lastData); } },
            done: function (res) {
              if (vconf !== vc || vc.tok !== tok) return;
              const e = res && res.j && res.j.estimate;
              if (e && (res.j.needs_confirm || res.j.estimate_changed || res.j.estimate_only)) { vc.est = { line: e.line, usd: e.usd }; vc.err = ''; }
              else vc.err = (res && res.error) ? cardErr(res) : 'Phoenix gave no price for this choice';
              vc.busy = false;
              render(lastData);
            },
          });
        }
        // Start: confirmed + audio + the estimate it was priced with; a price that moved meanwhile re-opens the row with the new line (at most 4 rounds, like before)
        async function vconfStart() {
          const vc = vconf;
          if (!vc || vc.busy || vc.err) return;
          vconf = null;
          const moved = await runAct('video', vc.id, Object.assign({ confirmed: true, audio: vc.audio, estimate: { line: vc.est.line, usd: vc.est.usd } }, vc.backend ? { backend: vc.backend } : {}));
          if (moved && vc.rounds < 3) {
            vconf = { id: vc.id, board: vc.board, audio: vc.audio, reason: vc.reason, est: { line: moved.line, usd: moved.usd }, busy: false, err: '', rounds: vc.rounds + 1, tok: 0, backend: vc.backend || null };
            render(lastData);
          } else if (moved) { actErr.set(vc.id, 'The price keeps changing — try again in a moment.'); busyErr.delete(vc.id); actSec.set(vc.id, 'acts'); render(lastData); }
        }
        function el(tag, cls, text) {
          const e = doc.createElement(tag);
          if (cls) e.className = cls;
          if (text != null) e.textContent = text;
          return e;
        }
        function fmt(n) { return (Number(n) || 0).toFixed(1); }
        function clock(sec) {
          const t = Math.max(0, Number(sec) || 0), m = Math.floor(t / 60), s = t - m * 60;
          return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
        }
        let curRoot = null;
        let lastData = null;                // the newest board the server sent
        let errText = '';
        let taById = new Map();             // shot id -> the prompt <textarea> currently shown
        const pendingDur = new Map();       // shot id -> the duration the user typed and that has not left the queue yet
        const base = new Map();             // shot id -> the server prompt its textarea was last rendered with
        const sentOk = new Map();           // shot id -> the text of the last prompt save the server accepted
        const promptErr = new Map();        // shot id -> error of a failed PROMPT save (cleared by a successful prompt save or a revert to the server text)
        const actErr = new Map();           // shot id -> error of a failed action (duration, move, camera, references ...; cleared by the next successful action)
        const busyErr = new Map();          // shot id -> the sequence of the busy refusal (busy:true) shown for it: it goes when the jobs are idle, if no newer note replaced it
        let busySeq = 0;                    // one counter: an idle answer clears only the refusals shown before it was asked
        // V1b-2: the same base/sentOk keep-rule for every other text field, one entry per field key '<shotId>:<field>' ('#board:title' for the board)
        let fEl = new Map();                // key -> the <input> currently shown
        let fDesc = new Map();              // key -> { get(shot) -> server text, body(value, shot) -> update patch | null }
        const fBase = new Map(), fSent = new Map(), fErr = new Map();
        let selectedId = null, view = 'key';
        let sentOpen = false, castOpen = false, helpFor = null, popEls = [], docWired = false, scrollSel = null;
        let castDraft = null, castSent = null, castErr = '';
        let curBoardId = null, castEls = [], animVid = null;
        const actSec = new Map();
        // a board that was left with saves still queued: its inspector fields/data stay reachable ("parked") so those saves are sent with THEIR board id
        const parked = new Map();           // board id -> { data, fEl, fDesc, ta }
        let renderedData = null;           // shot id -> the section (refs / camera / dialogue / sound / dur / top) the failed action's message belongs under
        let picker = null;                  // { id, role, items: null | [...], error: '' }
        let voices = null, voiceMode = '', voiceRefs = [], sfxClips = null, boardsList = null;     // lazy lists (loaded when a control that needs them is used)
        let voiceSels = [], sfxSels = [], boardSel = null;
        let pvBox = null, clockEl = null, playBtn = null, tileEls = new Map();
        let anim = null, animGen = 0;
        let undo = null;                    // R6: { board, shot, at, n, busy } the last remove of THIS page; cleared by any other write, a board switch, a reload, a server-side change
        let rmFor = null;                   // R6: the shot whose "Remove shot n?" row is open
        let refsOpen = true;                // R6: the References section is collapsible
        let tagUi = { shot: null, mode: '', tag: '', draft: '', err: '' };   // R6: own tags - mode '' | 'add' (inline field) | 'del' (remove-from-list confirm), bound to one shot
        let wantFocus = null;               // R6: { el } set while a pane is built, focused once the rebuilt page is in place
        let focusOnce = false;              // R6: the click that opened an inline row (remove confirm, own-tag field / confirm) asks for the focus ONCE - a later rebuild never steals it
        const VARIANTS = ['primary', 'secondary', 'ghost', 'danger'];
        const queue = [];
        let busy = false;
        function shotIndex(id) {
          const a = lastData && Array.isArray(lastData.shots) ? lastData.shots : [];
          for (let i = 0; i < a.length; i++) if (a[i] && a[i].id === id) return i;
          return -1;
        }
        let forceBid = null;               // <lc2b-r3> while a deferred action is enqueued it belongs to the board it was pressed on, not to the one on screen by then
        const resv = new Set();            // <lc2b-r3> '<kind>:<shotId>' reserved at activation (the saves ahead of the action are still running)
        function bidNow() { return forceBid !== null ? forceBid : (boardOf(lastData).id || ''); }
        function ctxFor(bid) {   // the screen of board bid: the live one, or the parked one when another board is shown now
          if (!lastData || (bid || '') === (boardOf(lastData).id || '')) return { data: lastData, fEl: fEl, fDesc: fDesc, ta: taById, live: true };   // <lc2b-r4> compared with the board ON SCREEN, never the forced one (forceBid only says which board an action belongs to)
          const p = parked.get(bid);
          return p ? { data: p.data, fEl: p.fEl, fDesc: p.fDesc, ta: p.ta, live: false, park: p } : null;
        }
        function idxIn(data, id) { const a = data && Array.isArray(data.shots) ? data.shots : []; for (let i = 0; i < a.length; i++) if (a[i] && a[i].id === id) return i; return -1; }
        function boardOf(d) { return (d && d.board && typeof d.board === 'object') ? d.board : {}; }
        function localBoard(patch) { if (lastData) lastData = Object.assign({}, lastData, { board: Object.assign({}, lastData.board, patch) }); }   // what the server just accepted, on screen at once
        function statusOf(s) { return s.status || (s.clip_url ? 'video' : (s.image && s.exists ? 'keyframe' : 'draft')); }
        function castOf(d) { return Array.isArray(boardOf(d).cast) ? boardOf(d).cast : []; }
        function engineUnknown(r) { return !!(r && r.engine && r.engine !== 'crispasr' && r.engine !== 'chatterbox'); }   // <sb3-r2> a stored engine this page does not know: sent back untouched, shown as "unknown engine"
        function castClean(list) {   // <sb3> a cast member = {name, engine, voice (CrispASR pack), reference (Chatterbox .wav)}
          return (list || []).filter(function (r) { return r && String(r.name || '').trim(); }).map(function (r) {
            if (engineUnknown(r)) return { name: String(r.name).trim(), engine: r.engine, voice: r.voice || '', reference: r.reference || '' };
            return r.engine === 'chatterbox' ? { name: String(r.name).trim(), engine: 'chatterbox', voice: '', reference: r.reference || '' } : { name: String(r.name).trim(), engine: 'crispasr', voice: r.voice || '', reference: '' };
          });
        }
        function castDupName() {   // two named rows with the same name, case-insensitive like the server's normCast
          const seen = {};
          return (castDraft || []).some(function (r) { const n = String(r && r.name || '').trim().toLowerCase(); if (!n) return false; if (seen[n]) return true; seen[n] = 1; return false; });
        }
        function sameJson(a, b) { try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; } }
        async function call(url, method, body, plain, ms) {
          try {
            const sig = deadline ? deadline(ms || REQUEST_MS) : null;
            const opts = method === 'POST' ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) } : {};
            if (sig) opts.signal = sig;
            const timedOut = sig ? new Promise(function (_r, rej) {
              const boom = function () { const te = new Error('Phoenix did not answer in time — nothing was changed on screen'); te.deadline = true; rej(te); };
              if (sig.aborted) boom(); else sig.addEventListener('abort', boom);
            }) : null;
            // the deadline covers the whole request: headers AND body
            const whole = (async function () {
              const r = await deps.fetch(url, Object.keys(opts).length ? opts : undefined);
              let j = null;
              try { j = await r.json(); } catch (_) {}
              return { r: r, j: j };
            })();
            if (timedOut) whole.catch(function () {});   // the abandoned request must not become an unhandled rejection
            const got = await (timedOut ? Promise.race([whole, timedOut]) : whole);
            const r = got.r, j = got.j;
            if (!r || !r.ok) return { error: (j && j.error) || ('HTTP ' + (r && r.status)), j: j };   // j: the server's whole answer (a 409 estimate_changed carries the new price)
            if (plain) return (j && typeof j === 'object') ? { data: j } : { error: 'Phoenix sent an unreadable answer' };   // a list / board-list answer, not a board
            if (!j || typeof j !== 'object' || !Array.isArray(j.shots)) return { error: 'Phoenix sent an unreadable answer — nothing was changed on screen' };   // a 2xx without a board is a failure
            return { data: j };
          } catch (err) {
            // LC1: a thrown fetch error is the browser's raw "Failed to fetch" - say it in words (header text here, card text via cardErr)
            if (err && err.deadline) return { error: err.message };
            return { error: 'Phoenix is not reachable — try again in a moment.', network: true };
          }
        }
        // the text under a card: a network failure keeps the typed text and says so
        function cardErr(res) { return res && res.network ? 'Phoenix is not reachable — your text is kept and will be saved on the next try.' : res.error; }
        // item = { key?, id?, build() -> {url, method, body, plain?} | null (skip), done(res), skipped?() }
        async function pump() {
          if (busy) return;
          busy = true;
          try {
            while (queue.length) {
              const it = queue.shift();
              try {
                const req = it.build();
                if (!req) { if (it.skipped) await it.skipped(); }
                else {
                  // a shot write names the board it was edited on (an activation elsewhere cannot redirect it)
                  if (it.board && req.method === 'POST' && /^\/storyboard\/shot/.test(req.url) && req.body && typeof req.body === 'object') req.body.board = it.board;
                  const stale = function () { const cur = boardOf(lastData).id; return !!(it.board && cur && it.board !== cur && req.method === 'POST' && req.url !== '/storyboards/activate'); };
                  let res = await call(req.url, req.method, req.body, req.plain, req.ms);
                  if (req.chain && !res.error) {   // step 2 of one queued step (e.g. activate, THEN read the board): nothing can run in between
                    if (req.onFirst && !stale()) req.onFirst(res);
                    if (!stale()) res = await call(req.chain.url, req.chain.method, null, false);
                  }
                  if (stale() && !res.error) { if (it.staleDone) it.staleDone(res); }   // the answer of a board that is no longer on screen is not rendered (its parked copy is updated)
                  else it.done(res);
                }
              } catch (_) {}
              it.resolve();
            }
          } finally { busy = false; }
        }
        function enqueue(it) {
          if (it.key) { const ex = queue.find(function (q) { return q.key === it.key; }); if (ex) return ex.promise; }   // several saves for one shot collapse into one
          it.promise = new Promise(function (r) { it.resolve = r; });
          if (it.board === undefined) it.board = bidNow();
          queue.push(it);
          pump();
          return it.promise;
        }
        // an action that is not a text save
        function ok(res, id) {
          if (res.error) return false;
          errText = '';                       // a success proves the server answers again
          lastData = res.data;
          if (id) { actErr.delete(id); busyErr.delete(id); }
          return true;
        }
        // R6: a write that was accepted - the one remove the server can undo is gone with it (every other write forgets it server-side)
        function okw(res, id) { return ok(res, id); }   // B7: a start / answer that writes nothing must not clear the Undo; render() compares data.undo, 409 on restore and a board switch clear it
        // one shot update that is not a text field (camera chip, speaker, sound clip, references): build() runs when it leaves the queue
        function shotAction(id, build, sec, onSkip) {
          const bid = bidNow();
          return enqueue({
            id: id,
            skipped: typeof onSkip === 'function' ? function () { onSkip(bid); } : undefined,
            build: function () { const c = ctxFor(bid); const i = c ? idxIn(c.data, id) : -1; return i >= 0 ? build(c.data.shots[i]) : null; },
            staleDone: function (res) { const c = ctxFor(bid); if (c && c.park) c.park.data = res.data; },
            done: function (res) { if (!okw(res, id)) { actErr.set(id, cardErr(res)); busyErr.delete(id); actSec.set(id, sec || 'top'); } render(lastData); },
          });
        }
        // V1b-3: Make keyframe / Speak line / Make video. The button is disabled while its request is queued or running;
        // a keyframe/video that runs in the background shows as `keyframe_busy` / `video_busy` from the server until the page is told it ended.
        function refreshNow() {   // one GET after everything queued so far (an unkeyed item: it is never merged into an earlier read)
          const bid = bidNow();
          return enqueue({
            build: function () { return { url: '/storyboard' + (bid ? '?board=' + encodeURIComponent(bid) : ''), method: 'GET' }; },
            staleDone: function () {},
            done: function (res) { if (ok(res)) render(lastData); },
          });
        }
        function runAct(kind, id, extra) {
          const key = kind + ':' + id;
          if (actBusy.has(key) || (kind === 'keyframe' && actBusy.has('unkey:' + id))) return Promise.resolve(null);
          actBusy.add(key);
          const bid = bidNow();
          let changed = null, gone = false;
          render(lastData);
          return enqueue({
            id: id,
            build: function () { const c = ctxFor(bid); gone = !(c && idxIn(c.data, id) >= 0); return !gone ? { url: ACT_URL[kind], method: 'POST', body: Object.assign({ id: id }, extra || {}), ms: kind === 'speak' ? SPEAK_MS : undefined } : null; },
            skipped: function () { actBusy.delete(key); if (gone) errText = 'That shot is no longer there — nothing was started.'; render(lastData); },
            staleDone: function (res) { actBusy.delete(key); const c = ctxFor(bid); if (c && c.park) c.park.data = res.data; },
            done: function (res) {
              actBusy.delete(key);
              if (res && res.j && res.j.estimate_changed && res.j.estimate) changed = res.j.estimate;   // the price moved: the caller asks again
              else if (!okw(res, id)) { actErr.set(id, cardErr(res)); actSec.set(id, ACT_SEC[kind]); if (res.j && res.j.busy === true) busyErr.set(id, ++busySeq); else busyErr.delete(id); }
              else if (kind === 'speak') {   // <lc2b> a one-word take ends in ~1 s: say it
                takeReady.set(id, nowMs() + TAKE_MS);
                later(function () { if (takeReady.has(id) && takeReady.get(id) <= nowMs()) { takeReady.delete(id); render(lastData); } }, TAKE_MS + 50);
              }
              render(lastData);
            },
          }).then(function () { return changed; });
        }
        // the status poll says the jobs are idle: a busy refusal under a card is stale once the server confirms nothing holds the slot or a lock
        function jobState(idle) {
          if (idle !== true) return Promise.resolve();
          const asked = busySeq, held = [];   // taken before the request goes out; a refusal shown while it is out is newer and stays
          busyErr.forEach(function (n, id) { if (actErr.has(id)) held.push(id); else busyErr.delete(id); });
          if (!held.length) return Promise.resolve();
          return deps.fetch('/storyboard/export/status').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
            if (!(j && j.idle === true)) return;
            let changed = false;
            held.forEach(function (id) { if (busyErr.has(id) && busyErr.get(id) <= asked && actErr.has(id)) { actErr.delete(id); busyErr.delete(id); changed = true; } });
            if (changed && lastData) render(lastData);
          }).catch(function () { /* the next poll asks again */ });
        }
        // the server says a keyframe / video ended (SSE kind 'storyboard'): read the board again, once
        function serverEvent(ev) {
          if (curRoot && ev && ev.kind === 'storyboard' && ev.phase === 'progress') {   // v1.10 V2: a progress tick only moves the shot's progress text - no reload, no rebuild (players and open selects keep their state)
            const i = lastData && Array.isArray(lastData.shots) ? idxIn(lastData, ev.shot) : -1;
            if (i >= 0 && (!ev.board || ev.board === (boardOf(lastData).id || ''))) {
              lastData.shots[i].video_progress = String(ev.text || '');
              const spans = curRoot.querySelectorAll('.sb-vprog');
              for (let j = 0; j < spans.length; j++) if (spans[j].getAttribute('data-shot') === ev.shot) spans[j].textContent = String(ev.text || '');
            }
            return Promise.resolve();
          }
          if (ev && ev.kind === 'storyboard' && (ev.phase === 'export' || ev.phase === 'export-done')) return Promise.resolve();   // R6: the export controller owns these (js-20); the board is not reloaded
          if (curRoot && ev && ev.kind === 'storyboard') { return load(curRoot, true); }   // a keyframe / video / sound change was written on the server: the fresh view says whether the Undo still stands (render() compares)
          return Promise.resolve();
        }
        function addShot() {
          const before = new Set((lastData && lastData.shots ? lastData.shots : []).map(function (s) { return s.id; }));
          return enqueue({
            build: function () { return { url: '/storyboard/shot', method: 'POST', body: {} }; },
            done: function (res) {
              if (okw(res)) { errText = ''; const fresh = lastData.shots.find(function (s) { return !before.has(s.id); }); if (fresh) selectedId = fresh.id; }   // the new shot is the one you work on
              else errText = res.error;
              render(lastData);   // the header line belongs to GET / add
            },
          });
        }
        function setDuration(id) {
          const bid = bidNow();
          return enqueue({
            key: 'dur:' + id,
            id: id,
            build: function () {
              if (!pendingDur.has(id)) return null;
              const v = pendingDur.get(id);
              pendingDur.delete(id);
              const c = ctxFor(bid);
              return c && idxIn(c.data, id) >= 0 ? { url: '/storyboard/shot/update', method: 'POST', body: { id: id, duration_s: v } } : null;
            },
            staleDone: function (res) { const c = ctxFor(bid); if (c && c.park) c.park.data = res.data; },
            done: function (res) { if (!okw(res, id)) { actErr.set(id, cardErr(res)); busyErr.delete(id); actSec.set(id, 'dur'); } render(lastData); },
          });
        }
        function moveShot(id, dir) {
          const bid = bidNow();
          return enqueue({
            id: id,
            staleDone: function (res) { const c = ctxFor(bid); if (c && c.park) c.park.data = res.data; },
            build: function () {
              const c = ctxFor(bid); if (!c) return null;
              const i = idxIn(c.data, id), n = c.data.shots.length;
              return i >= 0 && i + dir >= 0 && i + dir < n ? { url: '/storyboard/shot/move', method: 'POST', body: { id: id, index: i + dir } } : null;
            },
            done: function (res) { if (!okw(res, id)) { actErr.set(id, cardErr(res)); busyErr.delete(id); } render(lastData); },   // under the card it belongs to
          });
        }
        // R6: the inline "Remove shot n?" row asked first (the caller); this is the request. The server answers the removed shot + its index: that is the Undo.
        function removeShot(id) {
          let at = -1;
          return enqueue({
            id: id,
            build: function () { at = shotIndex(id); return at >= 0 ? { url: '/storyboard/shot/remove', method: 'POST', body: { id: id } } : null; },
            done: function (res) {
              if (okw(res)) {
                for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === id) { queue[i].resolve(); queue.splice(i, 1); }   // what was queued for a removed shot is dropped
                if (selectedId === id) { const rest = lastData.shots; selectedId = rest.length ? rest[Math.min(Math.max(at, 0), rest.length - 1)].id : null; }
                const rm = res.data && res.data.removed;
                undo = rm && rm.shot && typeof rm.shot.id === 'string' && typeof rm.at === 'number' ? { board: boardOf(lastData).id || '', shot: rm.shot.id, at: rm.at, n: rm.at + 1, busy: false } : null;
              } else { actErr.set(id, cardErr(res)); busyErr.delete(id); }
              render(lastData);
            },
          });
        }
        // Undo: POST /storyboard/shot/restore { board, shot, at } through the queue. build() runs when it leaves the queue: if another write went first the
        // server has forgotten the remove (and so has this page) - nothing is sent. The row goes with the answer, an error shows the server's text.
        function undoRemove() {
          const u = undo;
          if (!u || u.busy) return Promise.resolve();
          u.busy = true; render(lastData);
          return enqueue({
            board: u.board,
            build: function () { return undo === u ? { url: '/storyboard/shot/restore', method: 'POST', body: { board: u.board, shot: u.shot, at: u.at } } : null; },
            skipped: function () { render(lastData); },
            staleDone: function () { if (undo === u) undo = null; },
            done: function (res) {
              if (undo === u) undo = null;
              if (ok(res)) { const back = res.data && res.data.restored; if (typeof back === 'string' && shotIndex(back) >= 0) selectedId = back; }
              else errText = cardErr(res);
              render(lastData);
            },
          });
        }
        function savePrompt(id) {
          let sent = null;                      // the text this save sends (read when it leaves the queue)
          const bid = bidNow();                 // ...to the board it was typed on, even if another board is on screen by then
          return enqueue({
            key: 'prompt:' + id,
            id: id,
            staleDone: function (res) { sentOk.set(id, sent); base.set(id, sent); promptErr.delete(id); const c = ctxFor(bid); if (c && c.park) c.park.data = res.data; },
            build: function () {
              const c = ctxFor(bid);
              const t = c && c.ta.get(id), i = c ? idxIn(c.data, id) : -1;
              if (!t || i < 0) return null;                                                  // the shot is gone
              if (t.value === (base.has(id) ? base.get(id) : (c.data.shots[i].prompt || '')) || t.value === (c.data.shots[i].prompt || '')) return null;   // nothing to save: unedited since it was rendered (even if the server text moved on) or equal to the server's
              sent = t.value;
              return { url: '/storyboard/shot/update', method: 'POST', body: { id: id, prompt: sent } };
            },
            skipped: function () { if (promptErr.has(id) && shotIndex(id) >= 0) { promptErr.delete(id); render(lastData); } },   // a revert to the server text clears the error
            done: function (res) {
              if (res.error) promptErr.set(id, cardErr(res));
              else {
                promptErr.delete(id); errText = ''; lastData = res.data; undo = null;
                sentOk.set(id, sent); base.set(id, sent);   // the server now has what was sent: a later revert to the old text is an edit
              }
              render(lastData);
            },
          });
        }
        // V1b-2: the same keep-rule for title, camera free text, dialogue line, sound text and reference labels (key '<shotId>:<field>')
        function saveField(id, key) {
          let sent = null;
          const bid = bidNow();
          return enqueue({
            key: 'f:' + key,
            id: id,
            staleDone: function (res) { fErr.delete(key); fSent.set(key, sent); fBase.set(key, sent); const c = ctxFor(bid); if (c && c.park) c.park.data = res.data; },
            build: function () {
              const c = ctxFor(bid);
              const t = c && c.fEl.get(key), d = c && c.fDesc.get(key), i = c ? idxIn(c.data, id) : -1;
              if (!t || !d || i < 0) return null;
              const sh = c.data.shots[i], server = d.get(sh);
              if (t.value === (fBase.has(key) ? fBase.get(key) : server) || t.value === server) return null;   // unedited since it was rendered, or equal to the server's
              const patch = d.body(t.value, sh);
              if (!patch) return null;
              sent = t.value;
              return { url: '/storyboard/shot/update', method: 'POST', body: Object.assign({ id: id }, patch) };
            },
            skipped: function () { if (fErr.has(key) && shotIndex(id) >= 0) { fErr.delete(key); render(lastData); } },
            done: function (res) {
              if (res.error) fErr.set(key, cardErr(res));
              else { fErr.delete(key); errText = ''; lastData = res.data; undo = null; fSent.set(key, sent); fBase.set(key, sent); }
              render(lastData);
            },
          });
        }
        // board-level requests (title, cast, active board) answer with a board LIST: the board is then read again IN THE SAME queued step
        // (req.chain), and what the server accepted is put on screen at once (localBoard) - no render between can bring back old values
        function notifyBoard() { if (api.onBoard) { try { api.onBoard(boardOf(lastData).title || ''); } catch (_) {} } }   // the Library's Use label follows the board
        function titleKey(d) { return '#' + (boardOf(d).id || '') + ':title'; }
        function saveBoardTitle() {
          const key = titleKey(lastData), bid = boardOf(lastData).id;
          let sent = null;
          return enqueue({
            key: 'f:' + key,
            build: function () {
              const t = fEl.get(key);
              if (!t || !lastData || boardOf(lastData).id !== bid) return null;
              const server = boardOf(lastData).title || '';
              if (t.value === (fBase.has(key) ? fBase.get(key) : server) || t.value === server) return null;
              if (!t.value.trim()) return null;                                           // the server refuses an empty title; nothing to send
              sent = t.value;
              return {
                url: '/storyboards/update', method: 'POST', body: { id: bid, title: sent }, plain: true,
                chain: { url: '/storyboard?board=' + encodeURIComponent(bid), method: 'GET' },
                onFirst: function (res) { fErr.delete(key); fSent.set(key, sent); fBase.set(key, sent.trim()); localBoard({ title: sent.trim() }); if (Array.isArray(res.data.boards)) boardsList = res.data.boards; },
              };
            },
            skipped: function () { if (fErr.has(key)) { fErr.delete(key); render(lastData); } },
            done: function (res) {
              if (res.error) { fErr.set(key, cardErr(res)); render(lastData); return; }
              errText = ''; lastData = res.data; undo = null; render(lastData); notifyBoard();
            },
          });
        }
        function activateBoard(id) {
          return enqueue({
            build: function () {
              if (!id || id === boardOf(lastData).id) return null;
              return {
                url: '/storyboards/activate', method: 'POST', body: { id: id }, plain: true, chain: { url: '/storyboard', method: 'GET' },
                onFirst: function (res) { if (Array.isArray(res.data.boards)) boardsList = res.data.boards; },
              };
            },
            skipped: function () { render(lastData); },
            done: function (res) {
              if (res.error) { errText = res.error; render(lastData); return; }
              stopAnim(false);   // the old board's playback, audio and frame loop end before the destination is shown
              errText = ''; selectedId = null; undo = null; rmFor = null; tagUi = { shot: null, mode: '', tag: '', draft: '', err: '' }; lastData = res.data; render(lastData); notifyBoard();
            },
          });
        }
        // R6: "+ New board" (the board switch's last option): create, then open the new board through the same activation as any other board
        function newBoard() {
          return enqueue({
            board: '',
            build: function () { return { url: '/storyboards/create', method: 'POST', body: {}, plain: true }; },
            done: function (res) {
              if (res.error) { errText = res.error; render(lastData); return; }
              if (Array.isArray(res.data.boards)) boardsList = res.data.boards;
              const nid = typeof res.data.created === 'string' ? res.data.created : '';
              if (!nid) { render(lastData); return; }
              activateBoard(nid);
            },
          });
        }
        function saveCast() {
          const bid = boardOf(lastData).id;
          let sent = null;
          return enqueue({
            key: 'cast',
            build: function () {
              if (!lastData || castDraft === null || boardOf(lastData).id !== bid) return null;
              sent = castClean(castDraft);
              if (sameJson(sent, castClean(castOf(lastData)))) return null;               // already what the server has (an earlier save of this very list)
              return {
                url: '/storyboards/update', method: 'POST', body: { id: bid, cast: sent }, plain: true,
                chain: { url: '/storyboard?board=' + encodeURIComponent(bid), method: 'GET' },
                onFirst: function (res) { castErr = ''; castSent = sent; localBoard({ cast: sent }); if (Array.isArray(res.data.boards)) boardsList = res.data.boards; },
              };
            },
            skipped: function () { if (castErr) { castErr = ''; render(lastData); } },
            done: function (res) {
              if (res.error) { castErr = res.error === 'bad cast' ? (castDupName() ? 'Cast not saved \u2014 every character needs a different name.' : ((castDraft || []).some(engineUnknown) ? 'Cast not saved \u2014 a row with an unknown voice engine can only be kept as it is; pick a voice for it to change it.' : 'Cast not saved \u2014 every character needs a different name.')) : cardErr(res); render(lastData); return; }
              castErr = ''; errText = ''; lastData = res.data; undo = null; render(lastData);
            },
          });
        }
        // lazy lists: asked for when the control that needs them is first used (the tab opens with exactly one GET)
        function ensureVoices() {
          if (voices) return;
          enqueue({
            key: 'voices',
            build: function () { return voices ? null : { url: '/voice-state', method: 'GET', plain: true }; },
            done: function (res) {
              if (res.error) { castErr = 'Could not list the voices: ' + res.error; render(lastData); return; }
              voices = (Array.isArray(res.data.voices) ? res.data.voices : []).map(function (v) { return v && typeof v === 'object' ? v.name : v; }).filter(function (v) { return typeof v === 'string' && v; });
              voiceMode = (res.data.dispatcher && typeof res.data.dispatcher === 'object' && res.data.dispatcher.mode) || '';   // <sb3> Chatterbox voices: local = the reference files, rig = the rig's default voice
              voiceRefs = (res.data.refs && Array.isArray(res.data.refs.files)) ? res.data.refs.files.filter(function (f) { return typeof f === 'string' && f; }) : [];
              voiceSels.forEach(function (sel) { if (sel.castRow) fillCastVoice(sel, sel.castRow); else fillSelect(sel, voices, sel.value, '— no voice yet —'); });
              if (castOpen && !voices.length && !castVoices().cb.length) render(lastData);   // the "No voices yet" line of the cast rows
            },
          });
        }
        function ensureSfx() {
          if (sfxClips) return;
          enqueue({
            key: 'sfx',
            build: function () { return sfxClips ? null : { url: '/library/sfx', method: 'GET', plain: true }; },
            done: function (res) {
              if (res.error) return;
              sfxClips = (Array.isArray(res.data.items) ? res.data.items : []).map(function (c) { return c && c.file; }).filter(Boolean);
              sfxSels.forEach(function (sel) { fillSelect(sel, sfxClips, sel.value, '— no saved clip —'); });
            },
          });
        }
        function ensureBoards() {
          if (boardsList) return;
          enqueue({
            key: 'boards',
            build: function () { return boardsList ? null : { url: '/storyboards', method: 'GET', plain: true }; },
            done: function (res) {
              if (res.error || !Array.isArray(res.data.boards)) return;
              boardsList = res.data.boards;
              if (boardSel) fillBoardSelect(boardSel);
            },
          });
        }
        function fillSelect(sel, names, cur, noneLabel) {
          sel.textContent = '';
          const list = names.slice();
          if (cur && list.indexOf(cur) < 0) list.unshift(cur);
          const o0 = el('option', '', noneLabel); o0.value = ''; sel.appendChild(o0);
          list.forEach(function (n) { const o = el('option', '', n); o.value = n; sel.appendChild(o); });
          sel.value = cur || '';
        }
        // <sb3> the cast voice dropdown, grouped by engine. Value: a plain pack name = CrispASR, 'chatterbox:<file>' = Chatterbox ('chatterbox:' = the rig's default voice)
        function castVal(r) { return engineUnknown(r) ? '__unknown' : r.engine === 'chatterbox' ? 'chatterbox:' + (r.reference || '') : (r.voice || ''); }
        function castVoices() {   // -> { packs, cb: [[value, label]] }
          const cb = [];
          if (voiceMode === 'local') voiceRefs.forEach(function (f) { cb.push(['chatterbox:' + f, f]); });
          else if (voiceMode === 'rig') cb.push(['chatterbox:', 'server default voice']);
          return { packs: (voices || []).slice(), cb: cb };
        }
        function fillCastVoice(sel, r) {
          sel.textContent = '';
          const cur = castVal(r), cv = castVoices();
          const o0 = el('option', '', '— no voice yet —'); o0.value = ''; sel.appendChild(o0);
          if (engineUnknown(r)) { const ou = el('option', '', 'unknown engine (' + r.engine + ')'); ou.value = '__unknown'; sel.appendChild(ou); }
          if (r.engine !== 'chatterbox' && !engineUnknown(r) && r.voice && cv.packs.indexOf(r.voice) < 0) cv.packs.unshift(r.voice);   // a saved pack that is not in the list stays selectable
          if (r.engine === 'chatterbox' && !cv.cb.some(function (x) { return x[0] === cur; })) cv.cb.unshift([cur, r.reference ? r.reference : 'server default voice']);
          [['CrispASR packs', cv.packs.map(function (n) { return [n, n]; })], ['Chatterbox', cv.cb]].forEach(function (g) {
            if (!g[1].length) return;   // a group without entries is not shown
            const og = el('optgroup'); og.setAttribute('label', g[0]); og.label = g[0];
            g[1].forEach(function (x) { const o = el('option', '', x[1]); o.value = x[0]; og.appendChild(o); });
            sel.appendChild(og);
          });
          sel.value = cur;
        }
        function fillBoardSelect(sel) {
          const cur = boardOf(lastData).id || '';
          sel.textContent = '';
          const list = (boardsList && boardsList.length) ? boardsList : [{ id: cur, title: boardOf(lastData).title || 'Storyboard' }];
          list.forEach(function (b) { const o = el('option', '', b.title || b.id); o.value = b.id; sel.appendChild(o); });
          const on = el('option', '', '+ New board'); on.value = '__new'; sel.appendChild(on);
          sel.value = cur;
        }
        // ── reference picker over the Library images ──────────────────────────────────
        function openPicker(id, role) {
          if (picker && picker.id === id && picker.role === role) { picker = null; render(lastData); return; }
          picker = { id: id, role: role, items: null, error: '' };
          render(lastData);
          const mine = picker;
          enqueue({
            build: function () { return { url: '/images?kind=' + encodeURIComponent('image,i2i,upload'), method: 'GET', plain: true }; },
            done: function (res) {
              if (picker !== mine) return;
              if (res.error) mine.error = res.network ? 'Phoenix is not reachable — try again in a moment.' : res.error;
              else mine.items = (Array.isArray(res.data.items) ? res.data.items : []).filter(function (r) { return r && typeof r.path === 'string' && r.path && r.url && r.exists !== false; });
              render(lastData);
            },
          });
        }
        // a reference from a file on this computer: the existing upload route stores + records it, the returned relative path is added like a Library pick
        function pickFromDisk(id, role) {
          const inp = doc.createElement('input'); inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp';
          const mine = picker;   // the picker open when the file dialog was started: only that one closes when the upload answers
          const bid = bidNow();   // F6: the board the dialog was OPENED on (and so the shot's board), even if the user switched boards before choosing the file or the upload answers
          inp.addEventListener('change', function () {
            const file = inp.files && inp.files[0]; if (!file) return;
            const fail = function (t) { if (bid !== bidNow()) return; actErr.set(id, t); actSec.set(id, 'refs'); busyErr.delete(id); render(lastData); };
            deps.fetch('/upload?add=1&name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
              .then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { ok: !!r.ok, status: r.status, j: j }; }); })
              .then(function (res) {
                if (!res.ok) fail((res.j && res.j.error) || ('HTTP ' + res.status));
                else if (!res.j || typeof res.j.path !== 'string' || !res.j.path) fail('Phoenix sent an unreadable answer — nothing was added');
                else { forceBid = bid; try { addRef(id, role, { path: res.j.path }, mine); } finally { forceBid = null; } }
              }, function () { fail('Phoenix is not reachable — try again in a moment.'); });
          });
          inp.click();
        }
        function groupOfRec(rec) {
          if (rec.kind === 'upload') return 'imported';
          if (rec.kind === 'i2i') return 'edits';
          if (typeof rec.category === 'string' && rec.category) return rec.category;
          const m = /^output\/([^/]+)\//.exec(rec.path.replace(/\\/g, '/'));
          return m ? m[1] : 'other';
        }
        function minRef(r) { const o = { role: r.role, path: r.path, label: r.label || '' }; if (r.rid) o.rid = r.rid; return o; }
        // <lc2b> pending edits of one shot go into the queue AHEAD of an action: the action then runs on the saved text
        function flushShot(id) {
          const ps = [savePrompt(id)], keys = [];
          Array.from(fEl.keys()).forEach(function (key) { if (key.indexOf(id + ':') === 0) { keys.push(key); ps.push(saveField(id, key)); } });
          return { ps: ps, keys: keys };
        }
        // <lc2b> an action button acts on pointerdown (preventDefault: the focused field does not blur first and re-render the page away under the click);
        // a keyboard click (no pointerdown before it) still works; the click that follows a pointerdown is the same gesture and does nothing
        // <lc2b-r2> flush first; the action runs only when every flushed save was accepted (a failed save keeps its error on the shot and the action does NOT run)
        // <lc2b-r3> the action's busy state is reserved HERE (button shows "Saving…", conflicting actions of the shot are disabled), the board it
        // belongs to is captured here, and only the errors of the fields just flushed can block it (a stale error of a field that is gone cannot)
        function flushThen(id, kind, fn) {
          if (!id) { fn(); return; }
          const rk = kind ? kind + ':' + id : null;
          if ((kind === 'unkey' && (resv.has('keyframe:' + id) || actBusy.has('keyframe:' + id))) || (kind === 'keyframe' && unkeyingNow(id))) return;   // conflicting actions of one shot never overlap
          if (rk) { if (resv.has(rk) || actBusy.has(rk)) return; resv.add(rk); render(lastData); }
          const bid = bidNow();
          const fl = flushShot(id);
          Promise.all(fl.ps).then(function () {
            if (rk) resv.delete(rk);
            const bad = promptErr.has(id) || fl.keys.some(function (k) { return fErr.has(k); });
            if (bad) { render(lastData); return; }
            forceBid = bid;
            try { fn(); } finally { forceBid = null; }
            if (rk) render(lastData);   // <lc2b-r4> the reservation is gone: redraw even when the action itself drew nothing (e.g. Make video with its confirm row already open)
          });
        }
        function wireAct(b, key, flushId, fn, kind) {
          b.addEventListener('pointerdown', function (e) {
            if (b.disabled) return;
            if (e && ((e.button != null && e.button !== 0) || e.isPrimary === false)) return;
            if (e && e.preventDefault) e.preventDefault();
            lastPd = { key: key, t: nowMs() };
            flushThen(flushId, kind, fn);
          });
          b.addEventListener('pointerup', function () { if (lastPd && lastPd.key === key) lastPd.t = nowMs(); });   // the click of THIS gesture follows the release
          b.addEventListener('click', function (e) {
            const kbd = !(e && e.detail > 0);   // a keyboard (or programmatic) activation has detail 0: never the trailing click of a pointer gesture
            if (!kbd && lastPd && lastPd.key === key && nowMs() - lastPd.t < 1000) { lastPd = null; return; }
            lastPd = null;
            if (b.disabled) return;
            flushThen(flushId, kind, fn);
          });
        }
        function unkeyingNow(id) { return actBusy.has('unkey:' + id) || resv.has('unkey:' + id); }
        function removeKeyframe(id) {   // only the link goes: the file stays in output/ and the Library
          const bid = bidNow(), ak = 'unkey:' + id;
          if (actBusy.has(ak) || actBusy.has('keyframe:' + id)) return Promise.resolve();
          actBusy.add(ak);
          return enqueue({
            id: id,
            build: function () {
              const c = ctxFor(bid); const i = c ? idxIn(c.data, id) : -1;
              if (i < 0) return null;
              if (actBusy.has('keyframe:' + id) || c.data.shots[i].keyframe_busy) { actErr.set(id, 'A keyframe is being made — remove it when it is done.'); busyErr.delete(id); actSec.set(id, 'acts'); return null; }   // re-checked when it leaves the queue
              return { url: '/storyboard/shot/update', method: 'POST', body: { id: id, image: null } };
            },
            skipped: function () { actBusy.delete(ak); render(lastData); },
            staleDone: function (res) { actBusy.delete(ak); const c = ctxFor(bid); if (c && c.park) c.park.data = res.data; },
            done: function (res) { actBusy.delete(ak); if (!okw(res, id)) { actErr.set(id, cardErr(res)); busyErr.delete(id); actSec.set(id, 'acts'); } render(lastData); },
          });
        }
        function addPrevAsSet(id, prevId) {
          return shotAction(id, function (sh) {
            const p = lastData && Array.isArray(lastData.shots) ? lastData.shots.find(function (x) { return x.id === prevId; }) : null;
            if (!p || !p.image || p.exists === false) return null;
            const refs = (sh.refs || []).map(minRef);
            if (refs.length >= MAX_REFS || refs.some(function (r) { return r.role === 'set'; })) return null;
            refs.push({ role: 'set', path: p.image, label: '' });
            return { url: '/storyboard/shot/update', method: 'POST', body: { id: id, refs: refs } };
          }, 'refs');
        }
        function setRefRole(id, tok, role) {
          return shotAction(id, function (sh) {
            const refs = (sh.refs || []).map(minRef);
            const i = refIdx(sh.refs || [], tok);
            if (i < 0 || refs[i].role === role) return null;
            refs[i].role = role;
            return { url: '/storyboard/shot/update', method: 'POST', body: { id: id, refs: refs } };
          }, 'refs');
        }
        function addRef(id, role, rec, owner) {
          const label = '';   // <lc2b> nothing is injected into the prompt by default: an old generation prompt as a label turned a keyframe into a diamond phoenix (the user names it, or not)
          if (owner === undefined || picker === owner) picker = null;   // an upload answering later closes only the picker it was started from (a board switch resets picker)
          let why = '';
          return shotAction(id, function (sh) {
            const refs = (sh.refs || []).map(minRef);
            if (refs.length >= MAX_REFS) { why = 'This shot already has the most references it can hold - the image was not added.'; return null; }
            refs.push({ role: role, path: rec.path, label: label });
            return { url: '/storyboard/shot/update', method: 'POST', body: { id: id, refs: refs } };
          }, 'refs', function (bid) {   // F6: never silent - attach on the originating board, or say why not
            // where a notice shows is decided by the board that is DISPLAYED (a shot of another board has no card on screen), never by the forced request board
            const notice = function (text) {
              if (lastData && idxIn(lastData, id) >= 0) { actErr.set(id, text); actSec.set(id, 'refs'); busyErr.delete(id); }
              else errText = text;
              render(lastData);
            };
            if (why) { notice(why); return; }
            if (ctxFor(bid) === null && bid) {   // the originating board is no longer in the page's cache: read it from the server and attach there
              // the whole read-append-write runs as ONE queued step (pump awaits skipped()), so two uploads for the same evicted shot cannot overwrite each other
              enqueue({ board: bid, build: function () { return null; }, skipped: async function () {
                const g = await call('/storyboard?board=' + encodeURIComponent(bid), 'GET');
                const sh = !g.error && g.data && Array.isArray(g.data.shots) ? g.data.shots.find(function (s) { return s && s.id === id; }) : null;
                if (!sh) { notice(g.error ? 'The image was uploaded, but its board could not be read - nothing was attached. Add it again from the Library.' : 'The image was uploaded, but its shot is no longer on its board - nothing was attached.'); return; }
                const refs = (sh.refs || []).map(minRef);
                if (refs.length >= MAX_REFS) { notice('That shot already has the most references it can hold - the image was not added.'); return; }
                refs.push({ role: role, path: rec.path, label: label });
                const u = await call('/storyboard/shot/update', 'POST', { id: id, refs: refs, board: bid });
                if (u.error) notice('The image was uploaded, but it could not be attached: ' + cardErr(u));
              } });
              return;
            }
            notice('The image was uploaded, but its shot is no longer here - nothing was attached. Add it again from the Library.');
          });
        }
        // a reference is identified by its image path (+ which occurrence of it): positions shift when an earlier one is removed
        // (the server gives every reference a stable rid; without one - an old board in an old answer - path + occurrence is the fallback)
        function refTok(refs, ri) { const r = refs[ri]; if (r.rid) return 'r:' + r.rid; return 'p:' + r.path + '#' + refs.slice(0, ri).filter(function (q) { return q.path === r.path; }).length; }
        function refIdx(refs, tok) { for (let i = 0; i < refs.length; i++) if (refTok(refs, i) === tok) return i; return -1; }
        function removeRef(id, tok) {
          return shotAction(id, function (sh) {
            const refs = (sh.refs || []).map(minRef);
            const i = refIdx(sh.refs || [], tok);
            if (i < 0) return null;
            refs.splice(i, 1);
            return { url: '/storyboard/shot/update', method: 'POST', body: { id: id, refs: refs } };
          }, 'refs');
        }
        function setCamera(id, k, v) {
          return shotAction(id, function (sh) {
            const cur = (sh.camera && sh.camera[k]) || '';
            const cam = {}; cam[k] = cur === v ? '' : v;   // a second click on the chosen chip clears it (decided when the request leaves the queue)
            return { url: '/storyboard/shot/update', method: 'POST', body: { id: id, camera: cam } };
          }, 'camera');
        }
        // ── own camera tags (R6) ──────────────────────────────────────────────────────
        // The shared list is the server's (lastData.camera_tags). A tag request carries no board; its answer { tags } replaces the list and the page is drawn again.
        const TAG_MAX = 40, TAGS_PER_SHOT = 8;
        const sameTag = function (a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); };
        function tagsOf(sh) { return sh && sh.camera && Array.isArray(sh.camera.tags) ? sh.camera.tags.filter(function (t) { return typeof t === 'string' && t; }) : []; }
        function sharedTags(d) { return d && Array.isArray(d.camera_tags) ? d.camera_tags.filter(function (t) { return typeof t === 'string' && t; }) : []; }
        function toggleTag(id, tag) {
          return shotAction(id, function (sh) {
            const cur = tagsOf(sh), has = cur.some(function (t) { return sameTag(t, tag); });
            if (!has && cur.length >= TAGS_PER_SHOT) return null;
            const nxt = has ? cur.filter(function (t) { return !sameTag(t, tag); }) : cur.concat([tag]);
            return { url: '/storyboard/shot/update', method: 'POST', body: { id: id, camera: { tags: nxt } } };
          }, 'camera');
        }
        function tagRequest(path, tag, onOk) {
          return enqueue({
            board: '',
            build: function () { return { url: '/storyboard/tags/' + path, method: 'POST', body: { tag: tag }, plain: true }; },
            done: function (res) {
              if (res.error || !Array.isArray(res.data.tags)) { tagUi.err = res.error || 'Phoenix sent an unreadable answer'; render(lastData); return; }
              if (lastData) lastData = Object.assign({}, lastData, { camera_tags: res.data.tags });
              tagUi.err = ''; onOk();
              render(lastData);
            },
          });
        }
        function addOwnTag(shotId) {
          const t = String(tagUi.draft || '').trim();
          if (!t || t.length > TAG_MAX) { tagUi.err = 'An own tag is 1 to ' + TAG_MAX + ' characters.'; render(lastData); return Promise.resolve(); }
          return tagRequest('add', t, function () { tagUi = { shot: null, mode: '', tag: '', draft: '', err: '' }; });
        }
        function removeOwnTag(tag) { return tagRequest('remove', tag, function () { tagUi = { shot: null, mode: '', tag: '', draft: '', err: '' }; }); }
        function tagRow(s) {
          const row = el('div', 'sb-tagrow');
          const on = tagsOf(s), shared = sharedTags(lastData);
          const all = shared.concat(on.filter(function (t) { return !shared.some(function (x) { return sameTag(x, t); }); }));
          const full = on.length >= TAGS_PER_SHOT;
          all.forEach(function (tag) {
            const listed = shared.some(function (x) { return sameTag(x, tag); }), has = on.some(function (t) { return sameTag(t, tag); });
            const chip = el('span', 'sb-tagchip');
            const b = bare(listed ? tag + ' ★' : tag, 'tag secondary sm');
            b.setAttribute('data-tag', tag); b.setAttribute('aria-pressed', has ? 'true' : 'false'); b.setAttribute('aria-label', 'Own tag ' + tag);
            if (!has && full) { b.disabled = true; b.setAttribute('title', 'Up to ' + TAGS_PER_SHOT + ' own tags per shot'); }
            b.addEventListener('click', function () { if (!b.disabled) toggleTag(s.id, tag); });
            chip.appendChild(b);
            if (listed) {
              const x = bare('×', 'tag-del ghost sm');
              x.setAttribute('data-tag', tag); x.setAttribute('aria-label', 'Remove ' + tag + ' from the list'); x.setAttribute('title', 'Remove ' + tag + ' from the list');
              x.addEventListener('click', function () { tagUi = { shot: s.id, mode: 'del', tag: tag, draft: '', err: '' }; focusOnce = true; render(lastData); });
              chip.appendChild(x);
            }
            row.appendChild(chip);
          });
          if (!(tagUi.shot === s.id && tagUi.mode === 'add')) {
            const ab = bare('+ own tag', 'tag-add secondary sm');
            ab.setAttribute('title', 'Add an own tag: saved once, offered on every shot of every board');
            ab.addEventListener('click', function () { tagUi = { shot: s.id, mode: 'add', tag: '', draft: '', err: '' }; focusOnce = true; render(lastData); });
            row.appendChild(ab);
          }
          return row;
        }
        function tagExtra(s) {   // the inline field / the remove-from-list confirm / the error, under the chips
          const box = el('div', 'sb-tagextra');
          if (tagUi.shot === s.id && tagUi.mode === 'add') {
            const line = el('div', 'sb-tagrow');
            const inp = el('input', 'sb-tagin');
            inp.setAttribute('type', 'text'); inp.setAttribute('maxlength', String(TAG_MAX)); inp.setAttribute('aria-label', 'New own tag');
            inp.value = tagUi.draft || '';
            inp.addEventListener('input', function () { tagUi.draft = inp.value; });
            inp.addEventListener('keydown', function (e) {
              if (e && e.key === 'Enter') { if (e.preventDefault) e.preventDefault(); tagUi.draft = inp.value; addOwnTag(s.id); }
              else if (e && e.key === 'Escape') { tagUi = { shot: null, mode: '', tag: '', draft: '', err: '' }; render(lastData); }
            });
            line.appendChild(inp);
            const sv = bare('Add', 'tag-save primary sm'); sv.addEventListener('click', function () { tagUi.draft = inp.value; addOwnTag(s.id); });
            const cn = bare('Cancel', 'tag-cancel ghost sm'); cn.addEventListener('click', function () { tagUi = { shot: null, mode: '', tag: '', draft: '', err: '' }; render(lastData); });
            line.appendChild(sv); line.appendChild(cn);
            box.appendChild(line);
            if (focusOnce && !wantFocus) wantFocus = { el: inp };
          }
          if (tagUi.shot === s.id && tagUi.mode === 'del') {
            const tc = el('div', 'sb-tagconfirm');
            tc.appendChild(el('span', null, 'Remove "' + tagUi.tag + '" from the list? Shots that use it keep it.'));
            const go = bare('Remove', 'tag-del-go danger sm'); const tg = tagUi.tag; go.addEventListener('click', function () { removeOwnTag(tg); });
            const cn = bare('Cancel', 'tag-del-cancel ghost sm'); cn.addEventListener('click', function () { tagUi = { shot: null, mode: '', tag: '', draft: '', err: '' }; render(lastData); });
            tc.appendChild(go); tc.appendChild(cn);
            box.appendChild(tc);
            if (focusOnce && !wantFocus) wantFocus = { el: cn };
          }
          if (tagUi.err && tagUi.shot === s.id) box.appendChild(errLine(tagUi.err));
          return box;
        }
        // ── animatic (client side only) ───────────────────────────────────────────────
        // R6: it plays the SERVER's timeline (lastData.timeline, the one timing source the MP4 export renders too): a shot is entered when the board
        // time reaches its start_s, a line starts once when the time reaches its at_s (never before, never twice), the shot's sound clip starts with
        // the shot, and leaving a shot ends its lines and its sound. The pause between lines is part of the timeline (at_s): nothing chains on 'ended'.
        function linesOf(s) { return s && Array.isArray(s.lines) ? s.lines : []; }
        function lineSub(l) {
          const line = String((l && l.line) || '').trim();
          if (!line) return '';
          return (l.speaker ? l.speaker + ': ' : '') + '“' + line + '”';
        }
        function subtitleOf(s) { return linesOf(s).map(lineSub).filter(Boolean).join('  ·  '); }
        function tlOf(d) { const t = d && d.timeline; return t && Array.isArray(t.shots) && t.shots.length ? t : null; }
        function stopAnim(restore) {
          if (!anim) return;
          animGen++;
          animVid = null;
          if (anim.raf != null) { try { cancelRaf(anim.raf); } catch (_) {} }
          anim.audios.forEach(function (a) { try { a.pause(); } catch (_) {} });
          anim = null;
          if (restore !== false) { paintTransport(); paintPreview(); markPlaying(); }
        }
        function pauseShotAudio(a) { (a.shotAudios || []).forEach(function (u) { try { u.pause(); } catch (_) {} }); a.shotAudios = []; }
        function playAudio(a, src) {
          if (!AudioCtor) return;
          try { const au = new AudioCtor(src); a.audios.push(au); a.shotAudios.push(au); const p = au.play(); if (p && p.catch) p.catch(function () {}); } catch (_) {}
        }
        function startDueLines(a, t) {   // every line of the current shot whose at_s the board time has reached - each exactly once, never before
          const ts = a.tl.shots[a.cur];
          (ts && Array.isArray(ts.lines) ? ts.lines : []).forEach(function (l, k) {
            if (a.started.has(k) || !(t >= (Number(l.at_s) || 0))) return;
            a.started.add(k);
            if (l.take) playAudio(a, l.take);
          });
        }
        function enterShot(idx, t) {
          const a = anim;
          a.cur = idx;
          animVid = null;
          pauseShotAudio(a);   // leaving a shot ends its lines (those not started yet never start) AND a take / sound still playing
          a.started = new Set();
          const ts = a.tl.shots[idx];
          if (ts && ts.sfx && ts.sfx.clip) playAudio(a, '/sfx-clip/' + encodeURIComponent(ts.sfx.clip));
          startDueLines(a, t);
          paintPreview(); markPlaying();
        }
        function tick() {
          const a = anim;
          if (!a || a.gen !== animGen) return;
          a.raf = null;
          const t = a.offset + (nowMs() - a.t0) / 1000;
          if (t >= a.total) { stopAnim(); return; }
          let idx = a.cur;
          while (idx + 1 < a.tl.shots.length && (Number(a.tl.shots[idx + 1].start_s) || 0) <= t) idx++;
          if (idx !== a.cur) enterShot(idx, t);
          else startDueLines(a, t);
          a.pos = t;
          paintTransport();
          a.raf = raf(tick);
        }
        function playBoard() {
          if (anim) { stopAnim(); return; }
          const tl = tlOf(lastData);
          if (!tl) return;
          const sel = curSelected(lastData.shots || []);
          const si = Math.max(0, tl.shots.findIndex(function (x) { return x.id === sel; }));
          const offset = Number(tl.shots[si].start_s) || 0;
          anim = { tl: tl, cur: -1, offset: offset, pos: offset, total: Number(tl.total_s) || 0, t0: nowMs(), raf: null, audios: [], shotAudios: [], started: new Set(), gen: ++animGen };
          enterShot(si, offset);
          paintTransport();
          anim.raf = raf(tick);
        }
        function curSelected(list) {
          const a = list || (lastData && lastData.shots) || [];
          if (selectedId && a.some(function (s) { return s.id === selectedId; })) return selectedId;
          return a.length ? a[0].id : null;
        }
        function totalOf(shots) { return shots.reduce(function (t, s) { return t + (Number(s.duration_s) || 0); }, 0); }
        function paintTransport() {
          if (!clockEl) return;
          const shots = lastData && lastData.shots ? lastData.shots : [];
          const tl = tlOf(lastData);
          const si = shotIndex(curSelected(shots));
          let start = 0;
          if (si >= 0) { const ts = tl ? tl.shots.find(function (x) { return x.id === shots[si].id; }) : null; start = ts ? Number(ts.start_s) || 0 : Number(shots[si].start_s) || 0; }
          const pos = anim ? anim.pos : start;
          clockEl.textContent = clock(pos) + ' / ' + clock(anim ? anim.total : (tl ? Number(tl.total_s) || 0 : totalOf(shots)));
          if (playBtn) {
            const none = !anim && (!shots.length || !tl);
            playBtn.disabled = none;
            playBtn.setAttribute('title', none ? (shots.length ? 'No timeline' : 'No shots') : 'Animatic: keyframes held, clips where ready, voice + SFX laid under');
            playBtn.textContent = anim ? 'Stop' : 'Play board';
            playBtn.setAttribute('aria-label', anim ? 'Stop the animatic' : 'Play board');
          }
        }
        function markPlaying() {
          tileEls.forEach(function (t, id) {
            const ts = anim && anim.cur >= 0 ? anim.tl.shots[anim.cur] : null;
            if (ts && ts.id === id) t.setAttribute('data-playing', 'true'); else t.removeAttribute('data-playing');
          });
        }
        // ── preview ───────────────────────────────────────────────────────────────────
        function grey(text) { return el('div', 'sb-grey', text); }
        function imgOf(url, cls) {
          const im = el('img', cls || null);
          im.setAttribute('loading', 'lazy');
          im.setAttribute('alt', '');
          im.setAttribute('src', url);
          return im;
        }
        function paintPreview() {
          const box = pvBox;
          if (!box) return;
          box.textContent = '';
          const shots = lastData && Array.isArray(lastData.shots) ? lastData.shots : [];
          let s, v;
          if (anim) {
            // the timeline is a snapshot taken when playback started - the clip URL and its muted flag come from the CURRENT board by shot id (the Clip sound switch changes them while it plays)
            const ts0 = anim.tl.shots[anim.cur];
            s = ts0 ? (shots.find(function (x) { return x.id === ts0.id; }) || null) : null; v = 'anim';
          }
          else { const si = shotIndex(curSelected(shots)); s = si >= 0 ? shots[si] : null; v = view; }
          if (!s) {
            if (!shots.length) {   // <lc2b> an empty board: the text and the way out, in the preview
              const es = el('div', 'sb-stage sb-stage-empty');
              es.appendChild(el('div', 'sb-empty sb-grey', 'No shots yet — add one here or send an image from the Library.'));
              es.appendChild(btn('+ Shot', 'Add the first shot', false, function () { addShot(); }, 'emptyadd secondary'));
              box.appendChild(es);
            }
            return;
          }
          const n = shots.findIndex(function (x) { return x.id === s.id; }) + 1 || (anim ? anim.cur + 1 : 1);
          const st = statusOf(s);
          if (v === 'clip' && st !== 'video') v = 'key';
          const stage = el('div', 'sb-stage');
          const asp = boardOf(lastData).aspect;
          if (asp) stage.setAttribute('data-aspect', asp);
          let badge = '';
          if (v === 'refs') {
            badge = '① REFERENCES · shot ' + n;
            const refs = Array.isArray(s.refs) ? s.refs : [];
            if (!refs.length) stage.appendChild(grey('No references yet — add one with + Character, + Set or + Prop'));
            else {
              const grid = el('div', 'sb-refgrid');
              refs.forEach(function (r) {
                const cell = el('div', 'sb-refcell');
                if (!r.url || r.exists === false) cell.appendChild(grey('missing'));
                else cell.appendChild(imgOf(r.url));
                cell.appendChild(el('span', 'sb-reflbl', (r.role || '') + (r.label ? ' · ' + r.label : '')));
                grid.appendChild(cell);
              });
              stage.appendChild(grid);
            }
          } else if (v === 'clip') {
            badge = '③ CLIP · shot ' + n;
            const vid = el('video', 'sb-video');
            vid.setAttribute('controls', '');
            vid.setAttribute('src', s.clip_url);
            vid.muted = !!(s.clip && s.clip.muted === true);   // LC2f (T9-1): the shot's Clip sound switch
            stage.appendChild(vid);
          } else if (v === 'anim') {
            badge = '▶ ANIMATIC · shot ' + n;
            const tsh = anim && anim.tl.shots[anim.cur];
            if (tsh && tsh.visual === 'clip' && s.clip_url) {
              // the same shot keeps its <video> through a rebuild (re-attached and resumed, not restarted)
              let vid;
              if (animVid && animVid.id === s.id && animVid.src === s.clip_url) vid = animVid.el;
              else { vid = el('video', 'sb-video'); vid.setAttribute('src', s.clip_url); vid.setAttribute('autoplay', ''); animVid = { id: s.id, src: s.clip_url, el: vid }; }
              vid.muted = !!(s.clip && s.clip.muted === true);   // R6 r2-B3: derived live from the CURRENT shot (tsh is the snapshot from when playback started): muted exactly when clip.muted === true, the timeline's own clip_audio rule - so the Clip sound switch works while it plays, also on a re-used element
              stage.appendChild(vid);
              try { if (vid.play) { const p = vid.play(); if (p && p.catch) p.catch(function () {}); } } catch (_) {}
            } else if (s.image && s.exists && s.url) stage.appendChild(imgOf(s.url));
            else stage.appendChild(grey(s.title || ('Shot ' + n)));
          } else {
            badge = '② KEYFRAME · shot ' + n + ' — the first frame of the video';
            if (!s.image) stage.appendChild(grey('No keyframe yet — Make keyframe'));
            else if (!s.exists || !s.url) stage.appendChild(grey('missing'));
            else stage.appendChild(imgOf(s.url));
          }
          const ph = el('div', 'sb-pvhead');
          ph.appendChild(el('span', 'sb-badge ' + (v === 'clip' ? 'video' : (v === 'key' ? 'keyframe' : '')), badge));
          box.appendChild(ph);
          const sub = v === 'refs' ? '' : subtitleOf(s);
          if (sub) stage.appendChild(el('span', 'sb-sub', sub));
          box.appendChild(stage);
          if (v === 'clip' && s.clip_url) {   // v1.10 VP1: the clip opens in the Video tab (frame step, scrub, speed)
            const ov = el('div', 'sb-openrow');
            const ob = bare('Open in Video tab', 'openvideo secondary sm');
            ob.setAttribute('title', 'Open this clip in the Video tab');
            ob.addEventListener('click', function () { { const ov2 = deps.openVideo || api.openVideo; if (ov2) ov2({ url: s.clip_url, path: s.clip_path || '', muted: !!(s.clip && s.clip.muted === true), board: curBoardId || (lastData && lastData.board && lastData.board.id) || '', shot: s.id }); } });
            ov.appendChild(ob); box.appendChild(ov);
          }
        }
        // ── pieces of the page ───────────────────────────────────────────────────────
        // spec = 'name [primary|secondary|ghost|danger] [sm] [act]': className is `btn btn-<variant>` (+ btn-sm) and nothing else; the name is the ONE data-sb attribute
        function bare(label, spec) {
          const t = String(spec || 'button').split(/\s+/).filter(Boolean);
          const variant = t.filter(function (x) { return VARIANTS.indexOf(x) >= 0; })[0] || 'secondary';
          const name = t.filter(function (x) { return VARIANTS.indexOf(x) < 0 && x !== 'sm' && x !== 'act'; })[0] || 'button';
          const b = el('button', 'btn btn-' + variant + (t.indexOf('sm') >= 0 ? ' btn-sm' : ''), label);
          b.setAttribute('type', 'button');
          b.setAttribute('data-sb', name);
          return b;
        }
        function btn(label, aria, disabled, fn, spec, flushId) {
          const b = bare(label, spec);
          b.setAttribute('aria-label', aria);
          b.setAttribute('title', aria);
          if (disabled) b.disabled = true;
          if (/(^|\s)act(\s|$)/.test(spec || '')) wireAct(b, 'btn:' + (b.getAttribute('data-sb')) + ':' + label, flushId || null, fn);   // <lc2b> an action button: pointerdown
          else b.addEventListener('click', function () { if (!b.disabled) fn(); });
          return b;
        }
        function errLine(text) { const er = el('div', 'sb-err', text); er.setAttribute('role', 'alert'); return er; }
        // a text input under the keep-rule: key '<shotId>:<name>'
        function field(s, name, desc, cls, placeholder, oldEls, aria) {
          const key = s.id + ':' + name;
          const server = desc.get(s);
          const t = oldEls.get(key);
          const keep = !!t && t.value !== fBase.get(key) && t.value !== fSent.get(key) && t.value !== server;   // typed since the last render, and not just-saved text
          if (!keep) fBase.set(key, server);
          const inp = el('input', cls);
          inp.setAttribute('type', 'text');
          if (placeholder) inp.setAttribute('placeholder', placeholder);
          if (aria || placeholder) inp.setAttribute('aria-label', aria || placeholder);
          inp.value = keep ? t.value : server;
          if (fErr.has(key) && inp.value === server) fErr.delete(key);   // reverted to the server text: the error is moot
          fEl.set(key, inp); fDesc.set(key, desc);
          inp.addEventListener('blur', function () { saveField(s.id, key); });
          inp.addEventListener('keydown', function (e) { if (e && e.key === 'Enter') { if (e.preventDefault) e.preventDefault(); saveField(s.id, key); } });
          return inp;
        }
        function secErr(parent, id, names) {
          names.forEach(function (nm) { const m = fErr.get(id + ':' + nm); if (m) parent.appendChild(errLine(m)); });
        }
        function section(title, hint) {
          const sec = el('div', 'sb-sec');
          const h = el('div', 'sb-sec-h');
          h.appendChild(el('strong', null, title));
          if (hint) h.appendChild(el('span', 'sb-hintline', ' — ' + hint));
          sec.appendChild(h);
          return sec;
        }
        function wireDoc() {
          if (docWired || !doc.addEventListener) return;
          docWired = true;
          doc.addEventListener('keydown', function (e) { if (e && e.key === 'Escape') closePop(); });
          doc.addEventListener('click', function (e) {
            if (!helpFor) return;
            const t = e && e.target;
            if (t && popEls.some(function (p) { return p.contains && p.contains(t); })) return;   // the ? button and its popover handle themselves
            closePop();
          });
        }
        function closePop() {
          if (!helpFor) return;
          helpFor = null;
          popEls.forEach(function (p) { if (p.pop) { p.pop.hidden = true; p.pop.setAttribute('hidden', ''); } });
        }
        // <sb3> why a speaker cannot be spoken ('' = fine): the cast member must exist and have a usable voice (the server's own availability when it sent one)
        function castWhy(name, data) {
          const noVoice = '"' + name + '" has no voice yet — set it in the cast';
          const m = castOf(data).find(function (x) { return x && x.name === name; });
          if (!m) return noVoice;
          if (m.engine !== 'chatterbox' && !m.voice) return noVoice;
          const v = (Array.isArray(data && data.cast) ? data.cast : []).find(function (x) { return x && x.name === name; });
          if (v && v.available === false) return (v.reason === 'pick a reference voice' || v.reason === 'no voice pack chosen') ? noVoice : '"' + name + '": ' + v.reason;
          return '';
        }
        function pane(s, i, n, promptText, isSel, oldEls, data) {
          const c = el('div', 'sb-card sb-pane');
          c.setAttribute('data-shot', s.id);
          if (!isSel) { c.hidden = true; c.setAttribute('hidden', ''); }
          const st = statusOf(s);
          const sibs = data && Array.isArray(data.shots) ? data.shots : [];
          // header: Shot N, status chip, ? help, ‹ › (select only - no request)
          const h = el('div', 'sb-phead');
          h.appendChild(el('strong', 'sb-ptitle', 'Shot ' + (i + 1)));
          h.appendChild(el('span', 'sb-status ' + st, STATUS_TEXT[st] || st));
          if (takeReady.has(s.id) && takeReady.get(s.id) > nowMs()) h.appendChild(el('span', 'sb-takeready', 'Take ready'));   // <lc2b> ~3 s after a successful Speak line
          const helpWrap = el('span', 'sb-help');
          const hb = btn('?', 'What are the three steps?', false, function () {
            wireDoc();
            if (helpFor === s.id) { closePop(); return; }
            closePop();
            helpFor = s.id;
            popEls.forEach(function (p) { if (p.id === s.id) { p.pop.hidden = false; p.pop.removeAttribute('hidden'); } });
          }, 'help ghost sm');
          hb.setAttribute('title', 'What are the three steps?');
          const pop = el('div', 'sb-pop');
          pop.setAttribute('role', 'note');
          pop.appendChild(el('div', 'sb-pophelp', HELP_TEXT));
          if (helpFor !== s.id) { pop.hidden = true; pop.setAttribute('hidden', ''); }
          helpWrap.appendChild(hb);
          popEls.push({ id: s.id, pop: pop, contains: function (t) { return helpWrap.contains(t); } });
          h.appendChild(helpWrap);
          h.appendChild(btn('‹', 'Previous shot', i === 0, function () { if (i > 0 && sibs[i - 1]) { selectedId = sibs[i - 1].id; helpFor = null; render(lastData); } }, 'prev secondary sm'));
          h.appendChild(btn('›', 'Next shot', i === n - 1, function () { if (i < n - 1 && sibs[i + 1]) { selectedId = sibs[i + 1].id; helpFor = null; render(lastData); } }, 'next secondary sm'));
          c.appendChild(h);
          // title, Earlier / Later, ✕ - the ✕ sends NOTHING: it opens "Remove shot n?" in the same place (the row is stacked over the controls: nothing moves)
          const rw = el('div', 'sb-rmwrap');
          rw.setAttribute('data-open', rmFor === s.id ? 'true' : 'false');
          const h2 = el('div', 'sb-phead2');
          h2.appendChild(field(s, 'title', { get: function (x) { return x.title || ''; }, body: function (v) { return { title: v }; } }, 'sb-title-in', 'Title', oldEls, 'Shot title'));
          h2.appendChild(btn('Earlier', 'Move earlier', i === 0, function () { moveShot(s.id, -1); }, 'move-earlier secondary sm'));
          h2.appendChild(btn('Later', 'Move later', i === n - 1, function () { moveShot(s.id, 1); }, 'move-later secondary sm'));
          h2.appendChild(btn('✕', 'Remove shot', false, function () { rmFor = s.id; focusOnce = true; render(lastData); }, 'remove ghost sm'));
          rw.appendChild(h2);
          const rc = el('div', 'sb-rmconfirm');
          if (rmFor === s.id) {
            rc.appendChild(el('span', null, 'Remove shot ' + (i + 1) + '?'));
            rc.appendChild(btn('Remove', 'Remove shot ' + (i + 1), false, function () { rmFor = null; removeShot(s.id); render(lastData); }, 'rm-go danger sm'));
            const rn = btn('Cancel', 'Cancel', false, function () { rmFor = null; render(lastData); }, 'rm-cancel ghost sm');
            rc.appendChild(rn);
            if (isSel && focusOnce && !wantFocus) wantFocus = { el: rn };
          } else { rc.hidden = true; rc.setAttribute('hidden', ''); }
          rw.appendChild(rc);
          c.appendChild(rw);
          c.appendChild(el('div', 'sb-meta', '#' + (i + 1) + '  ' + fmt(s.start_s) + '–' + fmt((Number(s.start_s) || 0) + (Number(s.duration_s) || 0)) + ' s'));
          const actMsg = !promptErr.has(s.id) && actErr.get(s.id);
          const putAct = function (sec, box) { if (actMsg && (actSec.get(s.id) || 'top') === sec) box.appendChild(errLine(actMsg)); };   // an action's error sits under the section it belongs to
          putAct('top', c);
          secErr(c, s.id, ['title']);
          // <lc2b> the three-step chain lives in the ? popover (the top-bar view switch is the only switch in the workbench)
          const steps = el('div', 'sb-popsteps');
          const refs = Array.isArray(s.refs) ? s.refs : [];
          const stepDefs = [
            ['refs', '① References', refs.length ? refs.length + ' linked' : 'none yet', refs.find(function (r) { return r.url && r.exists !== false; }), false],
            ['key', '② Keyframe', !s.image ? 'not yet' : ((s.exists && s.url) ? 'ok' : 'missing'), (s.image && s.exists && s.url) ? { url: s.url } : null, false],
            ['clip', '③ Clip', st === 'video' ? 'ok' : 'not yet', null, st !== 'video'],
          ];
          stepDefs.forEach(function (d, k) {
            if (k) steps.appendChild(el('span', 'sb-arrow', '→'));
            const b = bare('', 'step secondary sm');
            b.setAttribute('data-view', d[0]);
            b.setAttribute('aria-pressed', view === d[0] ? 'true' : 'false');
            if (d[4]) { b.disabled = true; b.setAttribute('title', 'No clip yet'); }
            const th = el('span', 'sb-stepthumb');
            if (d[3] && d[3].url) th.appendChild(imgOf(d[3].url)); else if (d[0] === 'clip') th.textContent = '③';
            b.appendChild(th);
            b.appendChild(el('strong', null, d[1]));
            b.appendChild(el('span', 'sb-stepnote', d[2]));
            b.addEventListener('click', function () { if (b.disabled) return; view = d[0]; helpFor = null; render(lastData); });   // switches the view and closes the popover
            steps.appendChild(b);
          });
          pop.appendChild(steps);
          helpWrap.appendChild(pop);
          // ① references
          const rs = el('details', 'sb-sec sb-refsec');
          rs.open = refsOpen; if (refsOpen) rs.setAttribute('open', '');
          rs.addEventListener('toggle', function () { refsOpen = !!rs.open; });
          const rsh = el('summary', 'sb-sec-h'); rsh.appendChild(el('strong', null, 'References')); rsh.appendChild(el('span', 'sb-hintline', ' — who / where / what, from the Library')); rs.appendChild(rsh);
          const chips = el('div', 'sb-chips');
          refs.forEach(function (r, ri) {
            const tok = refTok(refs, ri);
            const refAt = function (x) { return (x.refs || [])[refIdx(x.refs || [], tok)]; };
            const chip = el('span', 'sb-ref');
            if (r.url && r.exists !== false) chip.appendChild(imgOf(r.url, 'sb-refthumb')); else chip.appendChild(el('span', 'sb-refthumb sb-nothumb'));
            const rsel = el('select', 'sb-refrole sb-refrolesel');
            rsel.setAttribute('aria-label', 'Role of the reference ' + (r.label || String(r.path).split(/[\\/]/).pop()));
            [['character', 'Character'], ['set', 'Set'], ['prop', 'Prop']].forEach(function (o) { const op = el('option', '', o[1]); op.value = o[0]; rsel.appendChild(op); });
            rsel.value = r.role;
            rsel.addEventListener('change', function () { setRefRole(s.id, tok, rsel.value); });
            chip.appendChild(rsel);
            if (!r.label) { const fn0 = String(r.path).split(/[\\/]/).pop(); const fe = el('span', 'sb-reffile', fn0); fe.setAttribute('title', String(r.path)); chip.appendChild(fe); }   // no label: the filename stands in (placeholder text, never sent to the model)
            chip.appendChild(field(s, 'label:' + tok, { get: function (x) { const q = refAt(x); return q ? (q.label || '') : ''; },
              body: function (v, x) { const i = refIdx(x.refs || [], tok); if (i < 0) return null; const list = (x.refs || []).map(minRef); list[i].label = v; return { refs: list }; } }, 'sb-reflabel', 'name in the prompt (optional)', oldEls, 'Label of the ' + r.role + ' reference'));
            chip.appendChild(btn('✕', 'Remove reference ' + (r.label || r.role), false, function () { removeRef(s.id, tok); }, 'refx ghost sm'));
            chips.appendChild(chip);
          });
          [['character', '+ Character'], ['set', '+ Set'], ['prop', '+ Prop']].forEach(function (d) {
            const full = refs.length >= MAX_REFS;
            const ab = btn(d[1], full ? 'Up to ' + MAX_REFS + ' references per shot' : 'Add a ' + d[0] + ' reference from the Library', full, function () { openPicker(s.id, d[0]); }, 'addref secondary sm');
            ab.setAttribute('data-role', d[0]);
            chips.appendChild(ab);
          });
          if (i > 0 && !refs.some(function (r) { return r.role === 'set'; })) {   // <lc2b> the shot before this one has a keyframe that exists: it can be this shot's Set in one click
            const prev = data && Array.isArray(data.shots) ? data.shots[i - 1] : null;
            if (prev && prev.image && prev.exists) {
              const full2 = refs.length >= MAX_REFS;
              const pb = btn('+ Previous keyframe as Set', full2 ? 'Up to ' + MAX_REFS + ' references per shot' : 'Use the keyframe of shot ' + i + ' as the Set of this shot', full2, function () { addPrevAsSet(s.id, prev.id); }, 'addprev secondary sm');
              chips.appendChild(pb);
            }
          }
          rs.appendChild(chips);
          secErr(rs, s.id, refs.map(function (r, ri) { return 'label:' + refTok(refs, ri); }));
          putAct('refs', rs);
          if (s.keyframe_error && !(actMsg && (actSec.get(s.id) || 'top') === 'refs')) rs.appendChild(errLine(s.keyframe_error));   // the last keyframe failure, kept by the server (survives a reload)
          if (picker && picker.id === s.id) rs.appendChild(pickerBox(s));
          // what happens
          const ps = section('What happens');
          const ta = el('textarea', 'sb-prompt');
          ta.value = promptText;
          ta.setAttribute('placeholder', 'Prompt');
          ta.setAttribute('aria-label', 'What happens');
          taById.set(s.id, ta);
          ta.addEventListener('blur', function () { savePrompt(s.id); });
          ta.addEventListener('keydown', function (e) { if (e && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { if (e.preventDefault) e.preventDefault(); savePrompt(s.id); } });
          ps.appendChild(ta);
          if (promptErr.has(s.id)) ps.appendChild(errLine(promptErr.get(s.id)));
          // camera
          const cs = section('Camera', 'presets optional, click again to clear');
          const cam = s.camera || {};
          CAM_ROWS.forEach(function (row) {
            const r = el('div', 'sb-camrow');
            r.appendChild(el('span', 'sb-camlbl', row.label));
            row.opts.forEach(function (o) {
              const on = cam[row.key] === o[0];
              const b = bare(o[1], 'chip secondary sm');
              b.setAttribute('aria-pressed', on ? 'true' : 'false');
              b.setAttribute('data-cam', row.key + ':' + o[0]);
              b.addEventListener('click', function () { setCamera(s.id, row.key, o[0]); });
              r.appendChild(b);
            });
            cs.appendChild(r);
          });
          cs.appendChild(tagRow(s));
          cs.appendChild(tagExtra(s));
          cs.appendChild(field(s, 'free', { get: function (x) { return (x.camera && x.camera.free) || ''; }, body: function (v) { return { camera: { free: v } }; } }, 'sb-free', 'Or describe the camera yourself…', oldEls, 'Camera, in your own words'));
          cs.appendChild(el('div', 'sb-hintline', '★ own tags are saved and offered on every shot of every board'));
          secErr(cs, s.id, ['free']);
          putAct('camera', cs);
          // dialogue
          const nLines = linesOf(s).length;
          const ds = section('Dialogue · ' + nLines + (nLines === 1 ? ' line' : ' lines'));
          const cast = castOf(data);
          const lines = linesOf(s);
          // <sb3> several lines per shot. Every change sends the WHOLE list, built from the server's shot when the request leaves the queue (a take is the server's: it keeps it by lid)
          const lineBody = function (l) { return { lid: l.lid, speaker: l.speaker || '', line: l.line || '', gap_s: Number(l.gap_s) || 0 }; };
          const setLines = function (build) {
            return shotAction(s.id, function (sh) {
              const nxt = build(linesOf(sh).map(lineBody));
              return nxt ? { url: '/storyboard/shot/update', method: 'POST', body: { id: s.id, lines: nxt } } : null;
            }, 'dialogue');
          };
          const lineIn = function (x, lid) { return linesOf(x).find(function (y) { return y.lid === lid; }) || null; };
          lines.forEach(function (l, li) {
            const lid = l.lid;
            const dr = el('div', 'sb-row2 sb-lrow');
            dr.setAttribute('data-lid', lid);
            const sp = el('select', 'sb-speaker');
            sp.setAttribute('aria-label', 'Speaker of line ' + (li + 1));
            const curSp = l.speaker || '';
            const o0 = el('option', '', '— nobody —'); o0.value = ''; sp.appendChild(o0);
            cast.forEach(function (m) { const o = el('option', '', m.name); o.value = m.name; sp.appendChild(o); });
            if (curSp && !cast.some(function (m) { return m.name === curSp; })) { const o = el('option', '', curSp + ' (not in the cast)'); o.value = curSp; sp.appendChild(o); }
            sp.value = curSp;
            sp.addEventListener('change', function () { const v = sp.value; setLines(function (cur) { const x = cur.find(function (y) { return y.lid === lid; }); if (!x) return null; x.speaker = v; return cur; }); });
            dr.appendChild(sp);
            const lineInp = field(s, 'line:' + lid, {
              get: function (x) { const y = lineIn(x, lid); return y ? (y.line || '') : ''; },
              body: function (v, sh) { const cur = linesOf(sh).map(lineBody); const x = cur.find(function (y) { return y.lid === lid; }); if (!x) return null; x.line = v; return { lines: cur }; },
            }, 'sb-line', 'What is said…', oldEls, 'Dialogue line ' + (li + 1));
            dr.appendChild(lineInp);
            const gp = field(s, 'gap:' + lid, {   // <sb3-r2> a field like the text: a typed pause is flushed before an action and survives a re-render
              get: function (x) { const y = lineIn(x, lid); return String(y ? (Number(y.gap_s) || 0) : 0); },
              body: function (v, sh) { const cur = linesOf(sh).map(lineBody); const x = cur.find(function (y) { return y.lid === lid; }); if (!x) return null; let g = Number(v); if (!isFinite(g)) g = 0; x.gap_s = Math.min(5, Math.max(0, g)); return { lines: cur }; },
            }, 'sb-gap', '', oldEls, 'Pause before line ' + (li + 1) + ' (s)');
            gp.setAttribute('type', 'number'); gp.setAttribute('step', '0.1'); gp.setAttribute('min', '0'); gp.setAttribute('max', '5');
            gp.setAttribute('aria-label', 'Pause before line ' + (li + 1) + ' (s)'); gp.setAttribute('title', 'Pause before this line (s)');
            gp.addEventListener('change', function () { return saveField(s.id, s.id + ':gap:' + lid); });
            dr.appendChild(gp);
            // Speak THIS line: the same flush-first / reserve-at-activation path as the shot's buttons (kind 'speak' = one request per shot at a time)
            const nm = (l.speaker || '').trim(), rk0 = 'speak:' + s.id;
            let why = '', lbl = 'Speak', textWhy = '';
            if (resv.has(rk0) && !actBusy.has(rk0)) { why = 'Saving your edits…'; lbl = 'Saving…'; }
            else if (actBusy.has(rk0)) { why = 'Speaking…'; lbl = 'Speaking…'; }
            else if (!nm) why = 'Pick a speaker from the cast first';
            else if (castWhy(nm, data)) why = castWhy(nm, data);
            const pendingText = function () { return String(lineInp.value || '').trim(); };   // <sb3-r2> eligibility follows the text in the box (typed, maybe not saved yet), not only the saved line
            if (!why && !pendingText()) textWhy = 'Type a line first';
            const sb = bare(lbl, 'speakline secondary sm');
            sb.setAttribute('data-act', 'speak-line'); sb.setAttribute('data-lid', lid);
            const paintSpeak = function () {
              const w = textWhy;
              if (w) { sb.disabled = true; sb.setAttribute('title', w); sb.setAttribute('aria-label', lbl + ' — ' + w); }
              else { sb.disabled = false; sb.setAttribute('title', 'Speak this line with the voice of ' + nm); sb.setAttribute('aria-label', 'Speak line ' + (li + 1)); }
            };
            if (why) { sb.disabled = true; sb.setAttribute('title', why); sb.setAttribute('aria-label', lbl + ' — ' + why); }
            else { paintSpeak(); lineInp.addEventListener('input', function () { textWhy = pendingText() ? '' : 'Type a line first'; paintSpeak(); }); wireAct(sb, 'speakline:' + s.id + ':' + lid, s.id, function () { ACTIONS.speak(s.id, { lid: lid }); }, 'speak'); }
            dr.appendChild(sb);
            if (l.takeExists) { const mk = el('span', 'sb-takemark', '♪'); mk.setAttribute('title', 'This line has a take'); dr.appendChild(mk); }
            dr.appendChild(btn('↑', 'Move line ' + (li + 1) + ' up', li === 0, function () { setLines(function (cur) { const i = cur.findIndex(function (y) { return y.lid === lid; }); if (i < 1) return null; const t = cur[i]; cur[i] = cur[i - 1]; cur[i - 1] = t; return cur; }); }, 'lineup ghost sm'));
            dr.appendChild(btn('↓', 'Move line ' + (li + 1) + ' down', li === lines.length - 1, function () { setLines(function (cur) { const i = cur.findIndex(function (y) { return y.lid === lid; }); if (i < 0 || i >= cur.length - 1) return null; const t = cur[i]; cur[i] = cur[i + 1]; cur[i + 1] = t; return cur; }); }, 'linedown ghost sm'));
            dr.appendChild(btn('✕', 'Remove line ' + (li + 1), false, function () { setLines(function (cur) { const i = cur.findIndex(function (y) { return y.lid === lid; }); if (i < 0) return null; cur.splice(i, 1); return cur; }); }, 'lineremove ghost sm'));
            ds.appendChild(dr);
          });
          if (!lines.length) ds.appendChild(el('div', 'sb-hint sb-nolines', 'No lines yet — add one with + Line'));
          if (!cast.length) ds.appendChild(el('div', 'sb-hint', 'No cast yet — add characters in the cast (board header) to pick a speaker'));
          lines.forEach(function (l) { const nm = (l.speaker || '').trim(); const w = nm ? castWhy(nm, data) : ''; if (w && w.indexOf('has no voice yet') > 0) ds.appendChild(el('div', 'sb-hint', w)); });
          ds.appendChild(btn('+ Line', lines.length >= MAX_LINES ? 'A shot holds up to ' + MAX_LINES + ' lines' : 'Add a line of dialogue to this shot', lines.length >= MAX_LINES, function () { setLines(function (cur) { if (cur.length >= MAX_LINES) return null; cur.push({ lid: '', speaker: '', line: '', gap_s: 0 }); return cur; }); }, 'addline secondary sm'));
          secErr(ds, s.id, lines.map(function (l) { return 'line:' + l.lid; }));
          putAct('dialogue', ds);
          // sound + duration
          const ss = section('Sound');
          ss.appendChild(field(s, 'stext', { get: function (x) { return (x.sound && x.sound.text) || ''; }, body: function (v) { return { sound: { text: v } }; } }, 'sb-stext', 'e.g. wind, crackling embers', oldEls, 'Sound description'));
          const cl = el('select', 'sb-clipsel');
          cl.setAttribute('aria-label', 'Saved SFX clip');
          fillSelect(cl, sfxClips || [], (s.sound && s.sound.clip) || '', '— no saved clip —');
          ['focus', 'mouseenter'].forEach(function (ev) { cl.addEventListener(ev, function () { ensureSfx(); }); });
          cl.addEventListener('change', function () { const v = cl.value; shotAction(s.id, function () { return { url: '/storyboard/shot/update', method: 'POST', body: { id: s.id, sound: { clip: v } } }; }, 'sound'); });
          sfxSels.push(cl);
          ss.appendChild(cl);
          if (s.sound && s.sound.clip && s.sound.clipExists === false) ss.appendChild(el('div', 'sb-hint', 'That clip is gone from the SFX library'));
          secErr(ss, s.id, ['stext']);
          putAct('sound', ss);
          const dsec = section('Duration');
          const dur = el('input', 'sb-dur');
          dur.setAttribute('type', 'number');
          dur.setAttribute('step', '0.5');
          dur.setAttribute('min', '1');
          dur.setAttribute('max', '15');
          dur.setAttribute('aria-label', 'Duration (s)');
          dur.value = pendingDur.has(s.id) ? pendingDur.get(s.id) : String(s.duration_s);   // a change still waiting in the queue is not lost by a rebuild
          dur.addEventListener('change', function () { pendingDur.set(s.id, dur.value); setDuration(s.id); });   // the raw field value goes out as it is when the request leaves the queue ('' -> the server makes it 5)
          dsec.appendChild(dur);
          putAct('dur', dsec);
          [ds, ps, cs, rs, ss, dsec].forEach(function (x) { c.appendChild(x); });   // R6: Dialogue · What happens · Camera · References · Sound · Duration
          // sent to the model
          const det = el('details', 'sb-sent');
          det.open = sentOpen;
          if (sentOpen) det.setAttribute('open', '');
          det.addEventListener('toggle', function () { sentOpen = !!det.open; });
          det.appendChild(el('summary', null, '▸ Sent to the model'));
          const cmp = s.compiled || {};
          det.appendChild(el('div', 'sb-cmp-h', 'Keyframe (image model)'));
          det.appendChild(el('div', 'sb-cmp sb-cmp-key', cmp.keyframe || '—'));
          det.appendChild(el('div', 'sb-cmp-h', 'Video'));
          det.appendChild(el('div', 'sb-cmp sb-cmp-video', cmp.video || '—'));
          det.appendChild(el('div', 'sb-cmp sb-cmp-start', 'start image: ' + (s.image ? String(s.image).split(/[\\/]/).pop() : 'none')));
          det.appendChild(el('div', 'sb-cmp sb-cmp-refs', 'references: ' + (refs.length ? refs.map(function (r) { return r.role + ' ' + (r.label || String(r.path).split(/[\\/]/).pop()); }).join(', ') : 'none')));
          c.appendChild(det);
          // V1b-3: the three action buttons (state comes from the shot + board: a disabled button always says why in its title)
          const acts = el('div', 'sb-acts');
          const vid = vReady(data);   // <v2-choice> the pick in the selector (else the config's choice): { available, reason }
          // <sb3-r3> Speak all = the lines without a take; the text of a line is what is in its box (typed, maybe not saved yet), like the per-line Speak
          const textOfLine = function (l) { const t = fEl.get(s.id + ':line:' + l.lid); return String(t ? t.value : (l.line || '')).trim(); };
          const spkReason = function () {
            const todo = lines.filter(function (l) { return textOfLine(l) && !l.take; });
            if (!lines.length) return 'Add a line first';
            if (!lines.some(function (l) { return textOfLine(l); })) return 'Type a line first';
            if (!todo.length) return 'Every line has a take — use Speak on a line to redo it';
            for (const l of todo) {
              const nm0 = (l.speaker || '').trim();
              if (!nm0) return 'Pick a speaker from the cast first';
              const w0 = castWhy(nm0, data);
              if (w0) return w0;
            }
            return '';
          };
          const kf = data && data.keyframe && typeof data.keyframe === 'object' ? data.keyframe : null;   // <lc2b> which image workflow builds the keyframe
          const kfTooMany = !!(kf && kf.mode !== 'none' && Number(kf.max_refs) >= 1 && refs.length > Number(kf.max_refs));
          const kfWhy = (kf && kf.mode === 'none' && refs.length) ? '"' + (kf.label || 'the active image workflow') + '" has no reference mode — use Flux Klein (up to 2 references) or Z-Image Turbo (1 reference).'
            : (kfTooMany ? 'The active image workflow takes ' + kf.max_refs + ' reference images — this shot has ' + refs.length + '. Remove some or switch the workflow.' : '');   // the server's own text, shown before the click
          const defs = [
            ['speak', 'Speak all', 'Speak every line of this shot that has no take yet'],
            ['keyframe', s.image ? 'Redo keyframe' : 'Make keyframe', 'Make the first frame of this shot from its references'],
            ['video', 'Make video', 'Make the clip of this shot from its keyframe'],
          ];
          const vEst = vEff(s).est;   // the effective backend's estimate for THIS shot (null = free): paid -> the price is on the button
          const vPrice = (vid.available && vEst && Number.isFinite(Number(vEst.usd))) ? ' · $' + Number(vEst.usd).toFixed(2) : '';
          defs.forEach(function (d) {
            const kind = d[0], bsy = actBusy.has(kind + ':' + s.id) || (kind === 'keyframe' && s.keyframe_busy) || (kind === 'video' && s.video_busy);
            let why = '', label = d[1];
            const rk0 = kind + ':' + s.id, unkeying = actBusy.has('unkey:' + s.id) || resv.has('unkey:' + s.id);
            if (resv.has(rk0) && !actBusy.has(rk0)) { why = 'Saving your edits…'; label = 'Saving…'; }
            else if (bsy) { why = kind === 'keyframe' ? 'A keyframe is being made' : (kind === 'speak' ? 'Speaking…' : 'A video is being made'); label = kind === 'keyframe' ? 'Making keyframe…' : (kind === 'speak' ? 'Speaking…' : 'Making video…'); }
            else if (kind === 'keyframe' && unkeying) why = 'Removing the keyframe…';
            else if (kind === 'keyframe') why = kfWhy;
            else if (kind === 'speak') why = spkReason();
            else if (kind === 'video') why = !vid.available ? (vid.reason || 'No video backend yet') : ((!s.image || !s.exists) ? 'Make a keyframe first — the video starts from it' : '');
            if (kind === 'video' && label === d[1]) label += vPrice;   // "Make video · $0.84" (only the idle label carries the price)
            const b = bare(label, 'act-' + kind + (kind === 'video' ? ' primary' : ' secondary'));
            b.setAttribute('data-act', kind);
            const idle = !(resv.has(rk0) || bsy);   // <sb3-r3> Speak all follows the typed text: wired whenever it is not busy, enabled/disabled live on input
            const paintSpeakAll = function () { const w = spkReason(); if (w) { b.disabled = true; b.setAttribute('title', w); b.setAttribute('aria-label', label + ' — ' + w); } else { b.disabled = false; b.setAttribute('title', d[2]); b.setAttribute('aria-label', label); } };
            if (kind === 'speak' && idle) {
              paintSpeakAll();
              lines.forEach(function (l) { const t = fEl.get(s.id + ':line:' + l.lid); if (t) t.addEventListener('input', paintSpeakAll); });
              wireAct(b, kind + ':' + s.id, s.id, function () { ACTIONS[kind](s.id); }, kind);
            }
            else if (why) { b.disabled = true; b.setAttribute('title', why); b.setAttribute('aria-label', label + ' — ' + why); }
            else { b.setAttribute('title', d[2]); wireAct(b, kind + ':' + s.id, s.id, function () { ACTIONS[kind](s.id); }, kind); }   // <lc2b> pointerdown, pending edits of this shot saved first
            acts.appendChild(b);
            if (kind === 'keyframe' && s.image) {   // <lc2b> only the link goes; the file stays in output/ and the Library
              const ub = bare('✕ Remove keyframe', 'act-unkey ghost sm');
              ub.setAttribute('data-act', 'unkey');
              const ubWhy = (bsy || resv.has('keyframe:' + s.id)) ? 'A keyframe is being made' : (unkeyingNow(s.id) ? 'Removing the keyframe…' : '');
              if (ubWhy) { ub.disabled = true; ub.setAttribute('title', ubWhy); ub.setAttribute('aria-label', '✕ Remove keyframe — ' + ubWhy); if (ubWhy === 'Removing the keyframe…') ub.textContent = 'Removing…'; }
              else { ub.setAttribute('title', 'Remove the keyframe from this shot — the image file stays in the Library'); wireAct(ub, 'unkey:' + s.id, s.id, function () { removeKeyframe(s.id); }, 'unkey'); }
              acts.appendChild(ub);
            }
          });
          // R6 video card: [backend select when > 1] · <duration> s · price (the estimate line or free) · the read-only "with sound" line
          const vcard = el('div', 'sb-vcard'), vrow = el('div', 'sb-vrow');
          // <v2-choice> where Make video runs: only when more than one backend is registered (auto = local first, it is free); a backend that is not available is listed greyed with its reason
          { const vc = vcOf(data);
            if (vc && vpick && vpick !== 'auto' && !vc.backends.some(function (x) { return x.id === vpick; })) vpick = null;   // F6.7: a remembered backend that is gone is ignored
            if (vc && vc.backends.length > 1) {
              const costOf = function (b) { const o = (s.video_options || []).find(function (x) { return x.id === b.id; }); if (o && o.estimate && o.estimate.line) return o.estimate.line; return b.gpu ? 'free · local' : (o ? 'free' : ''); };
              const sel = el('select', 'sb-vbackend');
              sel.setAttribute('aria-label', 'Where Make video runs'); sel.setAttribute('title', 'Where Make video runs');
              const addOpt = function (val, text, dis, why) { const o = el('option', null, text); o.setAttribute('value', val); if (dis) o.disabled = true; if (why) o.setAttribute('title', why); sel.appendChild(o); };
              const au = vc.auto ? vc.backends.find(function (x) { return x.id === vc.auto; }) : null;
              addOpt('auto', 'Auto' + (au ? ' — ' + au.label + (costOf(au) ? ' · ' + costOf(au) : '') : ''), false, 'Local first when it is ready (free), otherwise the cloud backend');
              vc.backends.forEach(function (b) { addOpt(b.id, b.label + (b.available ? (costOf(b) ? ' — ' + costOf(b) : '') : ' — not available') + (b.unverified ? ' · ' + UNVERIFIED_TEXT : ''), !b.available, b.available ? (b.unverified ? UNVERIFIED_TIP : '') : b.reason); });   // LC2d: a workflow with status:'unverified' says so
              sel.value = vpick || (vc.choice && vc.choice !== 'auto' && vc.backends.some(function (x) { return x.id === vc.choice; }) ? vc.choice : 'auto');
              sel.addEventListener('change', function () { vpick = sel.value; try { localStorage.setItem('phoenix.storyboard.videoBackend', vpick); } catch (_) {} vconf = null; render(lastData); });
              vrow.appendChild(sel);
            }
            // LC2d (decision 1): the badge next to the selector (also when it is the only backend) when the backend that would run has not finished a run yet
            const ue = vcOf(data) ? vc.backends.find(function (x) { return x.id === vEffId(data); }) : null;
            if (ue && ue.unverified) { const ub2 = el('span', 'sb-vunverified', UNVERIFIED_TEXT); ub2.setAttribute('title', UNVERIFIED_TIP); vrow.appendChild(ub2); }
          }
          vrow.appendChild(el('span', 'sb-vdur', (Number(s.duration_s) || 0) + ' s'));
          vrow.appendChild(el('span', 'sb-cost', !vid.available ? 'not available' : (vEst && vEst.line ? vEst.line : 'free')));
          vcard.appendChild(vrow);
          { const vc = vcOf(data);   // M1.1: ALWAYS one line naming the backend in use, one row per greyed backend with its reason, a jump to where the local one is chosen
            if (vc) {
              const effId = vEffId(data) || (vc.backends[0] && vc.backends[0].id) || '', eb = vc.backends.find(function (x) { return x.id === effId; }) || null;
              const vl = el('div', 'sb-vline', eb ? 'Video: ' + eb.label + (eb.gpu ? ' · local' : ' · cloud') + (eb.available ? '' : ' · not available') : 'Video: not available');
              vcard.appendChild(vl);
              vc.backends.forEach(function (b) { if (b.available === false) vcard.appendChild(el('div', 'sb-vwhy', b.label + ': ' + (b.reason || 'not available'))); });
              if (vc.backends.some(function (b) { return b.gpu; })) {
                const jb = el('button', 'btn btn-ghost btn-sm sb-vjump', 'Change in Workflows ▸ Video'); jb.setAttribute('type', 'button');
                jb.addEventListener('click', function () { if (typeof window.__openWorkflows === 'function') window.__openWorkflows('video'); });
                vcard.appendChild(jb);
              }
            }
          }
          { const va2 = s.video_audio || { on: true, reason: '' }; vcard.appendChild(el('div', 'sb-vsound', 'with sound · ' + (va2.on !== false ? 'on' : 'off' + (va2.reason ? ', ' + va2.reason : '')))); }
          c.appendChild(vcard);
          // LC2f: Stop is shown only for a run that THIS shot has locally (stoppable / a job id) - never because the selector's backend is local (a fal shot's Stop used to cancel another shot's ComfyUI run)
          // LC2d (T8-7): Stop + progress sit in their OWN full-width row above the buttons, built from the server view alone (busy + stoppable / job / a local backend):
          // inside the wrapping button row they could drop to a line below the fold of a narrow panel and read as "no Stop"
          const runningLocal = !!(s.video_busy && (s.video_stoppable || s.video_job != null));
          const runningFal = !!(s.video_busy && !runningLocal);   // LC2i: a fal run has no local id - its Stop posts /video/cancel (stopVideo decides); the paid clip is no longer billed to the end
          if (runningLocal || runningFal) {
            const rr = el('div', 'sb-vrun');
            rr.appendChild(btn('Stop', 'Stop this video', false, function () { stopVideo(s.id); }, 'act-stop secondary act', s.id));
            const pv = el('span', 'sb-vprog', s.video_progress || ''); pv.setAttribute('data-shot', s.id); rr.appendChild(pv);   // progress events patch this node in place
            c.appendChild(rr);
          }
          putAct('acts', acts);
          if (s.video_error) acts.appendChild(errLine(s.video_error));
          if (vconf && vconf.id === s.id && vconf.board === (boardOf(data).id || '')) {   // <lc2a-fal-audio> the inline confirm row
            const row = el('div', 'sb-vconf');
            row.appendChild(el('span', 'sb-vconf-line', vconf.est.line + ' — start this video?'));
            const cb = bare('with sound', 'vconf-audio secondary sm');
            cb.setAttribute('role', 'switch'); cb.setAttribute('aria-checked', vconf.audio ? 'true' : 'false'); cb.disabled = !!vconf.busy;
            cb.addEventListener('click', function () { if (!cb.disabled) vconfToggle(cb.getAttribute('aria-checked') !== 'true'); });
            row.appendChild(cb);
            if (!vconf.audio && vconf.reason) row.appendChild(el('span', 'sb-vconf-why', vconf.reason));
            row.appendChild(btn(vconf.busy ? 'Pricing…' : 'Start', 'Start this video for the price shown', vconf.busy || !!vconf.err, vconfStart, 'vconf-start primary sm act', vconf.id));
            row.appendChild(btn('Cancel', 'Do not make this video', false, vconfCancel, 'vconf-cancel ghost sm act'));
            if (vconf.err) row.appendChild(errLine(vconf.err));
            acts.appendChild(row);
          }
          c.appendChild(acts);
          // LC2d (T8-6): the model's length cap BEFORE the run (the after-clip note stays): the view carries it per backend, the shot's length is the live one
          { const ee2 = vEff(s), cap = (s.video_caps && ee2 && ee2.id) ? Number(s.video_caps[ee2.id]) : 0, dur = Number(s.duration_s) || 0;
            if (cap > 0 && dur - cap >= 0.1 - 1e-9) c.appendChild(el('div', 'sb-hint sb-vcap', 'This model makes up to ' + (Math.round(cap * 10) / 10) + ' s per clip; the shot is ' + dur + ' s.')); }
          // LC2f (T9-1): "Clip sound" - the clip is ONE file; off = every player mutes it (clip.muted). The switch only flips that flag, nothing is re-rendered.
          if (s.clip_sound && typeof s.clip_sound === 'object') {
            const cs = s.clip_sound, row2 = el('div', 'sb-clipsound');
            const cb2 = bare('Clip sound', 'clipsound secondary sm');
            cb2.setAttribute('role', 'switch'); cb2.setAttribute('aria-checked', cs.on === true ? 'true' : 'false');
            const busy2 = actBusy.has('clipsound:' + s.id);
            if (!cs.available || busy2 || s.video_busy) { cb2.disabled = true; cb2.setAttribute('disabled', ''); }
            cb2.setAttribute('aria-label', 'Clip sound');
            const tip2 = !cs.available ? (cs.reason || 'This clip has no separate sound version') : (s.video_busy ? 'A video is being made' : 'Play this shot with the sound the video model made (off = muted)');
            cb2.setAttribute('title', tip2);
            cb2.addEventListener('click', function () {
              if (cb2.disabled) return;
              const want = cb2.getAttribute('aria-checked') !== 'true';
              actBusy.add('clipsound:' + s.id); render(lastData);
              shotAction(s.id, function (sh) { return { url: '/storyboard/shot/clip-sound', method: 'POST', body: { id: sh.id, on: want } }; }, 'acts').then(function () { actBusy.delete('clipsound:' + s.id); render(lastData); });
            });
            row2.appendChild(cb2);
            if (!cs.available && cs.reason) row2.appendChild(el('span', 'sb-hint sb-clipsound-why', cs.reason));
            else if (cs.available && s.video_busy) row2.appendChild(el('span', 'sb-hint sb-clipsound-why', 'A video is being made'));
            c.appendChild(row2);
          }
          if (refs.length && vEffLocal(data)) c.appendChild(el('div', 'sb-hint sb-vrefs', 'References are ignored by the local preview — it starts from the keyframe and the prompt only.'));
          if (s.video_note) c.appendChild(el('div', 'sb-hint sb-vnote', s.video_note));
          if (s.keyframe_busy && s.keyframe_job != null) {   // M4: a reference keyframe run can be stopped (a stopped / timed-out run leaves its line in keyframe_error)
            const kr = el('div', 'sb-kfrun');
            const kb = el('button', 'btn btn-secondary btn-sm sb-kfstop', 'Stop'); kb.setAttribute('type', 'button'); kb.setAttribute('data-act', 'stop-keyframe'); kb.setAttribute('title', 'Stop this keyframe'); kb.setAttribute('aria-label', 'Stop this keyframe');
            kb.addEventListener('click', function () { if (!kb.disabled) { kb.disabled = true; stopKeyframe(s.id); } });
            kr.appendChild(kb); c.appendChild(kr);
          }
          if (kf) {   // <lc2b> what builds the keyframe, said before the click
            const nref = refs.length;
            c.appendChild(el('div', 'sb-kfline', 'Keyframe: ' + (kf.label || 'the active image workflow') + ' · ' + (nref ? nref + (nref === 1 ? ' reference' : ' references') : 'no references (text only)')));
            if (kfTooMany) c.appendChild(el('div', 'sb-hint sb-kfhint', kfWhy));
            else if (nref && kf.mode === 'img2img') c.appendChild(el('div', 'sb-hint sb-kfhint', (kf.label || 'The active image workflow') + ' only restyles one reference — for edits switch the image workflow to Flux Klein.'));
            else if (nref && kf.mode === 'none') c.appendChild(el('div', 'sb-hint sb-kfhint', kfWhy));
          }
          return c;
        }
        function pickerBox(s) {
          const box = el('div', 'sb-picker');
          const head = el('div', 'sb-picker-h');
          head.appendChild(el('strong', null, 'Pick a ' + picker.role + ' from the Library'));
          const fullShot = (s.refs || []).length >= MAX_REFS, role0 = picker.role;
          const disk = btn('From disk…', 'Add a ' + role0 + ' reference from a file on this computer', fullShot, function () { pickFromDisk(s.id, role0); }, 'refdisk secondary sm');
          disk.setAttribute('data-role', role0);
          head.appendChild(disk);
          head.appendChild(btn('Cancel', 'Close the picker', false, function () { picker = null; render(lastData); }, 'picker-cancel ghost sm'));
          box.appendChild(head);
          if (picker.error) { box.appendChild(errLine(picker.error)); return box; }
          if (!picker.items) { box.appendChild(el('div', 'sb-hint', 'Loading images…')); return box; }
          if (!picker.items.length) { box.appendChild(el('div', 'sb-hint', 'No images in the Library yet.')); return box; }
          const groups = new Map();
          picker.items.forEach(function (rec) { const k = groupOfRec(rec); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(rec); });
          groups.forEach(function (items, name) {
            box.appendChild(el('div', 'sb-picker-g', name));
            const grid = el('div', 'sb-picker-grid');
            items.forEach(function (rec) {
              const b = bare('', 'pick ghost sm');
              b.setAttribute('title', String(rec.prompt || rec.path).slice(0, 120));
              b.setAttribute('aria-label', 'Use ' + String(rec.path).split(/[\\/]/).pop());
              b.appendChild(imgOf(rec.url));
              b.addEventListener('click', function () { addRef(s.id, picker ? picker.role : 'prop', rec); });
              grid.appendChild(b);
            });
            box.appendChild(grid);
          });
          return box;
        }
        function topBar(data, shots, selId, oldEls) {
          const bar = el('div', 'sb-head sb-topbar');
          const bk = titleKey(data);
          const serverTitle = boardOf(data).title || '';
          const t0 = oldEls.get(bk);
          const keep = !!t0 && t0.value !== fBase.get(bk) && t0.value !== fSent.get(bk) && t0.value !== serverTitle;
          if (!keep) fBase.set(bk, serverTitle);
          const ti = el('input', 'sb-board-title');
          ti.setAttribute('type', 'text');
          ti.setAttribute('aria-label', 'Board title (click to rename)');
          ti.value = keep ? t0.value : serverTitle;
          if (fErr.has(bk) && ti.value === serverTitle) fErr.delete(bk);
          fEl.set(bk, ti);
          ti.addEventListener('blur', function () { saveBoardTitle(); });
          ti.addEventListener('keydown', function (e) { if (e && e.key === 'Enter') { if (e.preventDefault) e.preventDefault(); saveBoardTitle(); } });
          bar.appendChild(ti);
          const bs = el('select', 'sb-boardsel');
          bs.setAttribute('aria-label', 'Storyboard');
          boardSel = bs;
          fillBoardSelect(bs);
          ['focus', 'mouseenter'].forEach(function (ev) { bs.addEventListener(ev, function () { ensureBoards(); }); });
          bs.addEventListener('change', function () { if (bs.value === '__new') newBoard(); else activateBoard(bs.value); });
          bar.appendChild(bs);
          bar.appendChild(el('span', 'sb-count', shots.length + (shots.length === 1 ? ' shot' : ' shots') + ' · ' + fmt(totalOf(shots)) + ' s'));
          const cast = castOf(data);
          const cb = btn('Cast (' + cast.length + ')', 'Edit the cast of this board', false, function () { castOpen = !castOpen; if (castOpen) ensureVoices(); render(lastData); }, 'castbtn secondary sm');
          cb.setAttribute('aria-expanded', castOpen ? 'true' : 'false');
          bar.appendChild(cb);
          return bar;
        }
        function viewSwitch(shots, selId) {   // ① References · ② Keyframe · ③ Clip (disabled "not yet" without a clip)
          const vg = el('div', 'sb-views');
          vg.setAttribute('role', 'group'); vg.setAttribute('aria-label', 'Shot shows');
          if (!shots.length) return vg;
          const si = shots.findIndex(function (s) { return s.id === selId; });
          const sel = si >= 0 ? shots[si] : shots[0];
          [['refs', '① References'], ['key', '② Keyframe'], ['clip', '③ Clip']].forEach(function (d) {
            const dis = d[0] === 'clip' && statusOf(sel) !== 'video';
            const on = !dis && view === d[0];
            const b = bare(dis ? '③ Clip · not yet' : d[1], 'view secondary sm');
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
            b.setAttribute('data-view', d[0]);
            if (dis) { b.disabled = true; b.setAttribute('title', 'No clip yet'); }
            b.addEventListener('click', function () { if (b.disabled) return; view = d[0]; render(lastData); });
            vg.appendChild(b);
          });
          return vg;
        }
        function castPanel(data) {
          const box = el('div', 'sb-cast');
          box.appendChild(el('div', 'sb-sec-h', 'Cast — the characters who speak in this board (name → voice)'));
          const cvNow = castVoices();
          const noVoices = voices !== null && !cvNow.packs.length && !cvNow.cb.length;
          (castDraft || []).forEach(function (r, i) {
            const row = el('div', 'sb-castrow');
            const nm = el('input', 'sb-cast-name');
            nm.setAttribute('type', 'text');
            nm.setAttribute('placeholder', 'Name');
            nm.setAttribute('aria-label', 'Character name');
            nm.value = r.name;
            castEls[i] = nm;
            if (engineUnknown(r)) { nm.readOnly = true; nm.setAttribute('readonly', ''); nm.setAttribute('title', 'unknown voice engine — pick a voice for it first to edit this row'); }   // <sb3-r3> the stored row is kept as it is; a rename would be refused and stick the draft
            nm.addEventListener('input', function () { if (engineUnknown(r)) { nm.value = r.name; return; } r.name = nm.value; });
            nm.addEventListener('blur', function () { if (engineUnknown(r)) return; r.name = nm.value; saveCast(); });
            nm.addEventListener('keydown', function (e) { if (e && e.key === 'Enter') { if (e.preventDefault) e.preventDefault(); if (engineUnknown(r)) return; r.name = nm.value; saveCast(); } });
            row.appendChild(nm);
            const vs = el('select', 'sb-cast-voice');
            vs.setAttribute('aria-label', 'Voice of ' + (r.name || 'this character'));
            vs.castRow = r;
            fillCastVoice(vs, r);
            ['focus', 'mouseenter'].forEach(function (ev) { vs.addEventListener(ev, function () { ensureVoices(); }); });
            vs.addEventListener('change', function () {
              const v = vs.value;
              if (v === '__unknown') return;   // the unknown-engine entry is only a label: nothing to change
              if (v.indexOf('chatterbox:') === 0) { r.engine = 'chatterbox'; r.reference = v.slice(11); r.voice = ''; }
              else { r.engine = 'crispasr'; r.voice = v; r.reference = ''; }
              saveCast();
            });
            voiceSels.push(vs);
            row.appendChild(vs);
            if (noVoices && !castVal(r)) row.appendChild(el('span', 'sb-hint sb-novoices', 'No voices yet — add a CrispASR server or turn on voice engines in Settings → Voice engines.'));
            row.appendChild(btn('✕', 'Remove ' + (r.name || 'character') + ' from the cast', false, function () { castDraft.splice(i, 1); saveCast(); render(lastData); }, 'cast-remove ghost sm'));
            if (engineUnknown(r)) row.appendChild(el('span', 'sb-hint sb-unkeng', 'unknown engine'));
            else if (String(r.name || '').trim() && r.engine !== 'chatterbox' && !r.voice) row.appendChild(el('span', 'sb-hint', 'no voice yet'));
            else if (String(r.name || '').trim() && r.engine === 'chatterbox' && !r.reference && voiceMode === 'local') row.appendChild(el('span', 'sb-hint', 'no voice yet'));
            else { const cv2 = (Array.isArray(data && data.cast) ? data.cast : []).find(function (x) { return x && x.name === String(r.name || '').trim(); }); if (cv2 && cv2.available === false && cv2.reason && castVal(r)) row.appendChild(el('span', 'sb-hint sb-castwhy', cv2.reason)); }   // <sb3> a saved voice that cannot be used right now says why
            box.appendChild(row);
          });
          const addB = btn('+ Character', 'Add a character to the cast', (castDraft || []).length >= MAX_CAST, function () { castDraft.push({ name: '', engine: 'crispasr', voice: '', reference: '' }); render(lastData); }, 'castadd secondary sm');
          box.appendChild(addB);
          if (castErr) box.appendChild(errLine(castErr));
          return box;
        }
        function tileOf(s, i, selId) {
          const st = statusOf(s);
          const t = bare('', 'tile ghost sm');
          t.setAttribute('data-shot', s.id);
          t.setAttribute('data-status', st);
          t.setAttribute('aria-label', 'Shot ' + (i + 1) + ' · ' + (Number(s.duration_s) || 0) + ' s' + (s.title ? ' · ' + s.title : '') + ' · ' + (STATUS_TEXT[st] || st));
          if (s.id === selId) t.setAttribute('aria-current', 'true');
          t.style.flexGrow = String(Number(s.duration_s) || 1);
          const th = el('div', 'sb-thumb');
          if (!s.image) th.textContent = 'no image';
          else if (!s.exists || !s.url) th.textContent = 'missing';
          else th.appendChild(imgOf(s.url));
          t.appendChild(th);
          t.appendChild(el('span', 'sb-tilelbl', (i + 1) + ' · ' + (Number(s.duration_s) || 0) + ' s'));
          if (s.title) t.appendChild(el('span', 'sb-tiletitle', s.title));
          const dot = el('span', 'sb-dot ' + st);
          dot.setAttribute('title', STATUS_TEXT[st] || st);
          t.appendChild(dot);
          t.addEventListener('click', function () { selectedId = s.id; render(lastData); });
          tileEls.set(s.id, t);
          return t;
        }
        function undoSlot() {   // directly above the tiles; its height is reserved, so showing / hiding the row moves nothing
          const slot = el('div', 'sb-undoslot');
          const u = el('div', 'sb-undo');
          u.setAttribute('role', 'status');
          if (undo && undo.board === (boardOf(lastData).id || '')) {
            u.appendChild(el('span', null, 'Shot ' + undo.n + ' removed — '));
            const ub = bare('Undo', 'undo secondary sm');
            if (undo.busy) ub.disabled = true;
            ub.addEventListener('click', function () { if (!ub.disabled) undoRemove(); });
            u.appendChild(ub);
          } else { u.hidden = true; u.setAttribute('hidden', ''); }
          slot.appendChild(u);
          return slot;
        }
        function strip(shots, selId) {
          const row = el('div', 'sb-striprow');
          row.appendChild(el('span', 'sb-lanelbl'));
          const tiles = el('div', 'sb-strip');
          shots.forEach(function (s, i) { tiles.appendChild(tileOf(s, i, selId)); });
          row.appendChild(tiles);
          const add = bare('+ Shot', 'add secondary sm');
          add.addEventListener('click', function () { addShot(); });
          row.appendChild(add);
          return row;
        }
        function lane(label, shots, tot, pick) {
          const row = el('div', 'sb-lanerow');
          row.appendChild(el('span', 'sb-lanelbl', label));
          const track = el('div', 'sb-lane');
          shots.forEach(function (s) {
            const b = pick(s);
            if (!b) return;
            const blk = el('span', 'sb-blk ' + b.cls, b.text);
            blk.style.left = ((Number(s.start_s) || 0) / tot * 100).toFixed(4) + '%';
            blk.style.width = ((Number(s.duration_s) || 0) / tot * 100).toFixed(4) + '%';
            blk.setAttribute('title', b.title || b.text);
            track.appendChild(blk);
          });
          row.appendChild(track);
          row.appendChild(el('span', 'sb-lanepad'));
          return row;
        }
        // <sb3> the Voice lane: one block per line, in order, inside the shot's span (a take's length when known, else ~1 s); ♪ = the line has a take
        function voiceLane(shots, tot) {
          const row = el('div', 'sb-lanerow');
          row.appendChild(el('span', 'sb-lanelbl', 'Voice'));
          const track = el('div', 'sb-lane');
          shots.forEach(function (s) {
            const all = linesOf(s), shown = all.filter(function (l) { return !!lineSub(l); });
            if (!shown.length) return;
            const start = Number(s.start_s) || 0, dur = Number(s.duration_s) || 0;
            let used = 0, W = 0;
            all.forEach(function (l) { used += (Number(l.gap_s) || 0) + ((l.takeExists && Number(l.take_s) > 0) ? Number(l.take_s) : 0); });   // known take seconds + gaps
            const lenOf = function (l) { return (l.takeExists && Number(l.take_s) > 0) ? Number(l.take_s) : 1; };   // a line without a take counts ~1 s
            shown.forEach(function (l) { W += (Number(l.gap_s) || 0) + lenOf(l); });
            let at = 0;
            shown.forEach(function (l) {   // the lines share the shot's span in proportion to (pause + length): they always sit inside it, a lone line fills it
              at += Number(l.gap_s) || 0;
              const from = dur * at / W, w = dur * lenOf(l) / W;
              at += lenOf(l);
              const take = !!l.takeExists;
              const blk = el('span', 'sb-blk voice ' + (take ? 'solid' : 'outline'), (take ? '♪ ' : '') + lineSub(l));
              blk.setAttribute('data-lid', l.lid);
              blk.style.left = ((start + from) / tot * 100).toFixed(4) + '%';
              blk.style.width = (w / tot * 100).toFixed(4) + '%';
              blk.setAttribute('title', take ? 'take ready — click Play board to hear it' : lineSub(l));
              track.appendChild(blk);
            });
            if (used > dur + 1e-9) {
              const wn = el('span', 'sb-lanewarn', '⚠ lines longer than the shot');
              wn.style.left = (start / tot * 100).toFixed(4) + '%';
              wn.style.width = (dur / tot * 100).toFixed(4) + '%';
              wn.setAttribute('title', 'The takes and pauses of this shot add up to ' + (Math.round(used * 10) / 10) + ' s, the shot is ' + dur + ' s');
              track.appendChild(wn);
            }
          });
          row.appendChild(track);
          row.appendChild(el('span', 'sb-lanepad'));
          return row;
        }
        function render(data) {
          const root = curRoot;
          if (!root) return;
          const shots = (data && Array.isArray(data.shots)) ? data.shots : [];
          const prevEls = fEl, prevDesc = fDesc, prevTa = taById, prevData = renderedData;
          const rBid = boardOf(data).id || '';
          let back = null;   // coming back to a board that was parked: its typed text is still there
          if (curBoardId !== null && rBid !== curBoardId) {
            if (prevData && (boardOf(prevData).id || '') === curBoardId) { parked.set(curBoardId, { data: prevData, fEl: prevEls, fDesc: prevDesc, ta: prevTa }); if (parked.size > 8) parked.delete(parked.keys().next().value); }
            back = parked.get(rBid) || null;
            if (back) { parked.delete(rBid); taById = new Map(Array.from(back.ta).concat(Array.from(taById))); }
          }
          // focus + caret of the text field the user is in
          let focusId = null, focusKey = null, castFocus = -1, selStart = null, selEnd = null;
          const act0 = doc.activeElement;
          if (act0) {
            taById.forEach(function (t, id) { if (t === act0) { focusId = id; selStart = t.selectionStart; selEnd = t.selectionEnd; } });
            fEl.forEach(function (t, key) { if (t === act0) { focusKey = key; selStart = t.selectionStart; selEnd = t.selectionEnd; } });
            castEls.forEach(function (t, i) { if (t === act0) { castFocus = i; selStart = t.selectionStart; selEnd = t.selectionEnd; } });
          }
          // what each card shows: the user's text while it differs from what the server had before (unsent / still typing), else the server's text
          const texts = new Map();
          shots.forEach(function (s) {
            const sp = s.prompt || '';
            const t = taById.get(s.id);
            // the user's text stays only while it differs from the server's text AND from what the last accepted save sent (= typed since);
            // focus is not ownership: just-saved text follows the server even while the cursor is in it (e.g. the 2000-char cut)
            const keep = !!t && t.value !== base.get(s.id) && t.value !== sentOk.get(s.id) && t.value !== sp;   // edited since that render, and not just-saved text
            texts.set(s.id, keep ? t.value : sp);
            if (!keep) base.set(s.id, sp);
          });
          const ids = new Set(shots.map(function (s) { return s.id; }));
          const keepIds = new Set(ids);   // ids of parked boards keep their drafts / errors too
          parked.forEach(function (p) { (p.data.shots || []).forEach(function (s) { keepIds.add(s.id); }); });
          [promptErr, actErr, actSec, pendingDur, sentOk, base].forEach(function (m) { Array.from(m.keys()).forEach(function (id) { if (!keepIds.has(id)) m.delete(id); }); });
          [fBase, fSent, fErr].forEach(function (m) { Array.from(m.keys()).forEach(function (k) { if (k.charAt(0) !== '#' && !keepIds.has(k.slice(0, k.indexOf(':')))) m.delete(k); }); });
          if (picker && !ids.has(picker.id)) picker = null;
          if (helpFor && !ids.has(helpFor)) helpFor = null;
          if (rmFor && !ids.has(rmFor)) rmFor = null;
          if (tagUi.shot && !ids.has(tagUi.shot)) tagUi = { shot: null, mode: '', tag: '', draft: '', err: '' };
          if (undo) {   // the Undo row mirrors the server: same board, same shot, same index - else the server can no longer undo it
            const su = data && data.undo;
            if (undo.board !== (boardOf(data).id || '') || !su || su.shot !== undo.shot || su.at !== undo.at) undo = null;
          }
          taById = new Map();
          shots.forEach(function (s) { if (promptErr.has(s.id) && texts.get(s.id) === (s.prompt || '')) promptErr.delete(s.id); });   // reverted to the server text: the error is moot
          const bidNow = boardOf(data).id || '';
          if (bidNow !== curBoardId) {   // another board: its cast draft, picker and title draft are not carried over
            curBoardId = bidNow; castDraft = null; castSent = null; castErr = ''; picker = null; helpFor = null; rmFor = null; undo = null; tagUi = { shot: null, mode: '', tag: '', draft: '', err: '' };
            [fBase, fSent, fErr].forEach(function (m) { Array.from(m.keys()).forEach(function (k) { if (k.charAt(0) === '#') m.delete(k); }); });
          }
          // the cast draft follows the server unless the user changed it (an unsent edit, a blank row, or what the last save sent)
          const serverCast = castClean(castOf(data));
          if (castDraft === null || !(castDraft.some(function (r) { return !String(r.name || '').trim(); }) || (!sameJson(castClean(castDraft), serverCast) && !sameJson(castClean(castDraft), castSent)))) {
            castDraft = castOf(data).map(function (c) { return { name: c.name, engine: c.engine || 'crispasr', voice: c.voice || '', reference: c.reference || '' }; });
          }
          const oldEls = back ? new Map(Array.from(back.fEl).concat(Array.from(fEl))) : fEl;
          fEl = new Map(); fDesc = new Map(); popEls = []; voiceSels = []; sfxSels = []; tileEls = new Map(); castEls = [];
          const selId = shots.length ? curSelected(shots) : null;
          if (selId) selectedId = selId;
          if (selId && view === 'clip' && statusOf(shots.find(function (s) { return s.id === selId; })) !== 'video') view = 'key';   // the shown view and the highlighted one stay the same
          // <lc2b> the rebuild must not move what the user is looking at: the inspector (same shot) and the strip keep their scroll, the page keeps its height meanwhile
          const oldInsp = root.querySelector ? root.querySelector('.sb-inspector') : null, oldStrip = root.querySelector ? root.querySelector('.sb-strip') : null;
          const inspTop = (oldInsp && selId === scrollSel) ? (Number(oldInsp.scrollTop) || 0) : 0, stripLeft = oldStrip ? (Number(oldStrip.scrollLeft) || 0) : 0;
          const holdH = Number(root.offsetHeight) || 0;
          if (holdH && root.style) root.style.minHeight = holdH + 'px';
          scrollSel = selId;
          wantFocus = null;
          root.textContent = '';
          root.appendChild(topBar(data, shots, selId, oldEls));
          if (fErr.has(titleKey(data))) root.appendChild(errLine(fErr.get(titleKey(data))));
          if (castOpen) root.appendChild(castPanel(data));
          if (errText) root.appendChild(errLine(errText));
          pvBox = null; clockEl = null; playBtn = null;
          const caretTo = function (t) {
            try { if (t.focus) t.focus({ preventScroll: true }); } catch (_) {}   // <lc2b-r2> focusing must not scroll the page/inspector back to the field
            try { if (t.setSelectionRange && selStart != null) { const len = String(t.value).length; t.setSelectionRange(Math.min(selStart, len), Math.min(selEnd, len)); } } catch (_) {}   // clamped to the new length
          };
          const restoreFocus = function () {
            if (focusId && taById.has(focusId)) caretTo(taById.get(focusId));
            else if (focusKey && fEl.has(focusKey)) caretTo(fEl.get(focusKey));
            else if (castFocus >= 0 && castEls[castFocus]) caretTo(castEls[castFocus]);
          };
          const main = el('div', 'sb-main');   // <lc2b> an empty board keeps the whole workbench frame (preview with the empty text + "+ Shot", transport, lanes, strip)
          const left = el('div', 'sb-left');
          left.appendChild(viewSwitch(shots, selId));
          pvBox = el('div', 'sb-preview');
          left.appendChild(pvBox);
          const tr = el('div', 'sb-transport');
          playBtn = bare('Play board', 'play primary sm');
          playBtn.setAttribute('aria-label', 'Play board');
          playBtn.addEventListener('click', function () { playBoard(); });
          clockEl = el('span', 'sb-clock');
          tr.setAttribute('title', shots.length ? 'Animatic: keyframes held, clips where ready, voice + SFX laid under' : 'No shots');
          tr.appendChild(playBtn); tr.appendChild(clockEl);
          const exb = bare('Export board as video', 'export secondary sm');
          exb.setAttribute('title', shots.length ? 'Render this board as one MP4: the animatic, with its voice and sound' : 'No shots');
          if (!shots.length) { exb.disabled = true; exb.setAttribute('data-noshots', 'true'); }   // the export controller keeps it disabled meanwhile it also disables Export while a job runs
          exb.addEventListener('click', function () { if (!exb.disabled && deps.exportBoard) deps.exportBoard(boardOf(lastData).id || ''); });
          tr.appendChild(exb);
          const exs = bare('Stop export', 'export-stop secondary sm');
          exs.setAttribute('data-export-stop', ''); exs.hidden = true; exs.setAttribute('hidden', '');   // the export controller shows it while an export runs
          tr.appendChild(exs);
          const est = el('span', 'sb-exportst'); est.setAttribute('data-export-status', ''); est.setAttribute('role', 'status');
          tr.appendChild(est);
          { const wl = el('ul', 'sb-exp-warnings'); wl.setAttribute('data-export-warnings', ''); wl.hidden = true; wl.setAttribute('hidden', ''); tr.appendChild(wl); }   // M1.2: the export controller fills it from the last result
          left.appendChild(tr);
          main.appendChild(left);
          let insp = null;
          if (shots.length) {
            insp = el('div', 'sb-inspector');
            shots.forEach(function (s, i) { insp.appendChild(pane(s, i, shots.length, texts.get(s.id), s.id === selId, oldEls, data)); });
            main.appendChild(insp);
          }
          root.appendChild(main);
          Array.from(fErr.keys()).forEach(function (k) { if (k.charAt(0) !== '#' && ids.has(k.slice(0, k.indexOf(':'))) && !fEl.has(k)) fErr.delete(k); });   // <lc2b-r3> an error of a field that no longer exists (a removed reference) is gone with it
          if (insp && inspTop) insp.scrollTop = inspTop;
          root.appendChild(undoSlot());
          const newStrip = strip(shots, selId);
          root.appendChild(newStrip);
          const stripTiles = newStrip.querySelector ? newStrip.querySelector('.sb-strip') : null;
          if (stripTiles && stripLeft) stripTiles.scrollLeft = stripLeft;
          const tot = totalOf(shots) || 1;
          root.appendChild(voiceLane(shots, tot));
          root.appendChild(lane('SFX', shots, tot, function (s) {
            const x = s.sound || {};
            const text = String(x.text || '').trim() || (x.clip ? String(x.clip) : '');
            return text ? { text: text, cls: 'sfx' } : null;
          }));
          const lg = el('div', 'sb-legend');
          [['draft', 'draft'], ['keyframe', 'keyframe ok'], ['video', 'video ok']].forEach(function (d) {
            const it = el('span', 'sb-legend-i'); it.appendChild(el('span', 'sb-dot ' + d[0])); it.appendChild(el("span", null, d[1])); lg.appendChild(it);
          });
          root.appendChild(lg);
          renderedData = data;
          paintPreview(); paintTransport(); markPlaying();
          restoreFocus();
          if (insp && inspTop) insp.scrollTop = inspTop;   // <lc2b-r2> again AFTER the focus restore (belt and braces: a focus() that scrolls cannot win)
          if (stripTiles && stripLeft) stripTiles.scrollLeft = stripLeft;
          if (holdH && root.style) root.style.minHeight = '';
          if (wantFocus && wantFocus.el) { try { if (wantFocus.el.focus) wantFocus.el.focus({ preventScroll: true }); } catch (_) {} }   // the inline Cancel / tag field of the row just opened
          wantFocus = null; focusOnce = false;
          if (typeof window !== 'undefined' && window.__animaticExport && window.__animaticExport.paint) { try { window.__animaticExport.paint(); } catch (_) {} }   // R6: the fresh status / Stop nodes show the export's state
        }
        let loading = false;
        function load(root, soft) {
          curRoot = root;
          loading = true;
          if (!soft) { stopAnim(false); sfxClips = null; boardsList = null; rmFor = null; }   // r2-B4: the Undo survives a load (workspace switch); render() clears it when the loaded board differs from undo.board. asked for again (once) when a select is next used; a soft reload (a keyframe/video ended) leaves the animatic and the lists alone
          return enqueue({
            key: 'get',
            build: function () { errText = ''; return { url: '/storyboard', method: 'GET' }; },
            done: function (res) {
              loading = false;
              if (res.error) {
                if (lastData) { errText = 'Could not load: ' + res.error; render(lastData); return; }   // a failed reopen keeps the board (cards, drafts, focus) on screen
                root.textContent = ''; root.appendChild(el('div', 'sb-err', 'Could not load: ' + res.error)); return;
              }
              lastData = res.data;
              if (res.data && res.data.error) errText = res.data.error;   // the board file could not be read: shown, nothing will be changed
              render(lastData);
              if (api.onBoard) { try { api.onBoard(boardOf(lastData).title || ''); } catch (_) {} }   // the page repaints the Library's Use label from this (no second request)
            },
          });
        }
        // stop(): the animatic ends when the user leaves the tab (the page calls this from switchTab)
        // R6: open a shot of a board (Audio desk "Open in Story"): the board is activated through the queue when it is not the shown one, then the shot is selected
        async function openShot(boardId, shotId) {
          if (!curRoot && deps.root) curRoot = deps.root;
          if (!curRoot) return;
          if (!lastData) await load(curRoot);
          if (!lastData) return;
          if (boardId && boardId !== (boardOf(lastData).id || '')) await activateBoard(boardId);
          if (shotIndex(shotId) >= 0) { selectedId = shotId; render(lastData); }
        }
        const api = { load: load, serverEvent: serverEvent, jobState: jobState, render: render, openShot: openShot, boardId: function () { return boardOf(lastData).id || ''; }, stop: function () { stopAnim(); }, title: function () { return boardOf(lastData).title || ''; }, loading: function () { return loading; }, onBoard: null, later: null };
        return api;
      }
const storyboardTab = makeStoryboardTab({ fetch: function (u, o) { return fetch(u, o); }, document: document, root: document.getElementById('sb-root'), exportBoard: function (b) { return window.__animaticExport ? window.__animaticExport.start(b) : Promise.resolve(); } });
      storyboardTab.onBoard = function (t) { imagesTab.refreshUse(); if (typeof shellRender === 'function') shellRender(); };   // R6: the Use label AND the top bar's crumb (Story / <board title>) follow the board
      window.__storyCrumb = function () { return storyboardTab.title(); };
      window.__storyOpen = function (boardId, shotId) { return storyboardTab.openShot(boardId, shotId).then(function () { switchTab('storyboard'); }); };   // R6: Audio desk "Open in Story"
      storyboardTab.openVideo = function (o) { setArtifact({ slot: 'video', url: o.url, path: o.path, muted: o.muted === true, board: o.board || '', shot: o.shot || '', source: 'storyboard' }); };   // v1.10 VP1: ③ Clip -> Open in Video tab (set outside the region, like onBoard)
      // </v1-storyboard>
      // <lc2b-take-timer>
      storyboardTab.later = function (f, ms) { return setTimeout(f, ms); };   // the one-shot timer of the "Take ready" note (~3 s), kept outside the timer-free storyboard region
      // </lc2b-take-timer>
      // <v1b-boards> Library > Tools > Storyboards (v1.10 V1b-1): the boards under their group headers (ungrouped last), each row
      // Open (activate + Storyboard tab) / Rename / Group / Trash (no confirm: the row says "Moved to trash" for 3 s with an Undo).
      // The Library only STORES boards - no shot editing here. Loaded when opened, no polling; one request at a time; all text via
      // textContent. deps: { fetch, document, switchTab, setTimeout?, clearTimeout? } so a suite can drive it on a fake DOM.
      function makeStoryboardsTab(deps) {
        const doc = deps.document;
        const setT = deps.setTimeout || function (f, ms) { return setTimeout(f, ms); };
        const clearT = deps.clearTimeout || function (h) { return clearTimeout(h); };
        const UNDO_MS = 3000;
        const DL_ID = 'sb-groups-datalist';
        function el(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
        let root = null, boards = [], groups = [], active = '', errText = '';
        const trashed = new Map();   // board id -> { title, group, timer } : rows showing "Moved to trash" + Undo
        let chain = Promise.resolve();   // one request at a time
        function queue(fn) { const p = chain.then(fn, fn); chain = p.catch(function () {}); return p; }
        async function call(url, body) {
          try {
            const r = await deps.fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            let j = null;
            try { j = await r.json(); } catch (_) {}
            if (r && r.ok && j && Array.isArray(j.boards)) { boards = j.boards; groups = Array.isArray(j.groups) ? j.groups : []; active = j.active || ''; errText = ''; return true; }
            errText = (j && j.error) || ('HTTP ' + (r && r.status));
          } catch (err) { errText = (err && err.message) || String(err); }
          return false;
        }
        function btn(label, fn, title) {
          const b = el('button', 'lib-add-btn', label);
          b.setAttribute('type', 'button');
          if (title) b.setAttribute('title', title);
          b.addEventListener('click', function () { Promise.resolve(fn()).catch(function () {}); });
          return b;
        }
        // an inline text field: Enter / blur saves (once), Escape cancels; an unchanged value sends nothing
        function inlineField(host, value, listId, save) {
          const inp = el('input', 'sb-lib-input');
          inp.setAttribute('type', 'text');
          inp.value = value;
          if (listId) inp.setAttribute('list', listId);
          let done = false;
          const finish = function (commit) {
            if (done) return; done = true;
            const v = String(inp.value);
            if (commit && v.trim() !== value) save(v.trim()); else render();
          };
          inp.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault && e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') finish(false);
          });
          inp.addEventListener('blur', function () { finish(true); });
          host.textContent = '';
          host.appendChild(inp);
          try { inp.focus(); } catch (_) {}
        }
        function secs(t) { return String(Math.round((Number(t) || 0) * 10) / 10); }
        function rowFor(b) {
          const row = libTile({ kind: 'storyboard', name: b.title, poster: b.poster, placeholder: 'No keyframe yet', meta: b.shots + ' shot' + (b.shots === 1 ? '' : 's') + ' \u00B7 ' + secs(b.total_s) + ' s' });
          const acts = row.querySelector('.lib-tile-actions');
          row.setAttribute('data-board', b.id);
          if (b.id === active) row.classList.add('active');
          const name = row.querySelector('.lib-tile-name'), meta = row.querySelector('.lib-tile-meta');
          acts.appendChild(btn('Open', function () {
            return queue(async function () {
              if (await call('/storyboards/activate', { id: b.id })) { render(); if (deps.switchTab) deps.switchTab('storyboard'); } else render();
            });
          }, 'Open this storyboard'));
          acts.appendChild(btn('Rename', function () {
            inlineField(name, b.title, null, function (v) {
              if (!v) { render(); return; }
              queue(async function () { await call('/storyboards/update', { id: b.id, title: v }); render(); });
            });
          }));
          acts.appendChild(btn('Group', function () {
            inlineField(meta, b.group || '', DL_ID, function (v) {
              queue(async function () { await call('/storyboards/update', { id: b.id, group: v }); render(); });
            });
          }, 'Put this storyboard in a group'));
          acts.appendChild(btn('Trash', function () {
            return queue(async function () {
              if (await call('/storyboards/trash', { id: b.id })) {
                const h = setT(function () { trashed.delete(b.id); render(); }, UNDO_MS);
                trashed.set(b.id, { title: b.title, group: b.group || '', timer: h });
                try { if (typeof libraryPage !== 'undefined' && libraryPage) libraryPage.noteChange('storyboards'); } catch (_) {}   // F4: count + Trash follow
              }
              render();
            });
          }, 'Move to trash (Undo stays for 3 s)'));
          return row;
        }
        function trashedRow(id, t) {
          const row = el('div', 'sb-lib-row trashed');
          row.setAttribute('data-board-trashed', id);
          row.appendChild(el('span', 'sb-lib-title', t.title));
          row.appendChild(el('span', 'sb-lib-meta', 'Moved to trash'));
          row.appendChild(btn('Undo', function () {
            return queue(async function () {
              clearT(t.timer);
              if (await call('/storyboards/restore', { id: id })) { trashed.delete(id); try { if (typeof libraryPage !== 'undefined' && libraryPage) libraryPage.noteChange('storyboards'); } catch (_) {} }   // the row stays until the restore really worked
              else t.timer = setT(function () { trashed.delete(id); render(); }, UNDO_MS);
              render();
            });
          }));
          return row;
        }
        function render() {
          if (!root) return;
          root.textContent = '';
          const bar = el('div', 'lib-addbar');
          bar.appendChild(btn('+ New storyboard', function () {
            return queue(async function () { await call('/storyboards/create', {}); render(); });
          }));
          root.appendChild(bar);
          if (errText) { const e = el('div', 'lib-adderr', errText); e.setAttribute('role', 'alert'); root.appendChild(e); }
          const dl = el('datalist'); dl.setAttribute('id', DL_ID);
          groups.forEach(function (g) { const o = el('option'); o.setAttribute('value', g); dl.appendChild(o); });
          root.appendChild(dl);
          const names = groups.slice();
          trashed.forEach(function (t) { if (t.group && names.indexOf(t.group) < 0) names.push(t.group); });
          names.push('');   // ungrouped last
          names.forEach(function (g) {
            const rows = boards.filter(function (b) { return (b.group || '') === g; }).map(rowFor);
            trashed.forEach(function (t, id) { if (t.group === g) rows.push(trashedRow(id, t)); });
            if (!rows.length) return;
            const box = el('div', 'sb-lib-group');
            box.setAttribute('data-sbgroup', g);
            box.appendChild(el('div', 'lib-folder-name', g || 'Ungrouped'));
            const grid = el('div', 'lib-tile-grid');
            rows.forEach(function (r) { grid.appendChild(r); });
            box.appendChild(grid);
            root.appendChild(box);
          });
          if (!boards.length && !trashed.size) root.appendChild(el('div', 'lib-empty', 'No storyboards yet.'));
        }
        function load(rootEl) {
          root = rootEl;
          return queue(async function () { await call('/storyboards'); render(); });
        }
        return { load: load, render: render };
      }
      const storyboardsTab = makeStoryboardsTab({ fetch: function (u, o) { return fetch(u, o); }, document: document, switchTab: function (t) { switchTab(t); } });
      // </v1b-boards>
      // <l1-library> Sound (= voice takes) and SFX clips: file name, date, size, <audio controls preload="none">; one listing route each
      function makeAudioTab(deps) {
        const doc = deps.document;
        function el(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
        function fmtSize(b) { b = Number(b) || 0; return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
        function fmtDate(ms) { const d = new Date(Number(ms) || 0); return isNaN(d.getTime()) ? '' : d.toLocaleString(); }
        async function load(listUrl, openUrl, openBody, root, emptyText) {
          let items = [];
          try {
            const r = await deps.fetch(listUrl);
            if (!r.ok) { if (audioPlaying(root)) return; root.textContent = ''; root.appendChild(el('div', 'lib-empty', 'Could not load (HTTP ' + r.status + ').')); return; }
            const j = await r.json();
            items = (j && Array.isArray(j.items)) ? j.items : [];
          } catch (err) { if (audioPlaying(root)) return; root.textContent = ''; root.appendChild(el('div', 'lib-empty', 'Could not load: ' + ((err && err.message) || String(err)))); return; }
          if (audioPlaying(root)) return;   // <lt2-a1> a take started while the GET was pending is not cut off by the response
          try { if (typeof libraryPage !== 'undefined' && libraryPage) libraryPage.noteChange(/sfx/.test(String(listUrl)) ? 'sfx' : 'sound'); } catch (_) {}
          root.textContent = '';
          const bar = el('div', 'lib-addbar');
          const open = el('button', 'lib-add-btn', 'Open folder');
          open.setAttribute('type', 'button');
          open.addEventListener('click', function () {
            Promise.resolve(deps.fetch(openUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(openBody || {}) })).catch(function () {});
          });
          bar.appendChild(open);
          root.appendChild(bar);
          if (!items.length) { root.appendChild(el('div', 'lib-empty', emptyText)); return; }
          // F1.3: the first 100 rows, then "Show more" appends the next 100 without a reload (1200+ takes would be 1200 <audio> elements)
          const PAGE = 100, listBox = el('div'), moreBox = el('div'); let shown = 0;
          const drawMore = function () {
            items.slice(shown, shown + PAGE).forEach(function (it) {
              const row = el('div', 'lib-audio-item lib-list-row');
              row.appendChild(el('div', 'lib-audio-meta', String(it.label || it.file) + ' \u00B7 ' + fmtDate(it.mtime) + ' \u00B7 ' + fmtSize(it.bytes)));
              const a = el('audio');
              a.setAttribute('controls', '');
              a.setAttribute('preload', 'none');
              a.setAttribute('src', String(it.url));
              row.appendChild(a);
              listBox.appendChild(row);
            });
            shown = Math.min(items.length, shown + PAGE);
            moreBox.textContent = '';
            if (shown < items.length) {
              const more = el('button', 'btn btn-secondary btn-sm', 'Show more (' + (items.length - shown) + ' left)');
              more.setAttribute('type', 'button'); more.setAttribute('data-lib-more', '');
              more.addEventListener('click', drawMore);
              moreBox.appendChild(more);
            }
          };
          root.appendChild(listBox); root.appendChild(moreBox);
          drawMore();
        }
        return { load: load };
      }
      const audioTab = makeAudioTab({ fetch: function (u, o) { return fetch(u, o); }, document: document });
      // <lc1-drop> Drops never navigate (LC1). A window-level guard cancels any file drag that no zone accepted (Chrome would
      // otherwise open the file and Phoenix is gone); the Image tab accepts one external image like "Load image...".
      // deps: { document, window, panel, upload(file), note(text) } - testable on a fake DOM.
      function makeDropGuard(deps) {
        const doc = deps.document, win = deps.window, panels = deps.panels || [deps.panel];
        const OK_TYPES = ['image/png', 'image/jpeg', 'image/webp'], OK_EXT = /\.(png|jpe?g|webp)$/i;
        const hasFiles = function (e) { const t = e && e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0; };
        let inPage = false;   // a drag that started inside this page is never an import
        let dragArmed = false;   // an in-page dragstart happened since the last clear (its own first dragenter has relatedTarget null)
        let wasInPage = false;   // snapshot for the panel's drop handler, which runs after the window capture clear
        // same reset as the Library's (amendment 2): the flag must not stick when a tile is detached mid-drag and no dragend arrives
        if (doc && doc.addEventListener) {
          doc.addEventListener('dragstart', function () { inPage = true; dragArmed = true; });
          doc.addEventListener('dragend', function () { inPage = false; dragArmed = false; });
          doc.addEventListener('dragenter', function (e) {
            if (!e || e.relatedTarget) return;
            if (dragArmed) dragArmed = false;   // the in-page drag's own entry
            else inPage = false;                // a drag entering the window from outside
          });
        }
        if (win && win.addEventListener) {
          win.addEventListener('drop', function () { wasInPage = inPage; inPage = false; dragArmed = false; }, true);
          win.addEventListener('dragend', function () { inPage = false; dragArmed = false; }, true);
          // bubble phase: a zone that accepts the drag has already called preventDefault by the time it gets here
          const guard = function (e) {
            if (!hasFiles(e) || e.defaultPrevented) return;
            e.preventDefault();
            try { e.dataTransfer.dropEffect = 'none'; } catch (_) {}
          };
          win.addEventListener('dragover', guard);
          // <lc2a-libdrop> a drop is ALWAYS cancelled here, even when a zone already did - it is never handed back to the browser's default (opening the file)
          win.addEventListener('drop', function (e) { if (hasFiles(e)) e.preventDefault(); });
        }
        panels.forEach(function (panel) {
        if (panel && panel.addEventListener) {
          const setDrop = function (on) { if (panel.classList) panel.classList.toggle('drop-active', !!on); };
          const over = function (e) {
            if (!hasFiles(e) || inPage) return;
            e.preventDefault();
            setDrop(true);
          };
          panel.addEventListener('dragenter', over);
          panel.addEventListener('dragover', over);
          panel.addEventListener('dragleave', function (e) { if (!e.relatedTarget || !panel.contains || !panel.contains(e.relatedTarget)) setDrop(false); });
          panel.addEventListener('drop', function (e) {
            setDrop(false);
            if (!hasFiles(e)) return;
            e.preventDefault();   // never navigate
            const internal = inPage || wasInPage;
            inPage = false; wasInPage = false;
            if (internal) return;
            if (deps.busy && deps.busy()) { deps.note('Phoenix is busy right now — load the image again when the current job is done.'); return; }
            const files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
            const isImg = function (f) { return !!f && OK_EXT.test(String(f.name || '')) && (!f.type || OK_TYPES.indexOf(f.type) >= 0); };
            const first = files.filter(isImg)[0];
            if (!first) { deps.note('Only PNG, JPEG or WebP images can be loaded.'); return; }
            if (files.length > 1) deps.note('Only one image can be loaded at a time \u2014 using ' + String(first.name || 'the first image') + '.');
            deps.upload(first);
          });
        }
        });
      }
      makeDropGuard({ document: document, window: (typeof window !== 'undefined' ? window : null), panels: [document.getElementById('panel-image'), document.querySelector('#inspector [data-insp="image-generate"]')],
        upload: function (f) { return uploadImageFile(f); }, busy: function () { const b = document.querySelector && document.querySelector("#image-actions .art-btn[data-action=\"load-image\"]"); return !!(b && b.disabled); }, note: function (t) { appendBubble('phoenix', t); } });
      wireInspectorDrop(document.getElementById('inspector'), function (t) { appendBubble('phoenix', t); });
      const inspectorDropNote = function (t) { appendBubble('phoenix', t); };
      wireInspectorDrop(document.getElementById('right-switch'), inspectorDropNote, function () { return document.getElementById('library-wrap').classList.contains('show-inspector'); });
      wireInspectorDrop(document.getElementById('library-header'), inspectorDropNote, function () { return document.getElementById('library-wrap').classList.contains('show-inspector'); });
      // </lc1-drop>
      // <lc2a-libdrop> the whole Library column accepts an image drop on every tab (T6-5): imports into Images, never a navigation
      const libDropOpts = {
        expand: function () { if (typeof libraryPage !== 'undefined' && libraryPage && libraryPage.shown()) return; const lw = document.getElementById('library-wrap'), strip = document.getElementById('lib-strip'); if (lw && lw.classList && lw.classList.contains('collapsed') && strip && strip.click) strip.click(); },   // <lc2a-r2> M5
        switchToImages: function () { if (typeof libraryPage !== 'undefined' && libraryPage && libraryPage.shown()) libraryPage.select('images'); else switchLibTab('images'); },
        reload: function (fromAdd) { return imagesTab.load('image,i2i,upload', libImagesBody, 'No images yet — generated, edited and added images show up here.', { grouped: true, tree: imageTree }, fromAdd === true); },
        note: function (t) { appendBubble('phoenix', t); },
      };
      imagesTab.wireLibraryDrop(document.getElementById('library-wrap'), libDropOpts);   // the PARENT of #library-list, so the Images zone (wireDrop) always runs first
      imagesTab.wireLibraryDrop(document.getElementById('library-page'), libDropOpts);   // R4: the Library workspace is a page - an image dropped on any section imports like on the column
      // v1.10 LIB2 (T6-21): the Videos tab's own folder tree (scope 'video'): the page's renderLibTree / folder state with the video scope
      const videoTree = (typeof renderLibTree === 'function' && typeof fetchLibFolders === 'function') ? {
        refresh: function () { return fetchLibFolders(); },
        render: function (container, entries, groupFn, emptyText, mkItem) { renderLibTree(container, entries, groupFn, [], emptyText, { scope: 'video', grid: true, mkItem: mkItem }); },
        assigned: function (key) { return (LIB_FOLDERS.assignments && LIB_FOLDERS.assignments[key]) || null; },
        pick: function (key, cur) { openFolderPicker(key, cur, 'video'); },
      } : null;
      const imageTree = (typeof renderLibTree === 'function' && typeof fetchLibFolders === 'function') ? {
        key: function (rec) { return 'image:' + rec.path; },
          refresh: function () { return fetchLibFolders(); },
        render: function (container, entries, groupFn, emptyText, mkItem) { renderLibTree(container, entries, groupFn, [], emptyText, { scope: 'image', grid: true, mkItem: mkItem }); },
        assigned: function (key) { return (LIB_FOLDERS.assignments && LIB_FOLDERS.assignments[key]) || null; },
        pick: function (key, cur) { openFolderPicker(key, cur, 'image'); },
      } : null;
      function loadImagesTab(name) {
        if (name === 'images') return imagesTab.load('image,i2i,upload', libImagesBody, 'No images yet — generated, edited and added images show up here.', { grouped: true, tree: imageTree });
        if (name === 'videos') return imagesTab.load('video', libVideosBody, 'No videos yet — video generation arrives with the video stage.', videoTree ? { tree: videoTree } : undefined);
        if (name === 'sound') return audioTab.load('/library/sounds', '/voice-open', {}, libSoundBody, 'No voice takes yet — they show up here after you speak a line in the Voice tab.');
        if (name === 'sfx') return audioTab.load('/library/sfx', '/sfx-open', { which: 'clips' }, libSfxBody, 'No sound clips yet — saved clips from the SFX tab show up here.');
      }

