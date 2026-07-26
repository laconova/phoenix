"""Turn an A-pose character into a T-POSE variant, for use as the HY-Motion retarget template.

Why: the MPFB "mixamo" rig is built in an A-pose, arms hanging at roughly 48 degrees. The
HY-Motion retargeter assumes a T-pose and applies its rotations ABSOLUTELY, without
compensating for the difference in rest pose -- so the arms end up systematically ~45 degrees
too high, and every generated clip comes out hunched with the forearms crossed in front of the
body. Generation still reports success, which is what makes this so confusing. The fix is
simply to hand the node what it expects.

The original character is left untouched (this writes a separate file), so the normal Mixamo
path in animate_human keeps working exactly as before.

Run:  blender --background --python make_tpose_char.py -- <in.fbx> <out.fbx>

Both paths are REQUIRED. Put the result in the input/3d/ folder of THE ComfyUI that has the
HY-Motion nodes, and point phoenix-config.json -> hyMotion.template at it.
"""
import bpy, addon_utils, os, sys, math
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) < 2:
    raise SystemExit(
        "usage: blender --background --python make_tpose_char.py -- <in.fbx> <out.fbx>\n"
        "  <in.fbx>  a Mixamo-rigged character FBX (A-pose is fine -- that is the point)\n"
        "  <out.fbx> where to write the T-pose template")
IN, OUT = argv[0], argv[1]

# Reihenfolge = Kette von der Wurzel nach aussen. Parent zuerst, sonst schleppt
# die Elternrotation das Kind wieder aus der Waagerechten.
CHAIN = ["mixamorig:LeftShoulder", "mixamorig:LeftArm", "mixamorig:LeftForeArm", "mixamorig:LeftHand",
         "mixamorig:RightShoulder", "mixamorig:RightArm", "mixamorig:RightForeArm", "mixamorig:RightHand"]

# Der Arm selbst muss in einer echten T-Pose STRIKT seitlich liegen (reine X-Achse) --
# nicht nur waagerecht. Das MPFB-Rig winkelt den Unterarm zusaetzlich ~44 Grad nach vorne
# an; nimmt man nur die Hoehenneigung raus, bleibt genau diese Beugung stehen und der
# Retargeter erbt sie in jede Animation.
# Das Schluesselbein (Shoulder) zeigt anatomisch seitlich-vorne -> dort nur die Neigung.
STRICT_X = {"mixamorig:LeftArm", "mixamorig:LeftForeArm", "mixamorig:LeftHand",
            "mixamorig:RightArm", "mixamorig:RightForeArm", "mixamorig:RightHand"}

addon_utils.enable("io_scene_fbx", default_set=False, persistent=False)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=IN)

arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
if arm is None:
    print("TPOSE_ERR:kein Armature in %s" % IN); sys.exit(1)
print("TPOSE:armature=%s bones=%d meshes=%d" % (arm.name, len(arm.data.bones), len(meshes)))


def tilt(v):
    """Neigung gegen die Horizontale in Grad. 0 = waagerecht = T-Pose."""
    return math.degrees(math.asin(max(-1.0, min(1.0, v.z))))


def bone_dir(pb):
    """Weltrichtung entlang des Bones (Bone-Y-Achse)."""
    M = arm.matrix_world @ pb.matrix
    return (M.to_3x3() @ Vector((0.0, 1.0, 0.0))).normalized(), M


# --- vorher messen -------------------------------------------------------
print("TPOSE:--- vorher ---")
before = {}
for bn in CHAIN:
    pb = arm.pose.bones.get(bn)
    if pb is None:
        print("TPOSE:   %s FEHLT" % bn); continue
    d, _ = bone_dir(pb)
    before[bn] = tilt(d)
    print("TPOSE:   %-26s Neigung=%+6.1f Grad" % (bn, before[bn]))

# --- Arme in die Waagerechte biegen -------------------------------------
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="POSE")

