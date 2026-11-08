      // ── Gate-waiting highlight ───────────────────────────────────────────────

      function setGateWaiting(stage) {
        createPipe.set({ awaiting: stage });
        document.querySelectorAll('.art-tab-btn').forEach(b => b.classList.toggle('gate-waiting', b.dataset.tab === stage));
      }

      function clearGateWaiting() {
        createPipe.set({ awaiting: null });
        document.querySelectorAll('.art-tab-btn').forEach(b => b.classList.remove('gate-waiting'));
      }

      // ── Settings panel ──────────────────────────────────────────────────────

      const quickBtn      = document.getElementById('quick-switches');   // R1: the top bar's Quick switches button opens the gates popover (it was the header gear)
      const settingsPanel = document.getElementById('settings-panel');
      const toolModal     = document.getElementById('tool-modal');
      const toolTitle     = document.getElementById('tool-title');
      const toolBody      = document.getElementById('tool-body');
      const toolClose     = document.getElementById('tool-close');

      // Fills every control of the Quick switches and the Settings window from GET /config (fillSettings, js-57: the registry decides which
      // control shows which key), plus the few things that are not a control.
      async function loadGates() {
        try {
          const res = await fetch('/config');
          if (!res.ok) return;
          const c = await res.json();
          const g = c.gates || {};
          fillSettings(c);
          setVisionGateVal(g.vision);   // the Copilot's Auto warning follows render vision
          document.getElementById('gate-notool').checked = blenderOnly;
          // Remesh group (M9): GET /config substitutes the defaults and never carries a key (only c.keys.meshy as a flag)
          const rmc = c.remesh || {};
          REMESH_ON = rmc.enabled === true;
          REMESH_DEFAULTS = { topology: rmc.topology === 'triangle' ? 'triangle' : 'quad', targetPolycount: rmc.targetPolycount !== undefined ? rmc.targetPolycount : 20000 };
          if (c.voice && window.__voSettings) window.__voSettings.render(c.voice);   // VO1b: Settings -> Voice engines
          if (typeof loadAssets === 'function') loadAssets();   // the Library's Remesh entry follows the opt-in
          if (typeof c.mcpScript === 'string' && c.mcpScript) {   // MCP group: the setup lines carry the real absolute path
            document.getElementById('mcp-line-claude').textContent = 'claude mcp add --scope user phoenix -- node "' + c.mcpScript + '"';
            document.getElementById('mcp-line-codex').textContent = 'codex mcp add phoenix -- node "' + c.mcpScript + '"';
            document.getElementById('mcp-line-cursor').textContent = JSON.stringify({ mcpServers: { phoenix: { command: 'node', args: [c.mcpScript] } } });
          }
        } catch (_) {}
      }

      // ── Info popups in the gates panel ───────────────────────────────────────
      // Long explanations would flood a panel that is meant to be scanned at a glance, so they
      // open on demand and close when you click anywhere else (user's call, 2026-07-31).
      function closeGatePops() {
        settingsPanel.querySelectorAll('.gate-pop').forEach(function (p) { p.hidden = true; });
      }
      settingsPanel.addEventListener('click', function (e) {
        const btn = e.target.closest('.gate-info');
        if (!btn) {
          // A click anywhere else inside the panel closes an open bubble, so it can never sit
          // there stale while the operator changes a different row.
          if (!e.target.closest('.gate-pop')) closeGatePops();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        const pop = document.getElementById(btn.dataset.pop);
        if (!pop) return;
        const wasOpen = !pop.hidden;
        closeGatePops();
        if (wasOpen) return;
        // Align the bubble with its own row rather than a fixed offset — the panel's height
        // changes with the gate list and a hard-coded top would drift.
        pop.style.top = (btn.offsetTop - 4) + 'px';
        pop.hidden = false;
      });
      document.addEventListener('click', function (e) {
        if (!e.target.closest('#settings-panel')) closeGatePops();
      });

      // open / close the gates popover (the rail, the top bar button and the Ctrl K palette all come through here)
      function toggleQuickSwitches(open) {
        const on = open === undefined ? settingsPanel.hidden : !!open;
        settingsPanel.hidden = !on;
        quickBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
        if (on) { loadGates(); if (window.__levelsRefreshOpen) window.__levelsRefreshOpen(true); if (window.__brushSaveRow) window.__brushSaveRow.refresh(); }
      }
      quickBtn.addEventListener('click', function () { toggleQuickSwitches(); });

      // R2: the gate / vision / Unreal switches save themselves one field at a time (commitControl, js-57); Blender-only is page state
      document.getElementById('gate-notool').addEventListener('change', function () { setBlenderOnly(this.checked); });

      document.addEventListener('click', function (e) {
        if (!settingsPanel.hidden && !settingsPanel.contains(e.target) && !quickBtn.contains(e.target)) {
          toggleQuickSwitches(false);
        }
      });

      // ── Modal (reusable) ─────────────────────────────────────────────────────

      function openModal(title) { toolTitle.textContent = title; toolModal.hidden = false; }
      function closeModal() { toolModal.hidden = true; }
      toolClose.addEventListener('click', closeModal);
      toolModal.addEventListener('click', e => { if (e.target === toolModal) closeModal(); });
