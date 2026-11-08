import sys
import os
import bpy

# Opened with the character .blend already loaded (blender --background <blend> --python this -- <out.glb>).
output = sys.argv[sys.argv.index('--') + 1]
os.makedirs(os.path.dirname(output), exist_ok=True)

# A saved character is written with bpy.data.libraries.write, so it opens as "Library file, loading empty scene":
# the objects exist in bpy.data but are linked to no scene. Link every mesh / armature that is not in the scene yet.
scene = bpy.context.scene
in_scene = set(o.name for o in scene.objects)
for obj in bpy.data.objects:
    if obj.type in ('MESH', 'ARMATURE') and obj.name not in in_scene:
        scene.collection.objects.link(obj)

# The poster shows the character as saved: nothing hidden, nothing applied.
for obj in bpy.data.objects:
    try:
        obj.hide_set(False)
        obj.hide_viewport = False
        obj.hide_render = False
    except Exception:
        pass

if not [o for o in scene.objects if o.type == 'MESH']:
    raise RuntimeError('No mesh in the character file')

bpy.ops.export_scene.gltf(filepath=output, export_format='GLB', use_selection=False, export_apply=False, export_animations=False)

if not os.path.exists(output) or os.path.getsize(output) <= 1024:
    raise RuntimeError('Blender wrote an empty GLB')
