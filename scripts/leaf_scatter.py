# leaf_scatter.py — scatter leaves as instances over tree canopies (Blender 5.x)
#
# WHY THIS EXISTS
#   An image-to-3D mesher gives you roughly 27k polygons for a WHOLE tree. Scaled to scene
#   size, every "leaf" in that mesh is a facet 0.5-1 m across — backlit, it reads as broken
#   glass. No prompt fixes that: it is polygon budget divided by tree size.
#   What the mesher IS good at is compact, solid bodies — animals, rocks, trunks, and SINGLE
#   LEAVES. So: generate one leaf, decimate it, and instance it thousands of times over the
#   canopy with Geometry Nodes. Leaf size becomes a DIAL instead of a property baked into
#   the mesh.
#
# WHAT THIS SCRIPT HANDLES FOR YOU (two traps that cost real time)
#   1) Leaf size is given in WORLD units. The instance scale inside Geometry Nodes lives in
#      OBJECT space and gets multiplied by the tree's own object scale, which after an import
#      is often ~26x. The script converts for you.
#   2) INSTANCE GUARD: the instance count is computed exactly, from the emitter area, BEFORE
#      anything is applied. Over budget means it stops and tells you, instead of letting
#      Blender die of OOM. (That failure is why the guard exists: density 55000 x 15 trees.)
#
# USAGE (inside Blender — e.g. through the Phoenix IPC bridge):
#
#   import sys; sys.path.append(r"<path to this repo>/scripts")
#   import leaf_scatter, importlib; importlib.reload(leaf_scatter)
#
#   # 1) prepare the leaf (import the GLB, decimate to an instance-friendly poly count)
#   leaf = leaf_scatter.prepare_leaf(r"<repo>/staging/leaf/my_oak_leaf.glb",
#                                    target_polys=400, name="LEAF_oak")
#
#   # 2) dry run: computes only, changes NOTHING
#   leaf_scatter.scatter(["TREE_oak"], leaf, leaf_size=0.30, dry_run=True)
#
#   # 3) numbers look right? apply
#   leaf_scatter.scatter(["TREE_oak"], leaf, leaf_size=0.30)
#
#   # remove again
#   leaf_scatter.clear(["TREE_oak"])

import bpy
import bmesh
import math
from mathutils import Vector, Matrix

# ─── Budget ──────────────────────────────────────────────────────────────────
# Measured on a 16 GB laptop: beyond this EEVEE turns unstable while rendering.
MAX_TOTAL_INSTANCES = 600_000
MAX_TOTAL_TRIS      = 200_000_000

NODE_GROUP = "LeafScatter"   # prefix; the actual group is named LeafScatter_<source>


def _group_name(leaf):
    return "%s_%s" % (NODE_GROUP, leaf.name)


# ─── Preparing the leaf ──────────────────────────────────────────────────────
def prepare_leaf(glb_path, target_polys=400, name="LEAF"):
    """Import a GLB, drop the import empties, decimate to target_polys.
    Returns the finished leaf object (it lives in the 'LeafLib' collection)."""
    coll = bpy.data.collections.get("LeafLib")
    if coll is None:
        coll = bpy.data.collections.new("LeafLib")
        bpy.context.scene.collection.children.link(coll)

    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=glb_path)
    added = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in added if o.type == 'MESH']
    if not meshes:
        raise RuntimeError("no mesh in the GLB: " + glb_path)

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

    # Park it out of the way and out of the render — the instances still render.
    ob.matrix_world = Matrix.Translation(Vector((0.0, 0.0, -500.0)))
    ob.hide_render = True

    d = ob.dimensions
    print("[leaf] %s: %d -> %d polys | own size %.3f x %.3f x %.3f"
          % (name, n, len(ob.data.polygons), d.x, d.y, d.z))
    return ob


# ─── Measuring (the guard) ───────────────────────────────────────────────────
def _canopy_area_objspace(tree, canopy_frac):
    """Canopy surface area in OBJECT space (that is the size
    DistributePointsOnFaces works with) plus the canopy cut height."""
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
    """Poly count of the instance source — works for a single object AND for a leaf set."""
    if isinstance(leaf, bpy.types.Collection):
        objs = [o for o in leaf.objects if o.type == 'MESH']
        if not objs:
            return 0
        return int(sum(len(o.data.polygons) for o in objs) / len(objs))
    return len(leaf.data.polygons)


