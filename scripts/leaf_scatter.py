# leaf_scatter.py — Blätter als Instanzen auf Baumkronen streuen (Blender 5.x)
#
# WARUM ES DAS GIBT (Befunde der Nacht 11./12.07.2026):
#   Trellis liefert ~27k Polys für einen GANZEN Baum. Auf Szenengröße skaliert ist jedes
#   "Blatt" im Mesh eine Facette von ~0,5–1 m -> im Gegenlicht Bruchglas. Kein Prompt
#   repariert das: es ist Polygon-Budget ÷ Baumgröße.
#   Trellis kann aber KOMPAKTE, MASSIVE Körper hervorragend (Reh, Steine, Stämme —
#   und EINZELNE BLÄTTER). Also: Blatt einzeln generieren, dezimieren, und per
#   Geometry Nodes tausendfach auf die Krone instanzieren. Damit wird die Blattgröße
#   zu einem REGLER statt einer Eigenschaft des Meshes.
#
# WAS DAS SKRIPT FÜR DICH ERLEDIGT (zwei Fallen, in die wir reingelaufen sind):
#   1) Blattgröße wird in WELT-Einheiten angegeben. Die Instanz-Skala in Geometry Nodes
#      liegt im OBJEKTRAUM und wird von der Objekt-Skalierung des Baums (oft ~26x!)
#      multipliziert. Das Skript rechnet das selbst um.
#   2) INSTANZ-WÄCHTER: die Instanzzahl wird VORHER exakt aus der Emitter-Fläche
#      bestimmt. Über Budget -> Abbruch mit Meldung, statt Blender per OOM zu killen.
#      (Genau so ist Blender am 12.07. gestorben: Dichte 55000 x 15 Bäume.)
#
# BENUTZUNG (in Blender, z.B. über die Phoenix-IPC):
#
#   import sys; sys.path.append(r"D:\phoenix\scripts")
#   import leaf_scatter, importlib; importlib.reload(leaf_scatter)
#
#   # 1) Blatt vorbereiten (GLB importieren + auf instanz-taugliche Polyzahl dezimieren)
#   leaf = leaf_scatter.prepare_leaf(r"D:\phoenix\staging\leaf\phoenix_oak_leaf_XXXX.glb",
#                                    target_polys=400, name="LEAF_oak")
#
#   # 2) Trockenlauf: rechnet nur, ändert NICHTS
#   leaf_scatter.scatter(["TREE_D1_oak"], leaf, leaf_size=0.30, dry_run=True)
#
#   # 3) Wenn die Zahlen passen: anwenden
#   leaf_scatter.scatter(["TREE_D1_oak"], leaf, leaf_size=0.30)
#
#   # wieder entfernen
#   leaf_scatter.clear(["TREE_D1_oak"])

import bpy
import bmesh
import math
from mathutils import Vector, Matrix

# ─── Budget ──────────────────────────────────────────────────────────────────
# Erfahrungswert 16-GB-Laptop: darüber wird EEVEE beim Rendern instabil.
MAX_TOTAL_INSTANCES = 600_000
MAX_TOTAL_TRIS      = 200_000_000

NODE_GROUP = "LeafScatter"   # Praefix; die echte Gruppe heisst LeafScatter_<quelle>


def _group_name(leaf):
    return "%s_%s" % (NODE_GROUP, leaf.name)