for bn in CHAIN:
    pb = arm.pose.bones.get(bn)
    if pb is None:
        continue
    d, M = bone_dir(pb)
    if bn in STRICT_X:
        target = Vector((1.0 if d.x >= 0 else -1.0, 0.0, 0.0))
    else:
        target = Vector((d.x, d.y, 0.0))
        if target.length < 1e-6:  # Bone zeigt senkrecht -> keine sinnvolle Horizontale
            print("TPOSE:   %s senkrecht, uebersprungen" % bn); continue
        target.normalize()
    R = d.rotation_difference(target).to_matrix().to_4x4()
    head = M.to_translation()
    # Weltrotation um den Bone-Kopf, dann zurueck in den Armature-Raum
    world_new = (Matrix.Translation(head) @ R @ Matrix.Translation(-head)) @ M
    pb.matrix = arm.matrix_world.inverted() @ world_new
    bpy.context.view_layer.update()

bpy.ops.object.mode_set(mode="OBJECT")
bpy.context.view_layer.update()

print("TPOSE:--- nachher (Pose) ---")
for bn in CHAIN:
    pb = arm.pose.bones.get(bn)
    if pb is None:
        continue
    d, _ = bone_dir(pb)
    print("TPOSE:   %-26s Neigung=%+6.1f Grad  (war %+6.1f)" % (bn, tilt(d), before.get(bn, 0.0)))

# --- Pose als Rest-Pose einbrennen --------------------------------------
# Kanonischer Weg: Armature-Modifier auf dem Mesh duplizieren, eine Kopie anwenden
# (friert die Pose-Form ein), dann die Rest-Pose des Armature ueberschreiben.
for me in meshes:
    mods = [m for m in me.modifiers if m.type == "ARMATURE"]
    if not mods:
        print("TPOSE:   %s ohne Armature-Modifier, uebersprungen" % me.name); continue
    if me.data.shape_keys:
        n = len(me.data.shape_keys.key_blocks)
        print("TPOSE_WARN:%s hat %d Shape-Keys -> modifier_apply blockiert" % (me.name, n))
    bpy.context.view_layer.objects.active = me
    bpy.ops.object.select_all(action="DESELECT")
    me.select_set(True)
    try:
        bpy.ops.object.modifier_copy(modifier=mods[0].name)
        bpy.ops.object.modifier_apply(modifier=mods[0].name)
        print("TPOSE:   %s Pose eingefroren (Modifier uebrig: %d)"
              % (me.name, len([m for m in me.modifiers if m.type == "ARMATURE"])))
    except Exception as e:
        print("TPOSE_ERR:modifier_apply auf %s: %r" % (me.name, e)); sys.exit(2)

bpy.context.view_layer.objects.active = arm
bpy.ops.object.select_all(action="DESELECT")
arm.select_set(True)
bpy.ops.object.mode_set(mode="POSE")
bpy.ops.pose.armature_apply()
bpy.ops.object.mode_set(mode="OBJECT")
bpy.context.view_layer.update()

# --- beweisen: jetzt muss die REST-Pose waagerecht sein ------------------
print("TPOSE:--- nachher (REST) ---")
ok = True
for bn in CHAIN:
    b = arm.data.bones.get(bn)
    if b is None:
        continue
    d = (arm.matrix_world.to_3x3() @ (b.tail_local - b.head_local)).normalized()
    t = tilt(d)
    # Fuer die Arme ist die Y-Komponente (Vorwaerts-Beugung) genauso wichtig wie die Neigung --
    # sie war der Grund, warum die Unterarme nach dem ersten Anlauf noch angewinkelt blieben.
    bad = abs(t) >= 1.0 or (bn in STRICT_X and abs(d.y) >= 0.02)
    if bad and "Shoulder" not in bn:
        ok = False
    print("TPOSE:   %-26s rest-dir=(%+.2f %+.2f %+.2f)  Neigung=%+6.1f Grad%s"
          % (bn, d.x, d.y, d.z, t, "  <-- NICHT T-Pose" if bad else ""))

bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.fbx(filepath=OUT, use_selection=True, add_leaf_bones=False,
                         bake_anim=False, path_mode="COPY", embed_textures=True)
size = os.path.getsize(OUT) if os.path.exists(OUT) else -1
print("TPOSE_DONE:%s:%d bytes:rest_flat=%s" % (OUT, size, ok))