def _leaf_name(leaf):
    return leaf.name


def plan(tree_names, leaf, leaf_size=0.30, per_tree=None, density=None, canopy_frac=0.28):
    """Compute without changing anything. Returns (rows, total_inst, total_tris)."""
    leaf_polys = _leaf_polys(leaf)
    rows = []
    total_inst = 0
    for name in tree_names:
        t = bpy.data.objects.get(name)
        if not t or t.type != 'MESH':
            rows.append((name, 0, 0, 0.0, 0.0, "MISSING"))
            continue
        area, _ = _canopy_area_objspace(t, canopy_frac)
        sc = _obj_scale(t)
        if per_tree:
            dens = per_tree / max(area, 1e-9)
            inst = per_tree
        else:
            dens = density if density else 9000.0
            inst = int(dens * area)
        obj_leaf = leaf_size / max(sc, 1e-9)     # world -> object space
        total_inst += inst
        rows.append((name, inst, int(dens), sc, obj_leaf, "ok"))
    return rows, total_inst, total_inst * leaf_polys


def _report(rows, total_inst, total_tris, leaf):
    print("%-18s %10s %9s %8s %10s" % ("tree", "instances", "density", "objscale", "leaf_obj"))
    for name, inst, dens, sc, obj_leaf, st in rows:
        if st != "ok":
            print("%-18s  %s" % (name, st))
            continue
        print("%-18s %10d %9d %8.1f %10.4f" % (name, inst, dens, sc, obj_leaf))
    print("-" * 62)
    print("TOTAL: %d instances x %d polys = %.1f M triangles"
          % (total_inst, _leaf_polys(leaf), total_tris / 1e6))
    print("Budget: %d instances / %.0f M triangles"
          % (MAX_TOTAL_INSTANCES, MAX_TOTAL_TRIS / 1e6))


