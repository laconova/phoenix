'use strict';
/**
 * contact-sheet.js — visuelle Abnahme eines Generierungs-Batches
 *
 * WARUM: Ein Batch-Log meldet "Datei erzeugt", nicht "Ding gut". In der Nacht 11./12.07.2026
 * meldeten vier Batches hintereinander Erfolg — die Ausschussquote lag bei 25–50 % (flache
 * Karten, Riesenblätter, ein Rechteck). Die flache Karte ist ein Trellis-Fehlermodus und tritt
 * bei JEDEM Prompt wieder auf; sie ist nicht wegformulierbar. Und drei selbstgebaute Metriken
 * haben in derselben Nacht gelogen. Was jedes Mal funktioniert hat: HINSEHEN.
 *
 * Erzeugt zwei Bilder: frontal + 90° gedreht. Die gedrehte Ansicht entlarvt flache Karten sofort.
 *
 * Nutzung:
 *   node contact-sheet.js --dir staging/flora --since 60        # alles der letzten 60 Minuten
 *   node contact-sheet.js --files a.glb,b.glb [--out sheet.png] [--textured]
 *
 * Ausgabe: SHEET:<pfad> je Bild (maschinenlesbar für Batch-Skripte).
 */
const fs = require('fs');
const path = require('path');
const { callBlender } = require('./blender-ipc');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = k => argv.includes('--' + k);

let files = [];
const list = arg('files');
if (list) {
  files = list.split(',').map(s => s.trim()).filter(Boolean);
} else {
  const dir = path.resolve(__dirname, arg('dir', 'staging'));
  const since = parseFloat(arg('since', '60')) * 60 * 1000;   // Minuten
  const cutoff = Date.now() - since;
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return walk(p);
    return (e.name.toLowerCase().endsWith('.glb') && fs.statSync(p).mtimeMs >= cutoff) ? [p] : [];
  });
  if (!fs.existsSync(dir)) { console.error('Kein solches Verzeichnis: ' + dir); process.exit(1); }
  files = walk(dir).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

if (!files.length) {
  console.error('Keine GLBs gefunden — nichts abzunehmen.');
  process.exit(1);
}

const out = path.resolve(arg('out', path.join(__dirname, 'output', `contact-sheet-${Date.now()}.png`)));
fs.mkdirSync(path.dirname(out), { recursive: true });

const py = `
import sys, importlib
sys.path.append(r"${path.join(__dirname, 'scripts').replace(/\\/g, '\\\\')}")
import contact_sheet, importlib
importlib.reload(contact_sheet)
contact_sheet.sheet(
    ${JSON.stringify(files.map(f => path.resolve(f)))},
    r"${out.replace(/\\/g, '\\\\')}",
    textured=${has('textured') ? 'True' : 'False'})
`;

console.log(`  Kontaktbogen: ${files.length} Meshes${has('textured') ? ' (texturiert)' : ' (nur Geometrie)'}`);
callBlender(py)
  .then(r => {
    const txt = (r && (r.stdout || r)) || '';
    String(txt).split('\n').filter(l => l.startsWith('SHEET:') || l.startsWith('[cs]')).forEach(l => console.log('  ' + l.trim()));
    if (!String(txt).includes('SHEET:')) { console.error('  Kein Bogen erzeugt — Blender-Ausgabe:\n' + txt); process.exit(1); }
  })
  .catch(e => {
    console.error('  Blender-IPC fehlgeschlagen: ' + e.message);
    console.error('  (Läuft Blender mit dem Phoenix-IPC-Addon?)');
    process.exit(1);
  });
