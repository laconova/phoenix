# contact_sheet.py — eyeball a whole batch of freshly generated meshes at once (Blender 5.x)
#
# WHY THIS EXISTS
#   A batch log reports "file created" — NOT "thing is good". Four batches in one night:
#     batch 2: "15/15, zero failures"  -> 12 of them were FLAT CARDS.
#     batch 3: "8/8 meshed"            -> 2 flat slabs, 2 with wrongly-scaled leaves.
#     batch 4: "5 OK"                  -> 2 flat slabs.
#     leaves:  "9/9 good GLB"          -> only 3 usable, one was a RECTANGLE.
#   A 25-50% reject rate, and the flat slab comes back for ANY prompt — it is a failure mode of
#   the mesher, not something you can word your way out of. The only reliable defence is LOOKING.
#
#   And METRICS do not help: three home-made ones lied in that same night (a denoise score, a
#   bounding-box depth test, a PCA flatness test). The PCA classified an obvious slab as "volume".
#   What worked every single time was a correctly framed render.
#
# THE RENDER TRAPS (all of them walked into first, all of them avoided here):
#   1) `render.opengl()` uses the VIEWPORT view by default, not the scene camera
#      -> view_context=False.
#   2) Putting the camera ALONG a row of objects is useless — they occlude each other.
#      -> for the side view, rotate the OBJECTS instead of moving the camera.
#   3) Objects imported from glTF are PARENTED to empties, so `location`/`scale` are LOCAL.
#      -> set matrix_world directly.
#   4) Compute the framing from the bounding box; do not guess it.
#
# USAGE:  driven by ../contact-sheet.js over the Phoenix IPC bridge.

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
    ob.parent = None                      # drop the glTF empties, or matrix_world is not ours to set
    for o in added:
        if o is not ob:
            bpy.data.objects.remove(o, do_unlink=True)
    for c in list(ob.users_collection):
        c.objects.unlink(ob)
    coll.objects.link(ob)
    ob.name = name
    return ob


def sheet(paths, out_png, textured=False, cols=None, cell=1.0):
    """Import every GLB, normalise them to one height, lay them out in a grid and render TWO
    views: head-on and rotated 90 degrees — the second one exposes a flat card instantly.
    Writes <out_png> and <out_png without .png>_rot90.png, then cleans up completely."""
    _clean()
    coll = bpy.data.collections.new(COLL)
    bpy.context.scene.collection.children.link(coll)

    n = len(paths)
    if cols is None:
        cols = min(5, max(1, int(math.ceil(math.sqrt(n)))))
    rows = int(math.ceil(n / float(cols)))

    ORIGIN = Vector((0.0, 3000.0, 0.0))   # far away from the real scene
    objs = []
    for i, p in enumerate(paths):
        ob = _import(p, coll, "CS_%02d_%s" % (i, os.path.basename(p)[:24]))
        if ob is None:
            print("[cs] EMPTY (no mesh): %s" % p)
            continue
        bb = [Vector(c) for c in ob.bound_box]
        lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
        hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
        d  = hi - lo
        s  = cell / max(d.x, d.y, d.z, 1e-6)          # normalise every object to the same size
        cx, cy = i % cols, i // cols
        pos = ORIGIN + Vector(((cx - (cols - 1) / 2.0) * cell * 1.4,
                               0.0,
                               ((rows - 1) / 2.0 - cy) * cell * 1.4))
        ob["cs_base"] = pos[:]                        # remembered for the 90-degree view
        ob["cs_scale"] = s
        ob["cs_anchor"] = ((lo + hi) / 2.0)[:]
        ob.matrix_world = (Matrix.Translation(pos)
                           @ Matrix.Diagonal((s, s, s, 1.0))
                           @ Matrix.Translation(-((lo + hi) / 2.0)))
        objs.append(ob)

    if not objs:
        print("[cs] nothing to show")
        return None
    bpy.context.view_layer.update()

    scn = bpy.context.scene
    saved_cam, saved_path = scn.camera, scn.render.filepath
    saved_res = (scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage)
    hidden = {o.name: (o.hide_viewport, o.hide_render) for o in bpy.data.objects}
    keep = set(objs)
    cam = None
    cd = None
    outs = []
    # Everything below hides the user's whole scene and swaps the camera and resolution. If a
    # render raises in the middle (an unwritable output path, an EEVEE failure), a straight-line
    # restore never runs and the user is left with an apparently empty scene and a foreign camera.
    # So: mutate inside try, restore inside finally, always.
    try:
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
        # A 3/4 view rather than head-on: FLAT objects (leaves!) are seen half edge-on from the
        # front and cannot be judged. Slightly from above reads both — leaf and tree alike.
        dist = cols * cell * 6.0
        cam.location = ORIGIN + Vector((0.0, -dist, dist * 0.45))
        cam.rotation_euler = (ORIGIN - cam.location).to_track_quat('-Z', 'Y').to_euler()

        px = 320
        scn.render.resolution_x = int(cols * px * 1.4)
        scn.render.resolution_y = int(rows * px * 1.4)
        scn.render.resolution_percentage = 100

        base = out_png[:-4] if out_png.lower().endswith('.png') else out_png
        for tag, rot in (("", 0.0), ("_rot90", math.radians(90))):
            for ob in objs:                # rotate the OBJECTS rather than moving the camera
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
                bpy.ops.render.render(write_still=True)        # EEVEE: colour + texture
            else:
                bpy.ops.render.opengl(write_still=True, view_context=False)   # geometry only
            outs.append(p)
    finally:
        scn.camera, scn.render.filepath = saved_cam, saved_path
        scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage = saved_res
        if cam is not None:
            try: bpy.data.objects.remove(cam, do_unlink=True)
            except Exception: pass
        if cd is not None:
            try: bpy.data.cameras.remove(cd, do_unlink=True)
            except Exception: pass
        for name, (hv, hr) in hidden.items():
            o = bpy.data.objects.get(name)
            if o:
                o.hide_viewport, o.hide_render = hv, hr
        _clean()
        bpy.context.view_layer.update()

    if len(outs) < 2:
        print("[cs] render produced %d of 2 sheets" % len(outs))
        return outs or None

    print("[cs] %d meshes | %s" % (len(objs), " | ".join(os.path.basename(o) for o in outs)))
    print("SHEET:" + outs[0])
    print("SHEET:" + outs[1])
    return outs