# ─── Node group ──────────────────────────────────────────────────────────────
def make_leaf_set(glb_paths, name, target_polys=400):
    """Several leaves in ONE collection -> a mixed canopy (not the same leaf 1000 times).
    Returns the collection; pass it to scatter(leaf=...)."""
    cname = "LeafSet_" + name
    c = bpy.data.collections.get(cname)
    if c:
        for o in list(c.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.collections.remove(c)
    c = bpy.data.collections.new(cname)
    # Deliberately NOT linked into the scene — the collection is only an instance source.
    for i, p in enumerate(glb_paths):
        ob = prepare_leaf(p, target_polys=target_polys, name="%s_leaf%d" % (name, i))
        # WARNING: CollectionInfo carries the source object's transform INTO EVERY INSTANCE.
        # prepare_leaf parks the leaf at z=-500, so every instance would inherit that offset
        # (ObjectInfo does NOT do this, which is why a single leaf never shows the problem).
        # Leaves in a set therefore have to sit at the origin.
        ob.matrix_world = Matrix.Identity(4)
        for cc in list(ob.users_collection):
            cc.objects.unlink(ob)
        c.objects.link(ob)
    print("[leaf] leaf set '%s': %d varieties" % (cname, len(c.objects)))
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

    # The canopy threshold is computed PER OBJECT, relatively. Hard-wiring it makes the group
    # work for exactly one tree and quietly misbehave on every other one.
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

    # Instance source: ONE object (ObjectInfo) OR a collection (CollectionInfo + Pick Instance)
    is_set = isinstance(leaf, bpy.types.Collection)
    if is_set:
        n_obj = nd.new("GeometryNodeCollectionInfo"); n_obj.location = (-40, -520)
        n_obj.inputs[0].default_value = leaf
        n_obj.inputs[1].default_value = True      # Separate Children -> one instance per variety
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

    # Sockets are wired BY INDEX — the names differ in Blender 5.1 ('Rotation' is its own type).
    lk.new(n_in.outputs[0],   n_bb.inputs[0])
    lk.new(n_bb.outputs[1],   n_smi.inputs[0])      # Min
    lk.new(n_bb.outputs[2],   n_sma.inputs[0])      # Max
    lk.new(n_sma.outputs[2],  n_sub.inputs[0])
    lk.new(n_smi.outputs[2],  n_sub.inputs[1])
    lk.new(n_sub.outputs[0],  n_mul.inputs[0])
    lk.new(n_mul.outputs[0],  n_add.inputs[0])
    lk.new(n_smi.outputs[2],  n_add.inputs[1])
    lk.new(n_add.outputs[0],  n_gt.inputs[1])       # threshold

    lk.new(n_pos.outputs[0],  n_sep.inputs[0])
    lk.new(n_sep.outputs[2],  n_gt.inputs[0])       # z
    lk.new(n_in.outputs[0],   n_dist.inputs[0])
    lk.new(n_gt.outputs[0],   n_dist.inputs[1])     # Selection = canopy
    lk.new(n_dist.outputs[0], n_iop.inputs[0])
    if is_set:
        lk.new(n_obj.outputs[0], n_iop.inputs[2])   # CollectionInfo -> Instances
        n_iop.inputs[3].default_value = True        # Pick Instance
        lk.new(n_pick.outputs[2], n_iop.inputs[4])  # Instance Index (random INT)
    else:
        lk.new(n_obj.outputs[4], n_iop.inputs[2])   # ObjectInfo -> Geometry
    lk.new(n_rot.outputs[0],  n_iop.inputs[5])      # Rotation
    lk.new(n_scl.outputs[1],  n_iop.inputs[6])      # Scale

    lk.new(n_in.outputs[0],   n_del.inputs[0])
    lk.new(n_gt.outputs[0],   n_del.inputs[1])      # canopy faces go, the trunk stays
    lk.new(n_del.outputs[0],  n_join.inputs[0])
    lk.new(n_iop.outputs[0],  n_join.inputs[0])
    lk.new(n_join.outputs[0], n_out.inputs[0])
    return ng


# ─── Applying ────────────────────────────────────────────────────────────────
def scatter(tree_names, leaf, leaf_size=0.30, size_var=0.35, per_tree=None,
            density=None, canopy_frac=0.28, seed=3, dry_run=False, force=False):
    """leaf_size = leaf size in WORLD units (e.g. 0.30 is about 30 cm when 1 unit = 1 m).
    Give either per_tree (target instance count per tree) OR density.
    dry_run=True only computes. force=True overrides the guard (at your own risk)."""
    if isinstance(leaf, str):
        leaf = bpy.data.collections.get(leaf) or bpy.data.objects[leaf]
    _assert_clean_sources(leaf)
    rows, total_inst, total_tris = plan(tree_names, leaf, leaf_size, per_tree, density, canopy_frac)
    _report(rows, total_inst, total_tris, leaf)

    over = (total_inst > MAX_TOTAL_INSTANCES) or (total_tris > MAX_TOTAL_TRIS)
    if over and not force:
        print("\nSTOPPED — over budget. NOTHING was changed.")
        print("   Remedies: a smaller target count (per_tree), a coarser leaf (fewer polys),")
        print("   or fine leaves ONLY on the foreground trees and coarse ones on the rest.")
        print("   (force=True overrides this — that is exactly how Blender got killed once.)")
        return None
    if dry_run:
        print("\n(Dry run — nothing changed.)")
        return None

    ok = [r for r in rows if r[5] == "ok"]
    if not ok:
        print("No valid trees.")
        return None

    # Scale and density are aligned to the first tree; if object scales differ a lot,
    # call this in separate groups of trees.
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
    print("\nApplied to %d trees | instances in the depsgraph: %d (estimated: %d)"
          % (len(ok), real, total_inst))
    return ng


def clear(tree_names):
    """Take the modifiers off again — the original canopies come back."""
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
    print("[leaf] %d modifiers removed" % n)

# ═══════════════════════════════════════════════════════════════════════════════
# EMITTER MODE  (added after the finding "the leaves grow out of thin air")
#
# THE PROBLEM with the canopy-cut mode above: `canopy_frac` deletes EVERYTHING above the
# threshold — not only the shard-like canopy but the BRANCHES too. What is left is a trunk
# stump with foliage hovering beside it. A pure height cut CANNOT solve this: at the same
# height you find branches (keep) and canopy facets (delete), and it cannot tell them apart.
#
# THE FIX: the visible trunk (with all its branches) and the emitter are TWO objects.
#   - The trunk is left completely untouched.
#   - The modifier sits on the EMITTER and outputs ONLY instances — the emitter geometry
#     never reaches the output and therefore disappears on its own.
#     No deleting, no cutting, no lost branches.
# ═══════════════════════════════════════════════════════════════════════════════

def _build_emitter_group(leaf, obj_leaf_min, obj_leaf_max, density, seed, canopy_frac=0.0,
                         poisson_dist=0.0, depth=0.0, out_frac=0.15):
    """Node tree for emitter mode: the output is NOTHING BUT instances."""
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
    # RANDOM clumps: leaves land on top of each other while gaps open up next to them. You then
    # raise the count to close the gaps and end up with a solid mass. POISSON keeps a minimum
    # distance instead: even coverage with far fewer leaves.
    if poisson_dist > 0.0:
        n_dist.distribute_method = 'POISSON'
        n_dist.inputs[2].default_value = float(poisson_dist)   # Distance Min (object space)
        n_dist.inputs[3].default_value = float(density)        # Density Max
        n_dist.inputs[6].default_value = int(seed)
    else:
        n_dist.distribute_method = 'RANDOM'
        n_dist.inputs[4].default_value = float(density)
        n_dist.inputs[6].default_value = int(seed)

    # A donor tree used as an emitter has a trunk of its own, and no leaves should grow from it.
    # The threshold is relative to the emitter's OWN bounding box (canopy_frac=0 -> the whole
    # surface emits).
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

    lk.new(n_in.outputs[0], n_dist.inputs[0])

    # ─── DEPTH: pull leaves off the emitter SKIN and into its VOLUME ──────────
    # WHY: DistributePointsOnFaces puts points exactly ON the surface, so the foliage sits on
    # a shell — you do not see a canopy, you see the emitter's OUTLINE ("monotonous, like
    # bubbles"). Whatever shape the emitter has shows through, no matter how many leaves you
    # add. Fix: displace each point randomly along its NORMAL — mostly INWARDS (negative), with
    # a small share outwards (out_frac) to fray the silhouette. The result is a filled volume
    # instead of a skin, and the emitter shape stops being visible.
    if depth > 0.0:
        n_sp  = nd.new("GeometryNodeSetPosition");    n_sp.location  = (0, 160)
        n_rd  = nd.new("FunctionNodeRandomValue");    n_rd.location  = (-200, 300)
        n_rd.data_type = 'FLOAT'
        n_rd.inputs[2].default_value = -float(depth)                   # inwards
        n_rd.inputs[3].default_value = float(depth) * float(out_frac)  # a little outwards
        n_rd.inputs[8].default_value = int(seed) + 7
        n_vs  = nd.new("ShaderNodeVectorMath");       n_vs.location  = (-40, 300)
        n_vs.operation = 'SCALE'

        lk.new(n_dist.outputs[1], n_vs.inputs[0])     # the point's normal
        lk.new(n_rd.outputs[1],   n_vs.inputs[3])     # random amount (FLOAT -> Scale)
        lk.new(n_dist.outputs[0], n_sp.inputs[0])     # points in
        lk.new(n_vs.outputs[0],   n_sp.inputs[3])     # offset = normal * amount
        lk.new(n_sp.outputs[0],   n_iop.inputs[0])    # displaced points -> instances
    else:
        lk.new(n_dist.outputs[0], n_iop.inputs[0])

    if is_set:
        lk.new(n_src.outputs[0], n_iop.inputs[2])
        n_iop.inputs[3].default_value = True          # Pick Instance
        lk.new(n_pick.outputs[2], n_iop.inputs[4])
    else:
        lk.new(n_src.outputs[4], n_iop.inputs[2])
    lk.new(n_rot.outputs[0], n_iop.inputs[5])
    lk.new(n_scl.outputs[1], n_iop.inputs[6])
    lk.new(n_iop.outputs[0], n_out.inputs[0])         # ONLY instances -> the emitter mesh vanishes
    return ng


def fit_emitter(emitter, trunk, overlap=0.25, width=1.0):
    """Place the emitter over the trunk's canopy: its lower edge sinks `overlap` (a fraction of
    the emitter height) into the branches, so the foliage wraps around them instead of floating
    above. `width` scales the canopy width relative to the span of the branches."""
    def wbb(o):
        cs = [o.matrix_world @ Vector(c) for c in o.bound_box]
        lo = Vector((min(c.x for c in cs), min(c.y for c in cs), min(c.z for c in cs)))
        hi = Vector((max(c.x for c in cs), max(c.y for c in cs), max(c.z for c in cs)))
        return lo, hi

    tlo, thi = wbb(trunk)
    span = max(thi.x - tlo.x, thi.y - tlo.y)      # span of the branches
    th = thi.z - tlo.z

    # the emitter's local dimensions
    bb = [Vector(c) for c in emitter.bound_box]
    elo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    ehi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    ed = ehi - elo

    target_w = max(span * width, 1e-6)
    s = target_w / max(ed.x, ed.y)
    eh = ed.z * s

    # lower edge = where the crown starts (where the branches begin), minus the overlap
    crown_base = tlo.z + th * 0.55
    z0 = crown_base - eh * overlap
    cx, cy = (tlo.x + thi.x) / 2.0, (tlo.y + thi.y) / 2.0

    # Centre in x/y — do NOT put the bbox corner on the trunk centre, or the canopy hangs off
    # to one side. Only z sits on the lower edge.
    anchor = Vector(((elo.x + ehi.x) / 2.0, (elo.y + ehi.y) / 2.0, elo.z))
    emitter.matrix_world = (Matrix.Translation(Vector((cx, cy, z0)))
                            @ Matrix.Diagonal((s, s, s, 1.0))
                            @ Matrix.Translation(-anchor))
    bpy.context.view_layer.update()
    print("[emit] %s placed on %s: width %.1f, height %.1f, lower edge z=%.1f"
          % (emitter.name, trunk.name, target_w, eh, z0))
    return emitter


def _assert_clean_sources(leaf):
    """Instance sources MUST be parentless and sit at the origin.

    WHY: CollectionInfo carries the source object's transform into EVERY instance. A leaf still
    parented to its glTF import empty travels with that empty — move the tree and all foliage of
    that variety jumps with it. The failure is SILENT: the foliage merely looks "somehow badly
    placed". A third of a finished tree once slipped out of position that way, with no message
    anywhere. So this does not warn — it STRAIGHTENS the sources out, and says so.
    """
    objs = list(leaf.objects) if hasattr(leaf, "objects") else [leaf]
    bad = [o for o in objs if o.parent is not None or o.matrix_world != Matrix.Identity(4)]
    for o in bad:
        print("WARNING: source '%s' was not clean (parent=%s) -> reset"
              % (o.name, o.parent.name if o.parent else "-"))
        o.parent = None
        o.matrix_world = Matrix.Identity(4)
    if bad:
        bpy.context.view_layer.update()
    return len(bad)


def scatter_emitter(emitter, leaf, leaf_size=0.30, size_var=0.35, count=70000,
                    seed=3, canopy_frac=0.0, dry_run=False, force=False, poisson=0.0,
                    depth=0.0, out_frac=0.15):
    """Leaves from a separate EMITTER — the visible trunk is left UNTOUCHED.
    The emitter itself disappears (its mesh never reaches the output).

    poisson: minimum distance between leaves in WORLD metres (0 = the old RANDOM distribution).
             Rule of thumb: leaf_size * 0.5 — leaves touch but do not clump.
             count then acts as an UPPER LIMIT: Poisson places as many points as the minimum
             distance allows, but never more than count."""
    if isinstance(emitter, str):
        emitter = bpy.data.objects[emitter]
    if isinstance(leaf, str):
        leaf = bpy.data.collections.get(leaf) or bpy.data.objects[leaf]

    _assert_clean_sources(leaf)

    # area of the WHOLE emitter (no canopy cut needed here)
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

    print("emitter=%s  area=%.3f  objscale=%.1f" % (emitter.name, area, sc))
    print("  leaf %.2f world -> %.4f object space | density %d" % (leaf_size, obj_leaf, dens))
    print("  %d instances x %d polys = %.1f M triangles (budget %.0f M)"
          % (count, polys, tris / 1e6, MAX_TOTAL_TRIS / 1e6))
    if (count > MAX_TOTAL_INSTANCES or tris > MAX_TOTAL_TRIS) and not force:
        print("")
        print("STOPPED — over budget. NOTHING changed.")
        return None
    if dry_run:
        print("(Dry run — nothing changed.)")
        return None

    for m in list(emitter.modifiers):
        if m.type == 'NODES':
            emitter.modifiers.remove(m)
    obj_poisson = (poisson / max(sc, 1e-9)) if poisson > 0.0 else 0.0   # world -> object space
    obj_depth   = (depth / max(sc, 1e-9)) if depth > 0.0 else 0.0
    ng = _build_emitter_group(leaf, obj_leaf * (1 - size_var), obj_leaf * (1 + size_var), dens, seed,
                              canopy_frac, obj_poisson, obj_depth, out_frac)
    m = emitter.modifiers.new("LeafEmit", 'NODES')
    m.node_group = ng
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    real = sum(1 for i in dg.object_instances if i.is_instance)
    print("Emitter populated | instances in the scene: %d" % real)
    return ng


# ─── Cluster emitter ─────────────────────────────────────────────────────────
# WHY: a single sphere as an emitter gives a SPHERE silhouette, at any density. Real canopies
# are clumped and frayed. So: place several small spheres at the BRANCH ENDS and merge them
# into ONE emitter. Side effect: on short branches, `spread` carries the clusters outwards and
# the canopy still fills out.
def make_cluster_emitter(trunk, n=10, radius=0.55, crown_from=0.5, spread=1.0,
                         squash=0.75, seed=7, name="EMITTER"):
    """Cluster emitter built from the trunk's branches.
      n          number of clusters
      radius     cluster radius, as a FRACTION of the branch span
      crown_from the relative trunk height above which clusters may sit (0..1)
      spread     >1 carries the clusters outwards (short branches -> still a wide canopy)
      squash     vertical squash of the clusters (canopies are wider than they are tall)
    """
    import random
    if isinstance(trunk, str):
        trunk = bpy.data.objects[trunk]
    rnd = random.Random(seed)

    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)

    # branch vertices in WORLD coordinates
    verts = [trunk.matrix_world @ v.co for v in trunk.data.vertices]
    zs = [v.z for v in verts]
    zlo, zhi = min(zs), max(zs)
    cut = zlo + (zhi - zlo) * crown_from
    cand = [v for v in verts if v.z >= cut]
    if len(cand) < n:
        cand = verts
    xs = [v.x for v in verts]; ys = [v.y for v in verts]
    span = max(max(xs) - min(xs), max(ys) - min(ys))
    cx, cy = (max(xs) + min(xs)) / 2.0, (max(ys) + min(ys)) / 2.0

    # Farthest-point sampling: clusters as FAR APART as possible rather than random
    # (random puts several clusters in the same clump of branches and leaves the rest bare).
    picks = [max(cand, key=lambda v: (v.x - cx) ** 2 + (v.y - cy) ** 2 + (v.z - cut) ** 2)]
    while len(picks) < n:
        nxt = max(cand, key=lambda v: min((v - p).length_squared for p in picks))
        picks.append(nxt)

    r = max(span * radius, 1e-4)
    parts = []
    for i, p in enumerate(picks):
        # spread: carry the cluster radially outwards from the trunk centre
        off = Vector((p.x - cx, p.y - cy, 0.0)) * (spread - 1.0)
        loc = p + off
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=r, location=loc)
        ob = bpy.context.active_object
        jitter = 1.0 + rnd.uniform(-0.30, 0.30)         # no two clusters the same size
        ob.scale = (jitter, jitter, jitter * squash)
        parts.append(ob)

    bpy.ops.object.select_all(action='DESELECT')
    for ob in parts:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    emit = bpy.context.active_object
    emit.name = name
    emit.hide_render = True
    bpy.context.view_layer.update()
    print("[emit] %s: %d clusters, r=%.2f, span %.1f, spread=%.2f"
          % (name, n, r, span, spread))
    return emit
