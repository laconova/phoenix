      // ── Library tabs (Assets | Brushes | Materials | Palette) ────────────────
      // <l1-library> the single tab -> group mapping; a future tab (e.g. Music under Media) is one entry here
      const LIB_GROUPS = [
        { id: 'media', label: 'Media', tabs: [ { id: 'images', label: 'Images' }, { id: 'videos', label: 'Videos' }, { id: 'sound', label: 'Sound' }, { id: 'sfx', label: 'SFX' } ] },
        { id: '3d',    label: '3D',    tabs: [ { id: 'assets', label: 'Assets' }, { id: 'brushes', label: 'Brushes' }, { id: 'materials', label: 'Materials' }, { id: 'characters', label: 'Characters' } ] },
        { id: 'scenes', label: 'Scenes', tabs: [{ id: 'levels', label: 'Levels' }] },
        { id: 'tools', label: 'Tools', tabs: [ { id: 'palette', label: 'Palette' }, { id: 'workflows', label: 'Workflows' }, { id: 'storyboards', label: 'Storyboards' } ] },
      ];
      const libPanels  = { levels: libLevelsBody, assets: libAssetsBody, images: libImagesBody, videos: libVideosBody, sound: libSoundBody, sfx: libSfxBody, brushes: libBrushesBody, materials: libMaterialsBody, characters: libCharactersBody, palette: libPaletteBody, workflows: libWorkflowsBody, storyboards: libStoryboardsBody };
      let libActiveTab = 'assets';
      const LIBGROUPS_KEY = 'phoenix.libGroups.v1';   // LC2d (T8-2): { open:[group ids], tab } - which groups are expanded and which tab is active survive a reload
      const libOpenGroups = new Set();   // ids of the expanded groups (any number; empty = all collapsed to their names)
      const libGroupEls = {};      // group id -> { box, nameBtn, bar, tabsEl }
      function libGroupOf(tab) { const g = LIB_GROUPS.find(g => g.tabs.some(t => t.id === tab)); return g ? g.id : null; }
      (function buildLibTabs() {
        const host = document.getElementById('lib-tabs');
        LIB_GROUPS.forEach(function (g) {
          const box = document.createElement('div'); box.className = 'lib-group'; box.setAttribute('data-libgroup', g.id);
          const nameBtn = document.createElement('button'); nameBtn.type = 'button'; nameBtn.className = 'lib-group-btn';
          nameBtn.setAttribute('data-libgroupbtn', g.id); nameBtn.textContent = g.label; nameBtn.setAttribute('aria-expanded', 'false');
          const bar = document.createElement('button'); bar.type = 'button'; bar.className = 'lib-group-bar';
          bar.setAttribute('data-libgroupbar', g.id); bar.setAttribute('aria-label', 'Collapse ' + g.label); bar.setAttribute('title', 'Collapse ' + g.label);
          bar.setAttribute('aria-expanded', 'true'); bar.hidden = true;
          const tabsEl = document.createElement('div'); tabsEl.className = 'lib-group-tabs'; tabsEl.hidden = true;
          g.tabs.forEach(function (t) {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'lib-tab-btn';
            b.setAttribute('data-libtab', t.id); b.textContent = t.label;
            b.addEventListener('click', function () { switchLibTab(t.id); });
            tabsEl.appendChild(b);
          });
          nameBtn.addEventListener('click', function () { openLibGroup(g.id, true); });
          bar.addEventListener('click', function () { collapseLibGroup(g.id); });
          box.appendChild(nameBtn); box.appendChild(bar); box.appendChild(tabsEl);
          host.appendChild(box);
          libGroupEls[g.id] = { box: box, nameBtn: nameBtn, bar: bar, tabsEl: tabsEl };
        });
      })();
      // <lib2-pan> (T6-2) The whole name bar pans left/right (drag, shift+wheel / horizontal wheel) - but ONLY while its names are cut off.
      // #lib-tabs-strip clips, #lib-tabs is the track that gets translateX(-offset). Everything fits: offset 0, no handlers act, no cursor change.
      // A press that moves < 5 px is a normal click. The offset survives restarts (localStorage 'phoenix.libTabs.v1', every access guarded).
      const LIBTABS_KEY = 'phoenix.libTabs.v1';
      const libPan = { host: document.getElementById('lib-tabs'), strip: document.getElementById('lib-tabs-strip'), offset: 0, active: false, drag: null, swallow: false };
      try { const v = Number(localStorage.getItem(LIBTABS_KEY)); libPan.offset = (isFinite(v) && v > 0) ? v : 0; } catch (_) { libPan.offset = 0; }
      function libPanSave() { try { localStorage.setItem(LIBTABS_KEY, String(Math.round(libPan.offset))); } catch (_) {} }
      function libPanMax() { const s = libPan.strip, h = libPan.host; return (s && h) ? Math.max(0, (h.scrollWidth || 0) - (s.clientWidth || 0)) : 0; }
      function libPanApply() {
        const s = libPan.strip, h = libPan.host;
        if (!s || !h) return;
        if (h.style) h.style.transform = libPan.offset ? 'translateX(' + (-libPan.offset) + 'px)' : '';
        s.classList.toggle('pan-active', libPan.active);
        s.classList.toggle('fade-l', libPan.active && libPan.offset > 0);
        s.classList.toggle('fade-r', libPan.active && libPan.offset < libPanMax());
      }
      // re-measure: called on every open / collapse of a group, on column resize and on window resize
      function libPanRefresh() {
        const s = libPan.strip;
        if (!s || !libPan.host || !(s.clientWidth > 0)) return;   // not laid out (Library collapsed / hidden): keep the stored offset
        const max = libPanMax(), was = libPan.offset;
        libPan.active = max > 0;
        libPan.offset = libPan.active ? Math.min(Math.max(0, libPan.offset), max) : 0;
        libPanApply();
        if (libPan.offset !== was) libPanSave();
      }
      function libPanSet(v) {
        if (!libPan.active) return;
        const n = Math.min(Math.max(0, v), libPanMax());
        if (n === libPan.offset) return;
        libPan.offset = n; libPanApply();
      }
      function libPanReveal(tabId) {   // switching to a tab outside the visible part pans it into view
        if (!libPan.active || !libPan.strip) return;
        let b = null;
        try { b = Array.prototype.find.call(libGroupEls[libGroupOf(tabId)].tabsEl.children, function (x) { return x.getAttribute('data-libtab') === tabId; }) || null; } catch (_) {}
        if (!b) return;
        const l = b.offsetLeft, r = l + (b.offsetWidth || 0), w = libPan.strip.clientWidth, pad = 6;
        if (l - pad < libPan.offset) libPanSet(l - pad);
        else if (r + pad > libPan.offset + w) libPanSet(r + pad - w);
        libPanSave();
      }
      if (libPan.strip) {
        const s = libPan.strip;
        s.addEventListener('pointerdown', function (e) {
          libPan.swallow = false;
          if (!libPan.active || e.button) return;
          libPan.drag = { x: e.clientX, off: libPan.offset, moved: false };
          // a release anywhere (also off the strip, also outside the page) must end the drag
          try { if (typeof window !== 'undefined' && window.addEventListener) { window.addEventListener('pointerup', panEnd); window.addEventListener('pointercancel', panEnd); } } catch (_) {}
        });
        s.addEventListener('pointermove', function (e) {
          const d = libPan.drag;
          if (!d || !libPan.active) return;
          if (e.buttons !== undefined && !(e.buttons & 1)) { panEnd(); libPan.swallow = false; return; }   // the button is no longer down: the release was missed
          const dx = e.clientX - d.x;
          if (!d.moved) {
            if (Math.abs(dx) < 5) return;   // still a click
            d.moved = true; s.classList.add('panning');
            try { if (s.setPointerCapture && e.pointerId != null) s.setPointerCapture(e.pointerId); } catch (_) {}
          }
          libPanSet(d.off - dx);
        });
        function panEnd() {
          const d = libPan.drag; libPan.drag = null;
          try { if (typeof window !== 'undefined' && window.removeEventListener) { window.removeEventListener('pointerup', panEnd); window.removeEventListener('pointercancel', panEnd); } } catch (_) {}
          if (!d) return;
          s.classList.remove('panning');
          if (d.moved) { libPan.swallow = true; libPanSave(); }
        }
        s.addEventListener('pointerup', panEnd);
        s.addEventListener('pointercancel', panEnd);
        s.addEventListener('lostpointercapture', panEnd);
        s.addEventListener('click', function (e) { if (libPan.swallow && e.detail !== 0) { libPan.swallow = false; e.preventDefault(); e.stopPropagation(); } }, true);   // the click that ends a pan is not a tab click
        s.addEventListener('wheel', function (e) {
          if (!libPan.active) return;
          // LC2d (T8-1): a plain mouse wheel (deltaY only) pans too; deltaMode 1 = lines (x 16 px), 2 = pages (x the strip width)
          let d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          if (!d) return;
          if (e.deltaMode === 1) d *= 16; else if (e.deltaMode === 2) d *= (s.clientWidth || 0);
          e.preventDefault(); libPanSet(libPan.offset + d); libPanSave();
        }, { passive: false });
        try { if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('resize', libPanRefresh); } catch (_) {}
        try { if (typeof ResizeObserver !== 'undefined') { const ro = new ResizeObserver(libPanRefresh); ro.observe(s); ro.observe(libPan.host); } } catch (_) {}   // column splitter / collapse, and the track growing (late font load)
      }
      // </lib2-pan>
      function renderLibTabs() {
        LIB_GROUPS.forEach(function (g) {
          const e = libGroupEls[g.id], open = libOpenGroups.has(g.id);
          e.nameBtn.hidden = open; e.bar.hidden = !open; e.tabsEl.hidden = !open;
          e.nameBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
          e.bar.setAttribute('aria-expanded', open ? 'true' : 'false');
          Array.prototype.forEach.call(e.tabsEl.children, function (b) { b.classList.toggle('active', b.getAttribute('data-libtab') === libActiveTab); });
        });
        libPanRefresh();
      }
      // expanding a group leaves the others as they are; its first tab opens unless one of its tabs is already active
      function libGroupsSave() { try { localStorage.setItem(LIBGROUPS_KEY, JSON.stringify({ open: Array.from(libOpenGroups), tab: libActiveTab })); } catch (_) {} }
      function libGroupsLoad() {   // unknown ids / tabs are dropped; nothing (or garbage) stored = today's default
        let v = null;
        try { v = JSON.parse(localStorage.getItem(LIBGROUPS_KEY)); } catch (_) { v = null; }
        if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
        const open = Array.isArray(v.open) ? v.open.filter(function (g) { return typeof g === 'string' && LIB_GROUPS.some(function (x) { return x.id === g; }); }) : [];
        const tab = (typeof v.tab === 'string' && libGroupOf(v.tab)) ? v.tab : null;
        return { open: open, tab: tab };
      }
      function openLibGroup(id, focusIt) {
        libOpenGroups.add(id);
        if (libGroupOf(libActiveTab) !== id) { switchLibTab(LIB_GROUPS.find(g => g.id === id).tabs[0].id); }
        else { renderLibTabs(); libGroupsSave(); }
        if (focusIt) { try { const b = libGroupEls[id].tabsEl.querySelector('.lib-tab-btn.active'); if (b && b.focus) b.focus(); } catch (_) {} }
      }
      function collapseLibGroup(id) {
        libOpenGroups.delete(id);   // only its own group
        renderLibTabs(); libGroupsSave();
        try { const b = libGroupEls[id].nameBtn; if (b && b.focus) b.focus(); } catch (_) {}
      }
      function switchLibTab(name) {
        try { if (typeof imagesTab !== 'undefined') imagesTab.stopPlayback(); } catch (_) {}   // v1.10 VP1: switching the Library tab stops the video playing in a tile
        libActiveTab = name;
        const og = libGroupOf(name); if (og) libOpenGroups.add(og);   // also expands the owning group (never closes another)
        renderLibTabs(); libGroupsSave();
        libPanReveal(name);
        Object.entries(libPanels).forEach(([n, p]) => p.classList.toggle('visible', n === name));
        if (name === 'images' || name === 'videos' || name === 'sound' || name === 'sfx') { if ((name === 'sound' || name === 'sfx') && audioPlaying(libPanels[name])) return; loadImagesTab(name); }   // loaded when opened, no polling
        if (name === 'storyboards' && typeof storyboardsTab !== 'undefined') storyboardsTab.load(libStoryboardsBody);   // V1b-1 boards tab: loaded when opened, no polling
        if (name === 'levels') levelsTab.load(libLevelsBody);
        if (name === 'characters') { try { fetch('/characters/previews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(function () {}); } catch (_) {} }   // R5a: opening the section (re)starts the preview export queue
        if (name === 'characters' && typeof libraryPage !== 'undefined' && libraryPage) libraryPage.loadCharacters(libCharactersBody);   // v1.10.1 R4: the saved characters, loaded when opened, no polling
      }
      // M1.1: Story's "Change in Workflows" lands here: Library > Tools > Workflows, the group bar of the stage scrolled into view
      window.__openWorkflows = function (stage) {
        try { shellOpenLibrary('tools'); if (libraryPage) libraryPage.select('workflows'); } catch (_) { /* the page is not there: nothing to open */ }
        const reveal = function () { const h = document.querySelector('#lib-workflows-body .lib-cat[data-wf-stage="' + (stage || 'video') + '"]') || document.querySelector('.lib-cat[data-wf-stage="' + (stage || 'video') + '"]'); if (h && h.scrollIntoView) h.scrollIntoView({ block: 'start' }); };
        Promise.resolve(window.__reloadLibraryWorkflows ? window.__reloadLibraryWorkflows() : null).then(reveal, reveal);
      };
      { const og0 = libGroupOf(libActiveTab); if (og0) libOpenGroups.add(og0); } renderLibTabs();   // initial: the group of the active tab (Assets -> 3D) is expanded
      // LC2d (T8-2): the stored state wins over the default (read before the first paint of the tabs; the tab's content loads like a click on it)
      { const sv = libGroupsLoad();
        if (sv) {
          libOpenGroups.clear(); sv.open.forEach(function (g) { libOpenGroups.add(g); });   // exactly as it was left (a collapsed group stays collapsed, even the active tab's)
          if (sv.tab && sv.tab !== libActiveTab) { libActiveTab = sv.tab; Object.entries(libPanels).forEach(([n, p]) => p.classList.toggle('visible', n === sv.tab)); Promise.resolve().then(function () { if (libActiveTab === sv.tab) { const keep = Array.from(libOpenGroups); switchLibTab(sv.tab); libOpenGroups.clear(); keep.forEach(function (g) { libOpenGroups.add(g); }); renderLibTabs(); libGroupsSave(); } }); }   // after the script ran: the tab's own loader (Images, Sound, Storyboards ...) needs the tabs built below
          renderLibTabs();
        } }

