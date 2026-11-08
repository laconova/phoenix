      // ── SSE ─────────────────────────────────────────────────────────────────

      const es = new EventSource('/events');

      syncRemeshStatus();   // M10: a reload during a remesh shows the badge (and the one chat line) again
      restoreRemeshConfig();   // sweep 2 G9
      es.addEventListener('open', function () { syncRemeshStatus(); releaseStaleUi(); if (typeof storyboardTab !== 'undefined') storyboardTab.serverEvent({ kind: 'storyboard', phase: 'reconnect' }); if (typeof window !== 'undefined' && window.__animaticExport) window.__animaticExport.refresh(true); });   // V1b-3: events missed while the stream was down - the open Storyboard reads the board once (no-op before it was ever opened)   // M10 D2: closes the load-time race (a job that started between load and the stream opening)

      es.onmessage = function (e) {
        let obj;
        try { obj = JSON.parse(e.data); } catch { return; }

        if (obj.kind === 'event') {
          if (obj.rec && obj.rec.cat === 'gate') { setGateWaiting(obj.rec.awaiting); switchTab(obj.rec.awaiting); }
          appendLogLine(obj.rec);
          return;
        }

        if (obj.kind === 'level-poster') { levelsTab.onPoster(obj); return; }
        if (obj.kind === 'brush-previews') { onBrushPreviews(obj); return; }
        if (obj.kind === 'character-previews') { if (window.__onCharacterPreviews) window.__onCharacterPreviews(obj); return; }
        if (obj.kind === 'artifact') {
          if (obj.slot === 'mesh' && window.__libInlinePreview && window.__libInlinePreview.take(obj)) return;
          // i2i result tiles are additive and belong to the Edit sub-tab's gallery — they must NOT
          // go through setArtifact (which would hijack the main image slot and switch tabs away).
          if (obj.slot === 'i2i-tile') { if (window.__i2iAddTile) window.__i2iAddTile(obj); return; }
          setArtifact(obj);
          if (obj.slot === 'mesh') refreshLibrary();
          else if (obj.slot === 'image' && obj.source !== 'library' && obj.source !== 'inspect') refreshImagesPanel();   // <lt-fixes> only a newly generated image (not Use/3D, not render checks)
          return;
        }

        if (obj.kind === 'reply') {
          settleActionOrigin(obj.action, obj.text, false, obj.requestId);
          if (obj.action === 'import_asset' && !/^(ERROR|[A-Z_]+_ERROR|BLENDER_UNREACHABLE|REJECTED|BUSY)/.test(String(obj.text || ''))) createPipe.set({ have: { scene: true } });
          if (obj.action === 'remesh_asset') clearRemeshProgress();   // D7: the in-place progress line goes away with the result
          const remeshFailed = obj.action === 'remesh_asset' && /^(ERROR|REJECTED|BUSY)/.test(String(obj.text || ''));
          if (remeshFailed) appendBubble('error', hideRefusalToken(obj.text));
          else appendBubble('phoenix', hideRefusalToken(obj.text));
          if (obj.context) { try { a2Meter.update(obj.context); } catch (_) {} }   // A2: context meter
          if (obj.stopped) appendBubble('busy-note', '⏸ Auto stopped: ' + (obj.stopped.reason || 'the render check did not confirm the last step'));
          if (!obj.background) releaseUi(obj.action);   // background notes (hy_motion) never held the lock
          if (!remeshFailed && !/^(ERROR|[A-Z_]+_ERROR|BLENDER_UNREACHABLE|REJECTED)/.test(String(obj.text || ''))) refreshLibrary();   // D7: a failed remesh changed nothing in the Library
          refreshCheckpoints();   // a scene-changing step may have added a checkpoint (M5)
          // A reply for i2i_edit means the run resolved WITHOUT a tile — an ERROR: string (bad
          // reference, etc.) comes back as a reply, not kind:'error'. Clear the "Editing… ~3–4 min"
          // status so it can't hang forever; the error text is already in the chat. (F5, 2026-08-06)
          if (obj.action === 'i2i_edit' && window.__i2iClearStatus) window.__i2iClearStatus();
          // Namenskollision beim Brush-Speichern: der Server lehnt ab, statt still zu
          // ueberschreiben. Hier bekommt der Operator die Entscheidung, die der Text
          // vorschlaegt — sonst steht in der UI ein Vorschlag, den die UI nicht ausfuehren kann.
          const rowOwned = obj.action === 'save_as_brush' && !!(window.__brushSaveRow && window.__brushSaveRow.ownsReply && window.__brushSaveRow.ownsReply(obj.text));
          if (obj.action === 'save_as_brush' && !rowOwned && !/REFUSED: the brush name/.test(obj.text || '')) window.__lastBrushSave = null;
          if (obj.action === 'save_as_brush' && /REFUSED: the brush name/.test(obj.text || '') && window.__lastBrushSave && !rowOwned) {
            const again = window.__lastBrushSave;
            window.__lastBrushSave = null;                  // nur EINE Rueckfrage pro Versuch
            // M2.2: the page's own inline confirm row (libInlineRow), same choice, same overwrite post
            const ask = typeof libInlineRow === 'function' ? libInlineRow : null;
            if (ask) ask({ host: messagesEl, kind: 'confirm', action: 'Replace', danger: true,
              label: 'A brush with that name already exists. Replace it? The old brush goes to the trash.',
              onDone: function () { postAction('save_as_brush', Object.assign({}, again, { overwrite: true })); } });
          }
          if (obj.action === 'hy_motion' && window.__phoenixStopGenClock) window.__phoenixStopGenClock();
          if (window.__phoenixRefreshAnims) window.__phoenixRefreshAnims();
          if (window.__phoenixRefreshRigs) window.__phoenixRefreshRigs();
          if (window.__phoenixRefreshChars) window.__phoenixRefreshChars();
          // The face preview is best-effort: it can fail (unsupported render engine, a scene that
          // refuses to render) while the human itself was built and staged perfectly well. Place
          // used to be unlocked ONLY by the preview artifact arriving, so a failed preview
          // dead-ended the documented Generate → Place flow with the figure stuck out of sight.
          // Keyed on the ACTION, not the reply text: a chat turn echoing the same wording must not
          // unlock a Place button that has nothing staged behind it.
          if (obj.action === 'make_human' && window.__charactersWs) window.__charactersWs.builtWithoutPreview(obj.text);
          return;
        }

        if (obj.kind === 'error') {
          settleActionOrigin(obj.action, obj.message, true, obj.requestId);
          if (obj.action === 'remesh_asset') clearRemeshProgress();
          appendBubble('error', 'Error: ' + readableReply(obj.message));
          releaseUi(obj.action);
          if (obj.action === 'i2i_edit' && window.__i2iClearStatus) window.__i2iClearStatus();
          if (obj.action === 'hy_motion' && window.__phoenixStopGenClock) window.__phoenixStopGenClock();
          return;
        }

        if (obj.kind === 'notice' && obj.progress === 'remesh') {   // D7: ONE line, updated in place
          onRemeshNotice(obj);
          return;
        }
        if (obj.kind === 'notice' && obj.level === 'error') { appendBubble('error', obj.text); return; }   // F1: e.g. the "maybe charged" warning
        if (obj.kind === 'notice') { appendBubble('phoenix', obj.text); refreshLibrary(); return; }

        // A call from an external agent over MCP (v1.9 M6): a marked line, never a user/assistant bubble and never chat history.
        if (obj.kind === 'mcp') {
          appendBubble('mcp', '🔌 MCP · ' + (obj.client || 'mcp') + ' · ' + (obj.tool || '') + (obj.phase === 'start' ? ' …' : '') + (obj.text ? '\n' + readableLines(obj.text) : ''));
          if (obj.phase === 'done') { refreshLibrary(); refreshCheckpoints(); }
          return;
        }

        // v1.10 V1b-3: a storyboard keyframe / video ended - the open Storyboard tab reads the board once; the Library shows the new image
        if (obj.kind === 'storyboard' && (obj.phase === 'export' || obj.phase === 'export-done')) {   // R6: the animatic export: the export controller only (no board reload); the finished file is a new Library video
          if (window.__animaticExport) window.__animaticExport.serverEvent(obj);
          if (obj.phase === 'export-done') refreshImagesPanel();
          return;
        }
        if (obj.kind === 'storyboard') { if (typeof storyboardTab !== 'undefined') storyboardTab.serverEvent(obj); if (obj.phase !== 'progress') refreshImagesPanel(); return; }

        if (obj.kind === 'chatreset') { messagesEl.textContent = ''; return; }   // LC2d T8-14: another page (or this one) started a new chat
        if (obj.kind === 'rewound') { onRewound(obj); return; }
        if (obj.kind === 'remote') { if (window.__remoteUi) window.__remoteUi.refresh(); return; }   // <r1-remote>

        if (obj.kind === 'acquire-progress') {
          const ui = window.__acqRows && window.__acqRows[obj.id];
          if (!ui) return;
          // Terminal events carry NO step (route-level complete/failed/cancelled) — tear the row down
          // and re-run the plan/deps check so the row reflects reality. Per-step events carry `step`.
          if (!obj.step && (obj.phase === 'complete' || obj.phase === 'failed' || obj.phase === 'cancelled')) {
            try { if (ui.cancelBtn) ui.cancelBtn.remove(); } catch (_) {}
            delete window.__acqRows[obj.id];
            if (obj.phase === 'failed') {
              const failBubble = appendBubble('error', 'Install failed for "' + obj.id + '"' + (obj.error ? ': ' + obj.error : ''));
              // v1.10 B3: FAQ / Copy log / Open issue row under the failure bubble.
              try { const failRow = acquireFailActions.render(obj); if (failRow) failBubble.after(failRow); } catch (_) {}
            }
            else if (obj.phase === 'cancelled') appendBubble('phoenix', 'Install cancelled for "' + obj.id + '".');
            else if (obj.summary && obj.summary.warnings && obj.summary.warnings.length) appendBubble('phoenix', 'Installed "' + obj.id + '" with warnings: ' + obj.summary.warnings.join(' · '));
            try { if (typeof loadWorkflowsTab === 'function') loadWorkflowsTab(); } catch (_) {}
            // v1.10 B2r: the detail window (if open for this workflow) rebuilds and, on failure, shows its FAQ / Copy log / Open issue row.
            try { if (window.__onAcquireTerminal) window.__onAcquireTerminal(obj); } catch (_) {}
            refreshLibrary();
            return;
          }
          const nm = (obj.step && obj.step.name) || '';
          if (ui.lineEl) {
            if (obj.phase === 'line')       ui.lineEl.textContent = (nm ? nm + ': ' : '') + String(obj.line || '').slice(0, 120);
            else if (obj.phase === 'warn')  { ui.lineEl.textContent = '⚠ ' + obj.warning; ui.lineEl.style.color = '#c98a2b'; }
            else if (obj.phase === 'done')  ui.lineEl.textContent = '✓ ' + nm;
            else if (obj.phase === 'skip')  ui.lineEl.textContent = '✓ ' + nm + ' (already present)';
            else if (obj.phase === 'manual') { ui.lineEl.textContent = '⚠ ' + nm + ' — install manually'; ui.lineEl.style.color = '#c98a2b'; }
            else if (obj.phase === 'cancelled') ui.lineEl.textContent = '✕ ' + nm + ' cancelled';
            else if (obj.phase === 'error') { ui.lineEl.textContent = '✕ ' + nm + ' failed'; ui.lineEl.style.color = '#e06c6c'; }
            else if (obj.phase === 'step-start') ui.lineEl.textContent = '· ' + nm + '…';
          }
          return;
        }

        // 'user' kind is ignored — we already appended optimistically on send
      };

      es.onerror = function () {
        // SSE reconnects automatically; no action needed
      };

