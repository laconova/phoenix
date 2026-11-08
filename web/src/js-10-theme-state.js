      // ── Theme system ─────────────────────────────────────────────────────────

      const THEMES = {
        'orange-light': { name: 'Orange (Light)', vars: { '--ground':'#BDBDBD','--surface':'#E3E3E3','--raised':'#CFCFCF','--line':'#9A9A9A','--text':'#1F1F1F','--muted':'#3D3D3D','--inverse-bg':'#232323','--inverse-text':'#F2F2F2','--accent':'#FF7A18','--ok':'#1C7247','--warn':'#8A5A00','--bad':'#A3302B','--bg':'var(--ground)','--panel':'var(--surface)','--border-soft':'var(--line)','--outline':'var(--accent)','--accent-hover':'#E2660D' } },
        'dark-orange': { name: 'Dark + Orange', vars: { '--ground':'#121212','--surface':'#2A2A2A','--raised':'#1F1F1F','--line':'#3A3A3A','--text':'#EDEDED','--muted':'#A6A6A6','--inverse-bg':'#EDEDED','--inverse-text':'#161616','--accent':'#FF7A18','--ok':'#4CC38A','--warn':'#E5C454','--bad':'#EC6866','--bg':'var(--ground)','--panel':'var(--surface)','--border-soft':'var(--line)','--outline':'var(--accent)','--accent-hover':'#E2660D' } },
        'dark-teal': { name: 'Dark + Teal', vars: { '--ground':'#16191D','--surface':'#1F242A','--raised':'#1B1F24','--line':'#2D353D','--text':'#E6EDF3','--muted':'#8A98A6','--inverse-bg':'#EDEDED','--inverse-text':'#161616','--accent':'#1FB6A6','--ok':'#4CC38A','--warn':'#E5C454','--bad':'#E5605E','--bg':'var(--ground)','--panel':'var(--surface)','--border-soft':'var(--line)','--outline':'var(--accent)','--accent-hover':'#17968A' } },
        'light-blue': { name: 'Light + Blue', vars: { '--ground':'#ECECEC','--surface':'#FFFFFF','--raised':'#F5F5F5','--line':'#D0D0D0','--text':'#2A2A2A','--muted':'#6B6B6B','--inverse-bg':'#232323','--inverse-text':'#F2F2F2','--accent':'#2D7FF9','--ok':'#1C7247','--warn':'#8A5A00','--bad':'#A3302B','--bg':'var(--ground)','--panel':'var(--surface)','--border-soft':'var(--line)','--outline':'var(--accent)','--accent-hover':'#1C6AE0' } },
        'brass-dim': { name: 'Brass (Dim)', vars: { '--ground':'#2E2A24','--surface':'#3D3830','--raised':'#48423A','--line':'#5C5549','--text':'#F2EDE3','--muted':'#C4BAA6','--inverse-bg':'#F2EDE3','--inverse-text':'#17140F','--accent':'#D4A64A','--ok':'#5CCB94','--warn':'#F29E4C','--bad':'#F29996','--bg':'var(--ground)','--panel':'var(--surface)','--border-soft':'var(--line)','--outline':'var(--accent)','--accent-hover':'#B88C33' } },
        'brass-light': { name: 'Brass (Light)', vars: { '--ground':'#C9C2B4','--surface':'#E6E0D3','--raised':'#D6CFC0','--line':'#A39A88','--text':'#1F1B14','--muted':'#4A4235','--inverse-bg':'#26221A','--inverse-text':'#F3EEE3','--accent':'#B8892E','--ok':'#19643E','--warn':'#8A4200','--bad':'#A02F2A','--bg':'var(--ground)','--panel':'var(--surface)','--border-soft':'var(--line)','--outline':'var(--accent)','--accent-hover':'#9A7022' } },
      };
      const THEME_STORAGE_KEY = 'phoenix-theme';
      let _currentTheme = 'orange-light';
      let _themePicked = false;   // the user chose a theme in this page: a late config answer must not override it

      // <theme-pure>
      // The theme to show: the one saved in Phoenix wins, then this browser's, then the default.
      function pickTheme(configTheme, storedTheme, themes) {
        const has = function (k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(themes, k); };
        if (has(configTheme)) return configTheme;
        if (has(storedTheme)) return storedTheme;
        return 'orange-light';
      }
      // </theme-pure>

      function applyTheme(key) {
        const t = THEMES[key]; if (!t) return;
        for (const [k, v] of Object.entries(t.vars)) document.documentElement.style.setProperty(k, v);
        for (const k of ['--inverse-bg', '--inverse-text']) if (!(k in t.vars)) document.documentElement.style.removeProperty(k);   // <lc2c-inverse> a theme without the pair falls back to the :root default
        _currentTheme = key;
        try { localStorage.setItem(THEME_STORAGE_KEY, key); } catch (_) {}
      }

      // Apply saved (or default) theme immediately on load
      try { applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || 'orange-light'); } catch (_) { applyTheme('orange-light'); }

      // Then the theme saved in Phoenix (the same in every browser / on the phone); applied only if it differs
      (async function loadConfigTheme() {
        try {
          const r = await fetch('/config');
          if (!r.ok) return;
          const c = await r.json();
          let stored = null; try { stored = localStorage.getItem(THEME_STORAGE_KEY); } catch (_) {}
          const want = pickTheme(c && c.ui && c.ui.theme, stored, THEMES);
          if (!_themePicked && want !== _currentTheme) applyTheme(want);
        } catch (_) {}
      })();

      // ── The VRAM ledger, in one line ─────────────────────────────────────────
      //
      // The 10 GB card is shared: this app, ComfyUI, and the batch queue all want
      // it. Until 2026-07-27 a busy card meant a silent hang — you pressed a
      // button and nothing happened for minutes. Now the audio service reports
      // the ledger in /health, and both audio tabs show it in their status line.
      //
      // ONE implementation, two callers (Voice and Sound). Written twice, the two
      // wordings drift and one of them ends up lying.
      function cardStatusText(health) {
        if (!health) return '';
        // Our own service busy beats everything else — it is the nearer cause.
        if (health.busy) return ' · card busy (' + (health.busyWith || 'a job') + ')';
        const k = health.kasse;
        if (!k) return '';
        if (k.aus) return ' · ledger unavailable';
        const held = (k.halter && k.halter.length) ? k.halter.join(', ') : null;
        // One decimal always — '7/9.6' next to '2.6/9.6' reads like two different units.
        return ' · card ' + Number(k.freiGb).toFixed(1) + '/' + Number(k.gesamtGb).toFixed(1) + ' GB free'
             + (held ? ' · held by ' + held : '');
      }

      // Why THIS action will have to wait — or null if it can start right away.
      // `action` is one of the keys the service reports under kasse.braucht:
      // speak · bake · cast · sfx.
      //
      // Deliberately a hint, not a gate: the service asks ComfyUI to release the
      // card and often gets it, so a "will wait" here still frequently succeeds
      // within seconds. Blocking the button on this would refuse work that would
      // have gone through.
      function cardWaitReason(health, action) {
        if (!health) return null;
        if (health.busy) return 'The card is busy with ' + (health.busyWith || 'another job') + '.';
        const k = health.kasse;
        if (!k || k.aus) return null;
        const need = k.braucht && k.braucht[action];
        if (!need || typeof need.gb !== 'number') return null;
        if (need.gb <= k.freiGb) return null;
        const held = (k.halter && k.halter.length) ? k.halter.join(', ') : 'another process';
        return action + ' needs ' + Number(need.gb).toFixed(1) + ' GB, '
             + Number(k.freiGb).toFixed(1) + ' GB free — ' + held
             + ' holds the card. Asking it to release…';
      }

      // ── Debug console collapse toggle (starts collapsed) ─────────────────────

      const consoleWrapEl  = document.getElementById('console-wrap');
      const consoleTitleEl = document.getElementById('console-title');
      const consoleCaretEl = document.getElementById('console-caret');

      function updateConsoleCaret() {
        const collapsed = consoleWrapEl.classList.contains('collapsed');
        if (consoleCaretEl) consoleCaretEl.textContent = collapsed ? '▸' : '▾';
      }

      consoleTitleEl.addEventListener('click', function () {
        consoleWrapEl.classList.toggle('collapsed');
        updateConsoleCaret();
        if (!consoleWrapEl.classList.contains('collapsed')) {
          consoleEl.scrollTop = consoleEl.scrollHeight;
        }
      });

      updateConsoleCaret();

      // ── Run mode state (v1.9 M4) ─────────────────────────────────────────────
      // runMode = the Copilot's Ask | Auto toggle: it applies to the next sends AND is saved (it is the one home of gates.mode, R2).
      // visionGateVal mirrors the render-vision setting so the Auto warning can follow either change.
      let runMode = 'ask';
      let visionGateVal = 'focused';
      function refreshAutoWarn() {
        const w = document.getElementById('auto-warn');
        if (w) w.hidden = !(runMode === 'auto' && visionGateVal === 'off');
      }
      function setRunMode(m, save) {
        runMode = (m === 'auto') ? 'auto' : 'ask';
        const ba = document.getElementById('mode-ask'), bu = document.getElementById('mode-auto');
        if (ba) ba.setAttribute('aria-pressed', runMode === 'ask' ? 'true' : 'false');
        if (bu) bu.setAttribute('aria-pressed', runMode === 'auto' ? 'true' : 'false');
        refreshAutoWarn();
        if (save) saveRunMode();
      }
      // The toggle remembers itself: POST { gates: { mode } }. The choice stays applied when the save fails; the line under the toggle says so.
      async function saveRunMode() {
        const err = document.getElementById('run-mode-err');
        const req = settingBody('gates.mode', runMode);
        try {
          const r = await fetch(req.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
          let j = {}; try { j = await r.json(); } catch (_) {}
          if (err) err.textContent = r.ok ? '' : 'Not remembered: ' + ((j && j.error) || ('the server refused it (' + r.status + ')')) + '.';
        } catch (_) { if (err) err.textContent = 'Not remembered: Phoenix is not reachable.'; }
      }
      function setVisionGateVal(v) { visionGateVal = ['off', 'focused', 'full'].includes(v) ? v : 'focused'; refreshAutoWarn(); }
      document.getElementById('mode-ask').addEventListener('click', function () { if (runMode !== 'ask') setRunMode('ask', true); });
      document.getElementById('mode-auto').addEventListener('click', function () { if (runMode !== 'auto') setRunMode('auto', true); });
      // Initial value = the config default; read once at page start.
      (async function initRunMode() {
        try {
          const res = await fetch('/config');
          if (!res.ok) return;
          const c = await res.json();
          const g = c.gates || {};
          setVisionGateVal(g.vision);
          setRunMode(g.mode);
        } catch (_) {}
      })();

      // ── Blender-only mode state ──────────────────────────────────────────────

      let blenderOnly = false;
      // R1: the "Blender-only" indicator is the status bar's page item 'mode' (js-05-shell.js); it re-reads blenderOnly on every render
      function updateModeIndicator() { if (typeof renderStatusBar === 'function') renderStatusBar(); }
      // single source of truth — keeps the status bar item AND the gear checkbox in sync
      function setBlenderOnly(on) {
        blenderOnly = !!on;
        updateModeIndicator();
        const cb = document.getElementById('gate-notool');
        if (cb) cb.checked = blenderOnly;
      }

