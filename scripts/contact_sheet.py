# contact_sheet.py — visuelle Abnahme für einen Stapel frisch erzeugter Meshes (Blender 5.x)
#
# WARUM ES DAS GIBT (Nacht 11./12.07.2026, vier Mal hintereinander):
#   Ein Batch-Log meldet „Datei erzeugt" — NICHT „Ding gut".
#     Batch 2: „15/15, null Fehlschläge"  → 12 davon waren FLACHE KARTEN.
#     Batch 3: „8/8 gemesht"              → 2 flache Platten, 2 mit autogroßen Blättern.
#     Batch 4: „5 OK"                     → 2 flache Platten.
#     Blätter: „9/9 OK-GLB"               → nur 3 brauchbar, eine war ein RECHTECK.
#   Ausschussquote 25–50 %, und die flache Platte kommt bei JEDEM Prompt wieder — sie ist
#   ein Trellis-Fehlermodus, nicht wegformulierbar. Die einzige verlässliche Abwehr: HINSEHEN.
#
#   Und KENNZAHLEN helfen nicht: in derselben Nacht haben DREI selbstgebaute Metriken gelogen
#   (Entrausch-Score, Bounding-Box-Tiefe, PCA-Flachheitstest). Die PCA stufte eine offensichtliche
#   Platte als „Volumen" ein. Was JEDES MAL funktioniert hat, war ein korrekt gerahmter Render.
#
# DIE RENDER-FALLEN (alle selbst hineingetappt, alle hier vermieden):
#   1) `render.opengl()` nimmt per Default die VIEWPORT-Ansicht, nicht die Szenen-Kamera.
#      → view_context=False.
#   2) Die Kamera ENTLANG einer Objektreihe zu stellen ist sinnlos — die Objekte verdecken sich.
#      → Für die Seitenansicht die OBJEKTE drehen, nicht die Kamera versetzen.
#   3) Objekte aus glTF sind an Empties GEPARENTET: `location`/`scale` sind LOKAL.
#      → matrix_world direkt setzen.
#   4) Framing aus der Bounding-Box rechnen, nicht raten.
#
# BENUTZUNG:  contact_sheet.py wird von ../contact-sheet.js über die Phoenix-IPC gefahren.

import bpy
import os
import math
from mathutils import Vector, Matrix

COLL = "PhoenixContactSheet"


def _clean():
    c = bpy.data.collections.get(COLL)
    if c:
        for o in list(c.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        for parent in list(bpy.data.collections) + [bpy.context.scene.collection]:
            if c.name in [x.name for x in parent.children]:
                parent.children.unlink(c)
        bpy.data.collections.remove(c)
    for m in [m for m in bpy.data.meshes if m.users == 0]:
        bpy.data.meshes.remove(m)


def _import(path, coll, name):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    added = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in added if o.type == 'MESH']
    if not meshes:
        for o in added:
            bpy.data.objects.remove(o, do_unlink=True)
        return None
    ob = meshes[0]
    ob.parent = None                      # glTF-Empties wegwerfen: sonst ist matrix_world nicht unser
    for o in added:
        if o is not ob:
            bpy.data.objects.remove(o, do_unlink=True)
    for c in list(ob.users_collection):
        c.objects.unlink(ob)
    coll.objects.link(ob)
    ob.name = name
    return ob


