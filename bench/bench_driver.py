# Phoenix competence benchmark driver (v1.9 M2.1) — run by Blender, never by hand:
#   blender -b --python bench/bench_driver.py     (env PHOENIX_BLENDER_IPC_DIR=<bench dir>)
# No factory flags and no settings reset on purpose: both make Blender's extension wheel sync orphan the user's wheels (measured 08.10.).
# Builds a fixture scene, loads the SAME addon code the user's live session runs (blender-addon/phoenix_blender_ipc.py)
# as a plain module, and pumps its tick by hand: bpy.app.timers do not fire in -b script mode (measured 06.10.).
# A different IPC dir means the user's open Blender is never touched. Ends on a STOP file, or after MAX_SECONDS: the run budget the
# caller computed (env PHOENIX_BENCH_MAX_SECONDS: runs x tasks x task timeout + margin; default 600 for a hand run) - sweep 2 G5.
import bpy, os, sys, time, importlib.util

try:
    MAX_SECONDS = max(60.0, float(os.environ.get("PHOENIX_BENCH_MAX_SECONDS", "600")))
except ValueError:
    MAX_SECONDS = 600.0


def _bench_reset():
    """Rebuild the fixture from scratch (called before every task). Empties the open file in place; never resets Blender itself."""
    try:
        if bpy.context.object is not None and bpy.context.object.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
    except Exception:
        pass
    for o in list(bpy.data.objects):
        try:
            bpy.data.objects.remove(o, do_unlink=True)
        except Exception:
            pass
    try:
        scenes = list(bpy.data.scenes)
    except Exception:
        scenes = []
    for sc in scenes:
        try:
            for c in list(sc.collection.children):
                try:
                    bpy.data.collections.remove(c)
                except Exception:
                    pass
        except Exception:
            pass
    for attr in ("meshes", "materials", "lights", "cameras", "curves", "images", "textures", "node_groups", "actions", "grease_pencils"):
        coll = getattr(bpy.data, attr, None)
        if coll is None:
            continue
        for blk in list(coll):
            try:
                coll.remove(blk)
            except Exception:
                pass
    _edit = bpy.context.preferences.edit
    _prev = _edit.use_enter_edit_mode
    _edit.use_enter_edit_mode = False   # user prefs are loaded now; never saved, restored below
    try:
        bpy.ops.mesh.primitive_cube_add(location=(0, 0, 1)); bpy.context.object.name = "Crate"
        bpy.ops.mesh.primitive_uv_sphere_add(location=(3, 0, 1)); bpy.context.object.name = "Ball"
        bpy.ops.object.light_add(type='POINT', location=(0, 0, 5)); bpy.context.object.name = "Light"
        bpy.ops.object.camera_add(location=(8, -8, 6)); bpy.context.object.name = "Camera"
    finally:
        try:
            _edit.use_enter_edit_mode = _prev
        except Exception:
            pass


_bench_reset()

_addon = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "blender-addon", "phoenix_blender_ipc.py")
spec = importlib.util.spec_from_file_location("phoenix_blender_ipc_bench", _addon)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m._ns["_bench_reset"] = _bench_reset   # callable from the code the orchestrator-turn harness sends
m._running = True
m._dir = m._ipc_dir()
m._cmd_file = os.path.join(m._dir, "cmd.json")
m._res_file = os.path.join(m._dir, "result.json")
os.makedirs(m._dir, exist_ok=True)

print("BENCH READY", m._dir, flush=True)
_stop = os.path.join(m._dir, "STOP")
_t0 = time.time()
while not os.path.exists(_stop) and time.time() - _t0 < MAX_SECONDS:
    m._tick()
    time.sleep(0.1)
print("BENCH END", flush=True)
