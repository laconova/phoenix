      // ── Shell (v1.10.1 R1): rail · top bar · Ctrl K palette · Copilot toggle · status bar with providers ─────────────────────────────
      // The behaviour of the frame in 02-body.html. The panels are not rewritten: choosing a workspace / mode calls the existing switchTab(tab),
      // and switchTab tells shellOnTab() back, so the active data-tab stays the ONE source of truth (a tool result opening the Mesh tab moves
      // the rail too). This part runs first in the page script: whatever it needs from later parts is looked up when it is called, and the
      // wiring + the default commands run in shellBoot() once the whole script has been evaluated.

      // <r5-display>
      // Display only: the ERROR: / ERROR (exit n): / BLENDER ERROR: / BLENDER_UNREACHABLE: prefixes stay in the data (the failure tests match on them); a reply shown to the user drops them.
      // readableReply: the plain sentence (error surfaces, chat, MCP bubbles, the brush save). hideRefusalToken is the same formatter under its older name (the chat).
      function readableReply(t) {
        return String(t == null ? '' : t).replace(/^\s*(?:(?:ERROR \(exit \d+\)|ERROR|BLENDER ERROR|BLENDER_UNREACHABLE):\s*)+/, '');
      }
      function hideRefusalToken(t) {
        return readableReply(t);
      }
      // A multi-line text (an MCP result): every line loses its own leading wrapper.
      function readableLines(t) {
        return String(t == null ? '' : t).split(/\r?\n/).map(readableReply).join('\n');
      }
      // </r5-display>

      // <visible-poll>
      // The poll rule (R5a, design rules section 7): a panel's periodic timer runs ONLY while its workspace is visible (and the browser tab is not hidden);
      // a job clock runs from its start until its stop(), whatever is visible. Pure: no DOM, no storage, no network - timers only through deps.
      //   deps: { setInterval, clearInterval, current: () => workspaceId, hidden: () => boolean }
      function makePollRegistry(deps) {
        const polls = [];   // { workspace, fn, ms, id, stopped }
        const clocks = [];  // { id }
        function visible(p) { return !p.stopped && deps.current() === p.workspace && !deps.hidden(); }
        function sync() {
          polls.forEach(function (p) {
            const want = visible(p);
            if (want && p.id === null) p.id = deps.setInterval(p.fn, p.ms);
            else if (!want && p.id !== null) { deps.clearInterval(p.id); p.id = null; }
          });
        }
        function visiblePoll(workspace, fn, ms) {
          const p = { workspace: workspace, fn: fn, ms: ms, id: null, stopped: false };
          polls.push(p); sync();
          return { stop: function () { p.stopped = true; if (p.id !== null) { deps.clearInterval(p.id); p.id = null; } const i = polls.indexOf(p); if (i >= 0) polls.splice(i, 1); } };
        }
        function jobClock(fn, ms) {
          const c = { id: deps.setInterval(fn, ms) };
          clocks.push(c);
          return { stop: function () { const i = clocks.indexOf(c); if (i < 0) return; clocks.splice(i, 1); deps.clearInterval(c.id); } };
        }
        function active() { return clocks.length + polls.filter(function (p) { return p.id !== null; }).length; }
        return { visiblePoll: visiblePoll, jobClock: jobClock, sync: sync, active: active };
      }
      // </visible-poll>

      // <shell-pure>
      // Pure part: no DOM, no storage, no network - the acceptance suite runs exactly this block in vm.
      const SHELL_WORKSPACES = [
        { id: 'create', label: 'Create', modes: [ { tab: 'prompt', label: 'Prompt' }, { tab: 'image', label: 'Image' }, { tab: 'mesh', label: 'Mesh' }, { tab: 'scene', label: 'Scene' } ] },
        { id: 'characters', label: 'Characters', hideModes: true, modes: [ { tab: 'human', label: 'MakeHuman' }, { tab: 'customrig', label: 'Custom rig' } ] },   // M1.4: the source follows the picked row / + New character, the top bar has no switch for it
        { id: 'audio', label: 'Audio', modes: [ { tab: 'speak', label: 'Speak a line' }, { tab: 'cast', label: 'Cast a new voice' }, { tab: 'sfx', label: 'Sound effects' }, { tab: 'music', label: 'Music', disabled: true, tag: 'later', reason: 'No music engine yet.' } ] },
        { id: 'story', label: 'Story', modes: [ { tab: 'storyboard', label: 'Storyboard' }, { tab: 'video', label: 'Video · cut' } ] },
        { id: 'library', label: 'Library', modes: [] },
      ];

      // Ctrl K filter: a command matches when every word of the query is a substring of label + group + keywords (case-insensitive);
      // commands whose label STARTS with the query come first, then the rest, each in registry order. Empty query = all.
      function shellFilter(commands, query) {
        const list = Array.isArray(commands) ? commands : [];
        const words = String(query == null ? '' : query).toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) return list.slice();
        const q = words.join(' ');
        const hay = function (c) { return (String(c.label) + ' ' + String(c.group || '') + ' ' + (Array.isArray(c.keywords) ? c.keywords.join(' ') : String(c.keywords || ''))).toLowerCase(); };
        const hits = list.filter(function (c) { const h = hay(c); return words.every(function (w) { return h.indexOf(w) >= 0; }); });
        const first = hits.filter(function (c) { return String(c.label).toLowerCase().indexOf(q) === 0; });
        return first.concat(hits.filter(function (c) { return first.indexOf(c) < 0; }));
      }

      // The status bar order: ids of the saved order first (unknown ids skipped, a repeated id counts once), then every other known item by
      // its own order (ties by id), so a provider added later shows up without anyone touching the layout. -> [{ id, shown }]
      function statusLayout(items, saved) {
        const list = Array.isArray(items) ? items : [];
        const known = new Set(list.map(function (x) { return x.id; }));
        const hidden = new Set(saved && Array.isArray(saved.hidden) ? saved.hidden : []);
        const out = [], seen = new Set();
        const push = function (id) { if (seen.has(id) || !known.has(id)) return; seen.add(id); out.push({ id: id, shown: !hidden.has(id) }); };
        if (saved && Array.isArray(saved.order)) saved.order.forEach(push);
        list.slice().sort(function (a, b) { return (a.order - b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }).forEach(function (x) { push(x.id); });
        return out;
      }

      // The command registry: { list(), register({ id, label, group, keywords?, run }) }. A duplicate id replaces the earlier entry IN ITS PLACE;
      // a command without a string id / label or a function run is refused (register returns false).
      function makeShellRegistry() {
        const cmds = [];
        function register(c) {
          if (!c || typeof c.id !== 'string' || !c.id || typeof c.label !== 'string' || !c.label || typeof c.run !== 'function') return false;
          const entry = { id: c.id, label: c.label, group: typeof c.group === 'string' ? c.group : '', keywords: c.keywords, run: c.run };
          const i = cmds.findIndex(function (x) { return x.id === c.id; });
          if (i >= 0) cmds[i] = entry; else cmds.push(entry);
          return true;
        }
        return { list: function () { return cmds.slice(); }, register: register };
      }
      // </shell-pure>

      const pollRegistry = makePollRegistry({ setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
        current: function () { return shellState.workspace; }, hidden: function () { return document.hidden === true; } });
      function visiblePoll(ws, fn, ms) { return pollRegistry.visiblePoll(ws, fn, ms); }
      function jobClock(fn, ms) { return pollRegistry.jobClock(fn, ms); }
      document.addEventListener('visibilitychange', function () { pollRegistry.sync(); });

      const shellReg = makeShellRegistry();
      window.registerShellCommand = shellReg.register;   // later modules add their own commands to Ctrl K

      const SHELL_KEY = 'phoenix.shell.v1';
      const shellEl = function (id) { return document.getElementById(id); };
      const shellWs = function (id) { return SHELL_WORKSPACES.find(function (w) { return w.id === id; }); };
      const shellWsOfTab = function (tab) { return SHELL_WORKSPACES.find(function (w) { return w.modes.some(function (m) { return m.tab === tab; }); }); };

      // { workspace, modeByWorkspace: { create, characters, audio, story }, copilotOpen } - every access in try/catch, a bad value = the default
      function shellLoad() {
        const st = { workspace: 'create', modeByWorkspace: { create: 'prompt', characters: 'human', audio: 'speak', story: 'storyboard' }, copilotOpen: true };
        try {
          const j = JSON.parse(localStorage.getItem(SHELL_KEY));
          if (j && typeof j === 'object' && !Array.isArray(j)) {
            const w = shellWs(j.workspace);
            if (w && w.id !== 'library') st.workspace = w.id;   // Library is a column, not a place the centre can be restored to
            const m = j.modeByWorkspace;
            if (m && typeof m === 'object') SHELL_WORKSPACES.forEach(function (ws) {
              const want = (ws.id === 'audio' && m[ws.id] === 'voice') ? 'speak' : m[ws.id];   // R5b: the old Voice mode is Speak a line; a disabled mode is never restored
              if (ws.modes.some(function (x) { return x.tab === want && !x.disabled; })) st.modeByWorkspace[ws.id] = want;
            });
            if (typeof j.copilotOpen === 'boolean') st.copilotOpen = j.copilotOpen;
          }
        } catch (_) { /* broken or missing -> defaults */ }
        return st;
      }
      const shellState = shellLoad();
      function shellSave() { try { localStorage.setItem(SHELL_KEY, JSON.stringify(shellState)); } catch (_) {} }

      // ── rail + top bar rendering ─────────────────────────────────────────────
      let shellSegFor = '';
      function shellRender() {
        const ws = shellWs(shellState.workspace) || SHELL_WORKSPACES[0];
        let lp = null; try { lp = libraryPage; } catch (_) { lp = null; }   // R4: Library = the page; every other workspace shows the docked Library (the page is looked up by name: it is built after this part)
        if (lp) { if (ws.id === 'library') lp.show(); else lp.hide(); }
        const pipe = shellEl('create-pipeline'); if (pipe) { const wasHidden = pipe.hidden; pipe.hidden = ws.id !== 'create'; if (wasHidden && !pipe.hidden) createPipe.reveal(); }
        if (window.__syncCreateRight) window.__syncCreateRight();
        document.querySelectorAll('#rail [data-rail]').forEach(function (b) {
          if (b.getAttribute('data-rail') === ws.id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
        });
        const tab = shellState.modeByWorkspace[ws.id];
        const mode = ws.modes.find(function (m) { return m.tab === tab; });
        const crumb = shellEl('shell-crumb');
        if (crumb) { crumb.textContent = ''; const b = document.createElement('b'); b.textContent = ws.label; crumb.appendChild(b); if (mode) { const s = document.createElement('span'); s.textContent = ' / ' + (ws.id === 'characters' && window.__charactersWs && window.__charactersWs.crumbName ? window.__charactersWs.crumbName() : (ws.id === 'story' && window.__storyCrumb && window.__storyCrumb()) || mode.label); crumb.appendChild(s); } else if (ws.id === 'library' && lp) { const s = document.createElement('span'); s.textContent = ' / ' + lp.sectionLabel(); crumb.appendChild(s); } }
        const stepsEl = shellEl('char-steps'); if (stepsEl) stepsEl.hidden = ws.id !== 'characters';   // the Characters step switch lives in the top bar
        pollRegistry.sync();   // the poll rule: a panel's timer runs only while its workspace is the visible one
        const seg = shellEl('shell-modes');
        if (!seg) return;
        seg.hidden = ws.id === 'create' || !ws.modes.length || ws.hideModes === true;
        seg.setAttribute('aria-label', ws.id === 'characters' ? 'Source' : 'Mode');
        if (shellSegFor !== ws.id) {
          shellSegFor = ws.id; seg.textContent = '';
          ws.modes.forEach(function (m) {
            const b = document.createElement('button'); b.type = 'button'; b.textContent = m.label; b.setAttribute('data-mode', m.tab);
            if (m.disabled) {   // R5b: a mode that is not there yet (Music): visible, says why, does nothing
              b.disabled = true; b.setAttribute('aria-disabled', 'true'); b.title = m.reason || '';
              const tg = document.createElement('span'); tg.className = 'seg-tag'; tg.textContent = m.tag || 'later'; b.appendChild(tg);
            } else b.addEventListener('click', function () { switchTab(m.tab); });
            seg.appendChild(b);
          });
        }
        Array.prototype.forEach.call(seg.children, function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-mode') === tab ? 'true' : 'false'); });
      }

      // switchTab calls this after every tab change (whoever asked for it): the active data-tab decides the workspace + mode
      function shellOnTab(tab) {
        const ws = shellWsOfTab(tab);
        if (!ws) return;
        shellState.workspace = ws.id; shellState.modeByWorkspace[ws.id] = tab;
        shellSave(); shellRender();
      }

      function shellSelectWorkspace(id) {
        const ws = shellWs(id);
        if (!ws) return;
        if (ws.id === 'library') { shellOpenLibrary(); return; }
        const first = ws.modes.find(function (m) { return !m.disabled; });
        const tab = shellState.modeByWorkspace[ws.id] || (first && first.tab);
        switchTab(tab);   // -> shellOnTab -> render
      }

      // Library (R4): the workspace is a page (#library-page). A group name lands on that group's first section unless the open section already belongs
      // to it; the focus goes to the open section's row.
      function shellOpenLibrary(group) {
        shellState.workspace = 'library'; shellSave(); shellRender();
        try {
          const g = (group && typeof LIB_GROUPS !== 'undefined') ? LIB_GROUPS.find(function (x) { return x.id === group; }) : null;
          if (g && libraryPage && !g.tabs.some(function (t) { return t.id === libraryPage.section(); })) libraryPage.select(g.tabs[0].id);
        } catch (_) { /* the page is not there (yet): the workspace still switched */ }
        const row = document.querySelector('#lib-sections [aria-current="page"]');
        if (row && row.focus) row.focus();
      }

      // ── Copilot column (#chat-wrap) - collapses through its own buttons ──────
      const shellChatCollapsed = function () { const c = shellEl('chat-wrap'); return !!(c && c.classList.contains('collapsed')); };
      function shellToggleCopilot(open) {
        const want = open === undefined ? shellChatCollapsed() : !!open;   // true = show
        if (want === !shellChatCollapsed()) return;
        const b = shellEl(want ? 'chat-strip' : 'chat-collapse');
        if (b) b.click();
      }
      function shellSyncCopilot() {
        const t = shellEl('copilot-toggle');
        const open = !shellChatCollapsed();
        if (t) t.setAttribute('aria-pressed', open ? 'true' : 'false');
        if (shellState.copilotOpen !== open) { shellState.copilotOpen = open; shellSave(); }
      }

      // ── Help menu (rail) + Settings (rail) ───────────────────────────────────
      function shellHelp(open) {
        const menu = shellEl('help-menu'), btn = document.querySelector('#rail [data-rail="help"]');
        if (!menu || !btn) return;
        const on = open === undefined ? menu.hidden : !!open;
        if (on) {
          const r = btn.getBoundingClientRect();
          if (r.top > window.innerHeight / 2) { menu.style.top = ''; menu.style.left = Math.round(r.right + 8) + 'px'; menu.style.bottom = Math.max(8, Math.round(window.innerHeight - r.bottom)) + 'px'; }
          else { menu.style.bottom = ''; menu.style.left = Math.round(r.left) + 'px'; menu.style.top = Math.round(r.bottom + 8) + 'px'; }
        }
        menu.hidden = !on;
        btn.setAttribute('aria-expanded', on ? 'true' : 'false');
        if (on) { const first = menu.querySelector('[data-help]'); if (first) first.focus(); }
      }
      function shellHelpRun(which) {
        shellHelp(false);
        if (which === 'troubleshooter' && typeof openTroubleshooter === 'function') openTroubleshooter();
        else if (which === 'feedback' && typeof openFeedback === 'function') openFeedback();
        else if (which === 'onboarding' && typeof openOnboarding === 'function') openOnboarding();
      }
      // the Settings window on a given section: the window restores the section named in phoenix.settingsTab
      function shellOpenSettings(tab) {
        if (tab) { try { localStorage.setItem('phoenix.settingsTab', tab); } catch (_) {} }
        if (typeof openSettings === 'function') openSettings();
      }

      // ── Ctrl K palette ───────────────────────────────────────────────────────
      let palFlat = [], palSel = 0, palReturn = null;
      const palOpen = function () { const p = shellEl('shell-palette'); return !!(p && !p.hidden); };
      function shellPaletteSelect(i) {
        const list = shellEl('shell-palette-list'), input = shellEl('shell-palette-input');
        if (!palFlat.length) return;
        palSel = (i + palFlat.length) % palFlat.length;   // wraps
        Array.prototype.forEach.call(list.querySelectorAll('.pal-row'), function (r, n) {
          const on = n === palSel;
          r.setAttribute('aria-selected', on ? 'true' : 'false');
          const key = r.querySelector('.pal-key'); if (key) key.textContent = on ? 'Enter' : '';
          if (on) { input.setAttribute('aria-activedescendant', r.id); if (r.scrollIntoView) r.scrollIntoView({ block: 'nearest' }); }
        });
      }
      function shellPaletteRender() {
        const list = shellEl('shell-palette-list'), input = shellEl('shell-palette-input');
        const found = shellFilter(shellReg.list(), input.value);
        const groups = [], at = new Map();
        found.forEach(function (c) { const g = c.group || 'Other'; if (!at.has(g)) { at.set(g, groups.length); groups.push({ name: g, items: [] }); } groups[at.get(g)].items.push(c); });
        palFlat = [].concat.apply([], groups.map(function (g) { return g.items; }));
        list.textContent = '';
        if (!palFlat.length) {
          const none = document.createElement('div'); none.className = 'pal-none'; none.textContent = 'Nothing found'; list.appendChild(none);
          input.removeAttribute('aria-activedescendant'); return;
        }
        let n = 0;
        groups.forEach(function (g) {
          const h = document.createElement('div'); h.className = 'pal-group'; h.setAttribute('role', 'presentation'); h.textContent = g.name; list.appendChild(h);
          g.items.forEach(function (c) {
            const i = n++;
            const row = document.createElement('div'); row.className = 'pal-row'; row.id = 'pal-opt-' + i; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false');
            const lab = document.createElement('span'); lab.className = 'pal-label'; lab.textContent = c.label;
            const key = document.createElement('span'); key.className = 'pal-key';
            row.appendChild(lab); row.appendChild(key);
            row.addEventListener('mousemove', function () { if (palSel !== i) shellPaletteSelect(i); });
            row.addEventListener('click', function () { shellPaletteRun(c); });
            list.appendChild(row);
          });
        });
        shellPaletteSelect(Math.min(palSel, palFlat.length - 1));
      }
      function shellPaletteShow() {
        const p = shellEl('shell-palette'), input = shellEl('shell-palette-input');
        if (!p || !input) return;
        palReturn = document.activeElement;
        shellHelp(false); statusPopovers(false);
        input.value = ''; palSel = 0; p.hidden = false;
        shellPaletteRender(); input.focus();
      }
      function shellPaletteClose() {
        const p = shellEl('shell-palette');
        if (!p || p.hidden) return;
        p.hidden = true;
        const back = palReturn; palReturn = null;
        if (back && back.focus && back.isConnected !== false) { try { back.focus(); } catch (_) {} }   // focus goes back to where it was
      }
      function shellPaletteRun(c) {
        shellPaletteClose();
        try { const r = c.run(); if (r && typeof r.catch === 'function') r.catch(function (e) { console.error(e); }); } catch (e) { console.error(e); }
      }

      // ── status bar: server providers + page items, one list, one renderer, one saved layout ─────────
      const STATUS_POLL_MS = 10000;
      const STATUS_WORDS = { ok: 'ok', warn: 'warning', bad: 'not working', off: 'off', unknown: 'unknown' };
      let statusMeta = [], statusReadings = {}, statusSaved = null, statusDown = false, statusBusy = false, statusTipFor = '';
      const pageStatusItems = new Map();
      const statusEls = new Map();   // id -> { el, sig }: items are updated in place so keyboard focus survives a poll

      // facts only the page knows: window.registerStatusItem({ id, label, kind, order, read() -> Reading }); read is sync and called on every render
      window.registerStatusItem = function (it) {
        if (!it || typeof it.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(it.id) || typeof it.label !== 'string' || !it.label
          || ['dot', 'text', 'meter'].indexOf(it.kind) < 0 || typeof it.read !== 'function') return false;
        pageStatusItems.set(it.id, { id: it.id, label: it.label, kind: it.kind, order: typeof it.order === 'number' ? it.order : 1000, read: it.read, click: it.click });
        renderStatusBar();
        return true;
      };
      // server items win an id clash
      function statusItems() {
        const ids = new Set(statusMeta.map(function (m) { return m.id; }));
        const out = statusMeta.slice();
        pageStatusItems.forEach(function (it) { if (!ids.has(it.id)) out.push(it); });
        return out;
      }
      function statusReading(it) {
        let r = null;
        if (it.read) { try { r = it.read(); } catch (_) { r = null; } } else r = statusReadings[it.id];
        return r && typeof r === 'object' && typeof r.state === 'string' ? r : null;
      }
      function statusFill(el, it, rd) {
        const word = STATUS_WORDS[rd.state] || rd.state;
        el.setAttribute('data-state', rd.state); el.setAttribute('data-kind', it.kind);
        el.title = it.label + ': ' + word + (rd.tip ? ' - ' + rd.tip : '');
        el.setAttribute('aria-label', (rd.text || it.label) + ' - ' + word);
        el.textContent = '';
        const span = function (cls, txt) { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = txt; return s; };
        if (it.kind === 'dot') { const d = document.createElement('i'); d.className = 'st-dot'; d.setAttribute('aria-hidden', 'true'); el.appendChild(d); el.appendChild(span('st-val', rd.text)); }
        else if (it.kind === 'meter') {
          el.appendChild(span('', it.label.toLowerCase()));
          const m = document.createElement('span'); m.className = 'st-meter'; m.setAttribute('aria-hidden', 'true');
          const f = document.createElement('i'); f.style.width = Math.max(0, Math.min(100, rd.max > 0 ? (rd.value / rd.max) * 100 : 0)) + '%'; m.appendChild(f);
          el.appendChild(m); el.appendChild(span('st-val', rd.text));
        } else {   // text: the first word is the muted label, the rest the value
          const sp = rd.text.indexOf(' ');
          if (sp > 0) { el.appendChild(span('', rd.text.slice(0, sp))); el.appendChild(span('st-val', rd.text.slice(sp + 1))); } else el.appendChild(span('st-val', rd.text));
        }
      }
      function renderStatusBar() {
        const host = shellEl('status-items');
        if (!host) return;
        const items = statusItems();
        const byId = {}; items.forEach(function (it) { byId[it.id] = it; });
        const want = [];
        if (statusDown) want.push({ it: { id: '_down', label: 'Status', kind: 'text' }, rd: { state: 'unknown', text: 'status unavailable', tip: 'Phoenix did not answer GET /status.' } });
        statusLayout(items, statusSaved).forEach(function (e) {
          if (!e.shown) return;
          const it = byId[e.id]; let rd = statusReading(it);
          if (!rd || typeof rd.text !== 'string' || (rd.state === 'off' && !rd.text)) return;   // off with no text is not drawn
          if (!rd.text) rd = Object.assign({}, rd, { text: it.label.toLowerCase() });   // any other state with no text still gets a name
          want.push({ it: it, rd: rd });
        });
        const keep = new Set(want.map(function (w) { return w.it.id; }));
        statusEls.forEach(function (v, id) { if (!keep.has(id)) { if (v.el.parentNode) v.el.parentNode.removeChild(v.el); statusEls.delete(id); } });
        want.forEach(function (w, i) {
          let v = statusEls.get(w.it.id);
          if (!v) {
            const el = document.createElement('button'); el.type = 'button'; el.className = 'btn btn-ghost btn-sm'; el.setAttribute('data-id', w.it.id);
            el.addEventListener('click', function () {
              const it = statusItems().find(function (x) { return x.id === w.it.id; });
              if (it && typeof it.click === 'function') it.click(); else statusTip(w.it.id, el);
            });
            v = { el: el, sig: '' }; statusEls.set(w.it.id, v);
          }
          const sig = JSON.stringify([w.it.kind, w.it.label, w.rd.state, w.rd.text, w.rd.value, w.rd.max, w.rd.tip]);
          if (sig !== v.sig) { v.sig = sig; statusFill(v.el, w.it, w.rd); }
          if (host.children[i] !== v.el) host.insertBefore(v.el, host.children[i] || null);
        });
      }

      // click on an item: a small tip popover (inverse pair) with its tip, or the state in words
      function statusTip(id, el) {
        const tip = shellEl('status-tip');
        if (!tip) return;
        if (!tip.hidden && statusTipFor === id) { tip.hidden = true; return; }
        const it = statusItems().find(function (x) { return x.id === id; }) || { label: 'Status' };
        const rd = id === '_down' ? { state: 'unknown', text: '', tip: 'Phoenix did not answer GET /status.' } : (statusReading(it) || { state: 'unknown' });
        tip.textContent = rd.tip || (it.label + ': ' + (STATUS_WORDS[rd.state] || rd.state));
        statusTipFor = id; tip.hidden = false;
        const bar = shellEl('status-bar').getBoundingClientRect(), r = el.getBoundingClientRect();
        tip.style.left = Math.max(8, Math.min(Math.round(r.left - bar.left), Math.round(bar.width - 436))) + 'px';
      }

      async function statusPoll() {
        if (document.hidden || statusBusy) return;
        statusBusy = true;
        try {
          const r = await fetch('/status');
          const j = r.ok ? await r.json() : null;
          if (j && j.items && typeof j.items === 'object') { statusReadings = j.items; statusDown = false; if ((statusReadings.blender || {}).state === 'ok' && window.__levelsRefreshOpen) window.__levelsRefreshOpen(false); } else statusDown = true;
          if (!statusDown) {   // idle jobs clear a stale "a generation is already running" on the Storyboard and the export line
            try {
              const idle = !!(statusReadings.jobs && statusReadings.jobs.state === 'off');
              if (window.__animaticExport && typeof window.__animaticExport.jobState === 'function') window.__animaticExport.jobState(idle);
              if (typeof storyboardTab !== 'undefined' && storyboardTab && typeof storyboardTab.jobState === 'function') storyboardTab.jobState(idle);
            } catch (_) {}
          }
        } catch (_) { statusDown = true; }
        // 'unknown' (busy / no clear answer) is not proof that Blender is gone - only bad / off / missing clears the open level
        finally { if ((statusDown || ['bad', 'off', undefined].indexOf((statusReadings.blender || {}).state) >= 0) && window.__levelsBlenderGone) window.__levelsBlenderGone(); statusBusy = false; renderStatusBar(); createPipe.set({ blender: statusDown ? 'unknown' : (statusReadings.blender || {}).state }); }
      }
      async function statusLoadMeta() {
        try {
          const r = await fetch('/status/items');
          const j = r.ok ? await r.json() : null;
          if (Array.isArray(j)) statusMeta = j.filter(function (m) { return m && typeof m.id === 'string' && typeof m.label === 'string' && ['dot', 'text', 'meter'].indexOf(m.kind) >= 0; })
            .map(function (m) { return { id: m.id, label: m.label, kind: m.kind, order: typeof m.order === 'number' ? m.order : 1000 }; });
        } catch (_) {}
        // the readings of a server item come from statusReadings (no read function on the meta)
        renderStatusBar();
      }
      async function statusLoadSaved() {
        try {
          const r = await fetch('/config');
          const c = r.ok ? await r.json() : null;
          if (c) createPipe.set({ gates: c.gates || {} });
          const sb = c && c.ui && c.ui.statusBar;
          if (sb && Array.isArray(sb.order) && Array.isArray(sb.hidden)) statusSaved = { order: sb.order, hidden: sb.hidden };
        } catch (_) {}
      }

      // Customize: every provider with a toggle + up / down; every change saves at once ("Saved ✓", rules §6)
      let statusSavedTimer = null;
      function statusSaveNote(txt) {
        const n = shellEl('status-saved'); if (!n) return;
        n.textContent = txt;
        clearTimeout(statusSavedTimer); statusSavedTimer = setTimeout(function () { n.textContent = ''; }, 2500);
      }
      async function statusSaveLayout(entries, focusId, fallbackId) {
        const known = new Set(entries.map(function (e) { return e.id; }));
        const keepO = ((statusSaved && statusSaved.order) || []).filter(function (id) { return !known.has(id); });   // a provider removed for a while keeps its place
        const keepH = ((statusSaved && statusSaved.hidden) || []).filter(function (id) { return !known.has(id); });
        statusSaved = {
          order: entries.map(function (e) { return e.id; }).concat(keepO).slice(0, 64),
          hidden: entries.filter(function (e) { return !e.shown; }).map(function (e) { return e.id; }).concat(keepH).slice(0, 64),
        };
        renderStatusBar(); statusCustomRows(focusId, fallbackId);
        try {
          const r = await fetch('/status/layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(statusSaved) });
          if (r.ok) { statusSaveNote('Saved ✓'); statusLoadMeta(); } else statusSaveNote('Not saved');
        } catch (_) { statusSaveNote('Not saved'); }
      }
      function statusCustomRows(focusId, fallbackId) {
        const box = shellEl('status-custom');
        if (!box) return;
        const items = statusItems(), byId = {}; items.forEach(function (it) { byId[it.id] = it; });
        const entries = statusLayout(items, statusSaved);
        box.textContent = '';
        const head = document.createElement('div'); head.className = 'st-head'; head.textContent = 'Status bar'; box.appendChild(head);
        entries.forEach(function (e, i) {
          const it = byId[e.id];
          const row = document.createElement('div'); row.className = 'st-row';
          const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'toggle'; cb.id = 'st-tg-' + e.id; cb.checked = e.shown;
          cb.setAttribute('role', 'switch'); cb.setAttribute('aria-checked', e.shown ? 'true' : 'false');
          cb.addEventListener('change', function () { entries[i].shown = cb.checked; statusSaveLayout(entries, cb.id); });
          const lab = document.createElement('label'); lab.setAttribute('for', cb.id); lab.textContent = it.label;
          const mv = function (dir, text) {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-ghost btn-sm'; b.textContent = text;
            b.setAttribute('aria-label', 'Move ' + it.label + (dir < 0 ? ' up' : ' down')); b.id = 'st-' + (dir < 0 ? 'up-' : 'dn-') + e.id;
            b.disabled = dir < 0 ? i === 0 : i === entries.length - 1;
            b.addEventListener('click', function () { const o = entries.splice(i, 1)[0]; entries.splice(i + dir, 0, o); statusSaveLayout(entries, b.id, cb.id); });
            return b;
          };
          row.appendChild(cb); row.appendChild(lab); row.appendChild(mv(-1, '↑')); row.appendChild(mv(1, '↓'));
          box.appendChild(row);
        });
        if (focusId) { const f = shellEl(focusId); const g = shellEl(fallbackId || ''); if (f && !f.disabled) f.focus(); else if (g) g.focus(); }   // the rebuilt rows keep the keyboard where it was
      }
      // false closes both status popovers; true opens Customize
      function statusPopovers(openCustom) {
        const box = shellEl('status-custom'), btn = shellEl('status-customize'), tip = shellEl('status-tip');
        if (tip) tip.hidden = true;
        if (!box || !btn) return;
        if (openCustom) { statusCustomRows(); box.hidden = false; const f = box.querySelector('input'); if (f) f.focus(); } else box.hidden = true;
        btn.setAttribute('aria-expanded', openCustom ? 'true' : 'false');
      }

      window.__renderStatusBar = renderStatusBar;   // for code outside this closure (the remote UI in zz-tail)

      // ── wiring + default commands: after the whole page script has been evaluated ──────────────
      function shellRegisterDefaults() {
        const reg = window.registerShellCommand;
        SHELL_WORKSPACES.forEach(function (ws) {
          reg({ id: 'go:' + ws.id, label: ws.label, group: 'Go to', keywords: 'workspace open', run: function () { shellSelectWorkspace(ws.id); } });
          ws.modes.forEach(function (m) { if (m.disabled) return; reg({ id: 'go:' + ws.id + ':' + m.tab, label: ws.label + ' · ' + m.label, group: 'Go to', keywords: 'mode', run: function () { switchTab(m.tab); } }); });
        });
        const SETTINGS_KEYWORDS = { general: 'feedback theme themes colours colors dark light brass', brains: 'seats model provider orchestrator vision troubleshooter history tool steps', connections: 'comfyui blender endpoints mcp remote phone unreal',
          voice: 'speech engines', keys: 'api key openai meshy fal cloud paid', storage: 'checkpoints disk rewind' };
        SETTINGS_SECTIONS.forEach(function (s) {   // the six Settings sections (registry in js-57)
          reg({ id: 'settings:' + s.id, label: 'Settings · ' + s.label, group: 'Settings', keywords: SETTINGS_KEYWORDS[s.id] || '', run: function () { shellOpenSettings(s.id); } });
        });
        reg({ id: 'settings:quick', label: 'Quick switches', group: 'Settings', keywords: 'gates blender-only vision run mode', run: function () { toggleQuickSwitches(true); } });
        reg({ id: 'help:troubleshooter', label: 'Troubleshooter', group: 'Help', keywords: 'problem fix diagnose', run: function () { shellHelpRun('troubleshooter'); } });
        reg({ id: 'help:feedback', label: 'Feedback / bug report', group: 'Help', keywords: 'bug report send', run: function () { shellHelpRun('feedback'); } });
        reg({ id: 'help:onboarding', label: 'Setup (onboarding)', group: 'Help', keywords: 'first run install wizard', run: function () { shellHelpRun('onboarding'); } });
        if (typeof LIB_GROUPS !== 'undefined') LIB_GROUPS.forEach(function (g) {
          reg({ id: 'library:' + g.id, label: 'Library · ' + g.label, group: 'Library', keywords: g.tabs.map(function (t) { return t.label; }).join(' '), run: function () { shellOpenLibrary(g.id); } });
        });
        reg({ id: 'view:copilot', label: 'Show / hide Copilot', group: 'View', keywords: 'chat assistant', run: function () { shellToggleCopilot(); } });
        reg({ id: 'view:log', label: 'Show / hide log', group: 'View', keywords: 'console debug', run: function () { const b = shellEl('console-title'); if (b) b.click(); } });
      }

      function shellBoot() {
        // page status items (R1: Blender-only replaces the header badge; a paired phone shows its session where the "Remote" badge used to be)
        window.registerStatusItem({ id: 'mode', label: 'Mode', kind: 'text', order: 5, read: function () {
          return blenderOnly ? { state: 'warn', text: 'Blender-only', tip: 'Blender-only mode: the image and 3D generation tools are off (Quick switches).' } : { state: 'off', text: '' };
        } });
        window.registerStatusItem({ id: 'phone', label: 'Remote session', kind: 'dot', order: 90, read: function () {
          const u = window.__remoteUi;
          return u && u.isRemote() ? { state: 'ok', text: 'Remote · ' + u.name(), tip: 'This page is a paired phone session.' } : { state: 'off', text: '' };
        } });
        shellRegisterDefaults();

        document.querySelectorAll('#rail [data-rail]').forEach(function (b) {
          b.addEventListener('click', function () {
            const id = b.getAttribute('data-rail');
            if (id === 'settings') shellOpenSettings();   // reopens the section you left
            else if (id === 'help') shellHelp();
            else shellSelectWorkspace(id);
          });
        });
        shellEl('help-menu').addEventListener('click', function (e) { const b = e.target.closest('[data-help]'); if (b) shellHelpRun(b.getAttribute('data-help')); });
        shellEl('help-menu').addEventListener('keydown', function (e) {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          const items = Array.prototype.slice.call(shellEl('help-menu').querySelectorAll('[data-help]'));
          const i = items.indexOf(document.activeElement);
          items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
        });
        shellEl('copilot-toggle').addEventListener('click', function () { shellToggleCopilot(); });
        shellEl('shell-search').addEventListener('click', shellPaletteShow);
        const pin = shellEl('shell-palette-input');
        pin.addEventListener('input', function () { palSel = 0; shellPaletteRender(); });
        pin.addEventListener('keydown', function (e) {
          if (e.key === 'ArrowDown') { e.preventDefault(); shellPaletteSelect(palSel + 1); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); shellPaletteSelect(palSel - 1); }
          else if (e.key === 'Enter') { e.preventDefault(); if (palFlat[palSel]) shellPaletteRun(palFlat[palSel]); }
          else if (e.key === 'Tab') e.preventDefault();   // the input is the only stop inside the palette
        });
        shellEl('shell-palette').addEventListener('mousedown', function (e) { if (e.target === shellEl('shell-palette')) shellPaletteClose(); });

        // the log drawer keeps its own toggle code; the status bar's button presses the drawer title
        const logBtn = shellEl('status-log'), wrap = shellEl('console-wrap');
        logBtn.addEventListener('click', function () { const t = shellEl('console-title'); if (t) t.click(); });
        const syncLog = function () { logBtn.setAttribute('aria-expanded', wrap && !wrap.classList.contains('collapsed') ? 'true' : 'false'); };
        if (wrap && typeof MutationObserver !== 'undefined') new MutationObserver(syncLog).observe(wrap, { attributes: true, attributeFilter: ['class'] });
        syncLog();
        shellEl('status-customize').addEventListener('click', function () { statusPopovers(shellEl('status-custom').hidden); });

        const chat = shellEl('chat-wrap');
        if (chat && typeof MutationObserver !== 'undefined') new MutationObserver(shellSyncCopilot).observe(chat, { attributes: true, attributeFilter: ['class'] });

        document.addEventListener('keydown', function (e) {
          if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
            if (document.querySelector('dialog[open]')) return;
            const tm = shellEl('tool-modal'); if (tm && !tm.hidden) return;
            const sw = shellEl('settings-win'); if (sw && !sw.hidden) return;
            e.preventDefault();
            if (palOpen()) shellPaletteClose(); else shellPaletteShow();
            return;
          }
          if (e.key !== 'Escape') return;
          if (palOpen()) { shellPaletteClose(); return; }
          const menu = shellEl('help-menu');
          if (menu && !menu.hidden) { shellHelp(false); const hb = document.querySelector('#rail [data-rail="help"]'); if (hb) hb.focus(); return; }
          const box = shellEl('status-custom'), tip = shellEl('status-tip');
          if (box && !box.hidden) { statusPopovers(false); shellEl('status-customize').focus(); return; }
          if (tip && !tip.hidden) tip.hidden = true;
        });
        document.addEventListener('click', function (e) {
          const menu = shellEl('help-menu');
          if (menu && !menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-rail="help"]')) shellHelp(false);
          const box = shellEl('status-custom');
          if (box && !box.hidden && !box.contains(e.target) && !e.target.closest('#status-customize')) statusPopovers(false);
          const tip = shellEl('status-tip');
          if (tip && !tip.hidden && !tip.contains(e.target) && !e.target.closest('#status-items > button')) tip.hidden = true;
        });

        // restore: the last workspace + its mode (switchTab renders), Copilot as it was left
        const t0 = shellState.modeByWorkspace[shellState.workspace];
        if (t0 && t0 !== 'prompt') switchTab(t0); else shellOnTab('prompt');
        if (shellState.copilotOpen === false && !shellChatCollapsed()) shellToggleCopilot(false);
        shellSyncCopilot();

        statusLoadSaved().then(statusLoadMeta).then(statusPoll);
        setInterval(statusPoll, STATUS_POLL_MS);
        document.addEventListener('visibilitychange', function () { if (!document.hidden) statusPoll(); });   // catches up when the tab comes back
      }
      Promise.resolve().then(shellBoot);