def sheet(paths, out_png, textured=False, cols=None, cell=1.0):
    """Importiert jedes GLB, normiert auf gleiche Höhe, legt sie in ein Raster und rendert
    ZWEI Ansichten: frontal und 90° gedreht (letztere entlarvt flache Karten sofort).
    Schreibt <out_png> und <out_png ohne .png>_rot90.png. Räumt danach vollständig auf."""
    _clean()
    coll = bpy.data.collections.new(COLL)
    bpy.context.scene.collection.children.link(coll)

    n = len(paths)
    if cols is None:
        cols = min(5, max(1, int(math.ceil(math.sqrt(n)))))
    rows = int(math.ceil(n / float(cols)))

    ORIGIN = Vector((0.0, 3000.0, 0.0))   # weit weg von der echten Szene
    objs = []
    for i, p in enumerate(paths):
        ob = _import(p, coll, "CS_%02d_%s" % (i, os.path.basename(p)[:24]))
        if ob is None:
            print("[cs] LEER (kein Mesh): %s" % p)
            continue
        bb = [Vector(c) for c in ob.bound_box]
        lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
        hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
        d  = hi - lo
        s  = cell / max(d.x, d.y, d.z, 1e-6)          # alle auf gleiche Größe
        cx, cy = i % cols, i // cols
        pos = ORIGIN + Vector(((cx - (cols - 1) / 2.0) * cell * 1.4,
                               0.0,
                               ((rows - 1) / 2.0 - cy) * cell * 1.4))
        ob["cs_base"] = pos[:]                        # für die 90°-Ansicht gemerkt
        ob["cs_scale"] = s
        ob["cs_anchor"] = ((lo + hi) / 2.0)[:]
        ob.matrix_world = (Matrix.Translation(pos)
                           @ Matrix.Diagonal((s, s, s, 1.0))
                           @ Matrix.Translation(-((lo + hi) / 2.0)))
        objs.append(ob)

    if not objs:
        print("[cs] nichts zu zeigen")
        return None
    bpy.context.view_layer.update()

    scn = bpy.context.scene
    saved_cam, saved_path = scn.camera, scn.render.filepath
    saved_res = (scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage)
    hidden = {o.name: (o.hide_viewport, o.hide_render) for o in bpy.data.objects}
    keep = set(objs)
    for o in bpy.data.objects:
        k = (o in keep) or (o.type == 'LIGHT' and textured)
        o.hide_viewport = not k
        o.hide_render = not k

    cd = bpy.data.cameras.new("CS_cam")
    cd.type = 'ORTHO'
    cd.ortho_scale = cols * cell * 1.5
    cd.clip_end = 20000.0
    cam = bpy.data.objects.new("CS_cam", cd)
    scn.collection.objects.link(cam)
    scn.camera = cam
    # 3/4-Ansicht statt frontal: FLACHE Objekte (Blätter!) sind frontal halb von der Kante zu
    # sehen und damit nicht beurteilbar. Leicht von oben liest beides — Blatt wie Baum.
    dist = cols * cell * 6.0
    cam.location = ORIGIN + Vector((0.0, -dist, dist * 0.45))
    cam.rotation_euler = (ORIGIN - cam.location).to_track_quat('-Z', 'Y').to_euler()

    px = 320
    scn.render.resolution_x = int(cols * px * 1.4)
    scn.render.resolution_y = int(rows * px * 1.4)
    scn.render.resolution_percentage = 100

    outs = []
    base = out_png[:-4] if out_png.lower().endswith('.png') else out_png
    for tag, rot in (("", 0.0), ("_rot90", math.radians(90))):
        for ob in objs:                    # OBJEKTE drehen, nicht die Kamera versetzen
            pos = Vector(ob["cs_base"])
            anc = Vector(ob["cs_anchor"])
            s   = ob["cs_scale"]
            ob.matrix_world = (Matrix.Translation(pos)
                               @ Matrix.Rotation(rot, 4, 'Z')
                               @ Matrix.Diagonal((s, s, s, 1.0))
                               @ Matrix.Translation(-anc))
        bpy.context.view_layer.update()
        p = base + tag + ".png"
        scn.render.filepath = p
        if textured:
            bpy.ops.render.render(write_still=True)          # EEVEE: Farbe + Textur
        else:
            bpy.ops.render.opengl(write_still=True, view_context=False)   # nur Geometrie
        outs.append(p)

    scn.camera, scn.render.filepath = saved_cam, saved_path
    scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage = saved_res
    bpy.data.objects.remove(cam, do_unlink=True)
    bpy.data.cameras.remove(cd, do_unlink=True)
    for name, (hv, hr) in hidden.items():
        o = bpy.data.objects.get(name)
        if o:
            o.hide_viewport, o.hide_render = hv, hr
    _clean()
    bpy.context.view_layer.update()

    print("[cs] %d Meshes | %s" % (len(objs), " | ".join(os.path.basename(o) for o in outs)))
    print("SHEET:" + outs[0])
    print("SHEET:" + outs[1])
    return outs
