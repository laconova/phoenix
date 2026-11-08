      // ── Library page (v1.10.1 R4) ────────────────────────────────────────────────────────────────────────────────────────────────
      // The Library workspace is a page: a section list on the left (name + count, aria-current on the open one) and the section's view on the
      // right. The views are TODAY's panel bodies: while the page is shown the same nodes are moved into it (no copy, ids unchanged, handlers
      // unchanged) and put back when the workspace is left, so every other workspace keeps the docked Library exactly as it was. Counts come from
      // the existing list GETs, fetched when the page opens and after a change in a section - no polling, no timers. All text via textContent.

      // <libpage-pure>
      // Pure part: no DOM, no storage, no network - the acceptance suite runs exactly this block in vm.
      const LIBPAGE_KEY = 'phoenix.libPage.v1';
      // Library sections show visual things as tiles (images, videos, assets, brushes, materials, characters, storyboards), sound-like and text things as a list (sound, SFX, palette), and items with a detail view as list + detail page (workflows). One tile component, one row component.
      const LIBPAGE_LAYOUT = { images: 'tiles', videos: 'tiles', assets: 'tiles', brushes: 'tiles', materials: 'tiles', characters: 'tiles', storyboards: 'tiles', sound: 'list', sfx: 'list', palette: 'list', workflows: 'list+detail', levels: 'tiles' };
      const LIBPAGE_WF_DEFAULT = 420, LIBPAGE_WF_MIN = 320;
      function libWfWidth(raw, pageW, fit) {
        let n; try { const stored = JSON.parse(raw); n = stored.wfListW; if (n === 420 && !stored.wfListUser) n = null; } catch (_) {}
        if (!Number.isFinite(n) || n <= 0) { if (!Number.isFinite(fit) || fit <= 0) return LIBPAGE_WF_DEFAULT; n = Math.floor(fit); }
        return Math.max(LIBPAGE_WF_MIN, Math.min(n, Number.isFinite(pageW) && pageW > 0 ? Math.max(320, Math.floor(pageW * 0.5)) : Infinity));
      }
      const LIBPAGE_DEFAULT = 'assets';
      const LIBPAGE_SOURCES = { images: '/images?kind=image,i2i,upload', videos: '/images?kind=video', sound: '/library/sounds', sfx: '/library/sfx',
        assets: '/assets', brushes: '/brushes', materials: '/materials', characters: '/characters', palette: '/palette', workflows: '/workflows',
        levels: '/levels', libtrash: '/library/trash', storyboards: '/storyboards' };

      // every tab of every group in group order (group = the group's label), then Trash (no group). Nothing else.
      function libPageSections(groups) {
        const out = [];
        (Array.isArray(groups) ? groups : []).forEach(function (g) {
          (g && Array.isArray(g.tabs) ? g.tabs : []).forEach(function (t) { out.push({ id: t.id, label: t.label, group: g.label }); });
        });
        out.push({ id: 'trash', label: 'Trash', group: '' });
        return out;
      }
      // the stored string (or null) -> a known section id; missing / broken / unknown -> Assets
      function libPageLoad(raw, groups) {
        try {
          const j = JSON.parse(raw);
          if (j && typeof j === 'object' && !Array.isArray(j) && typeof j.section === 'string' && libPageSections(groups).some(function (s) { return s.id === j.section; })) return j.section;
        } catch (_) { /* broken or missing -> the default */ }
        return LIBPAGE_DEFAULT;
      }
      function libPageSave(section, wfListW, wfListUser) { const state = { section: section, wfListW: wfListW }; if (wfListUser === true) state.wfListUser = true; return JSON.stringify(state); }

      // a list answer -> { n, capped }, or null when the shape is wrong
      function libCountOf(section, json) {
        if (!json || typeof json !== 'object') return null;
        const isObj = function (o) { return !!o && typeof o === 'object' && !Array.isArray(o); };
        switch (section) {
          case 'images': case 'videos': return Array.isArray(json.items) ? { n: json.items.length, capped: json.items.length >= 500 } : null;
          case 'sound': case 'sfx': return Array.isArray(json.items) ? { n: json.items.length, capped: false } : null;
          case 'assets': return Array.isArray(json.assets) ? { n: json.assets.length, capped: false } : null;
          case 'brushes': return Array.isArray(json.brushes) ? { n: json.brushes.length, capped: false } : null;
          case 'materials': return Array.isArray(json.materials) ? { n: json.materials.length, capped: false } : null;
          case 'levels': return Array.isArray(json.levels) ? { n: json.levels.length, capped: false } : null;
          case 'characters': return Array.isArray(json.characters) ? { n: json.characters.length, capped: false } : null;
          case 'palette': return isObj(json.categories) ? { n: Object.keys(json.categories).length, capped: false } : null;
          case 'workflows': return isObj(json.workflows) ? { n: Object.keys(json.workflows).length, capped: false } : null;
          case 'storyboards': return Array.isArray(json.boards) ? { n: json.boards.length, capped: false } : null;
          default: return null;
        }
      }
      // what is in the trash today: the images answer's trash + the videos answer's trash (null-safe)
      function libTrashCount(imagesJson, videosJson, libTrashJson) {
        const len = function (j) { return (j && Array.isArray(j.trash)) ? j.trash.length : 0; };
        return len(imagesJson) + len(videosJson) + (libTrashJson && Array.isArray(libTrashJson.items) ? libTrashJson.items.length : 0);
      }
      // { ok: true, n, capped } -> the number ("500+" at the list limit); { ok: false, reason } -> an en dash with the reason as its title
      function libCountText(r) {
        if (r && r.ok) return { text: r.capped ? '500+' : String(r.n), title: '' };
        return { text: '–', title: (r && r.reason) ? String(r.reason) : '' };
      }
      // </libpage-pure>

      // <libpage-ui>
      // deps = { document, fetch, storage, groups, panels, selectTab, activeTab, postAction, openCharacter, onSection, inlineRow, dockState, restoreDock, onHide? }
      function makeLibraryPage(deps) {
        const doc = deps.document;
        const byId = function (id) { return doc.getElementById(id); };
        const sections = libPageSections(deps.groups);
        const secOf = {};
        sections.forEach(function (s) { secOf[s.id] = s; });
        const panelKeys = Object.keys(deps.panels || {});
        let isShown = false, current = null, remembered = null, dockSnap = null, origOrder = [], trashSeq = 0;
        const countState = {};

        function mk(tag, cls, text) {
          const e = doc.createElement(tag);
          if (cls) e.className = cls;
          if (text != null) e.textContent = text;
          return e;
        }
        function withStorage(fn) { try { return fn(deps.storage); } catch (_) { return null; } }
        const storedSection = function () { return libPageLoad(withStorage(function (s) { return s ? s.getItem(LIBPAGE_KEY) : null; }), deps.groups); };
        const saveSection = function (id) { withStorage(function (s) { if (s) s.setItem(LIBPAGE_KEY, libPageSave(id, userWidth, wfListUser)); }); };
        let wfWidth, userWidth, wfListUser = false;
        const rawWidth = function () { return withStorage(function (s) { return s ? s.getItem(LIBPAGE_KEY) : null; }); };
        function pageWidth() {
          const split = byId('lib-wf-split'), view = byId('lib-page-view');
          return (split && (split.getBoundingClientRect().width || split.clientWidth)) || (view && (view.getBoundingClientRect().width || view.clientWidth)) || 0;
        }
        function applyWidth(n, save) {
          wfWidth = libWfWidth(JSON.stringify({ wfListW: Math.max(LIBPAGE_WF_MIN, n), wfListUser: true }), pageWidth());
          const list = byId('lib-wf-list'); if (list) list.style.setProperty('--wf-list-w', wfWidth + 'px');
          if (handle) {
            handle.setAttribute('aria-valuemin', String(LIBPAGE_WF_MIN));
            handle.setAttribute('aria-valuemax', String(Math.max(LIBPAGE_WF_MIN, Math.floor(pageWidth() * 0.5))));
            handle.setAttribute('aria-valuenow', String(wfWidth));
          }
          if (save) { userWidth = wfWidth; wfListUser = true; saveSection(current || storedSection()); }
        }
        function fitWorkflowWidth() {
          let fit = 0;
          doc.querySelectorAll('.wf-name-btn').forEach(function (name) { const row = name.closest('.lib-list-row') || name.parentNode; fit = Math.max(fit, name.scrollWidth + (row ? Array.from(row.children).filter(function (e) { return e !== name; }).reduce(function (n, e) { return n + (e.scrollWidth || 0); }, 0) : 0) + 48); });
          const storedWidth = rawWidth(), measuredPageWidth = pageWidth();
          applyWidth(libWfWidth(storedWidth, measuredPageWidth, fit), false);
        }
        const handle = byId('lib-wf-resize');
        let drag = null;
        if (handle) {
          handle.addEventListener('keydown', function (e) { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); applyWidth(wfWidth + (e.key === 'ArrowRight' ? 16 : -16), true); } });
          handle.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, width: wfWidth }; handle.setPointerCapture(e.pointerId); e.preventDefault(); });
          handle.addEventListener('pointermove', function (e) { if (drag) applyWidth(drag.width + e.clientX - drag.x, false); });
          handle.addEventListener('pointerup', function (e) { if (drag && e.clientX !== drag.x) { userWidth = wfWidth; wfListUser = true; saveSection(current || storedSection()); } drag = null; if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId); });
          handle.addEventListener('pointercancel', function () { drag = null; });
        }
        if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') window.addEventListener('resize', function () { if (isShown) fitWorkflowWidth(); });
        function reasonOf(e) { return (e && e.message) ? String(e.message) : 'request failed'; }
        async function getJson(url) {
          try {
            const r = await deps.fetch(url);
            if (!r.ok) return { ok: false, reason: 'HTTP ' + r.status };
            return { ok: true, json: await r.json() };
          } catch (e) { return { ok: false, reason: reasonOf(e) }; }
        }
        async function postJson(url, payload) {
          try {
            const r = await deps.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            let j = null;
            try { j = await r.json(); } catch (_) { j = null; }
            return { ok: !!r.ok, status: r.status, json: j };
          } catch (e) { return { ok: false, status: 0, json: null, error: reasonOf(e) }; }
        }

        // ── counts ──
        function setCount(id, t) {
          countState[id] = { text: t.text, title: t.title };
          const nav = byId('lib-sections');
          const slot = nav ? nav.querySelector('[data-count-for="' + id + '"]') : null;
          if (!slot) return;
          slot.textContent = t.text;
          if (t.title) slot.setAttribute('title', t.title); else slot.removeAttribute('title');
        }
        // each source is asked once per call; Trash is derived from the images + videos answers (it has no route of its own)
        async function refreshCounts(ids) {
          const want = (Array.isArray(ids) && ids.length ? ids : sections.map(function (s) { return s.id; })).filter(function (id) { return !!secOf[id]; });
          const need = [];
          want.forEach(function (id) {
            const keys = id === 'trash' ? ['images', 'videos', 'libtrash'] : [id];
            keys.forEach(function (k) { if (need.indexOf(k) < 0) need.push(k); });
          });
          const got = {};
          await Promise.all(need.map(async function (k) { got[k] = await getJson(LIBPAGE_SOURCES[k]); }));
          want.forEach(function (id) {
            let r;
            if (id === 'trash') {
              const a = got.images, b = got.videos;
              r = (a.ok && b.ok) ? { ok: true, n: libTrashCount(a.json, b.json, got.libtrash && got.libtrash.json), capped: false } : { ok: false, reason: a.ok ? b.reason : a.reason };
            } else if (!got[id].ok) {
              r = got[id];
            } else {
              const c = libCountOf(id, got[id].json);
              r = c ? { ok: true, n: c.n, capped: c.capped } : { ok: false, reason: 'unexpected answer' };
            }
            setCount(id, libCountText(r));
          });
        }

        // ── the section list ──
        function buildSections() {
          const nav = byId('lib-sections');
          if (!nav || nav.children.length) return;
          let lastGroup = null;
          sections.forEach(function (s) {
            if (s.id === 'trash') { const sep = mk('div', 'lib-sec-sep'); sep.setAttribute('role', 'separator'); nav.appendChild(sep); }
            else if (s.group !== lastGroup) { nav.appendChild(mk('div', 'lib-sec-group', s.group)); lastGroup = s.group; }
            const b = mk('button', 'btn btn-ghost btn-sm lib-sec');
            b.type = 'button';
            b.setAttribute('data-libsec', s.id);
            b.appendChild(mk('span', 'lib-sec-name', s.label));
            const c = mk('span', 'lib-sec-count');
            c.setAttribute('data-count-for', s.id);
            if (countState[s.id]) { c.textContent = countState[s.id].text; if (countState[s.id].title) c.setAttribute('title', countState[s.id].title); }
            b.appendChild(c);
            b.addEventListener('click', function () { select(s.id); });
            nav.appendChild(b);
          });
        }
        function markRows() {
          const nav = byId('lib-sections');
          if (!nav) return;
          nav.querySelectorAll('[data-libsec]').forEach(function (b) {
            if (b.getAttribute('data-libsec') === current) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
          });
        }

        // which section(s) show a trashed kind of item; Restore rebuilds those lists (through deps.reload) and their counts
        const TRASH_KIND_SECTIONS = { asset: ['assets'], brush: ['brushes'], character: ['characters'], sound: ['sound', 'sfx'], storyboard: ['storyboards'], level: ['levels'], scene: ['levels'], customrig: [] };
        function reloadForKind(kind) {
          const secs = TRASH_KIND_SECTIONS[kind] || [];
          secs.forEach(function (s) { try { if (typeof deps.reload === 'function') deps.reload(s); } catch (_) {} });
          if (kind === 'customrig' || kind === 'character') { try { if (window.__phoenixRefreshRigs) window.__phoenixRefreshRigs(); if (window.__phoenixRefreshChars) window.__phoenixRefreshChars(); } catch (_) {} }
          refreshCounts(secs.filter(function (s) { return !!secOf[s]; }).concat(['trash'])).catch(function () {});
        }

        // ── Trash: what has a trash today (images + videos), grouped, one Restore per row, Empty with an inline confirm ──
        const IMAGE_KINDS = ['image', 'i2i', 'upload'], VIDEO_KINDS = ['video'];
        function trashRows(box, entries, rerender, where, which) {
          const here = !!(where && where.group === which);
          function trashRowMsg(text) {
            const m = mk('div', 'lib-trash-rowmsg', text);
            m.setAttribute('data-trash-rowmsg', '');
            m.setAttribute('role', 'status');
            return m;
          }
          entries.forEach(function (x, index) {
            if (here && where.at === index) box.appendChild(trashRowMsg(where.text));
            const name = x.library ? (x.kind === 'asset' ? 'Asset · ' : x.kind === 'level' ? 'Level · ' : x.kind === 'scene' ? 'Scene · ' : x.kind === 'character' ? 'Character · ' : x.kind === 'customrig' ? 'Custom rig · ' : x.kind === 'sound' ? 'Sound · ' : x.kind === 'storyboard' ? 'Storyboard · ' : 'Brush · ') + x.name + ' · ' + String(x.at || '').slice(0, 10) : String(x.from || '').split('/').pop();
            const row = mk('div', 'lib-trash-row');
            const nm = mk('span', 'lib-trash-name', name);
            nm.setAttribute('title', String(x.from || ''));
            const swap = !!(x.library && x.kind === 'brush' && x.replaced === true && x.live !== false);
            const rb = mk('button', 'btn btn-secondary btn-sm', swap ? 'Restore (swap back)' : 'Restore');
            rb.type = 'button';
            rb.setAttribute('data-trash-restore', String(x.id));
            rb.setAttribute('aria-label', (swap ? 'Restore (swap back) ' : 'Restore ') + name);
            rb.addEventListener('click', async function () {
              rb.disabled = true;
              const r = await postJson(x.library ? '/library/trash/restore' : '/images/restore', { id: x.id });
              if (!r.ok) {
                const old = row.querySelector('[data-trash-rowmsg]');
                if (old) old.remove();
                row.appendChild(trashRowMsg('Could not restore: ' + ((r.json && r.json.error) || r.error || ('HTTP ' + r.status))));
                rb.disabled = false;
                return;
              }
              if (x.library && typeof reloadForKind === 'function') reloadForKind(x.kind);   // F3: the restored item is back in its own list - rebuild that list and its count
              const plain = x.library ? String(x.name || '') : String(x.from || '').split('/').pop();
              let text = swap ? 'Restored ' + (x.display || plain) + ' — the version you replaced is now in the trash.' : 'Restored ' + plain + '.';
              if (r.json && r.json.warning) text += ' ' + String(r.json.warning);
              await rerender(text, { group: which, at: index });
            });
            row.appendChild(nm);
            if (swap) row.appendChild(mk('span', 'lib-trash-tag', 'replaced'));
            row.appendChild(rb);
            box.appendChild(row);
          });
          if (here && where.at >= entries.length) box.appendChild(trashRowMsg(where.text));   // the list is shorter now (or empty): the line goes last
        }
        function askEmpty(anchor, trigger, n, kinds, rerender) {
          if (typeof deps.inlineRow !== 'function') return;
          deps.inlineRow({
            doc: doc, anchor: anchor, trigger: trigger, kind: 'confirm', action: 'Delete', danger: true,
            label: 'Permanently delete ' + n + ' trashed file' + (n === 1 ? '' : 's') + '? This cannot be undone.',
            onDone: async function () {
              const r = await postJson(kinds === 'libtrash' ? '/library/trash/empty' : '/images/trash/empty', kinds === 'libtrash' ? {} : { kinds: kinds === 'all' ? IMAGE_KINDS.concat(VIDEO_KINDS) : kinds });
              const libraryResult = kinds === 'all' ? await postJson('/library/trash/empty', {}) : null;
              const failed = (r.json && Array.isArray(r.json.failed)) ? r.json.failed : [];
              let msg = '';
              if (!r.ok) msg = 'Could not empty the trash: ' + ((r.json && r.json.error) || r.error || ('HTTP ' + r.status));
              else if (failed.length) msg = failed.length + ' file' + (failed.length === 1 ? '' : 's') + ' could not be deleted and stay in the trash: ' + String(failed[0].error || '');
              if (libraryResult && !libraryResult.ok) msg += (msg ? ' ' : '') + 'Could not empty assets & brushes trash: ' + ((libraryResult.json && libraryResult.json.error) || libraryResult.error || ('HTTP ' + libraryResult.status));
              await rerender(msg);
            },
          });
        }
        function trashGroup(root, title, which, entries, kinds, rerender, where) {
          const box = mk('div', 'lib-trash-group');
          const head = mk('div', 'lib-trash-head-row');
          head.appendChild(mk('h3', 'lib-trash-title', title + ' (' + entries.length + ')'));
          if (entries.length) {
            const eb = mk('button', 'btn btn-secondary btn-sm', 'Empty trash…');
            eb.type = 'button';
            eb.setAttribute('data-trash-empty', which);
            eb.setAttribute('aria-label', 'Empty the ' + title.toLowerCase() + ' trash');
            eb.addEventListener('click', function () { askEmpty(head, eb, entries.length, kinds, rerender); });
            head.appendChild(eb);
          }
          box.appendChild(head);
          if (!entries.length) box.appendChild(mk('p', 'lib-trash-none', 'Nothing in the ' + title.toLowerCase() + ' trash.'));
          trashRows(box, entries, rerender, where, which);
          root.appendChild(box);
        }
        async function renderTrash(note, at) {
          const where = at && note ? { group: at.group, at: at.at, text: String(note) } : null;
          const root = byId('lib-trash-body');
          if (!root) return;
          const my = ++trashSeq;
          const rerender = function (msg, at) { return renderTrash(msg, at); };
          const pair = await Promise.all([getJson(LIBPAGE_SOURCES.images), getJson(LIBPAGE_SOURCES.videos), getJson(LIBPAGE_SOURCES.libtrash)]);
          if (my !== trashSeq) return;
          const a = pair[0], b = pair[1];
          [['images', a], ['videos', b]].forEach(function (p) {
            const c = p[1].ok ? libCountOf(p[0], p[1].json) : null;
            setCount(p[0], libCountText(c ? { ok: true, n: c.n, capped: c.capped } : { ok: false, reason: p[1].ok ? 'unexpected answer' : p[1].reason }));
          });
          setCount('trash', libCountText((a.ok && b.ok) ? { ok: true, n: libTrashCount(a.json, b.json, pair[2].json), capped: false } : { ok: false, reason: a.ok ? b.reason : a.reason }));
          root.textContent = '';
          const imgs = (a.ok && Array.isArray(a.json.trash)) ? a.json.trash : [];
          const vids = (b.ok && Array.isArray(b.json.trash)) ? b.json.trash : [];
          const libraryItems = pair[2].ok && Array.isArray(pair[2].json.items) ? pair[2].json.items : [];
          const top = mk('div', 'lib-trash-top');
          top.appendChild(mk('h2', 'lib-trash-heading', 'Trash'));
          if (imgs.length + vids.length + libraryItems.length) {
            const all = mk('button', 'btn btn-secondary btn-sm', 'Empty all…');
            all.type = 'button';
            all.setAttribute('data-trash-empty', 'all');
            all.setAttribute('aria-label', 'Empty the whole trash');
            all.addEventListener('click', function () { askEmpty(top, all, imgs.length + vids.length + libraryItems.length, 'all', rerender); });
            top.appendChild(all);
          }
          root.appendChild(top);
          if (note && !where) { const n = mk('p', 'lib-trash-msg', note); n.setAttribute('role', 'status'); root.appendChild(n); }
          if (!a.ok) root.appendChild(mk('p', 'lib-trash-msg', 'Could not read the images trash: ' + a.reason));
          if (!b.ok) root.appendChild(mk('p', 'lib-trash-msg', 'Could not read the videos trash: ' + b.reason));
          trashGroup(root, 'Images', 'images', imgs, IMAGE_KINDS, rerender, where);
          trashGroup(root, 'Videos', 'videos', vids, VIDEO_KINDS, rerender, where);
          trashGroup(root, 'Library', 'libtrash', pair[2].ok && Array.isArray(pair[2].json.items) ? pair[2].json.items.map(function (x) { return Object.assign({}, x, { library: true }); }) : [], 'libtrash', rerender, where);
        }

        // ── Characters: a read-only grid of the saved characters (rename / delete stay in Characters until the trash can take them) ──
        async function loadCharacters(root) {
          if (!root) return;
          const r = await getJson(LIBPAGE_SOURCES.characters);
          const list = (r.ok && r.json && Array.isArray(r.json.characters)) ? r.json.characters : null;
          root.textContent = '';
          if (!list) { root.appendChild(mk('div', 'lib-empty', r.ok ? 'could not read the characters' : 'could not load characters: ' + r.reason)); return; }
          if (!list.length) { root.appendChild(mk('div', 'lib-empty', 'No saved characters yet — save one in Characters ▸ MakeHuman.')); return; }
          const grid = mk('div', 'lib-tile-grid');
          list.forEach(function (c) {
            const name = String(c.name);
            const when = /^\d{4}-\d{2}-\d{2}/.exec(String(c.created || ''));
            const open = mk('button', 'btn btn-secondary btn-sm', 'Open in Characters');
            open.type = 'button';
            open.setAttribute('data-char-open', name);
            open.addEventListener('click', function () { deps.openCharacter(name); });
            const spawn = mk('button', 'btn btn-ghost btn-sm', 'Spawn in Blender');
            spawn.type = 'button';
            spawn.setAttribute('data-char-spawn', name);
            spawn.addEventListener('click', function () { deps.postAction('spawn_character', { name: name }, spawn); });
            // R5a: the poster comes from the character preview export (posterStamp = its key, set only for a fresh export)
            const stamp = typeof c.posterStamp === 'string' && c.posterStamp ? c.posterStamp : null;
            const dataset = { posterKey: 'character:' + name, charName: name }; if (stamp) dataset.posterStamp = stamp;
            const tile = libTile({ kind: 'character', name: name, dataset: dataset, poster: stamp ? '/poster?key=' + encodeURIComponent('character:' + name) + '&stamp=' + encodeURIComponent(stamp) : (typeof c.thumb === 'string' && c.thumb ? c.thumb : null), placeholder: c.previewError ? 'No preview' : 'No preview yet', meta: when ? when[0] : '', actions: [open, spawn], onPosterError: typeof renderTilePoster === 'function' ? renderTilePoster : undefined });
            if (c.previewError) libTileProblem(tile, 'No picture — the preview export failed: ' + readableReply(c.previewError), { label: 'Try again', run: function () { return postJson('/characters/previews', { retry: name }).then(function () { return loadCharacters(root); }); } }, 'poster');
            grid.appendChild(tile);
          });
          root.appendChild(grid);
        }

        // a loader reports that it rebuilt a list: while the page shows, that section's count follows (images / videos also move Trash);
        // hidden -> nothing. No polling: this runs only when something changed.
        function noteChange(section) {
          if (!isShown || !secOf[section]) return;
          if (section === 'workflows') fitWorkflowWidth();
          // F4: every list whose items can go to the trash also moves the Trash count
          const ids = ['images', 'videos', 'assets', 'brushes', 'characters', 'sound', 'sfx', 'storyboards', 'levels'].indexOf(section) >= 0 ? [section, 'trash'] : [section];
          refreshCounts(ids).catch(function () {});
        }

        // ── show / hide / select ──
        function closeOpenRow() {
          try { const o = deps.inlineRow && deps.inlineRow._open; if (o && o.close) o.close(true); } catch (_) {}
        }
        function select(id, fromShow) {
          if (!secOf[id]) return;
          current = id;
          saveSection(id);
          markRows();
          const trash = byId('lib-trash-body'), split = byId('lib-wf-split');
          if (id === 'trash') {
            panelKeys.forEach(function (k) { deps.panels[k].classList.remove('visible'); });
            if (trash) { trash.hidden = false; trash.classList.add('visible'); }
          } else {
            if (trash) trash.classList.remove('visible');
            try { deps.selectTab(id); } catch (_) {}
          }
          if (split) split.hidden = id !== 'workflows';
          if (id === 'workflows') fitWorkflowWidth();   // F1: the list width can only be measured once the split is visible (hidden, every name measures 0 and the list clamps to its minimum)
          try { if (deps.onSection) deps.onSection(secOf[id].label); } catch (_) {}
          if (id === 'trash') renderTrash().catch(function () {});
          else if (!fromShow) refreshCounts([id]).catch(function () {});
        }
        function show(section) {
          if (isShown) { if (section && secOf[section]) select(section); return; }
          isShown = true;   // first: onSection -> the shell renders again -> show() must already see the page as open
          try { remembered = deps.activeTab(); } catch (_) { remembered = null; }
          try { dockSnap = deps.dockState ? deps.dockState() : null; } catch (_) { dockSnap = null; }   // the docked strip as it is BEFORE the page moves anything
          const list = byId('library-list'), view = byId('lib-page-view'), wfList = byId('lib-wf-list');
          origOrder = [];
          if (list) origOrder = Array.prototype.slice.call(list.children).filter(function (c) { return panelKeys.some(function (k) { return deps.panels[k] === c; }); });
          panelKeys.forEach(function (k) {
            const body = deps.panels[k], target = k === 'workflows' ? wfList : view;
            if (body && target) target.appendChild(body);
          });
          const page = byId('library-page');
          if (page) page.hidden = false;
          userWidth = null; wfListUser = false; try { const stored = JSON.parse(rawWidth()); wfListUser = stored.wfListUser === true; userWidth = stored.wfListW || null; if (userWidth === 420 && !wfListUser) userWidth = null; } catch (_) {}
          fitWorkflowWidth();
          ['art-panels', 'library-wrap', 'handle-lib'].forEach(function (id) { const e = byId(id); if (e) e.hidden = true; });
          buildSections();
          refreshCounts().catch(function () {});
          select((section && secOf[section]) ? section : storedSection(), true);
        }
        function hide() {
          if (!isShown) return;
          isShown = false;
          trashSeq++;   // a late Trash answer must not draw into a closed page
          closeOpenRow();
          const list = byId('library-list');
          if (list) origOrder.forEach(function (b) { list.appendChild(b); });
          const page = byId('library-page');
          if (page) page.hidden = true;
          ['art-panels', 'library-wrap', 'handle-lib'].forEach(function (id) { const e = byId(id); if (e) e.hidden = false; });
          const trash = byId('lib-trash-body');
          if (trash) trash.classList.remove('visible');
          let now = null;
          try { now = deps.activeTab(); } catch (_) { now = null; }
          if (remembered && now !== remembered) { try { deps.selectTab(remembered); } catch (_) {} }
          else if (remembered && deps.panels[remembered]) deps.panels[remembered].classList.add('visible');   // Trash hid every body: the docked tab shows again
          try { if (deps.restoreDock && dockSnap) deps.restoreDock(dockSnap); } catch (_) {}   // open groups + pan exactly as before the page (and what is stored)
          dockSnap = null;
          try { if (deps.onHide) deps.onHide(); } catch (_) {}
        }

        return {
          fitWorkflows: function () { if (isShown) fitWorkflowWidth(); },
          show: show, hide: hide, select: function (id) { select(id, false); },
          section: function () { return current; },
          sectionLabel: function () { return secOf[current || storedSection()].label; },
          shown: function () { return isShown; },
          refreshCounts: refreshCounts,
          noteChange: noteChange,
          counts: function () { const o = {}; Object.keys(countState).forEach(function (k) { o[k] = { text: countState[k].text, title: countState[k].title }; }); return o; },
          loadCharacters: loadCharacters,
          renderTrash: renderTrash,
        };
      }
      // </libpage-ui>

      // ── the real page ──
      // var, not const: the shell (js-05) and the tabs (js-85) look the page up by name, and this part is evaluated after them
      var libraryPage = null;
      try {
        libraryPage = makeLibraryPage({
          document: document,
          fetch: function (u, o) { return fetch(u, o); },
          storage: (function () { try { return localStorage; } catch (_) { return null; } })(),
          groups: LIB_GROUPS,
          panels: libPanels,
          selectTab: function (id) { switchLibTab(id); },
          activeTab: function () { return libActiveTab; },
          postAction: function (a, p, o) { return postAction(a, p, o); },
          openCharacter: function (name) { switchTab('human'); if (window.__charactersWs) window.__charactersWs.openCharacter(name); },
          onSection: function () { if (typeof shellRender === 'function') shellRender(); },
          onHide: function () { if (typeof closeWorkflowWindow === 'function') closeWorkflowWindow(true); },   // an open workflow page is not replayed when the Library is entered again
          inlineRow: libInlineRow,
          reload: function (s) {   // F3: rebuild one section's list after a Restore from the Trash
            if (s === 'assets') loadAssets();
            else if (s === 'brushes') loadBrushes();
            else if (s === 'characters') { if (libraryPage) libraryPage.loadCharacters(libCharactersBody); }
            else if (s === 'sound' || s === 'sfx') { if (!audioPlaying(libPanels[s])) loadImagesTab(s); }
            else if (s === 'storyboards' && typeof storyboardsTab !== 'undefined') storyboardsTab.load(libStoryboardsBody);
            else if (s === 'levels') levelsTab.load(libLevelsBody);
          },
          dockState: function () { return { open: Array.from(libOpenGroups), pan: libPan.offset }; },
          restoreDock: function (snap) {
            libOpenGroups.clear();
            (snap.open || []).forEach(function (g) { libOpenGroups.add(g); });
            libPan.offset = snap.pan || 0;
            renderLibTabs(); libGroupsSave(); libPanSave();
          },
        });
      } catch (_) { libraryPage = null; }
      if (typeof onCharacterPreviews === 'function') window.__onCharacterPreviews = onCharacterPreviews;   // R5a: js-70 forwards the character-previews broadcast here (defined in js-75)
      // js-77 (the workflow page) reaches the Library only through this: where it was opened from, the Library on a section, and back again
      window.__libraryPage = {
        label: function (ws) { const w = shellWs(ws); return w ? w.label : ''; },
        workspace: function () { return shellState.workspace; },
        open: function (section) {
          shellState.workspace = 'library'; shellSave();
          if (libraryPage) libraryPage.show(section);
          shellRender();
        },
        back: function (ws) {
          if (!ws || ws === 'library') return;
          const w = shellWs(ws);
          if (!w || !w.modes.length) return;
          switchTab(shellState.modeByWorkspace[ws] || w.modes[0].tab);   // -> shellOnTab -> render: the page closes, the workspace is back as it was left
        },
      };
