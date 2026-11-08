      // ── Troubleshooter chat ──────────────────────────────────────────────────

      // Persistent across close/reopen within the same browser session.
      let _tsMessages = [];   // full context sent to /troubleshoot (includes TOOL_RESULT entries)
      let _tsDisplay  = [];   // [{role:'user'|'phoenix', text}] — display-only transcript

      function _appendTsBubble(container, role, text) {
        const div = document.createElement('div');
        div.className = 'ts-bubble ts-bubble-' + role + (role === 'phoenix' && text === '…' ? ' ts-thinking' : '');
        div.textContent = text;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return div;
      }

      async function openTroubleshooter() {
        openModal('Troubleshooter');
        toolBody.innerHTML = '';

        // Build chat layout dynamically (avoids any static-DOM timing issues)
        const transcript = document.createElement('div');
        transcript.className = 'ts-transcript';

        const inputRow = document.createElement('div');
        inputRow.className = 'ts-input-row';

        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'ts-input';
        inp.placeholder = 'Ask a question…';

        const sendBtn = document.createElement('button');
        sendBtn.className = 'modal-btn';
        sendBtn.textContent = 'Send';

        inputRow.appendChild(inp);
        inputRow.appendChild(sendBtn);
        toolBody.appendChild(transcript);
        toolBody.appendChild(inputRow);

        // Re-render prior display messages (if session was already open before)
        for (const m of _tsDisplay) {
          _appendTsBubble(transcript, m.role, m.text);
        }

        async function sendTsMessage(userText) {
          if (!userText.trim()) return;
          inp.disabled = true;
          sendBtn.disabled = true;

          _appendTsBubble(transcript, 'user', userText);
          _tsDisplay.push({ role: 'user', text: userText });
          _tsMessages.push({ role: 'user', content: userText });

          const thinkingBubble = _appendTsBubble(transcript, 'phoenix', '…');

          try {
            const res = await fetch('/troubleshoot', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ messages: _tsMessages }),
            });
            const data = await res.json();
            thinkingBubble.remove();

            if (data.error) {
              const errText = '[Error] ' + data.error;
              _appendTsBubble(transcript, 'phoenix', errText);
              _tsDisplay.push({ role: 'phoenix', text: errText });
              // Roll back the user message we pushed (no server context update)
              _tsMessages.pop();
            } else {
              const replyText = data.text || '(no response)';
              _appendTsBubble(transcript, 'phoenix', replyText);
              _tsDisplay.push({ role: 'phoenix', text: replyText });
              _tsMessages = data.messages; // update to full server context
            }
          } catch (e) {
            thinkingBubble.remove();
            const errText = '[Error] ' + e.message;
            _appendTsBubble(transcript, 'phoenix', errText);
            _tsDisplay.push({ role: 'phoenix', text: errText });
            _tsMessages.pop(); // roll back user message
          }

          inp.disabled = false;
          sendBtn.disabled = false;
          inp.focus();
        }

        sendBtn.addEventListener('click', () => {
          const v = inp.value.trim();
          inp.value = '';
          sendTsMessage(v);
        });
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            const v = inp.value.trim();
            inp.value = '';
            sendTsMessage(v);
          }
        });

        // LLM-on-demand: show a fresh, colour-coded preflight status on open — no LLM call,
        // zero tokens. The Claude seat only fires when the user actually types a question.
        const statusBox = document.createElement('div');
        statusBox.className = 'ts-status';
        statusBox.textContent = 'Running preflight…';
        transcript.insertBefore(statusBox, transcript.firstChild);
        fetch('/preflight', { method: 'POST' })
          .then(r => r.json())
          .then(d => _renderPreflight(statusBox, d.output || '(no preflight output)'))
          .catch(e => { statusBox.textContent = 'Preflight failed: ' + e.message; });
        inp.focus();
      }