# ─── Blatt vorbereiten ───────────────────────────────────────────────────────
def prepare_leaf(glb_path, target_polys=400, name="LEAF"):
    """GLB importieren, Import-Empties wegwerfen, auf target_polys dezimieren.
    Gibt das fertige Blatt-Objekt zurück (liegt in der Collection 'LeafLib')."""
    coll = bpy.data.collections.get("LeafLib")
    if coll is None:
        coll = bpy.data.collections.new("LeafLib")
        bpy.context.scene.collection.children.link(coll)

    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=glb_path)
    added = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in added if o.type == 'MESH']
    if not meshes:
        raise RuntimeError("Kein Mesh im GLB: " + glb_path)

    ob = meshes[0]
    ob.parent = None
    for o in added:
        if o is not ob:
            bpy.data.objects.remove(o, do_unlink=True)
    for c in list(ob.users_collection):
        c.objects.unlink(ob)
    coll.objects.link(ob)
    ob.name = name

    n = len(ob.data.polygons)
    if target_polys and n > target_polys:
        m = ob.modifiers.new("dec", 'DECIMATE')
        m.ratio = float(target_polys) / n
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.modifier_apply(modifier="dec")

    # aus dem Weg und unsichtbar im Render — die Instanzen rendern trotzdem
    ob.matrix_world = Matrix.Translation(Vector((0.0, 0.0, -500.0)))
    ob.hide_render = True

    d = ob.dimensions
    print("[leaf] %s: %d -> %d Polys | Eigenmass %.3f x %.3f x %.3f"
          % (name, n, len(ob.data.polygons), d.x, d.y, d.z))
    return ob


# ─── Messen (der Wächter) ────────────────────────────────────────────────────
def _canopy_area_objspace(tree, canopy_frac):
    """Oberflaeche der Krone IM OBJEKTRAUM (das ist die Groesse, mit der
    DistributePointsOnFaces rechnet) + Kronenhoehe in Weltmass."""
    me = tree.data
    zs = [v.co.z for v in me.vertices]
    lo, hi = min(zs), max(zs)
    cut = lo + canopy_frac * (hi - lo)

    bm = bmesh.new()
    bm.from_mesh(me)
    area = 0.0
    for f in bm.faces:
        if f.calc_center_median().z > cut:
            area += f.calc_area()
    bm.free()
    return area, cut


def _obj_scale(tree):
    s = tree.matrix_world.to_scale()
    return (abs(s.x) + abs(s.y) + abs(s.z)) / 3.0


def _leaf_polys(leaf):
    """Polyzahl der Instanz-Quelle — funktioniert fuer ein Objekt UND fuer ein Blatt-Set."""
    if isinstance(leaf, bpy.types.Collection):
        objs = [o for o in leaf.objects if o.type == 'MESH']
        if not objs:
            return 0
        return int(sum(len(o.data.polygons) for o in objs) / len(objs))
    return len(leaf.data.polygons)


def _leaf_name(leaf):
    return leaf.name


def plan(tree_names, leaf, leaf_size=0.30, per_tree=None, density=None, canopy_frac=0.28):
    """Rechnet durch, ohne etwas zu aendern. Gibt (rows, total_inst, total_tris) zurueck."""
    leaf_polys = _leaf_polys(leaf)
    rows = []
    total_inst = 0
    for name in tree_names:
        t = bpy.data.objects.get(name)
        if not t or t.type != 'MESH':
            rows.append((name, 0, 0, 0.0, 0.0, "FEHLT"))
            continue
        area, _ = _canopy_area_objspace(t, canopy_frac)
        sc = _obj_scale(t)
        if per_tree:
            dens = per_tree / max(area, 1e-9)
            inst = per_tree
        else:
            dens = density if density else 9000.0
            inst = int(dens * area)
        obj_leaf = leaf_size / max(sc, 1e-9)     # Welt -> Objektraum
        total_inst += inst
        rows.append((name, inst, int(dens), sc, obj_leaf, "ok"))
    return rows, total_inst, total_inst * leaf_polys


def _report(rows, total_inst, total_tris, leaf):
    print("%-18s %10s %9s %8s %10s" % ("baum", "instanzen", "dichte", "objskala", "blatt_obj"))
    for name, inst, dens, sc, obj_leaf, st in rows:
        if st != "ok":
            print("%-18s  %s" % (name, st))
            continue
        print("%-18s %10d %9d %8.1f %10.4f" % (name, inst, dens, sc, obj_leaf))
    print("-" * 62)
    print("GESAMT: %d Instanzen x %d Polys = %.1f Mio Dreiecke"
          % (total_inst, _leaf_polys(leaf), total_tris / 1e6))
    print("Budget: %d Instanzen / %.0f Mio Dreiecke"
          % (MAX_TOTAL_INSTANCES, MAX_TOTAL_TRIS / 1e6))


