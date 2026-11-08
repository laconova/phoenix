      // <r4d-levels-pure>
      const LEVEL_STAGES = [{id:'blockout',label:'Blockout'}, {id:'movable',label:'Movable'}, {id:'detail',label:'Detail'}];
      function levelMetaText(level) { const n = (level.scenes || []).length; return n + (n === 1 ? ' scene' : ' scenes') + (level.edited && !isNaN(Date.parse(level.edited)) ? ' · edited ' + new Date(level.edited).toISOString().slice(0,10) : ''); }
      function levelStageText(open) { const s = open && ['level','scene'].includes(open.kind) && LEVEL_STAGES.find(function (s) { return s.id === open.stage; }); return s ? 'Stage: ' + s.label : ''; }
      function levelOrphanText(o) { return levelOrphanLabel(o) + "'s animation lost its object — it was renamed or deleted in the level."; }
      function levelOrphanLabel(o) { return o.slots && o.slots.length ? o.slots.map(function (s) { return s.slice(2); }).join(', ') : (o.slot ? o.slot.slice(2) : o.name); }
      function movableAnimLabel(names) { return names.slice(0,3).join(', ') + (names.length > 3 ? ' +' + (names.length - 3) + ' more' : ''); }
      function levelMovableAnimText(names) { return movableAnimLabel(names) + (names.length === 1 ? ' is' : ' are') + ' animated in the level — movable parts move per scene. Remove the animation here (Object ▸ Animation ▸ Clear Keyframes) and animate it in each scene.'; }
      function linkedMovableAnimText(names) { return movableAnimLabel(names) + "'s motion comes from the level, so it can't be keyed here. Clear it in the level, then reopen this scene."; }
      function levelsShouldPing(lastAt, now) { return now - lastAt >= 30000; }
      // </r4d-levels-pure>
      // <r4d-levels-ui>
      function makeLevelsTab(deps) {
        const doc = deps.document; let root = null, open = null, guard = null;
        function mk(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
        function button(cls, text) { const b = mk('button',cls,text); b.type = 'button'; return b; }
        function receive(o) { open = o; renderStage(o); if (deps.onOpenState) deps.onOpenState(o); }
        function errorAt(el, r) {
          const help = r.code === 'BLENDER_UNREACHABLE' ? {label:'How to connect Blender',run:deps.openTroubleshooter} : undefined;
          if (el.classList.contains('lib-levels-head')) { let msg = el.querySelector('.lib-msg'); if (!msg) { msg = mk('div','lib-msg'); msg.setAttribute('role','status'); el.appendChild(msg); } msg.textContent = (typeof readableReply === 'function' ? readableReply(r.error) : r.error) || 'The action failed.'; if (help) { const b = button('btn btn-secondary btn-sm',help.label); b.addEventListener('click',help.run); msg.appendChild(b); } }
          else deps.libTileProblem(el,(typeof readableReply === 'function' ? readableReply(r.error) : r.error) || 'The action failed.',help,'action');
        }
        function showGuard(el, trigger, url, body, untitled) {
          if (guard) guard.remove(); guard = mk('div','lib-inline lib-guard'); guard.setAttribute('role','group');
          guard.appendChild(mk('span','lib-inline-text','Blender has unsaved changes.' + (untitled ? ' Save and open is not possible because the scene was never saved.' : '')));
          function close() { if (guard) guard.remove(); guard = null; }
          [['save','Save and open','primary'],['discard','Open without saving','danger'],['cancel','Cancel','secondary']].forEach(function (c) {
            if (untitled && c[0] === 'save') return; const b = button('btn btn-' + c[2] + ' btn-sm',c[1]); b.dataset.choice = c[0];
            b.addEventListener('click',async function () { close(); if (c[0] !== 'cancel') { try { const fresh = await (await deps.fetch('/levels/open')).json(); const next = Object.assign({},body); if (!fresh.open || fresh.open.dirty) next.choice = c[0]; post(url,next,trigger,el); } catch(e) { errorAt(el,{error:e.message}); } } }); guard.appendChild(b);
          });
          guard.addEventListener('keydown',function (e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }); el.after(guard);
        }
        function showTrashGuard(el, trigger, url, body, message) {
          if (guard) guard.remove(); guard = mk('div','lib-inline'); guard.appendChild(mk('span','lib-inline-text',message));
          [['Trash anyway','danger'],['Cancel','secondary']].forEach(function (c,i) { const b = button('btn btn-' + c[1] + ' btn-sm',c[0]); b.addEventListener('click',function () { guard.remove(); guard = null; if (!i) post(url,Object.assign({},body,{force:true}),trigger,el); }); guard.appendChild(b); }); el.after(guard);
        }
        async function post(url, body, trigger, el) {
          trigger.setAttribute('aria-busy','true');
          try { const res = await deps.fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const r = await res.json();
            if ('open' in r) receive(r.open);
            // R4d3 P3: something was created -> reload the list FIRST, then show the problem / guard on the NEW element
            const reloaded = !!(r.created && root); let target = el;
            if (reloaded) { await load(root); const made = root.querySelector('[data-level="' + r.created.slug + '"]'); const node = r.created.scene ? (made && made.querySelector('[data-scene="' + r.created.scene + '"]')) : made; if (node) target = node; }
            if (r.needsChoice) { showGuard(target,trigger,r.retry ? r.retry.url : url,r.retry ? r.retry.body : body,r.untitled); return; }
            if (r.code === 'OPEN_UNKNOWN') { showTrashGuard(target,trigger,url,body,r.error); return; }
            if (!res.ok || r.ok === false) { errorAt(target,r); return; }
            deps.libTileProblemClear(target,'action'); if (root) {
              if (!reloaded) await load(root);
              if (r.convertError) { const tile = root.querySelector('[data-level="' + (r.slug || body.level || (r.open && r.open.slug)) + '"]'); const row = tile && tile.querySelector('[data-scene="' + (r.scene || body.scene || (r.open && r.open.scene)) + '"]'); if (row) deps.libTileProblem(row,"This scene's movable layer could not be made per scene — " + convertReason(r.convertError),undefined,'convert'); }
              const lines = (r.note ? [r.note] : []).concat(r.hints || []);
              if (lines.length) { const msg = mk('div','lib-msg'); msg.setAttribute('role','status'); lines.forEach(function (line) { msg.appendChild(mk('div','',line)); }); root.querySelector('.lib-levels-head').appendChild(msg); }
            }
          } catch (e) { errorAt(el,{error:e.message}); } finally { trigger.removeAttribute('aria-busy'); }
        }
        // G9: the raw Blender text can carry an internal token or the watch-folder path; the page shows the plain sentence (the server keeps the detail in its log)
        function convertReason(m) {
          let s = String(m == null ? '' : m);
          if (typeof readableReply === 'function') { const t = readableReply(s); if (typeof t === 'string') s = t; }
          s = s.replace(/BLENDER_UNREACHABLE:\s*/g, '').replace(/\s*Watch dir:[\s\S]*$/i, '').trim();
          return s || 'Blender did not answer.';
        }
        function nameRow(el, trigger, label, url, body) { deps.inlineRow({doc:doc,kind:'name',label:label,action:'Create',anchor:el,trigger:trigger,onDone:function (name) { post(url,Object.assign({},body,{name:name}),trigger,el); }}); }
        function bindAction(b, act, el, body, level) {
          b.addEventListener('click',function (ev) { ev.stopPropagation();
            if (act === 'scene') nameRow(el,b,'Scene name','/levels/scenes/new',body);
            else if (act === 'delete') deps.inlineRow({doc:doc,kind:'confirm',label:body.scene ? 'Move this scene to trash?' : 'Move this level and its ' + (level.scenes || []).length + ((level.scenes || []).length === 1 ? ' scene' : ' scenes') + ' to trash?',action:'Move to trash',danger:true,anchor:el,trigger:b,onDone:function () { post('/levels/trash',body,b,el); }});
            else post('/levels/' + act,body,b,el);
          });
        }
        async function load(host) {
          root = host;
          try { const res = await deps.fetch('/levels',{cache:'no-store'}); const j = await res.json(); if (!res.ok) throw new Error(j.error || 'Could not load levels.'); host.textContent = '';
            const head = mk('div','lib-levels-head'), nb = button('btn btn-primary btn-sm','New level'); nb.dataset.levelNew = ''; const icon = doc.createElementNS('http://www.w3.org/2000/svg','svg'); icon.setAttribute('viewBox','0 0 24 24'); icon.setAttribute('width','16'); icon.setAttribute('height','16'); icon.setAttribute('aria-hidden','true'); const stroke = doc.createElementNS('http://www.w3.org/2000/svg','path'); stroke.setAttribute('d','M12 5v14M5 12h14'); stroke.setAttribute('stroke','currentColor'); stroke.setAttribute('stroke-width','1.8'); icon.appendChild(stroke); nb.insertBefore(icon,nb.firstChild); head.appendChild(nb); host.appendChild(head);
            nb.addEventListener('click',function () { nameRow(head,nb,'Level name','/levels/new',{}); });
            const grid = mk('div','lib-tile-grid'); host.appendChild(grid);
            (j.levels || []).forEach(function (level) {
              const acts = ['open','scene','save','delete'].map(function (a) { return deps.libActBtn(a); });
              const tile = deps.libTile({kind:'level',name:level.name,poster:level.posterStamp ? '/levels/poster?level=' + encodeURIComponent(level.slug) + '&stamp=' + encodeURIComponent(level.posterStamp) : null,placeholder:'No preview yet',meta:levelMetaText(level),dataset:{level:level.slug},actions:acts});
              acts.forEach(function (b,i) { bindAction(b,['open','scene','save','delete'][i],tile,{level:level.slug},level); });
              if (level.broken) { acts[0].disabled = true; acts[0].title = level.broken; deps.libTileProblem(tile,level.broken,undefined,'broken'); }
              if (open && open.kind === 'level' && open.slug === level.slug && (open.levelMovableAnims || []).length) { const hint = mk('div','lib-inline-text',levelMovableAnimText(open.levelMovableAnims)); hint.setAttribute('role','status'); hint.dataset.hint = 'level-anim'; tile.appendChild(hint); }
              if (level.posterUpdating) { const upd = mk('div','lib-inline-text','Updating preview…'); upd.setAttribute('role','status'); upd.dataset.hint = 'poster-updating'; tile.appendChild(upd); }
              const scenes = mk('div','lib-level-scenes'); tile.appendChild(scenes);
              (level.scenes || []).forEach(function (s) { const row = mk('div','lib-list-row'); row.dataset.scene = s.name; row.appendChild(mk('span','',s.name));
                ['open','save','delete'].forEach(function (a) { const b = deps.libActBtn(a); row.appendChild(b); bindAction(b,a,row,{level:level.slug,scene:s.name},level); if (a === 'open' && s.broken) { b.disabled = true; b.title = s.broken; } });
                if (s.broken) deps.libTileProblem(row,s.broken,undefined,'broken'); scenes.appendChild(row);
                if (open && open.kind === 'scene' && open.slug === level.slug && open.scene === s.name && (open.linkedMovableAnims || []).length) { const hint = mk('div','lib-inline-text',linkedMovableAnimText(open.linkedMovableAnims)); hint.setAttribute('role','status'); hint.dataset.hint = 'linked-anim'; scenes.appendChild(hint); }
                if (open && open.kind === 'scene' && open.slug === level.slug && open.scene === s.name && (open.orphanAnims || []).length) {
                  deps.libTileProblem(row,levelOrphanText(open.orphanAnims[0]),undefined,'orphan');
                  open.orphanAnims.forEach(function (orphan) {
                    const box = mk('div','lib-inline lib-orphan'); box.setAttribute('role','group'); box.dataset.orphan = orphan.name;
                    box.appendChild(mk('span','lib-inline-text',levelOrphanText(orphan) + (orphan.reattachable === false ? ' It is not an object animation, so it can only be kept or deleted.' : '')));
                    const label = mk('label','lib-inline-label','Reattach to'), select = mk('select','lib-inline-input');
                    const targets = open.reattachTargets || [];
                    if (targets.length !== 1) { const ph = mk('option','','Choose the object…'); ph.value = ''; select.appendChild(ph); }
                    targets.forEach(function (name) { const option = mk('option','',name); option.value = name; select.appendChild(option); });
                    select.value = targets.length === 1 ? targets[0] : '';
                    label.appendChild(select); if (orphan.reattachable !== false) box.appendChild(label);
                    [['reattach','Reattach','primary'],['keep','Keep for later','secondary'],['delete','Delete animation','danger']].forEach(function (c) {
                      if (c[0] === 'reattach' && orphan.reattachable === false) return;
                      const b = button('btn btn-' + c[2] + ' btn-sm',c[1]); b.dataset.choice = c[0];
                      if (c[0] === 'reattach' && !targets.length) b.title = 'No movable object without animation is available.';
                      b.addEventListener('click',function () { if (c[0] === 'reattach' && !select.value) return; const body = {level:level.slug,scene:s.name,action:orphan.name,pick:c[0]}; if (c[0] === 'reattach') body.object = select.value; if (c[0] === 'delete') deps.inlineRow({doc:doc,kind:'confirm',label:'Delete ' + levelOrphanLabel(orphan) + "'s animation? It is gone after the next save.",action:'Delete animation',danger:true,anchor:box,trigger:b,onDone:function () { post('/levels/orphan',body,b,row); }}); else post('/levels/orphan',body,b,row); }); box.appendChild(b);
                      if (c[0] === 'reattach') {
                        const why = mk('span','lib-inline-text'); why.dataset.reason = 'reattach'; box.appendChild(why);
                        const sync = function () { const has = select.value !== ''; b.textContent = has ? 'Reattach to ' + select.value : 'Reattach'; b.disabled = !has; why.hidden = has; why.textContent = has ? '' : (targets.length ? 'Choose the object to reattach to.' : 'No movable object without animation is available.'); };
                        select.addEventListener('change',sync); sync();
                      }
                    }); scenes.appendChild(box);
                  });
                }
              }); grid.appendChild(tile);
            });
            if (!(j.levels || []).length) host.appendChild(mk('div','lib-empty','No levels yet — make one with New level.'));
          } catch (e) { host.textContent = ''; const msg = mk('div','lib-msg',e.message); msg.setAttribute('role','status'); host.appendChild(msg); }
        }
        function renderStage(o) {
          open = o; const row = doc.getElementById('qs-stage-row'), qs = doc.getElementById('qs-stage'); if (!row || !qs) return;
          row.hidden = !(o && ['level','scene'].includes(o.kind)); Array.prototype.forEach.call(qs.querySelectorAll('[data-stage]'),function (b) { b.setAttribute('aria-pressed',o && o.stage === b.dataset.stage ? 'true' : 'false'); });
        }
        async function setStage(stage, origin) {
          const msg = doc.getElementById('qs-stage-msg'); if (origin) origin.setAttribute('aria-busy','true');
          try { const res = await deps.fetch('/levels/stage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stage:stage})}); const j = await res.json(); if (!res.ok || j.ok === false) throw new Error(j.error || 'Could not switch stage.'); if (msg) msg.textContent = j.note || ''; if ('open' in j) receive(j.open); } catch(e) { if (msg) msg.textContent = (typeof readableReply === 'function' ? readableReply(e.message) : e.message); } finally { if (origin) origin.removeAttribute('aria-busy'); }
        }
        const qs = doc.getElementById('qs-stage'); if (qs && !qs.children.length) LEVEL_STAGES.forEach(function (s) { const b = button('',s.label); b.dataset.stage = s.id; b.setAttribute('aria-pressed','false'); qs.appendChild(b); }); if (qs) Array.prototype.forEach.call(qs.querySelectorAll('[data-stage]'),function (b) { b.addEventListener('click',function () { setStage(b.dataset.stage,b); }); });
        async function refreshOpen() { try { const res = await deps.fetch('/levels/open'); const j = await res.json(); if (!j.busy) receive(j.open); } catch (_) {} }
        function onPoster(evt) { if (!root) return; if (evt.ok) return load(root); const tile = root.querySelector('[data-level="' + evt.level + '"]'); if (tile) deps.libTileProblem(tile,'Poster failed — ' + evt.error,undefined,'poster'); }
        return {onPoster:onPoster,clearOpen:function () { receive(null); },load:load,refreshOpen:refreshOpen,setStage:setStage,renderStage:renderStage,openState:function () { return open; }};
      }
      // </r4d-levels-ui>
      var levelsTab = makeLevelsTab({document:document,fetch:function (u, o) { return fetch(u, o); },libTile:libTile,libActBtn:libActBtn,libTileProblem:libTileProblem,libTileProblemClear:libTileProblemClear,inlineRow:libInlineRow,openTroubleshooter:function () { shellHelpRun('troubleshooter'); },onOpenState:function (open) { levelsTab.renderStage(open); renderStatusBar(); }});
      window.__levelsBlenderGone = function () { levelsTab.clearOpen(); };
      var levelsLastPing = 0;
      window.__levelsRefreshOpen = function (force) { const now = Date.now(); if (!force && !levelsShouldPing(levelsLastPing,now)) return; levelsLastPing = now; return levelsTab.refreshOpen(); };
      window.registerStatusItem({id:'stage',label:'Level stage',kind:'text',read:function () { const text = levelStageText(levelsTab.openState()); return text ? {state:'ok',text:text} : {state:'off',text:''}; },click:function () { toggleQuickSwitches(true); }});
