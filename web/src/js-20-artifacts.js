      // ── Artifacts ───────────────────────────────────────────────────────────

      const artPromptEl       = document.getElementById('artPrompt');
      const promptEditEl      = document.getElementById('prompt-edit');
      const imagePromptEditEl = document.getElementById('image-prompt-edit');
      const artImageEl        = document.getElementById('artImage');
      const imageFileEl       = document.getElementById('image-file');
      const artMeshEl         = document.getElementById('artMesh');
      const promptPlaceholder = document.getElementById('prompt-placeholder');
      const imagePlaceholder  = document.getElementById('image-placeholder');
      const meshPlaceholder   = document.getElementById('mesh-placeholder');

      const libAssetsBody    = document.getElementById('lib-assets-body');
      const libImagesBody    = document.getElementById('lib-images-body');
      const libVideosBody    = document.getElementById('lib-videos-body');
      const libSoundBody     = document.getElementById('lib-sound-body');
      const libSfxBody       = document.getElementById('lib-sfx-body');
      const libBrushesBody   = document.getElementById('lib-brushes-body');
      const libMaterialsBody = document.getElementById('lib-materials-body');
      const libPaletteBody    = document.getElementById('lib-palette-body');
      const libWorkflowsBody  = document.getElementById('lib-workflows-body');
      const libStoryboardsBody = document.getElementById('lib-storyboards-body');   // V1b-1 boards tab
      const libCharactersBody = document.getElementById('lib-characters-body');   // v1.10.1 R4: the saved characters (read-only grid)
      const libraryRefreshEl  = document.getElementById('library-refresh');

      let currentMesh = null;
      // True when the displayed mesh was loaded from the library (a staged GLB with no source image)
      // → "Regenerate mesh" can't work for it (it would regen from the last GENERATED image instead).
      let meshFromLibrary = false;
      function updateRegenLock() {
        const btn = document.querySelector("#mesh-actions [data-action=\"regen-mesh\"]");
        if (!btn) return;
        btn.classList.toggle('lib-locked', meshFromLibrary);
        btn.title = meshFromLibrary
          ? 'Not available for a library asset — it has no source image to regenerate from.'
          : '';
      }

      // True when the displayed image was loaded by the user (upload), not generated
      // → "Regenerate" image can't work for it (there is no source prompt that produced it).
      let imageFromUser = false;
      let refsFilled = 0;   // v1.10 I1: a filled reference slot makes Regenerate usable for a loaded image (it uses the references, not a source prompt)
      function updateRegenImageLock() {
        const btn = document.querySelector("#image-actions [data-action=\"regen-image\"]");
        if (!btn) return;
        const locked = imageFromUser && !refsFilled;
        btn.classList.toggle('lib-locked', locked);
        btn.title = locked
          ? 'Not available for a loaded image — there is no source prompt to regenerate from. Use "Make 3D", or type a prompt in chat to generate a fresh image.'
          : '';
      }

      // Filled from /palette — the server's palette is the only place a category exists.
      // This used to be a hardcoded copy ("keep in sync"), so every category added after
      // it was written (leaf, branch) silently got no face-count prefill.
      const FACE_DEFAULTS = {};
      async function refreshFaceDefaults(categories) {
        try {
          const cats = categories || (await (await fetch('/palette')).json()).categories || {};
          Object.entries(cats).forEach(([k, v]) => { FACE_DEFAULTS[k] = (v.params && v.params.target_face_num) ? v.params.target_face_num.value : v.target_face_num; });
        } catch (e) { /* prefill is a convenience; the server default still applies */ }
      }
      refreshFaceDefaults();
      const meshFacesEl = document.getElementById('mesh-faces');

      function parsePromptText(t) {
        const s = String(t || '');
        const negIdx = s.search(/NEGATIVE:/i);
        let posPart, negPart = '';
        if (negIdx >= 0) { posPart = s.slice(0, negIdx); negPart = s.slice(negIdx).replace(/NEGATIVE:/i, ''); }
        else { posPart = s; }
        const pos = posPart.replace(/POSITIVE:/i, '').trim();
        const neg = negPart.trim();
        return { pos, neg };
      }

      const tabBtns   = document.querySelectorAll('.art-tab-btn');
      const tabPanels = {
        prompt: document.getElementById('panel-prompt'),
        image:  document.getElementById('panel-image'),
        mesh:   document.getElementById('panel-mesh'),
        scene: document.getElementById('panel-scene'),
        human:  document.getElementById('panel-characters'),       // R5a: MakeHuman and Custom rig are two sources of ONE panel
        customrig: document.getElementById('panel-characters'),
        speak:  document.getElementById('panel-audio'),            // R5b: Speak a line, Cast a new voice and Sound effects are three modes of ONE panel
        cast:   document.getElementById('panel-audio'),
        sfx:    document.getElementById('panel-audio'),
        storyboard: document.getElementById('panel-storyboard'),   // v1.10 V1
        video:  document.getElementById('panel-video'),            // v1.10 VP1
      };

      function switchTab(tab) {
        if (tab === 'import') tab = 'scene';
        if (tab === 'voice') tab = 'speak';   // R5b: the old Voice tab id (Ctrl K, links) is Speak a line
        currentTab = tab;
        tabBtns.forEach(btn => {
          btn.classList.toggle('active', btn.dataset.tab === tab);
        });
        Object.entries(tabPanels).forEach(([name, panel]) => { if (panel) panel.classList.toggle('visible', tabPanels[tab] === panel); });   // per ELEMENT: two tabs share the Characters panel
        if (typeof videoTab !== 'undefined') { if (tab === 'video') videoTab.enter(); else videoTab.leave(); }   // v1.10 VP1: leaving the Video tab pauses it; opening it restores the last viewed file
        if (tab === 'storyboard' && typeof storyboardTab !== 'undefined') storyboardTab.load(document.getElementById('sb-root'));   // v1.10 V1: loaded when opened, no polling
        if (tab !== 'storyboard' && typeof storyboardTab !== 'undefined' && typeof storyboardTab.stop === 'function') storyboardTab.stop();   // v1.10 V1b-2: leaving the tab ends the animatic (its one frame loop)
        if (typeof imagesTab !== 'undefined') imagesTab.refreshUse();   // v1.10 V1b-1: the Use button's label follows the top tab
        const charsBefore = switchTab.charsShown === true; switchTab.charsShown = tab === 'human' || tab === 'customrig';   // was the Characters panel the visible one before this switch
        if (switchTab.charsShown && window.__charactersWs) {   // R5a: the Characters panel follows the tab; a fresh arrival reads the lists once (no polling)
          window.__charactersWs.setSource(tab === 'human' ? 'makehuman' : 'customrig');
          if (!charsBefore) window.__charactersWs.enter();
        }
        const audioBefore = switchTab.audioShown === true; switchTab.audioShown = tab === 'speak' || tab === 'cast' || tab === 'sfx';
        if (switchTab.audioShown && typeof window !== 'undefined' && window.__audioWs) {   // switchTab is also evaluated standalone (no window) by other suites   // R5b: the Audio panel follows the tab; a fresh arrival reloads the open mode
          window.__audioWs.setMode(tab);
          if (!audioBefore) window.__audioWs.enter();
        }
        const storyBefore = switchTab.storyShown === true; switchTab.storyShown = tab === 'storyboard' || tab === 'video';
        if (switchTab.storyShown && !storyBefore && typeof window !== 'undefined' && window.__animaticExport) window.__animaticExport.refresh();   // R6: a fresh arrival in Story reads the export state once (no timer; switchTab is also evaluated standalone, without a window)
        if (typeof syncCreateRight === 'function') syncCreateRight();
        if (typeof shellOnTab === 'function') shellOnTab(tab);   // R1: the rail + top bar follow the active tab (one source of truth), whoever called switchTab
      }

      tabBtns.forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
      });

      // <vp1-video> Video tab (v1.10 VP1, preview only): one large <video> with our own controls - play/pause, scrub, frame step
      // (1/fps, fps from the record else 24), speed, loop, mute, file info + Open file. The last viewed file is remembered per viewer
      // (localStorage 'phoenix.videoTab.v1', every access in try/catch). deps: { document, root, storage? () -> Storage }. All text via textContent.
      function makeVideoTab(deps) {
        const doc = deps.document;
        const root = deps.root;
        const KEY = 'phoenix.videoTab.v1';
        const EMPTY = 'No video loaded \u2014 pick one in Library \u25B8 Video, or open a shot\u2019s clip from the storyboard.';
        const DEFAULT_FPS = 24;
        function el(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
        function store() { try { return deps.storage ? deps.storage() : (typeof localStorage !== 'undefined' ? localStorage : null); } catch (_) { return null; } }
        function readSaved() {
          try { const st = store(); const raw = st && st.getItem(KEY); const o = raw ? JSON.parse(raw) : null; return o && typeof o.url === 'string' && o.url ? o : null; } catch (_) { return null; }
        }
        function writeSaved(o) { try { const st = store(); if (st) { if (o) st.setItem(KEY, JSON.stringify(o)); else st.removeItem(KEY); } } catch (_) {} }
        function pathOfUrl(u) {
          try { const m = /[?&]p=([^&]+)/.exec(String(u || '')); return m ? decodeURIComponent(m[1]) : ''; } catch (_) { return ''; }
        }
        function baseName(p) { return String(p || '').replace(/\\/g, '/').split('/').pop(); }
        function fmt(t) {   // m:ss.cc - the last two digits are hundredths of a second
          t = isFinite(t) && t > 0 ? t : 0;
          const total = Math.floor(t * 100 + 1e-6);
          const m = Math.floor(total / 6000), sec = Math.floor(total / 100) % 60, cc = total % 100;
          return m + ':' + (sec < 10 ? '0' : '') + sec + '.' + (cc < 10 ? '0' : '') + cc;
        }
        // ── the DOM, built once ──
        const stage = el('div', 'vt-stage');
        stage.setAttribute('tabindex', '-1');   // R3-B1: show()/enter() park focus here, so the keys work and no button holds them
        const vid = el('video', 'vt-video');
        vid.setAttribute('preload', 'metadata');
        vid.setAttribute('playsinline', '');
        const empty = el('div', 'vt-empty', EMPTY);
        stage.appendChild(vid); stage.appendChild(empty);
        const bar = el('div', 'vt-bar');
        function btn(label, title, name) { const b = el('button', 'btn btn-secondary btn-sm', label); b.setAttribute('type', 'button'); b.setAttribute('data-vt', name); b.setAttribute('title', title); b.setAttribute('aria-label', title); return b; }
        const bPlay = btn('Play', 'Play / pause (Space)', 'play');
        const bPrev = btn('\u2039', 'Previous frame (\u2190)', 'prev');
        const bNext = btn('\u203A', 'Next frame (\u2192)', 'next');
        const seek = el('input', 'vt-seek'); seek.setAttribute('type', 'range'); seek.setAttribute('min', '0'); seek.setAttribute('max', '0'); seek.setAttribute('step', 'any'); seek.setAttribute('aria-label', 'Position'); seek.value = '0';
        const timeEl = el('span', 'vt-time', '0:00.00 / 0:00.00');
        const frameEl = el('span', 'vt-frame', 'f0'); frameEl.setAttribute('title', 'Frame number');
        const speeds = [0.5, 1, 2].map(function (v) { const b = btn(v + '\u00D7', 'Speed ' + v + '\u00D7', 'speed'); b.dataset.speed = String(v); return b; });
        const bLoop = btn('Loop', 'Loop', 'loop');
        const bMute = btn('Mute', 'Mute', 'mute');
        const info = el('div', 'vt-info', '');
        const openA = el('a', 'vt-open', 'Open file');
        openA.setAttribute('target', '_blank'); openA.setAttribute('rel', 'noopener');
        const row1 = el('div', 'vt-bar');
        [bPlay, bPrev, bNext, seek, timeEl, frameEl].forEach(function (n) { row1.appendChild(n); });
        const row2 = el('div', 'vt-bar');
        speeds.forEach(function (n) { row2.appendChild(n); });
        [bLoop, bMute, info, openA].forEach(function (n) { row2.appendChild(n); });
        if (root) { root.appendChild(stage); root.appendChild(row1); root.appendChild(row2); }
        // ── state ──
        let cur = null;        // { url, path, name, fps }
        let visible = false;
        let restored = false;  // the loaded file came from storage (a gone file then also clears the memory)
        let meta = '';
        function fpsOf() { const f = cur && Number(cur.fps); return f > 0 && isFinite(f) ? f : DEFAULT_FPS; }
        function dur() { const d = vid.duration; return isFinite(d) && d > 0 ? d : 0; }
        function paintTime() {
          const d = dur();
          timeEl.textContent = fmt(vid.currentTime || 0) + ' / ' + fmt(d);
          frameEl.textContent = 'f' + Math.floor((vid.currentTime || 0) * fpsOf() + 1e-6);
          seek.setAttribute('max', String(d));
          seek.value = String(vid.currentTime || 0);
        }
        function paintPlay() { bPlay.textContent = vid.paused ? 'Play' : 'Pause'; }
        function paintToggles() {
          speeds.forEach(function (b) { b.setAttribute('aria-pressed', Number(b.dataset.speed) === vid.playbackRate ? 'true' : 'false'); });
          bLoop.setAttribute('aria-pressed', vid.loop ? 'true' : 'false');
          bMute.setAttribute('aria-pressed', vid.muted ? 'true' : 'false');
        }
        function paintInfo() {
          const parts = [cur ? cur.name : ''];
          if (meta) parts.push(meta);
          info.textContent = parts.filter(Boolean).join(' \u00B7 ');
        }
        function setEmpty() {
          cur = null; meta = '';
          try { vid.pause(); } catch (_) {}
          vid.removeAttribute('src');
          try { if (vid.load) vid.load(); } catch (_) {}
          vid.hidden = true; empty.hidden = false; row1.hidden = true; row2.hidden = true;
          paintInfo(); paintTime(); paintPlay();
        }
        function load(o) {
          const url = String(o.url);
          const path = String(o.path || pathOfUrl(url) || '');
          cur = { url: url, path: path, name: o.name || baseName(path || url.split('?')[0]), fps: Number(o.fps) > 0 ? Number(o.fps) : 0, muted: o.muted === true, synced: o.muted === true, board: typeof o.board === 'string' ? o.board : '', shot: typeof o.shot === 'string' ? o.shot : '' };   // synced = the shot's Clip sound state the player last took over (the user's own mute button may differ from it)
          meta = '';
          vid.hidden = false; empty.hidden = true; row1.hidden = false; row2.hidden = false;
          openA.setAttribute('href', url);
          vid.src = url;
          vid.muted = o.muted === true;   // LC2f (T9-1): a shot's clip opens muted when its Clip sound is off; every other open (Library, restore) plays with sound
          try { vid.currentTime = 0; } catch (_) {}
          paintInfo(); paintTime(); paintPlay(); paintToggles();
        }
        function show(o) {
          if (!o || !o.url) return;
          restored = false;
          load(o);
          writeSaved({ url: cur.url, path: cur.path, name: cur.name, fps: cur.fps || 0, muted: cur.muted === true, board: cur.board, shot: cur.shot });   // LC2f r3: a shot's clip remembers its mute state and which shot it is
          focusStage();
        }
        function focusStage() { try { stage.focus(); } catch (_) {} }
        // LC2f r4: a clip that came from a shot is re-checked against that shot on EVERY entry of the tab (restore AND a re-enter with the player already loaded). The shot's state wins only when it
        // CHANGED since the player last took it over (cur.synced / cur.url) - otherwise the user's own mute toggle stays. A changed file reloads the source (position 0, like load()). No shot (Library) -> untouched.
        function syncShot() {
          const c0 = cur;
          if (!c0 || !c0.shot || !c0.board || !deps.resolveShot) return;
          Promise.resolve().then(function () { return deps.resolveShot(c0.board, c0.shot); }).then(function (r) {
            if (!r || cur !== c0) return;
            if (r.url && r.url !== c0.url) { load({ url: r.url, path: pathOfUrl(r.url), name: undefined, fps: c0.fps, muted: r.muted === true, board: c0.board, shot: c0.shot }); writeSaved({ url: cur.url, path: cur.path, name: cur.name, fps: cur.fps || 0, muted: cur.muted === true, board: cur.board, shot: cur.shot }); }
            else if ((r.muted === true) !== (c0.synced === true)) { vid.muted = r.muted === true; c0.muted = vid.muted; c0.synced = vid.muted; paintToggles(); }
          }).catch(function () {});
        }
        function enter() {
          visible = true;
          focusStage();
          if (!cur) {
            const sv = readSaved();
            if (sv) { load(sv); restored = true; }
          }
          syncShot();
        }
        function pauseNow() { try { if (!vid.paused) vid.pause(); } catch (_) {} paintPlay(); }
        function leave() { visible = false; pauseNow(); }
        function togglePlay() {
          if (!cur) return;
          if (vid.paused) { if (api.onPlay) { try { api.onPlay(); } catch (_) {} } try { const p = vid.play(); if (p && p.catch) p.catch(function () {}); } catch (_) {} } else vid.pause();
          paintPlay();
        }
        function seekTo(t) {
          const d = dur();
          if (!isFinite(t)) return;
          vid.currentTime = Math.max(0, d ? Math.min(d, t) : t);
          paintTime();
        }
        function step(dir) { if (!cur) return; if (!vid.paused) vid.pause(); paintPlay(); seekTo((vid.currentTime || 0) + dir / fpsOf()); }
        function jump(sec) { if (!cur) return; seekTo((vid.currentTime || 0) + sec); }
        function typing() {
          const a = doc.activeElement;
          if (!a) return false;
          const t = String(a.tagName || '').toUpperCase();
          return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || a.isContentEditable === true;
        }
        function inRoot(n) { for (; n; n = n.parentNode) { if (n === root) return true; } return false; }
        function isBtnLike(a) { const t = String(a.tagName || '').toUpperCase(); return t === 'BUTTON' || t === 'A' || (a.getAttribute && a.getAttribute('role') === 'button'); }
        function isTabBtn(a) { return (' ' + String(a.className || '') + ' ').indexOf(' art-tab-btn ') >= 0 && !!a.dataset && a.dataset.tab === 'video'; }   // R4-M1: only the Video tab button; the others must still switch tabs
        // R3-B1: who gets the key? Fields / native <video> controls / sliders / modals keep every key. Arrows always reach the player (a button
        // focused by a mouse click must not eat them). Space on a button is the player's only inside the Video panel or on a top tab button
        // (where it must not also press the button); on any other button (chat Send, Library, modals) it stays native.
        function routeKey(k) {
          const a = doc.activeElement;
          if (!a) return true;
          const t = String(a.tagName || '').toUpperCase();
          if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || t === 'VIDEO' || a.isContentEditable === true) return false;
          if (a.getAttribute && a.getAttribute('role') === 'slider') return false;
          for (let n = a; n; n = n.parentNode) { if (n.getAttribute && n.getAttribute('aria-modal') === 'true') return false; }
          if ((k === ' ' || k === 'Spacebar') && isBtnLike(a)) return inRoot(a) || isTabBtn(a);
          return true;
        }
        let swallowUp = false;   // Space handled on a button: its keyup must not click it either
        bPlay.addEventListener('click', togglePlay);
        bPrev.addEventListener('click', function () { step(-1); });
        bNext.addEventListener('click', function () { step(1); });
        seek.addEventListener('input', function () { if (cur) seekTo(Number(seek.value)); });
        speeds.forEach(function (b) { b.addEventListener('click', function () { vid.playbackRate = Number(b.dataset.speed); paintToggles(); }); });
        bLoop.addEventListener('click', function () { vid.loop = !vid.loop; paintToggles(); });
        bMute.addEventListener('click', function () { vid.muted = !vid.muted; paintToggles(); });
        vid.addEventListener('loadedmetadata', function () {
          const w = vid.videoWidth, h = vid.videoHeight, d = dur();
          meta = [d ? fmt(d) : '', w && h ? w + '\u00D7' + h : ''].filter(Boolean).join(' \u00B7 ');
          paintInfo(); paintTime();
        });
        vid.addEventListener('timeupdate', paintTime);
        vid.addEventListener('durationchange', paintTime);
        vid.addEventListener('play', paintPlay);
        vid.addEventListener('pause', paintPlay);
        vid.addEventListener('ended', paintPlay);
        vid.addEventListener('error', function () {   // the file is gone (or cannot be decoded): back to the empty state
          if (!cur) return;
          if (restored) writeSaved(null);
          setEmpty();
        });
        if (doc.addEventListener) doc.addEventListener('keydown', function (e) {
          if (!visible || !cur || !e || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typing() || !routeKey(e.key)) return;
          const k = e.key;
          if ((k === ' ' || k === 'Spacebar') && e.repeat) { if (e.preventDefault) e.preventDefault(); return; }   // R4-M2: a held Space must not flicker play/pause
          if (k === ' ' || k === 'Spacebar') { togglePlay(); const a = doc.activeElement; swallowUp = !!(a && isBtnLike(a)); }
          else if (k === 'ArrowLeft') { if (e.shiftKey) jump(-1); else step(-1); }
          else if (k === 'ArrowRight') { if (e.shiftKey) jump(1); else step(1); }
          else return;
          if (e.preventDefault) e.preventDefault();
        });
        if (doc.addEventListener) doc.addEventListener('keyup', function (e) {
          if (swallowUp && e && (e.key === ' ' || e.key === 'Spacebar')) { swallowUp = false; if (e.preventDefault) e.preventDefault(); }
        });
        setEmpty();
        const api = { show: show, enter: enter, leave: leave, pause: pauseNow, current: function () { return cur; }, EMPTY: EMPTY, onPlay: null };   // onPlay: set by the page (stops a tile that is playing)
        return api;
      }
      // </vp1-video>
      // <r6-export>
      // The animatic export controller (R6): "Export board as video" renders the shown board into ONE MP4 on the server (a job in the shared slot, progress
      // over SSE, Stop). It owns no truth: `running` / `last` are the server's (GET /storyboard/export/status on a fresh arrival in Story and after an SSE reconnect;
      // the SSE events 'export' and 'export-done'), and every status line, Stop button and Export button on the page is painted from that ONE state (paint()).
      // An event always wins over an older status answer; a finished job is never made "running" again by a late start answer. No timer.
      // deps: { document, fetch, boardId() -> the shown board id ('' = the server's active board), openVideo(url, path) }
      function makeAnimaticExport(deps) {
        const doc = deps.document;
        let running = null;      // { board, job, progress 0..1 } | null
        let last = null;         // { board, ok, stopped, path, url, name, warnings, error, at } | null
        let note = '';           // a refusal of Start / Stop (not an export result)
        let busyNoteSeq = 0;     // the sequence of `note` when it is a busy refusal (the server says busy:true), else 0: it goes when the jobs are idle
        let busySeq = 0;         // one counter: an idle answer clears only a refusal shown before it was asked
        let starting = false, stopping = false;
        let evSeq = 0, refreshTok = 0;
        const finished = [];     // job ids whose 'export-done' was seen (a late answer of their Start must not revive them)
        function post(url, body) { return deps.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { ok: !!r.ok, status: r.status, j: j }; }); }); }
        function errOf(r) { return (r && r.j && r.j.error) || ('HTTP ' + (r && r.status)); }
        function setHidden(e, on) { if (!e) return; e.hidden = !!on; if (on) e.setAttribute('hidden', ''); else e.removeAttribute('hidden'); }
        function all(sel) { try { return Array.prototype.slice.call(doc.querySelectorAll(sel)); } catch (_) { return []; } }
        function byId(id) { return doc.getElementById ? doc.getElementById(id) : null; }
        function pct(p) { const n = Number(p); return Math.max(0, Math.min(100, Math.round((isFinite(n) ? n : 0) * 100))); }
        function statusText() {
          if (running) return 'Exporting animatic\u2026 ' + pct(running.progress) + '%';
          if (starting) return 'Starting the export\u2026';
          if (note) return note;
          if (last) return last.ok ? 'Exported ' + (last.name || last.path || 'the animatic') : (last.stopped ? 'Export stopped \u2014 no file was written.' : (last.error ? String(last.error) : 'The export failed.'));
          return '';
        }
        function paint() {
          const busy = !!running || starting, text = statusText();
          all('[data-export-status]').forEach(function (e) { e.textContent = text; });
          all('[data-export-stop]').forEach(function (b) { setHidden(b, !running); b.disabled = !!stopping; });
          const eb = byId('vt-export'); if (eb) eb.disabled = busy;
          all('[data-sb="export"]').forEach(function (b) { b.disabled = busy || b.getAttribute('data-noshots') === 'true'; });
          const shown = !running && !starting && last;
          const warn = byId('vt-export-warn');
          if (warn) {
            warn.textContent = '';
            const ws = shown && Array.isArray(last.warnings) ? last.warnings.filter(function (w) { return typeof w === 'string' && w; }) : [];
            if (ws.length) { const ul = doc.createElement('ul'); ws.forEach(function (w) { const li = doc.createElement('li'); li.textContent = w; ul.appendChild(li); }); warn.appendChild(ul); }
            setHidden(warn, !ws.length);
          }
          all('[data-export-warnings]').forEach(function (ul) {   // M1.2: the Storyboard transport lists the notes of the last export (until the next one starts)
            ul.textContent = '';
            const ws2 = shown && last.board && typeof deps.boardId === 'function' && last.board === deps.boardId() && Array.isArray(last.warnings) ? last.warnings.filter(function (w) { return typeof w === 'string' && w; }) : [];
            ws2.forEach(function (w) { const li = doc.createElement('li'); li.textContent = w; ul.appendChild(li); });
            setHidden(ul, !ws2.length);
          });
          const res = byId('vt-export-result');
          if (res) {
            res.textContent = '';
            const ok = !!(shown && last.ok && last.url);
            if (ok) {
              const b = doc.createElement('button'); b.className = 'btn btn-secondary btn-sm'; b.setAttribute('type', 'button'); b.setAttribute('data-vt', 'open'); b.textContent = 'Open in player';
              const url = last.url, p = last.path || '';
              b.addEventListener('click', function () { if (deps.openVideo) deps.openVideo(url, p); });
              res.appendChild(b);
            }
            setHidden(res, !ok);
          }
        }
        function start(boardId) {
          if (running || starting) return Promise.resolve();
          starting = true; note = ''; busyNoteSeq = 0; paint();
          return post('/storyboard/export', { board: boardId || deps.boardId() || '' }).then(function (r) {
            starting = false;
            const job = r.ok && r.j ? r.j.job : null;
            if (job == null) { note = r.ok ? 'Phoenix gave no export job.' : errOf(r); busyNoteSeq = !r.ok && r.j && r.j.busy === true ? ++busySeq : 0; }
            else if (finished.indexOf(job) < 0 && !(running && running.job === job)) running = { board: boardId || deps.boardId() || '', job: job, progress: 0 };
            paint();
          }).catch(function () { starting = false; note = 'Phoenix is not reachable \u2014 nothing was started.'; busyNoteSeq = 0; paint(); });
        }
        function stop() {
          if (!running || stopping) return Promise.resolve();
          stopping = true; note = ''; busyNoteSeq = 0; paint();
          return post('/stop', { kind: 'video', job: running.job }).then(function (r) {
            stopping = false;
            if (!r.ok) { note = errOf(r); busyNoteSeq = 0; }
            paint();
            return refresh();   // the answer may say the job was already over: the server's state is the truth
          }).catch(function () { stopping = false; note = 'Phoenix is not reachable \u2014 the export was not stopped.'; busyNoteSeq = 0; paint(); });
        }
        let bootId = null;   // the server start this controller last saw (GET /version { boot })
        // G7: job numbers restart with the server. After a reconnect the "finished" list is dropped ONLY when the server instance changed - a mere dropped stream keeps it, so a delayed Start answer cannot revive a completed job.
        function checkBoot() {
          const before = finished.slice(), seq0 = evSeq;   // what was known when the check began: a completion that arrives while /version is in flight is newer and must survive
          return deps.fetch('/version').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
            const b = j && typeof j.boot === 'string' ? j.boot : null;
            if (b && bootId && b !== bootId) {
              for (let i = finished.length - 1; i >= 0; i--) if (before.indexOf(finished[i]) >= 0) finished.splice(i, 1);
              if (evSeq === seq0) { running = null; paint(); }
            }
            if (b) bootId = b;
          }).catch(function () { /* unknown: keep the list */ });
        }
        function refresh(afterReconnect) {
          if (afterReconnect === true) return checkBoot().then(function () { return refresh(); });
          const tok = ++refreshTok, seq = evSeq;
          return deps.fetch('/storyboard/export/status').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
            if (tok !== refreshTok || seq !== evSeq || !j || typeof j !== 'object') return;   // a newer event (or request) already told the truth
            running = j.running && j.running.job != null ? { board: j.running.board || '', job: j.running.job, progress: Number(j.running.progress) || 0 } : null;
            // G7: job numbers restart with the server. The server's own reading is the truth: a job it says is running is not "finished", even when an older server used the same number.
            if (running) { const k = finished.indexOf(running.job); if (k >= 0) finished.splice(k, 1); }
            last = j.last && typeof j.last === 'object' ? j.last : null;
            paint();
          }).catch(function () { /* the next arrival reads it again */ });
        }
        // the status poll says the jobs are idle: a busy refusal is stale once the server confirms nothing holds the slot or a lock
        function jobState(idle) {
          if (idle !== true || !busyNoteSeq) return Promise.resolve();
          const asked = busySeq;   // taken before the request goes out; a refusal shown while it is out is newer and stays
          return deps.fetch('/storyboard/export/status').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
            if (j && j.idle === true && busyNoteSeq && busyNoteSeq <= asked) { note = ''; busyNoteSeq = 0; paint(); }
          }).catch(function () { /* the next poll asks again */ });
        }
        function serverEvent(ev) {
          if (!ev || ev.kind !== 'storyboard') return;
          if (ev.phase === 'export') {
            if (finished.indexOf(ev.job) >= 0) return;
            evSeq++;
            running = { board: ev.board || (running && running.board) || '', job: ev.job, progress: Number(ev.progress) || 0 };
            paint();
          } else if (ev.phase === 'export-done') {
            evSeq++;
            finished.push(ev.job); if (finished.length > 20) finished.shift();
            if (running && running.job !== ev.job) return;   // the end of an older job: the running one goes on
            running = null; starting = false; stopping = false; note = ''; busyNoteSeq = 0;
            last = { board: ev.board || '', ok: ev.ok === true, stopped: ev.stopped === true, path: ev.path || '', url: ev.url || '', name: ev.name || '', warnings: Array.isArray(ev.warnings) ? ev.warnings : [], error: ev.error || '' };
            paint();
          }
        }
        return { start: start, stop: stop, refresh: refresh, jobState: jobState, serverEvent: serverEvent, paint: paint, state: function () { return { running: running, progress: running ? running.progress : 0, last: last }; } };
      }
      // </r6-export>
      const videoTab = makeVideoTab({ document: document, root: document.getElementById('vt-root'), resolveShot: function (b, s) {   // LC2f r3: the shot's current clip state, from the server's board (null = the shot or its clip is gone)
        return fetch('/storyboard?board=' + encodeURIComponent(b)).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { const sh = d && Array.isArray(d.shots) ? d.shots.find(function (x) { return x.id === s; }) : null; return sh && sh.clip && sh.clip_url ? { muted: sh.clip.muted === true, url: sh.clip_url } : null; }).catch(function () { return null; });
      } });
      // R6: the one export controller of the page; the Video mode's button and every Stop export button talk to it, SSE events reach it from js-70
      window.__animaticExport = makeAnimaticExport({ document: document, fetch: function (u, o) { return fetch(u, o); },
        boardId: function () { return (typeof storyboardTab !== 'undefined' && storyboardTab.boardId) ? storyboardTab.boardId() : ''; },
        openVideo: function (url, p) { setArtifact({ slot: 'video', url: url, path: p, source: 'animatic' }); } });
      (function wireAnimaticExport() {
        const eb = document.getElementById('vt-export');
        if (eb) eb.addEventListener('click', function () { window.__animaticExport.start(); });
        document.addEventListener('click', function (e) {   // every [data-export-stop] (the Video mode's and the Storyboard transport's, rebuilt with each render)
          let n = e && e.target;
          for (; n && n !== document; n = n.parentNode) { if (n.hasAttribute && n.hasAttribute('data-export-stop')) { window.__animaticExport.stop(); return; } }
        });
      })();



      const libLevelsBody = document.getElementById('lib-levels-body');
