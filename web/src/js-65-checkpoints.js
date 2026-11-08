      // ── Checkpoints + rewind (v1.9 M5) ───────────────────────────────────────
      // The panel lists the scene copies Phoenix saved before scene-changing steps. Rewind is a USER action only.
      // Because a plain Ctrl+S inside a checkpoint copy would save into Phoenix's checkpoint folder instead of the
      // project file, EVERY rewind asks: stay in the copy, or overwrite the project file.
      let cpInCopy = false;
      function cpFmtSize(b) { b = Number(b) || 0; return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
      function cpFmtTime(at) { const d = new Date(at); return isNaN(d.getTime()) ? String(at || '') : d.toLocaleTimeString(); }
      function renderCheckpoints(data) {
        const items = (data && Array.isArray(data.items)) ? data.items : [];
        const list = document.getElementById('cp-list');
        const empty = document.getElementById('cp-empty');
        const summary = document.getElementById('cp-summary');
        list.textContent = '';
        for (const it of items) {
          const li = document.createElement('li');
          const cls = [];
          if (it.current) cls.push('cp-current');
          if (it.position === 'here') cls.push('cp-here');
          if (it.position === 'ahead') { cls.push('cp-ahead'); li.title = 'undone — the next action removes this'; }
          if (cls.length) li.className = cls.join(' ');
          const meta = document.createElement('span');
          meta.className = 'cp-meta';
          // a 'tip' is the latest state saved by a rewind, not a tool step
          meta.textContent = 'turn ' + it.turn + ' · ' + (it.kind === 'tip' ? 'latest state' : it.tool) + ' · ' + cpFmtTime(it.at) + ' · ' + cpFmtSize(it.bytes) + (it.current ? ' · current' : '') + (it.position === 'here' ? ' · you are here' : '');
          li.appendChild(meta);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'cp-rewind';
          btn.textContent = it.position === 'ahead' ? 'Redo to here' : (it.position === 'here' ? 'Reset to here' : 'Rewind here');
          btn.addEventListener('click', function () { openRewindDialog(it); });
          li.appendChild(btn);
          list.appendChild(li);
        }
        if (empty) empty.hidden = items.length > 0;
        if (summary) summary.textContent = 'Checkpoints (' + items.length + ')' + (data && data.enabled === false ? ' — off' : '');
        // The banner follows Blender's real state: it clears once no checkpoint copy is the open file any more.
        cpInCopy = !!(data && data.inCopy) || items.some(function (it) { return it.current; });
        const banner = document.getElementById('cp-banner');
        if (banner) banner.hidden = !cpInCopy;
      }
      async function refreshCheckpoints() {
        // Only while the Checkpoints panel is open (the read costs a Blender round trip). Exception: while the
        // "in a checkpoint copy" banner is up, so it can clear itself once Blender leaves the copy.
        const det = document.getElementById('cp-details');
        if (!(det && det.open) && !cpInCopy) return;
        try {
          const res = await fetch('/checkpoints');
          if (!res.ok) return;
          renderCheckpoints(await res.json());
        } catch (_) {}
      }
      async function doRewind(id, choice) {
        let res, body = {};
        try {
          res = await fetch('/rewind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, choice }) });
          try { body = await res.json(); } catch (_) {}
        } catch (err) { appendBubble('error', 'Network error: ' + err.message); return; }
        if (res.status === 409) { appendBubble('busy-note', (body && body.error && body.error !== 'busy') ? body.error : 'busy… try again in a moment'); return; }
        if (!res.ok) { appendBubble('error', 'Rewind: ' + ((body && body.error) || ('server error ' + res.status))); return; }
        // success: the 'rewound' SSE event reloads the chat and refreshes the list. A no-op (already there) sends no event: say so.
        if (body && body.note) { appendBubble('busy-note', body.note); refreshCheckpoints(); }
      }
      function openRewindDialog(it) {
        const dlg = document.getElementById('cp-dialog');
        const noProject = it.hasProject === false || it.projectPath === null;
        document.getElementById('cp-dialog-what').textContent = 'Back to before ' + it.tool + ' in turn ' + it.turn + ' (' + cpFmtTime(it.at) + ').';
        document.getElementById('cp-choice-overwrite').hidden = noProject;
        document.getElementById('cp-hint-overwrite').hidden  = noProject;
        document.getElementById('cp-noproject').hidden       = !noProject;
        const finish = function (choice) {
          if (typeof dlg.close === 'function') dlg.close(); else dlg.open = false;
          if (choice) doRewind(it.id, choice);
        };
        document.getElementById('cp-choice-stay').onclick      = function () { finish('stay'); };
        document.getElementById('cp-choice-overwrite').onclick = function () { finish('overwrite'); };
        document.getElementById('cp-choice-cancel').onclick    = function () { finish(null); };   // Cancel = nothing happens
        if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.open = true;
        const first = document.getElementById('cp-choice-stay');
        if (first && typeof first.focus === 'function') first.focus();
      }
      // The server cut the chat back: show the restored history instead of the undone exchange.
      function reloadChat(history) {
        messagesEl.textContent = '';
        for (const m of (Array.isArray(history) ? history : [])) {
          if (m && m.role === 'user') appendBubble('user', String(m.content));
          else if (m && m.role === 'assistant') appendBubble('phoenix', String(m.content));
        }
      }
      // <lc2d-newchat> T8-14: "New chat" in the chat header. Confirm only when there is something to lose; the SSE below clears every open page (laptop + phone).
      async function newChat() {
        const nonEmpty = messagesEl.querySelector ? !!messagesEl.querySelector('.bubble') : messagesEl.children.length > 0;
        if (nonEmpty && !window.confirm('Start a new chat? The conversation so far is cleared from the assistant memory. Your scene, checkpoints and storyboards stay as they are.')) return;
        try {
          const r = await fetch('/chat/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          let j = null; try { j = await r.json(); } catch (_) {}
          if (!r.ok) appendBubble('error', (j && j.error) || ('Could not start a new chat (HTTP ' + r.status + ')'));
        } catch (_) { appendBubble('error', 'Phoenix is not reachable - the chat was not cleared.'); }
      }
      { const nb = document.getElementById('chat-new'); if (nb) nb.addEventListener('click', newChat); }
      // </lc2d-newchat>
      function onRewound(obj) {
        reloadChat(obj.history);
        if (obj.choice === 'stay') { cpInCopy = true; const b = document.getElementById('cp-banner'); if (b) b.hidden = false; }
        refreshCheckpoints();
      }
      // ── Remesh settings (M9) ──  (R2: the switches save themselves through commitControl, js-57; this part keeps the page state they feed)
      var REMESH_ON = false, REMESH_DEFAULTS = { topology: 'quad', targetPolycount: 20000 };
      async function refreshRemeshBalance() {
        const el = document.getElementById('remesh-balance');
        if (!el) return;
        el.textContent = 'Meshy balance: …';
        try {
          const j = await (await fetch('/remesh-balance')).json();
          el.textContent = (j && j.ok && typeof j.balance === 'number') ? 'Meshy balance: ' + j.balance + ' credits' : 'balance unavailable';
        } catch (_) { el.textContent = 'balance unavailable'; }
      }
      document.getElementById('cp-details').addEventListener('toggle', function () { if (this.open) refreshCheckpoints(); });
      // Page load: ONE read that only restores the "in a checkpoint copy" banner / inCopy state (the banner must survive a
      // reload until Blender leaves the copy). The list itself is not rendered; the server bounds the read to 500 ms and
      // only takes it while the chat lock is free.
      async function loadCheckpointBanner() {
        try {
          const res = await fetch('/checkpoints');
          if (!res.ok) return;
          const data = await res.json();
          const items = (data && Array.isArray(data.items)) ? data.items : [];
          cpInCopy = !!(data && data.inCopy) || items.some(function (it) { return it.current; });
          const banner = document.getElementById('cp-banner');
          if (banner) banner.hidden = !cpInCopy;
        } catch (_) {}
      }
      loadCheckpointBanner();

