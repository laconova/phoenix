      // ── Feedback / Bug report ─────────────────────────────────────────────────

      // <g5-feedback-mail>
      // G5: without a feedback endpoint the dialog offers "Send by email": the full report goes to the clipboard and a mailto: draft opens
      // with as much as fits in the URL. Phoenix itself sends nothing. deps: { document, clipboard, openUrl }.
      function makeG5FeedbackMail(deps) {
        const DEFAULT_TO = 'info@laconova.com', MAX_URL = 1800;
        const ADDR_RE = /^[^\s\x00-\x1f@<>"?&%=#\/\\:]+@[^\s\x00-\x1f@<>"?&%=#\/\\:]+\.[^\s\x00-\x1f@<>"?&%=#\/\\:]+$/;
        const TAIL = '\n\n(Full bug report copied to your clipboard — paste it below.)';
        function fullText(problem, contact, report) {
          return 'Problem: ' + problem + (contact ? '\nContact: ' + contact : '') + '\n\n' + report;
        }
        function versionOf(report) { const m = /^Version:[ \t]*(.*)$/m.exec(String(report || '')); return m ? m[1].trim() : ''; }
        // mailto: URL <= MAX_URL: problem + contact + the first lines of the report, cut to fit, then the clipboard note
        function mailUrl(to, problem, contact, report) {
          const subject = 'Phoenix ' + versionOf(report) + ' feedback';
          const head = 'Problem: ' + problem + (contact ? '\nContact: ' + contact : '') + '\n\n';
          const pre = head + String(report || '');
          const build = function (n) {
            if (n > 0 && n < pre.length) { const c = pre.charCodeAt(n - 1); if (c >= 0xd800 && c <= 0xdbff) n--; }   // never split a surrogate pair
            return 'mailto:' + encodeURIComponent(to).replace(/%40/g, '@') + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(pre.slice(0, n) + TAIL);
          };
          let lo = 0, hi = pre.length;
          if (build(hi).length <= MAX_URL) return build(hi);
          while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (build(mid).length <= MAX_URL) lo = mid; else hi = mid - 1; }
          const nlAt = pre.lastIndexOf('\n', lo - 1);
          if (nlAt >= head.length) lo = nlAt;   // cut the report at a line end when there is one
          return build(lo);
        }
        async function copyFull(text, preview) {
          try { await deps.clipboard.writeText(text); return true; }
          catch (_) {
            try { if (preview && preview.select) preview.select(); return !!deps.document.execCommand('copy'); } catch (e2) { return false; }
          }
        }
        // parts: { actRow, before (optional node to insert in front of), desc, contact, preview, statusEl, hint }, data: the /bugreport answer.
        // Returns the button, or null when an endpoint is configured (the normal Send path stays as it is).
        function attach(parts, data) {
          if (data && data.canSend) return null;
          const to = (data && typeof data.mailTo === 'string' && ADDR_RE.test(data.mailTo)) ? data.mailTo : DEFAULT_TO;
          const btn = deps.document.createElement('button');
          btn.id = 'fb-mail'; btn.className = 'modal-btn'; btn.textContent = 'Send by email';
          btn.addEventListener('click', async function () {
            const problem = String(parts.desc.value || '').trim();
            if (!problem) { parts.statusEl.textContent = '⚠️ Describe the problem first.'; return; }
            const contact = String(parts.contact.value || '').trim();
            const report = String(parts.preview.value || '');
            const copied = await copyFull(fullText(problem, contact, report), parts.preview);
            deps.openUrl(mailUrl(to, problem, contact, report));
            parts.statusEl.textContent = copied ? '✅ Mail draft opened — the full report is on your clipboard.' : '⚠️ Mail draft opened, but copying failed — use Copy bug report and paste it into the mail.';
          });
          if (parts.before && parts.actRow.insertBefore) parts.actRow.insertBefore(btn, parts.before); else parts.actRow.appendChild(btn);
          parts.hint.textContent = 'Send by email opens your mail program with a draft to ' + to + ' — you see everything before it goes out. Or copy the report and post it as a GitHub issue.';
          return btn;
        }
        return { attach: attach, mailUrl: mailUrl, fullText: fullText };
      }
      // </g5-feedback-mail>
      const g5FeedbackMail = makeG5FeedbackMail({ document: document, clipboard: navigator.clipboard, openUrl: function (u) { window.location.href = u; } });

      async function openFeedback() {
        openModal('Feedback / Bug report');
        toolBody.innerHTML = '';

        // Description textarea
        const descRow = document.createElement('div');
        descRow.className = 'set-row';
        const descLbl = document.createElement('label');
        descLbl.className = 'set-label';
        descLbl.textContent = 'Describe the problem';
        const desc = document.createElement('textarea');
        desc.id = 'fb-desc';
        desc.rows = 4;
        desc.className = 'fb-textarea';
        desc.placeholder = 'Describe the problem: what you did, what happened…';
        descRow.appendChild(descLbl);
        descRow.appendChild(desc);
        toolBody.appendChild(descRow);

        // Optional contact (for follow-up)
        const contactRow = document.createElement('div');
        contactRow.className = 'set-row';
        const contactLbl = document.createElement('label');
        contactLbl.className = 'set-label';
        contactLbl.textContent = 'Your email (optional — only if you want a reply)';
        const contact = document.createElement('input');
        contact.type = 'text';
        contact.id = 'fb-contact';
        contact.className = 'fb-textarea';
        contact.placeholder = 'you@example.com';
        contactRow.appendChild(contactLbl);
        contactRow.appendChild(contact);
        toolBody.appendChild(contactRow);

        // Technical details preview (readonly)
        const previewRow = document.createElement('div');
        previewRow.className = 'set-row';
        const previewLbl = document.createElement('label');
        previewLbl.className = 'set-label';
        previewLbl.textContent = 'Technical details included in the report:';
        const preview = document.createElement('textarea');
        preview.id = 'fb-preview';
        preview.rows = 8;
        preview.className = 'fb-textarea';
        preview.readOnly = true;
        preview.style.fontFamily = 'monospace';
        preview.value = 'Loading…';
        previewRow.appendChild(previewLbl);
        previewRow.appendChild(preview);
        toolBody.appendChild(previewRow);

        // Actions row: [Send feedback] [Copy bug report] buttons + status
        const actRow = document.createElement('div');
        actRow.className = 'modal-actions';
        const sendBtn = document.createElement('button');
        sendBtn.className = 'modal-btn';
        sendBtn.textContent = 'Send feedback';
        // Shown only once /bugreport confirms an endpoint is configured — a Send button that can
        // only answer "not configured" is worse than no Send button.
        sendBtn.style.display = 'none';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'modal-btn';
        copyBtn.textContent = 'Copy bug report';
        const statusEl = document.createElement('span');
        statusEl.className = 'set-status';
        actRow.appendChild(sendBtn);
        actRow.appendChild(copyBtn);
        actRow.appendChild(statusEl);
        toolBody.appendChild(actRow);

        // Hint
        const hint = document.createElement('p');
        hint.className = 'set-hint';
        hint.textContent = 'Copy the report and send it wherever you like — the GitHub issues page is the usual place.';
        toolBody.appendChild(hint);

        // Fetch technical details from /bugreport on open
        try {
          const r = await fetch('/bugreport');
          const data = await r.json();
          if (r.ok && data.report) {
            preview.value = data.report;
            // Direct sending only exists if someone configured an endpoint to send to.
            if (data.canSend) {
              sendBtn.style.display = '';
              hint.textContent = 'Send delivers this straight to the configured feedback endpoint. Copy works too, if you would rather send it yourself.';
            } else {
              g5FeedbackMail.attach({ actRow: actRow, before: copyBtn, desc: desc, contact: contact, preview: preview, statusEl: statusEl, hint: hint }, data);
            }
          } else {
            preview.value = '(failed to load technical details: ' + (data.error || r.status) + ')';
          }
        } catch (e) {
          preview.value = '(failed to load technical details: ' + e.message + ')';
        }

        // Copy handler
        copyBtn.addEventListener('click', async function () {
          const full = (desc.value.trim() ? 'Problem: ' + desc.value.trim() + '\n\n' : '') + preview.value;
          try {
            await navigator.clipboard.writeText(full);
            statusEl.textContent = '✅ Copied to clipboard — paste it to send.';
          } catch (_) {
            try {
              preview.select();
              document.execCommand('copy');
              statusEl.textContent = '✅ Copied to clipboard — paste it to send.';
            } catch (e2) {
              statusEl.textContent = '⚠️ Copy failed — select the text manually.';
            }
          }
        });

        // Send handler — POSTs to the Phoenix server, which proxies to the configured endpoint
        sendBtn.addEventListener('click', async function () {
          const msg = desc.value.trim();
          if (!msg) { statusEl.textContent = '⚠️ Describe the problem first.'; return; }
          sendBtn.disabled = true;
          statusEl.textContent = 'Sending…';
          try {
            const r = await fetch('/feedback', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: msg, contact: contact.value.trim(), report: preview.value }),
            });
            const data = await r.json().catch(() => ({}));
            if (r.ok) {
              statusEl.textContent = '✅ Sent. Thank you!';
            } else if (r.status === 400 && /not configured/i.test(data.error || '')) {
              statusEl.textContent = '⚠️ No feedback endpoint set — add it in Settings, or use Copy.';
            } else {
              statusEl.textContent = '⚠️ ' + (data.error || ('Send failed (' + r.status + ')'));
            }
          } catch (e) {
            statusEl.textContent = '⚠️ Network error: ' + e.message;
          }
          sendBtn.disabled = false;
        });
      }

      // Render preflight text as colour-coded lines (PASS/WARN/FAIL). No LLM involved.
      function _renderPreflight(container, output) {
        container.textContent = '';
        for (const line of output.split('\n')) {
          const row = document.createElement('div');
          row.className = 'ts-status-line';
          if (line.includes('[PASS]'))      row.classList.add('pf-pass');
          else if (line.includes('[WARN]')) row.classList.add('pf-warn');
          else if (line.includes('[FAIL]')) row.classList.add('pf-fail');
          row.textContent = line;
          container.appendChild(row);
        }
      }

