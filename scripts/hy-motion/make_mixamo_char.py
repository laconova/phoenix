"""Build an MPFB2 human with a Mixamo rig and export it as FBX.
Purpose: the raw material for an HY-Motion retarget template (ComfyUI/input/3d/).
The rig call is identical to Phoenix's make_human.js (HS.add_builtin_rig(human, "mixamo")).

Runs headless: blender --background --python make_mixamo_char.py -- <out.fbx>

This is step 0, for when you have no rigged character at all. make_tpose_char.py then turns
the result into the actual HY-Motion template. Requires MPFB2 in this Blender.
"""
import bpy, sys, os, addon_utils, importlib

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if not argv:
    raise SystemExit(
        "usage: blender --background --python make_mixamo_char.py -- <out.fbx>")
OUT = argv[0]

addon_utils.enable("io_scene_fbx", default_set=False, persistent=False)
bpy.ops.wm.read_factory_settings(use_empty=True)

MOD = "bl_ext.user_default.mpfb"
addon_utils.enable(MOD, default_set=True, persistent=True)
HS = importlib.import_module(MOD + ".services.humanservice").HumanService

human = HS.create_human(mask_helpers=True, detailed_helpers=True,
                        macro_detail_dict={
                            "gender": 0.5, "age": 0.5, "muscle": 0.5,
                            "weight": 0.5, "height": 0.5,
                            "proportions": 0.5, "cupsize": 0.5, "firmness": 0.5,
                            "race": {"asian": 0.33, "caucasian": 0.34, "african": 0.33},
                        })
print("CHAR:basemesh=%s verts=%d" % (human.name, len(human.data.vertices)))

try:
    HS.add_builtin_rig(human, "mixamo", import_weights=True)
    print("CHAR:RIG_ADDED:mixamo")
except Exception as e:
    print("CHAR_ERR:rig:%r" % (e,))
    sys.exit(1)


def _root(o):
    while o.parent is not None:
        o = o.parent
    return o


arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
if arm is None:
    print("CHAR_ERR:no armature after rig")
    sys.exit(1)

bones = [b.name for b in arm.data.bones]
mixamo = [b for b in bones if b.lower().startswith("mixamorig")]
print("CHAR:armature=%s bones=%d mixamorig=%d" % (arm.name, len(bones), len(mixamo)))
print("CHAR:sample=%s" % ", ".join(bones[:8]))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.fbx(filepath=OUT, use_selection=True, add_leaf_bones=False,
                         bake_anim=False, path_mode="COPY", embed_textures=True)
size = os.path.getsize(OUT) if os.path.exists(OUT) else -1
print("CHAR_DONE:%s:%d bytes" % (OUT, size))
