      // R1: the Unreal bridge indicator that lived here is the 'unreal' status provider now (status-providers/unreal.js, drawn by the status bar).

      // ── Voice engine line (v1.8.1 Stage 2d, + Library click-to-activate follow-up; v1.10 B2r: read-only) ────────────
      // Lives in the SFX/workbench tab's "Generate voice" body per build-spec decision #6 ("that tab makes voices"), but the actual
      // dispatch it selects (voice.js speak(), the rig /speak call) belongs to the Voice tab's Speak button — ONE state feeding both,
      // via window.__voiceEngine. Since B2r it is no longer a <select>: it shows the ACTIVE voice engine (cfg.workflows.voice) and a
      // "change in Library" button; the Library activates (and only ever activates an installed, non-blocked engine).
      //
      // Initial value prefers the PERSISTED default (active.voice) over a hardcoded "crispasr". A persisted id that has since gone
      // missing or blocked never wins silently — falls back to crispasr. window.__setVoiceEngineActive is the Library's hook to
      // push a fresh activation into this SAME state instead of running a second, disconnected selection.
      (function initVoiceEnginePicker() {
        const labelEl   = document.getElementById('voice-engine-label');
        const changeBtn = document.getElementById('voice-engine-change');
        if (!labelEl) return;
        window.__voiceEngine = 'crispasr';   // default until the registry loads — matches the server's own default
        const labels = {};
        // Seed (2026-09-26): the Voice tab's #vo-seed field is disabled while crispasr is active (voice packs have no seed knob).
        // wireVoicePanel installs this hook once it has wired the field; call it after every place `window.__voiceEngine` can change.
        function syncSeedDisable() { if (window.__vo_updateSeedDisabled) window.__vo_updateSeedDisabled(); }
        function showLabel() { labelEl.textContent = labels[window.__voiceEngine] || window.__voiceEngine || ''; }
        window.__setVoiceEngineActive = function (id) {
          if (!id) return;
          window.__voiceEngine = id;
          showLabel();
          syncSeedDisable();
        };
        (async function loadVoiceEngine() {
          try {
            const r = await fetch('/workflows');
            if (!r.ok) return;
            const reg = await r.json();
            const wfs   = (reg && reg.workflows) || {};
            const active = (reg && reg.active) || {};
            const ids = Object.keys(wfs).filter(id => wfs[id].stage === 'voice');
            ids.forEach(id => { labels[id] = wfs[id].label || id; });
            const persisted   = active.voice;
            const persistedOk = persisted && wfs[persisted] && wfs[persisted].stage === 'voice' && !wfs[persisted].blocked;
            window.__voiceEngine = persistedOk ? persisted : (ids.includes('crispasr') ? 'crispasr' : (ids.find(id => !wfs[id].blocked) || ids[0] || 'crispasr'));
            showLabel();
            syncSeedDisable();
          } catch (_) { /* leave the default crispasr in place */ }
        })();
        if (changeBtn) changeBtn.addEventListener('click', function () { if (window.__openWorkflowWindow) window.__openWorkflowWindow(window.__voiceEngine || 'crispasr', changeBtn); });
      })();

