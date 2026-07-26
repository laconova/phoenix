'use strict';
/**
 * mesh-import-fix.js — Korrekturen, die JEDER frisch importierte Trellis-Mesh braucht.
 *
 * ENTMETALLISIEREN (Befund 2026-07-13):
 *   Trellis exportiert seine GLBs mit metallicFactor=1 UND einer metallicRoughness-Textur,
 *   deren Blau-Kanal (= Metallic in glTF) auf 1.0 steht — die Textur ist durchgehend cyan.
 *   Jeder generierte Baum, Stein, jedes Blatt ist damit technisch METALL.
 *   Sichtbar wird es nur bei dunkler Grundfarbe: Metall zeigt nicht die eigene Farbe, es
 *   spiegelt die Umgebung. Helle Birkenrinde spiegelt hell (faellt nicht auf), dunkles
 *   Eichenmoos spiegelt dunkel -> die Eiche rendert SCHWARZ. Ohne Environment (dunkle World,
 *   Nachtszene, Gegenlicht) trifft es alles.
 *
 *   Der Wert allein reicht nicht: die Textur haengt als LINK am Metallic-Eingang, und ein Link
 *   schlaegt jeden default_value. Also erst den Link trennen, dann auf 0 setzen.
 *
 *   Rinde, Stein, Laub, Erde — nichts davon ist metallisch. Wer echtes Metall braucht, setzt
 *   es ueber die Material-Palette (M_Metal_Iron etc.), nicht ueber einen Trellis-Zufall.
 */

/**
 * Python-Zeilen, die die Materialien der Objekte in `listExpr` entmetallisieren.
 * listExpr MUSS eine Python-Liste von Objekten sein (z.B. 'imported') — NICHT
 * bpy.context.selected_objects: die Import-Pfade deselektieren in ihrer Schleife und
 * haetten am Ende nur noch das letzte Mesh ausgewaehlt.
 */
function demetalPy(listExpr) {
  return [
    '_phx_fixed = 0',
    `for _o in ${listExpr}:`,
    '    for _slot in _o.material_slots:',
    '        _mat = _slot.material',
    '        if not _mat or not _mat.use_nodes:',
    '            continue',
    '        for _node in _mat.node_tree.nodes:',
    '            if _node.type != "BSDF_PRINCIPLED":',
    '                continue',
    '            _inp = _node.inputs.get("Metallic")',
    '            if _inp is None:',
    '                continue',
    '            for _link in list(_inp.links):          # Link schlaegt default_value -> zuerst weg',
    '                _mat.node_tree.links.remove(_link)',
    '            _inp.default_value = 0.0',
    '            _phx_fixed += 1',
    'print("DEMETAL:" + str(_phx_fixed))',
  ];
}

module.exports = { demetalPy };
