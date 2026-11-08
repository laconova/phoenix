      // ── Per-stage workflow picker (v1.10 B2) — removed in B2r: the active workflow of a stage is chosen in Library → Workflows (<b2r-window>).
      // <b3-faq>
      // B3: the action row under an "Install failed" bubble — FAQ link (when the event carries faq_url) · Copy log · Open issue.
      // The log is fetched on click and copied; it is NEVER put in the issue URL (the user pastes it). deps: { fetch, document, clipboard, labelOf? }.
      function makeAcquireFailActions(deps) {
        const doc = deps.document;
        const ISSUE_BASE = 'https://github.com/laconova/phoenix/issues/new';
        function scrub(t) {   // the server already redacted; this is a second belt for text that reaches the issue URL
          return String(t == null ? '' : t)
            .replace(/Bearer\s+\S+/g, '[redacted]')
            .replace(/hf_[A-Za-z0-9]{20,}/g, '[redacted]')
            .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[redacted]')
            .replace(/(token|key|password)=\S+/gi, '$1=[redacted]');
        }
        function cutCodePoints(t, n) { return Array.from(String(t)).slice(0, n).join(''); }   // never splits a surrogate pair
        function issueUrl(evt) {
          let title = 'Install failed';
          try {
            const label = (deps.labelOf && deps.labelOf(evt.id)) || evt.label || evt.id;
            title = 'Install failed: ' + label;
            const body = [
              'Workflow: ' + evt.id,
              'Error: ' + cutCodePoints(scrub(evt.error), 500),
              'FAQ: ' + (evt.faq || 'none'),
              '',
              'Paste the copied log below.',
            ].join('\n');
            return ISSUE_BASE + '?title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body);
          } catch (_) {
            try { return ISSUE_BASE + '?title=' + encodeURIComponent(title); } catch (_2) { return ISSUE_BASE; }
          }
        }
        function render(evt) {
          if (!evt || evt.phase !== 'failed') return null;
          const wrap = doc.createElement('div');
          wrap.className = 'acquire-fail-actions';
          const row = doc.createElement('div');
          row.style.fontSize = '11px';
          row.style.margin = '2px 0 6px 8px';
          wrap.appendChild(row);
          function sep() { const sp = doc.createElement('span'); sp.textContent = ' · '; row.appendChild(sp); }
          if (typeof evt.faq_url === 'string' && evt.faq_url.indexOf('https://') === 0) {
            const a = doc.createElement('a');
            a.textContent = 'FAQ';
            a.setAttribute('href', evt.faq_url);
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener');
            row.appendChild(a);
            sep();
          }
          const copyBtn = doc.createElement('button');
          copyBtn.textContent = 'Copy log';
          copyBtn.className = 'lib-act-btn';
          let pre = null;
          function showPre(lines) {
            if (!pre) { pre = doc.createElement('pre'); pre.style.fontSize = '11px'; pre.style.userSelect = 'text'; wrap.appendChild(pre); }
            pre.textContent = lines.length ? lines.join('\n') : '(no log available)';
          }
          copyBtn.addEventListener('click', async function () {
            let lines = [];
            try {
              const r = await deps.fetch('/workflows/acquire-log?id=' + encodeURIComponent(evt.id));
              const j = await r.json();
              lines = (j && Array.isArray(j.lines)) ? j.lines.map(String) : [];
              await deps.clipboard.writeText(lines.join('\n'));
              copyBtn.textContent = 'Copied';
              setTimeout(function () { copyBtn.textContent = 'Copy log'; }, 2000);
            } catch (_) {
              showPre(lines);
            }
          });
          row.appendChild(copyBtn);
          sep();
          const issue = doc.createElement('a');
          issue.textContent = 'Open issue';
          issue.setAttribute('href', issueUrl(evt));
          issue.setAttribute('target', '_blank');
          issue.setAttribute('rel', 'noopener');
          row.appendChild(issue);
          return wrap;
        }
        return { render: render, issueUrl: issueUrl };
      }
      const acquireFailActions = makeAcquireFailActions({ fetch: function (u, o) { return fetch(u, o); }, document: document, clipboard: navigator.clipboard });
      // </b3-faq>
      libraryRefreshEl.addEventListener('click', refreshLibrary);

      // Initialize buttons as enabled
      setActionsEnabled(true);

      // Focus input on load
      inputEl.focus();
      refreshLibrary();
      initOnboarding();
