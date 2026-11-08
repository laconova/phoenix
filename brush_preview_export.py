import sys
import os
import bpy

source, lib_dir, fn, output = sys.argv[sys.argv.index('--') + 1:]
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
for kind in ('meshes', 'curves', 'materials', 'collections'):
    blocks = getattr(bpy.data, kind)
    for block in list(blocks):
        if block.users == 0:
            blocks.remove(block)
namespace = {'__name__': '__preview__', '__file__': source}
with open(source, encoding='utf-8-sig') as stream:
    exec(compile(stream.read(), source, 'exec'), namespace)
namespace['_LIB_DIR'] = lib_dir
namespace[fn]()
os.makedirs(os.path.dirname(output), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=output, export_format='GLB', export_materials='EXPORT', export_apply=True)
