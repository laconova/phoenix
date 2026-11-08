      // ── SFX panel → R5b: the one effect rack (makeEffectRack), used by every Audio mode ─────────────────────────────
      // The old SFX workbench (three sources, simple + advanced mixer, inline styles) is gone: Sound effects, Cast a new voice and Speak a line
      // are three modes of ONE panel (js-45, makeAudioWs) and each mode owns one instance of this rack. The rack edits a `chain` in the shape of
      // sound-fx.js (buildChain): { advanced: { <id>: { <param>: value } }, order: [<id>…] }. Pure DOM component: no timers, no fetch, nothing
      // at the top level that touches the page.

      // <r5b-rack>
      // deps: { document, root, catalogue: [effect objects as listEffects()], control: 'fader' | 'knob', onChange(chain) }
      //   -> { chain(), strips(), add(id), load(chain), clear(), setCatalogue(list), setControl(c), control() }
      function makeEffectRack(deps) {
        const doc = deps.document, root = deps.root;
        let catalogue = Array.isArray(deps.catalogue) ? deps.catalogue.slice() : [];
        let ctl = deps.control === 'knob' ? 'knob' : 'fader';
        const strips = [];   // { id, muted, params: { <name>: number | boolean } } in rack order
        let picking = false;

        function el(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
        function find(id) { return catalogue.find(function (e) { return e && e.id === id; }) || null; }
        function params(eff) { return (eff && Array.isArray(eff.parameter)) ? eff.parameter : []; }
        function isBool(p) { return p && p.unit === 'bool'; }
        function defaults(eff) { const o = {}; params(eff).forEach(function (p) { o[p.name] = p.default; }); return o; }
        function stepOf(p) { return (Number(p.max) - Number(p.min)) <= 2 ? 0.05 : 1; }
        function fmt(v) { return String(Math.round(Number(v) * 100) / 100); }
        function knobV(p, v) { const span = Number(p.max) - Number(p.min); return span > 0 ? Math.min(1, Math.max(0, (Number(v) - Number(p.min)) / span)) : 0; }
        function btn(label, variant, aria) {
          const b = el('button', 'btn ' + variant + ' btn-sm', label); b.type = 'button'; b.setAttribute('type', 'button');
          if (aria) b.setAttribute('aria-label', aria);
          return b;
        }

        // the chain handed to the engine: only unmuted strips; numbers stay numbers, a bool stays what it is (the catalogue default until it is toggled)
        function chain() {
          const live = strips.filter(function (s) { return !s.muted; });
          if (!live.length) return null;
          const advanced = {}, order = [];
          live.forEach(function (s) { const o = {}; Object.keys(s.params).forEach(function (k) { o[k] = s.params[k]; }); advanced[s.id] = o; order.push(s.id); });
          return { advanced: advanced, order: order };
        }
        function changed() { try { if (typeof deps.onChange === 'function') deps.onChange(chain()); } catch (_) { /* a listener must never break the rack */ } }

        // ── the DOM ──
        const stripsEl = el('div', 'rk-strips');
        const addWrap = el('div', 'rk-add');   // the wrapper takes the click (the button itself carries only the shared button classes)
        const addBtn = btn('+ effect', 'btn-secondary', null); addBtn.setAttribute('aria-expanded', 'false');
        addWrap.appendChild(addBtn);
        root.appendChild(stripsEl); root.appendChild(addWrap);
        let pickEl = null;

        function closePick() { picking = false; addBtn.setAttribute('aria-expanded', 'false'); if (pickEl) { pickEl.remove(); pickEl = null; } }
        function openPick() {
          picking = true; addBtn.setAttribute('aria-expanded', 'true');
          if (pickEl) pickEl.remove();
          pickEl = el('div', 'rk-pick');
          const groups = [];
          catalogue.forEach(function (e) { if (groups.indexOf(e.group) < 0) groups.push(e.group); });
          groups.forEach(function (g) {
            const box = el('div', 'rk-group');
            box.appendChild(el('div', 'rk-group-name', g));
            catalogue.filter(function (e) { return e.group === g; }).forEach(function (e) {
              const b = btn(e.label || e.id, 'btn-ghost', null); b.setAttribute('data-add', e.id);
              if (e.description) b.title = e.description;
              if (strips.some(function (s) { return s.id === e.id; })) { b.disabled = true; b.title = 'Already in the rack'; }
              b.addEventListener('click', function () { add(e.id); });
              box.appendChild(b);
            });
            pickEl.appendChild(box);
          });
          root.appendChild(pickEl);
        }
        addWrap.addEventListener('click', function () { if (picking) closePick(); else openPick(); });

        // show a moved value in the CURRENT DOM (readout, knob angle, and the control itself when another render replaced the one that moved)
        function paint(s, p, v) {
          const box = stripsEl.querySelector('.rk-strip[data-eff="' + s.id + '"]');
          if (!box) return;
          const out = box.querySelector('.rk-val[data-param="' + p.name + '"]'), inp = box.querySelector('input[data-param="' + p.name + '"]');
          if (out) out.textContent = fmt(v);
          if (inp) { if (Number(inp.value) !== v) inp.value = String(v); inp.style.setProperty('--v', String(knobV(p, v))); }
        }
        function renderStrip(s) {
          const eff = find(s.id);
          const label = eff ? (eff.label || eff.id) : s.id;
          const box = el('div', 'rk-strip'); box.setAttribute('data-eff', s.id); box.setAttribute('data-muted', s.muted ? 'true' : 'false');
          const nm = el('div', 'rk-name', label); if (eff) nm.title = (eff.group || '') + ' · ' + (eff.description || '');
          box.appendChild(nm);
          const ps = el('div', 'rk-params');
          params(eff).forEach(function (p) {
            const cell = el('div', 'rk-param');
            if (isBool(p)) {
              const sw = btn(p.name, 'btn-ghost', null); sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', s.params[p.name] ? 'true' : 'false'); sw.setAttribute('data-param', p.name);
              sw.addEventListener('click', function () {
                const next = !(s.params[p.name] ? true : false);
                s.params[p.name] = next; sw.setAttribute('aria-checked', next ? 'true' : 'false'); changed();
              });
              cell.appendChild(sw);
            } else {
              const inp = el('input', ctl === 'knob' ? 'rk-knob' : 'rk-fader');
              inp.type = 'range'; inp.setAttribute('type', 'range'); inp.setAttribute('data-control', ctl); inp.setAttribute('data-param', p.name);
              inp.min = String(p.min); inp.max = String(p.max); inp.step = String(stepOf(p)); inp.value = String(s.params[p.name]);
              inp.setAttribute('aria-label', label + ' ' + p.name);
              inp.style.setProperty('--v', String(knobV(p, s.params[p.name])));
              const out = el('span', 'rk-val', fmt(s.params[p.name])); out.setAttribute('data-param', p.name);
              const onMove = function () {
                const v = Number(inp.value);
                if (!isFinite(v) || v === s.params[p.name]) return;   // 'input' and 'change' both land here; only a real move counts
                s.params[p.name] = v; paint(s, p, v); changed();
              };
              inp.addEventListener('input', onMove); inp.addEventListener('change', onMove);
              cell.appendChild(inp); cell.appendChild(out);
              cell.appendChild(el('span', 'rk-plabel', p.name));
            }
            ps.appendChild(cell);
          });
          box.appendChild(ps);
          const bt = el('div', 'rk-btns');
          const act = function (a, text, verb, variant) { const b = btn(text, variant || 'btn-ghost', verb + ' ' + label); b.setAttribute('data-act', a); bt.appendChild(b); return b; };
          act('up', '↑', 'Move up').addEventListener('click', function () { move(s, -1); });
          act('down', '↓', 'Move down').addEventListener('click', function () { move(s, 1); });
          const mu = act('mute', 'M', 'Mute'); mu.setAttribute('aria-pressed', s.muted ? 'true' : 'false');
          mu.addEventListener('click', function () { s.muted = !s.muted; render(); changed(); });
          act('reset', '↺', 'Reset').addEventListener('click', function () { s.params = defaults(eff); render(); changed(); });
          act('remove', '×', 'Remove').addEventListener('click', function () { const i = strips.indexOf(s); if (i >= 0) strips.splice(i, 1); render(); changed(); });
          box.appendChild(bt);
          return box;
        }
        function render() {
          stripsEl.textContent = '';
          strips.forEach(function (s) { stripsEl.appendChild(renderStrip(s)); });
          if (picking) openPick();   // the open picker follows the rack (a strip added or removed changes which effects are taken)
        }
        function move(s, dir) {
          const i = strips.indexOf(s), j = i + dir;
          if (i < 0 || j < 0 || j >= strips.length) return;
          strips[i] = strips[j]; strips[j] = s;
          render(); changed();
        }
        function add(id) {
          const eff = find(id);
          if (!eff || strips.some(function (s) { return s.id === id; })) { closePick(); return; }
          strips.push({ id: id, muted: false, params: defaults(eff) });
          closePick(); render(); changed();
        }
        function load(c) {
          strips.length = 0;
          const adv = c && c.advanced && typeof c.advanced === 'object' ? c.advanced : {};
          (c && Array.isArray(c.order) ? c.order : []).forEach(function (id) {
            const eff = find(id);
            if (!eff || strips.some(function (s) { return s.id === id; })) return;
            const p = defaults(eff), given = adv[id] && typeof adv[id] === 'object' ? adv[id] : {};
            Object.keys(p).forEach(function (k) { if (given[k] !== undefined && (typeof given[k] === 'number' || typeof given[k] === 'boolean')) p[k] = given[k]; });
            strips.push({ id: id, muted: false, params: p });
          });
          render();
        }
        function clear() { strips.length = 0; render(); changed(); }
        function setCatalogue(list) {
          const next = Array.isArray(list) ? list.slice() : [];
          if (JSON.stringify(next) === JSON.stringify(catalogue)) return;   // the same list again (every refresh): leave the strips alone
          catalogue = next;
          for (let i = strips.length - 1; i >= 0; i--) if (!find(strips[i].id)) strips.splice(i, 1);
          render();
        }
        function setControl(c) {
          ctl = c === 'knob' ? 'knob' : 'fader';
          stripsEl.querySelectorAll('input[data-param]').forEach(function (inp) {
            inp.className = ctl === 'knob' ? 'rk-knob' : 'rk-fader'; inp.setAttribute('data-control', ctl);
          });
        }
        render();
        return {
          chain: chain,
          strips: function () { return strips.map(function (s) { const p = {}; Object.keys(s.params).forEach(function (k) { p[k] = s.params[k]; }); return { id: s.id, muted: s.muted, params: p }; }); },
          add: add, load: load, clear: clear, setCatalogue: setCatalogue, setControl: setControl, control: function () { return ctl; },
        };
      }

      // The take's chain as one short line: "radio 0.3 · pitch -2", "dry" without effects. Per effect the value of its FIRST numeric parameter
      // (catalogue order), two decimals at most.
      function rackChainLine(chain, catalogue) {
        const order = chain && Array.isArray(chain.order) ? chain.order : [];
        if (!order.length) return 'dry';
        const adv = chain.advanced && typeof chain.advanced === 'object' ? chain.advanced : {};
        return order.map(function (id) {
          const eff = (Array.isArray(catalogue) ? catalogue : []).find(function (e) { return e && e.id === id; });
          const p = eff && Array.isArray(eff.parameter) ? eff.parameter.find(function (x) { return x.unit !== 'bool'; }) : null;
          const v = p && adv[id] ? adv[id][p.name] : undefined;
          return v === undefined ? id : id + ' ' + String(Math.round(Number(v) * 100) / 100);
        }).join(' · ');
      }
      // </r5b-rack>