# ─── Node-Group ──────────────────────────────────────────────────────────────
def make_leaf_set(glb_paths, name, target_polys=400):
    """Mehrere Blätter in EINE Collection -> gemischte Krone (nicht 1000x dasselbe Blatt).
    Gibt die Collection zurück; an scatter(leaf=...) übergeben."""
    cname = "LeafSet_" + name
    c = bpy.data.collections.get(cname)
    if c:
        for o in list(c.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.collections.remove(c)
    c = bpy.data.collections.new(cname)
    # NICHT in die Szene linken — die Collection dient nur als Instanz-Quelle
    for i, p in enumerate(glb_paths):
        ob = prepare_leaf(p, target_polys=target_polys, name="%s_leaf%d" % (name, i))
        # ⚠️ WICHTIG: CollectionInfo uebernimmt die Objekt-Transformation IN JEDE INSTANZ.
        # prepare_leaf parkt das Blatt bei z=-500 -> jede Instanz bekaeme diesen Versatz mit
        # (bei ObjectInfo passiert das NICHT, deshalb faellt es beim Einzelblatt nicht auf).
        # Set-Blaetter muessen also auf dem URSPRUNG stehen.
        ob.matrix_world = Matrix.Identity(4)
        for cc in list(ob.users_collection):
            cc.objects.unlink(ob)
        c.objects.link(ob)
    print("[leaf] Blatt-Set '%s': %d Sorten" % (cname, len(c.objects)))
    return c


def _build_group(leaf, canopy_frac, obj_leaf_min, obj_leaf_max, density, seed):
    gname = _group_name(leaf)
    ng = bpy.data.node_groups.get(gname)
    if ng:
        bpy.data.node_groups.remove(ng)
    ng = bpy.data.node_groups.new(gname, 'GeometryNodeTree')
    ng.interface.new_socket("Geometry", in_out='INPUT',  socket_type='NodeSocketGeometry')
    ng.interface.new_socket("Geometry", in_out='OUTPUT', socket_type='NodeSocketGeometry')
    nd, lk = ng.nodes, ng.links

    n_in  = nd.new("NodeGroupInput");  n_in.location  = (-1200, 0)
    n_out = nd.new("NodeGroupOutput"); n_out.location = (800, 0)

    # Kronen-Schwelle PRO OBJEKT relativ (nicht fest verdrahten — sonst greift sie
    # nur bei genau einem Baum; genau dieser Fehler hat uns Stunden gekostet)
    n_bb  = nd.new("GeometryNodeBoundBox");  n_bb.location  = (-1020, -560)
    n_smi = nd.new("ShaderNodeSeparateXYZ"); n_smi.location = (-860, -640)
    n_sma = nd.new("ShaderNodeSeparateXYZ"); n_sma.location = (-860, -780)
    n_sub = nd.new("ShaderNodeMath");        n_sub.location = (-700, -720); n_sub.operation = 'SUBTRACT'
    n_mul = nd.new("ShaderNodeMath");        n_mul.location = (-540, -720); n_mul.operation = 'MULTIPLY'
    n_mul.inputs[1].default_value = canopy_frac
    n_add = nd.new("ShaderNodeMath");        n_add.location = (-380, -720); n_add.operation = 'ADD'

    n_pos = nd.new("GeometryNodeInputPosition"); n_pos.location = (-1020, -300)
    n_sep = nd.new("ShaderNodeSeparateXYZ");     n_sep.location = (-860, -300)
    n_gt  = nd.new("ShaderNodeMath");            n_gt.location  = (-220, -300)
    n_gt.operation = 'GREATER_THAN'

    n_dist = nd.new("GeometryNodeDistributePointsOnFaces"); n_dist.location = (-40, 0)
    n_dist.distribute_method = 'RANDOM'
    n_dist.inputs[4].default_value = float(density)   # [4] = Density
    n_dist.inputs[6].default_value = int(seed)        # [6] = Seed

    # Instanz-Quelle: EIN Objekt (ObjectInfo) ODER eine Collection (CollectionInfo + Pick Instance)
    is_set = isinstance(leaf, bpy.types.Collection)
    if is_set:
        n_obj = nd.new("GeometryNodeCollectionInfo"); n_obj.location = (-40, -520)
        n_obj.inputs[0].default_value = leaf
        n_obj.inputs[1].default_value = True      # Separate Children -> je Blattsorte eine Instanz
        n_obj.transform_space = 'ORIGINAL'
        n_pick = nd.new("FunctionNodeRandomValue"); n_pick.location = (200, -760)
        n_pick.data_type = 'INT'
        n_pick.inputs[4].default_value = 0
        n_pick.inputs[5].default_value = max(0, len(leaf.objects) - 1)
        n_pick.inputs[8].default_value = seed + 3
    else:
        n_obj = nd.new("GeometryNodeObjectInfo"); n_obj.location = (-40, -520)
        n_obj.inputs[0].default_value = leaf
        n_obj.transform_space = 'ORIGINAL'
        n_pick = None

    n_rot = nd.new("FunctionNodeRandomValue"); n_rot.location = (200, -300)
    n_rot.data_type = 'FLOAT_VECTOR'
    n_rot.inputs[0].default_value = (0.0, 0.0, 0.0)
    n_rot.inputs[1].default_value = (math.tau, math.tau, math.tau)
    n_rot.inputs[8].default_value = seed + 1

    n_scl = nd.new("FunctionNodeRandomValue"); n_scl.location = (200, -560)
    n_scl.data_type = 'FLOAT'
    n_scl.inputs[2].default_value = obj_leaf_min
    n_scl.inputs[3].default_value = obj_leaf_max
    n_scl.inputs[8].default_value = seed + 2

    n_iop = nd.new("GeometryNodeInstanceOnPoints"); n_iop.location = (460, 0)
    n_del = nd.new("GeometryNodeDeleteGeometry");   n_del.location = (200, 260)
    n_del.domain = 'FACE'; n_del.mode = 'ALL'
    n_join = nd.new("GeometryNodeJoinGeometry");    n_join.location = (640, 140)

    # ⚠️ Sockets über INDEX — die Namen weichen in Blender 5.1 ab ('Rotation' ist ein eigener Typ)
    lk.new(n_in.outputs[0],   n_bb.inputs[0])
    lk.new(n_bb.outputs[1],   n_smi.inputs[0])      # Min
    lk.new(n_bb.outputs[2],   n_sma.inputs[0])      # Max
    lk.new(n_sma.outputs[2],  n_sub.inputs[0])
    lk.new(n_smi.outputs[2],  n_sub.inputs[1])
    lk.new(n_sub.outputs[0],  n_mul.inputs[0])
    lk.new(n_mul.outputs[0],  n_add.inputs[0])
    lk.new(n_smi.outputs[2],  n_add.inputs[1])
    lk.new(n_add.outputs[0],  n_gt.inputs[1])       # Schwelle

    lk.new(n_pos.outputs[0],  n_sep.inputs[0])
    lk.new(n_sep.outputs[2],  n_gt.inputs[0])       # z
    lk.new(n_in.outputs[0],   n_dist.inputs[0])
    lk.new(n_gt.outputs[0],   n_dist.inputs[1])     # Selection = Krone
    lk.new(n_dist.outputs[0], n_iop.inputs[0])
    if is_set:
        lk.new(n_obj.outputs[0], n_iop.inputs[2])   # CollectionInfo -> Instances
        n_iop.inputs[3].default_value = True        # Pick Instance
        lk.new(n_pick.outputs[2], n_iop.inputs[4])  # Instance Index (INT random)
    else:
        lk.new(n_obj.outputs[4], n_iop.inputs[2])   # ObjectInfo -> Geometry
    lk.new(n_rot.outputs[0],  n_iop.inputs[5])      # Rotation
    lk.new(n_scl.outputs[1],  n_iop.inputs[6])      # Scale

    lk.new(n_in.outputs[0],   n_del.inputs[0])
    lk.new(n_gt.outputs[0],   n_del.inputs[1])      # Kronenflaechen weg, Stamm bleibt
    lk.new(n_del.outputs[0],  n_join.inputs[0])
    lk.new(n_iop.outputs[0],  n_join.inputs[0])
    lk.new(n_join.outputs[0], n_out.inputs[0])
    return ng


# ─── Anwenden ────────────────────────────────────────────────────────────────
def scatter(tree_names, leaf, leaf_size=0.30, size_var=0.35, per_tree=None,
            density=None, canopy_frac=0.28, seed=3, dry_run=False, force=False):
    """leaf_size = Blattgröße in WELT-Einheiten (z.B. 0.30 ≈ 30 cm bei 1 Einheit = 1 m).
    Entweder per_tree (Zielzahl Instanzen je Baum) ODER density angeben.
    dry_run=True rechnet nur. force=True überschreibt den Wächter (auf eigenes Risiko)."""
    if isinstance(leaf, str):
        leaf = bpy.data.collections.get(leaf) or bpy.data.objects[leaf]
    rows, total_inst, total_tris = plan(tree_names, leaf, leaf_size, per_tree, density, canopy_frac)
    _report(rows, total_inst, total_tris, leaf)

    over = (total_inst > MAX_TOTAL_INSTANCES) or (total_tris > MAX_TOTAL_TRIS)
    if over and not force:
        print("\n🛑 ABBRUCH — über Budget. NICHTS wurde geändert.")
        print("   Gegenmittel: kleinere Zielzahl (per_tree), gröberes Blatt (weniger Polys),")
        print("   oder feine Blätter NUR auf die Vordergrundbäume und grobe auf den Rest.")
        print("   (force=True überschreibt — genau so ist Blender am 12.07. gestorben.)")
        return None
    if dry_run:
        print("\n(Trockenlauf — nichts geändert.)")
        return None

    ok = [r for r in rows if r[5] == "ok"]
    if not ok:
        print("Keine gültigen Bäume.")
        return None

    # Skala/Dichte am ersten Baum ausrichten; bei stark unterschiedlicher Objektskalierung
    # die Bäume in Gruppen getrennt aufrufen.
    obj_leaf = ok[0][4]
    dens = ok[0][2]
    ng = _build_group(leaf, canopy_frac,
                      obj_leaf * (1.0 - size_var), obj_leaf * (1.0 + size_var),
                      dens, seed)

    mname = _group_name(leaf)
    for name, *_ in ok:
        t = bpy.data.objects[name]
        for m in list(t.modifiers):
            if m.type == 'NODES' and m.name.startswith(NODE_GROUP):
                t.modifiers.remove(m)
        m = t.modifiers.new(mname, 'NODES')
        m.node_group = ng

    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    real = sum(1 for i in dg.object_instances if i.is_instance)
    print("\n✅ angewandt auf %d Bäume | Instanzen im Depsgraph: %d (geschätzt: %d)"
          % (len(ok), real, total_inst))
    return ng


def clear(tree_names):
    """Modifier wieder abnehmen — die Original-Kronen kommen zurück."""
    n = 0
    for name in tree_names:
        t = bpy.data.objects.get(name)
        if not t:
            continue
        for m in list(t.modifiers):
            if m.type == 'NODES' and m.name.startswith(NODE_GROUP):
                t.modifiers.remove(m)
                n += 1
    bpy.context.view_layer.update()
    print("[leaf] %d Modifier entfernt" % n)

# ═══════════════════════════════════════════════════════════════════════════════
# EMITTER-MODUS (12.07., nach user-Befund „die Blätter wachsen aus der Luft")
#
# PROBLEM des Kronen-Schnitt-Modus oben: `canopy_frac` löscht ALLES oberhalb der
# Schwelle — also nicht nur die Scherben-Krone, sondern auch das ASTWERK. Übrig
# bleibt ein Stammstumpf, das Laub schwebt daneben. Ein reiner Höhenschnitt KANN
# das nicht lösen: auf derselben Höhe sitzen Äste (behalten) und Kronen-Facetten
# (löschen), er kann sie nicht unterscheiden.
#
# LÖSUNG: Sichtbarer Stamm (mit vollem Astwerk) und Emitter sind ZWEI Objekte.
#   - Der Stamm bleibt komplett unangetastet.
#   - Der Modifier sitzt auf dem EMITTER und gibt NUR Instanzen aus — die
#     Emitter-Geometrie landet nie im Ausgang und verschwindet dadurch von selbst.
#     Kein Löschen, kein Schnitt, kein Astwerk-Verlust.
# ═══════════════════════════════════════════════════════════════════════════════

def _build_emitter_group(leaf, obj_leaf_min, obj_leaf_max, density, seed, canopy_frac=0.0):
    """Node-Tree fuer den Emitter-Modus: Ausgang = NUR Instanzen."""
    gname = "LeafEmit_" + leaf.name
    ng = bpy.data.node_groups.get(gname)
    if ng:
        bpy.data.node_groups.remove(ng)
    ng = bpy.data.node_groups.new(gname, 'GeometryNodeTree')
    ng.interface.new_socket("Geometry", in_out='INPUT',  socket_type='NodeSocketGeometry')
    ng.interface.new_socket("Geometry", in_out='OUTPUT', socket_type='NodeSocketGeometry')
    nd, lk = ng.nodes, ng.links

    n_in  = nd.new("NodeGroupInput");  n_in.location  = (-700, 0)
    n_out = nd.new("NodeGroupOutput"); n_out.location = (600, 0)

    n_dist = nd.new("GeometryNodeDistributePointsOnFaces"); n_dist.location = (-450, 0)
    n_dist.distribute_method = 'RANDOM'
    n_dist.inputs[4].default_value = float(density)
    n_dist.inputs[6].default_value = int(seed)

    # Spender-Baeume haben selbst einen Stamm -> daraus duerfen keine Blaetter wachsen.
    # Schwelle relativ zur EIGENEN BBox des Emitters (canopy_frac=0 -> ganze Flaeche emittiert).
    if canopy_frac > 0.0:
        n_bb  = nd.new("GeometryNodeBoundBox");  n_bb.location  = (-700, -240)
        n_smi = nd.new("ShaderNodeSeparateXYZ"); n_smi.location = (-560, -300)
        n_sma = nd.new("ShaderNodeSeparateXYZ"); n_sma.location = (-560, -420)
        n_sub = nd.new("ShaderNodeMath"); n_sub.location = (-420, -360); n_sub.operation = 'SUBTRACT'
        n_mul = nd.new("ShaderNodeMath"); n_mul.location = (-300, -360); n_mul.operation = 'MULTIPLY'
        n_mul.inputs[1].default_value = canopy_frac
        n_add = nd.new("ShaderNodeMath"); n_add.location = (-180, -360); n_add.operation = 'ADD'
        n_pos = nd.new("GeometryNodeInputPosition"); n_pos.location = (-700, -120)
        n_sep = nd.new("ShaderNodeSeparateXYZ");     n_sep.location = (-560, -120)
        n_gt  = nd.new("ShaderNodeMath");            n_gt.location  = (-60, -180)
        n_gt.operation = 'GREATER_THAN'
        lk_ = ng.links
        lk_.new(n_in.outputs[0],  n_bb.inputs[0])
        lk_.new(n_bb.outputs[1],  n_smi.inputs[0])
        lk_.new(n_bb.outputs[2],  n_sma.inputs[0])
        lk_.new(n_sma.outputs[2], n_sub.inputs[0])
        lk_.new(n_smi.outputs[2], n_sub.inputs[1])
        lk_.new(n_sub.outputs[0], n_mul.inputs[0])
        lk_.new(n_mul.outputs[0], n_add.inputs[0])
        lk_.new(n_smi.outputs[2], n_add.inputs[1])
        lk_.new(n_add.outputs[0], n_gt.inputs[1])
        lk_.new(n_pos.outputs[0], n_sep.inputs[0])
        lk_.new(n_sep.outputs[2], n_gt.inputs[0])
        lk_.new(n_gt.outputs[0],  n_dist.inputs[1])   # Selection

    is_set = isinstance(leaf, bpy.types.Collection)
    if is_set:
        n_src = nd.new("GeometryNodeCollectionInfo"); n_src.location = (-450, -380)
        n_src.inputs[0].default_value = leaf
        n_src.inputs[1].default_value = True          # Separate Children
        n_src.transform_space = 'ORIGINAL'
        n_pick = nd.new("FunctionNodeRandomValue"); n_pick.location = (-200, -620)
        n_pick.data_type = 'INT'
        n_pick.inputs[4].default_value = 0
        n_pick.inputs[5].default_value = max(0, len(leaf.objects) - 1)
        n_pick.inputs[8].default_value = seed + 3
    else:
        n_src = nd.new("GeometryNodeObjectInfo"); n_src.location = (-450, -380)
        n_src.inputs[0].default_value = leaf
        n_src.transform_space = 'ORIGINAL'
        n_pick = None

    n_rot = nd.new("FunctionNodeRandomValue"); n_rot.location = (-200, -160)
    n_rot.data_type = 'FLOAT_VECTOR'
    n_rot.inputs[0].default_value = (0.0, 0.0, 0.0)
    n_rot.inputs[1].default_value = (math.tau, math.tau, math.tau)
    n_rot.inputs[8].default_value = seed + 1

    n_scl = nd.new("FunctionNodeRandomValue"); n_scl.location = (-200, -400)
    n_scl.data_type = 'FLOAT'
    n_scl.inputs[2].default_value = obj_leaf_min
    n_scl.inputs[3].default_value = obj_leaf_max
    n_scl.inputs[8].default_value = seed + 2

    n_iop = nd.new("GeometryNodeInstanceOnPoints"); n_iop.location = (200, 0)

    lk.new(n_in.outputs[0],   n_dist.inputs[0])
    lk.new(n_dist.outputs[0], n_iop.inputs[0])
    if is_set:
        lk.new(n_src.outputs[0], n_iop.inputs[2])
        n_iop.inputs[3].default_value = True          # Pick Instance
        lk.new(n_pick.outputs[2], n_iop.inputs[4])
    else:
        lk.new(n_src.outputs[4], n_iop.inputs[2])
    lk.new(n_rot.outputs[0], n_iop.inputs[5])
    lk.new(n_scl.outputs[1], n_iop.inputs[6])
    lk.new(n_iop.outputs[0], n_out.inputs[0])         # NUR Instanzen -> Emitter-Mesh verschwindet
    return ng


def fit_emitter(emitter, trunk, overlap=0.25, width=1.0):
    """Emitter auf die Krone des Stamms setzen: Unterkante taucht `overlap` (Anteil der
    Emitter-Hoehe) in das Astwerk ein, damit das Laub die Aeste umschliesst statt darueber
    zu schweben. `width` skaliert die Kronenbreite relativ zur Astwerk-Spannweite."""
    def wbb(o):
        cs = [o.matrix_world @ Vector(c) for c in o.bound_box]
        lo = Vector((min(c.x for c in cs), min(c.y for c in cs), min(c.z for c in cs)))
        hi = Vector((max(c.x for c in cs), max(c.y for c in cs), max(c.z for c in cs)))
        return lo, hi

    tlo, thi = wbb(trunk)
    span = max(thi.x - tlo.x, thi.y - tlo.y)      # Spannweite des Astwerks
    th = thi.z - tlo.z

    # lokale Masse des Emitters
    bb = [Vector(c) for c in emitter.bound_box]
    elo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    ehi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    ed = ehi - elo

    target_w = max(span * width, 1e-6)
    s = target_w / max(ed.x, ed.y)
    eh = ed.z * s

    # Unterkante = Kronenansatz (dort wo die Aeste beginnen), minus Ueberlappung
    crown_base = tlo.z + th * 0.55
    z0 = crown_base - eh * overlap
    cx, cy = (tlo.x + thi.x) / 2.0, (tlo.y + thi.y) / 2.0

    # ⚠️ In x/y ZENTRIEREN (nicht die BBox-Ecke auf die Stammmitte setzen — sonst haengt
    #    die Krone seitlich neben dem Stamm). Nur z sitzt auf der Unterkante.
    anchor = Vector(((elo.x + ehi.x) / 2.0, (elo.y + ehi.y) / 2.0, elo.z))
    emitter.matrix_world = (Matrix.Translation(Vector((cx, cy, z0)))
                            @ Matrix.Diagonal((s, s, s, 1.0))
                            @ Matrix.Translation(-anchor))
    bpy.context.view_layer.update()
    print("[emit] %s auf %s gesetzt: Breite %.1f, Hoehe %.1f, Unterkante z=%.1f"
          % (emitter.name, trunk.name, target_w, eh, z0))
    return emitter


def scatter_emitter(emitter, leaf, leaf_size=0.30, size_var=0.35, count=70000,
                    seed=3, canopy_frac=0.0, dry_run=False, force=False):
    """Blaetter aus einem separaten EMITTER — der sichtbare Stamm bleibt UNANGETASTET.
    Der Emitter selbst verschwindet (sein Mesh landet nicht im Ausgang)."""
    if isinstance(emitter, str):
        emitter = bpy.data.objects[emitter]
    if isinstance(leaf, str):
        leaf = bpy.data.collections.get(leaf) or bpy.data.objects[leaf]

    # Flaeche des GANZEN Emitters (kein Kronen-Schnitt noetig)
    if canopy_frac > 0.0:
        area, _ = _canopy_area_objspace(emitter, canopy_frac)
    else:
        bm = bmesh.new(); bm.from_mesh(emitter.data)
        area = sum(f.calc_area() for f in bm.faces); bm.free()
    sc = _obj_scale(emitter)
    dens = count / max(area, 1e-9)
    obj_leaf = leaf_size / max(sc, 1e-9)
    polys = _leaf_polys(leaf)
    tris = count * polys

    print("emitter=%s  flaeche=%.3f  objskala=%.1f" % (emitter.name, area, sc))
    print("  Blatt %.2f Welt -> %.4f Objektraum | Dichte %d" % (leaf_size, obj_leaf, dens))
    print("  %d Instanzen x %d Polys = %.1f Mio Dreiecke (Budget %.0f Mio)"
          % (count, polys, tris / 1e6, MAX_TOTAL_TRIS / 1e6))
    if (count > MAX_TOTAL_INSTANCES or tris > MAX_TOTAL_TRIS) and not force:
        print("")
        print("🛑 ABBRUCH — ueber Budget. NICHTS geaendert.")
        return None
    if dry_run:
        print("(Trockenlauf — nichts geaendert.)")
        return None

    for m in list(emitter.modifiers):
        if m.type == 'NODES':
            emitter.modifiers.remove(m)
    ng = _build_emitter_group(leaf, obj_leaf * (1 - size_var), obj_leaf * (1 + size_var), dens, seed, canopy_frac)
    m = emitter.modifiers.new("LeafEmit", 'NODES')
    m.node_group = ng
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    real = sum(1 for i in dg.object_instances if i.is_instance)
    print("✅ Emitter bestueckt | Instanzen in der Szene: %d" % real)
    return ng
