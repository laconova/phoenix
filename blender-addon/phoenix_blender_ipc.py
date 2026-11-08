# Phoenix Blender IPC — file-based addon
#
# Lets Phoenix drive Blender. It watches a shared folder for cmd.json, runs the Python
# inside, and writes the result to result.json. No sockets — this is deliberate: raw
# cross-process sockets fail on Windows + Blender 5.1 / Python 3.13 (WinError 10035,
# accept() never returns external connections). File-IPC has no networking/firewall/
# Winsock failure modes and works identically on Windows and Linux.
#
# Install:  Edit > Preferences > Add-ons > Install from Disk… > pick this file > enable
#           the checkbox. It starts automatically. A "Phoenix" tab in the 3D viewport
#           sidebar (press N) shows status and a manual Start/Stop.
#
# Protocol (shared dir, default <os temp>/phoenix-blender-ipc — override with the
# PHOENIX_BLENDER_IPC_DIR env var to match Phoenix's config):
#   cmd.json    : {"id": <uuid>, "type": "execute", "code": "<python>"}
#   result.json : {"id": <uuid>, "status": "ok"|"error", "stdout": "<print>", "message": "<err>", "result": {}}

bl_info = {
    "name": "Phoenix Blender IPC",
    "author": "Laconova",
    "version": (1, 1, 2),
    "blender": (3, 0, 0),
    "location": "View3D > Sidebar (N) > Phoenix",
    "description": "File-based IPC so Phoenix can run Python in Blender (no sockets).",
    "category": "Development",
}

import bpy
import os
import io
import json
import tempfile
import traceback
from contextlib import redirect_stdout

POLL = 0.25  # seconds between folder checks

def _ipc_dir():
    return os.environ.get("PHOENIX_BLENDER_IPC_DIR") or \
        os.path.join(tempfile.gettempdir(), "phoenix-blender-ipc")

_dir = _ipc_dir()
_cmd_file = os.path.join(_dir, "cmd.json")
_res_file = os.path.join(_dir, "result.json")

_running = False
_last_id = None
_last_error = ""
# Persistent exec namespace so multi-step interactions keep their variables.
_ns = {"__name__": "__main__", "bpy": bpy}


def _write_result(obj):
    tmp = _res_file + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    os.replace(tmp, _res_file)   # atomic — Phoenix never reads a partial result


def _run(code):
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            exec(code, _ns)
        return {"status": "ok", "stdout": buf.getvalue(), "result": {}}
    # 🔴 BaseException, NOT Exception — this catch is what stops a sent script from KILLING
    # BLENDER. `raise SystemExit` (and a bare `exit()`/`quit()`, which raise it too) derives
    # from BaseException, so an `except Exception` handler does not see it: it sails out of
    # here, out of the bpy.app.timers callback, into the embedded interpreter, and the process
    # goes down. No traceback, no .crash.txt — afterwards it does not even look like a script
    # error. Measured the hard way on 2026-07-31: two crashes of a live session, both from a
    # `raise SystemExit` used as an early exit in generated bridge code.
    #
    # KeyboardInterrupt is in the same family and equally not ours to let through.
    # The gate belongs HERE rather than in a note asking callers to be careful, because a
    # caller who forgets costs the operator his whole scene — a protection has to be code
    # that refuses, not a document that requests.
    except Exception:
        return {"status": "error", "stdout": buf.getvalue(), "message": traceback.format_exc()}
    except BaseException as exc:
        return {
            "status": "error",
            "stdout": buf.getvalue(),
            "message": "script raised %s — caught so it cannot terminate Blender. "
                       "Use `return` from a function for early exits, never SystemExit/exit()/quit().\n%s"
                       % (type(exc).__name__, traceback.format_exc()),
        }


def _tick():
    """Polled by bpy.app.timers on the main thread (bpy is not thread-safe)."""
    global _last_id, _last_error
    if not _running:
        return None  # unregister
    try:
        if os.path.exists(_cmd_file):
            with open(_cmd_file, "r", encoding="utf-8") as f:
                cmd = json.load(f)
            cid = cmd.get("id")
            if cid and cid != _last_id:          # a new command we haven't run
                _last_id = cid
                resp = _run(cmd.get("code", ""))
                resp["id"] = cid
                _write_result(resp)
    except (json.JSONDecodeError, OSError, ValueError):
        pass  # file mid-write — retry next tick
    except Exception:
        _last_error = traceback.format_exc()
        traceback.print_exc()
    return POLL


def start_server():
    global _running, _last_id, _last_error, _dir, _cmd_file, _res_file
    if _running:
        return True, "already watching %s" % _dir
    # Re-resolve in case the env var changed since import.
    _dir = _ipc_dir()
    _cmd_file = os.path.join(_dir, "cmd.json")
    _res_file = os.path.join(_dir, "result.json")
    try:
        os.makedirs(_dir, exist_ok=True)
    except OSError as e:
        _last_error = str(e)
        return False, "cannot create %s — %s" % (_dir, e)
    # Skip any stale command left from a previous session so we don't re-run it.
    try:
        if os.path.exists(_cmd_file):
            with open(_cmd_file, "r", encoding="utf-8") as f:
                _last_id = json.load(f).get("id")
    except Exception:
        _last_id = None
    _running = True
    _last_error = ""
    if not bpy.app.timers.is_registered(_tick):
        bpy.app.timers.register(_tick, first_interval=POLL, persistent=True)
    print("[Phoenix IPC] watching", _dir)
    return True, "watching %s" % _dir


def stop_server():
    global _running
    _running = False
    if bpy.app.timers.is_registered(_tick):
        try:
            bpy.app.timers.unregister(_tick)
        except (ValueError, Exception):
            pass
    print("[Phoenix IPC] stopped")
    return True


class PHOENIX_OT_start(bpy.types.Operator):
    bl_idname = "phoenix.ipc_start"
    bl_label = "Start Phoenix IPC"
    bl_description = "Start watching the Phoenix IPC folder"

    def execute(self, context):
        ok, msg = start_server()
        (self.report({'INFO'}, msg) if ok else self.report({'ERROR'}, msg))
        return {'FINISHED'} if ok else {'CANCELLED'}


class PHOENIX_OT_stop(bpy.types.Operator):
    bl_idname = "phoenix.ipc_stop"
    bl_label = "Stop Phoenix IPC"
    bl_description = "Stop watching the Phoenix IPC folder"

    def execute(self, context):
        stop_server()
        self.report({'INFO'}, "Phoenix IPC stopped")
        return {'FINISHED'}


class PHOENIX_PT_panel(bpy.types.Panel):
    bl_label = "Phoenix IPC"
    bl_idname = "PHOENIX_PT_panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = "Phoenix"

    def draw(self, context):
        layout = self.layout
        if _running:
            layout.label(text="IPC: ON", icon='CHECKMARK')
            layout.operator("phoenix.ipc_stop", icon='PAUSE')
        else:
            layout.label(text="IPC: OFF", icon='X')
            layout.operator("phoenix.ipc_start", icon='PLAY')
        box = layout.box()
        box.label(text="Watching:")
        box.label(text=_dir)
        if _last_error:
            err = layout.box()
            err.label(text="Last error:", icon='ERROR')
            for line in _last_error.strip().splitlines()[-3:]:
                err.label(text=line)


_classes = (PHOENIX_OT_start, PHOENIX_OT_stop, PHOENIX_PT_panel)


PHOENIX_HANDLERS_PY = r'''import bpy, os
@bpy.app.handlers.persistent
def phoenix_clear_saved(*args):
    if args and isinstance(args[0], str):
        saved = os.path.normcase(os.path.abspath(args[0])).replace('\\', '/').lower()
        current = os.path.normcase(os.path.abspath(bpy.data.filepath)).replace('\\', '/').lower()
        if saved == current:
            bpy.app.driver_namespace.pop('phoenix_modified', None)
@bpy.app.handlers.persistent
def phoenix_clear_loaded(*args):
    bpy.app.driver_namespace.pop('phoenix_rescue_undo', None)
    bpy.app.driver_namespace.pop('phoenix_modified', None)
    bpy.app.driver_namespace['phoenix_orphan_kept'] = []
    changed = False
    scene = bpy.context.scene
    if scene.get('phoenix_scene'):
        tagged = [a for a in bpy.data.actions if a.library is None and a.get('phoenix_orphan')]
        used = {a for a, users in bpy.data.user_map(subset=tagged).items() if any(u is not a and u.library is None for u in users)}
        for act in bpy.data.actions:
            if act in used:
                for key in ('phoenix_orphan', 'phoenix_orphan_object'):
                    if key in act: del act[key]; changed = True
            if act.library is None and act.users == 0:
                act.use_fake_user = True
                act['phoenix_orphan'] = scene['phoenix_scene']
                act['phoenix_orphan_object'] = act.slots[0].identifier[2:] if act.slots else ''
                changed = True
        for col in scene.collection.children:
            if col.name == '_movable' and col.library is None and col.override_library is not None:
                for ob in col.all_objects:
                    if ob.override_library and ob.override_library.is_system_override:
                        ob.override_library.is_system_override = False
                        changed = True
    if changed:
        bpy.app.driver_namespace['phoenix_modified'] = True
        loaded_path = bpy.data.filepath
        def push_rescue_undo():
            try:
                if bpy.data.filepath != loaded_path:
                    return None
                windows = bpy.context.window_manager.windows
                if windows:
                    w = windows[0]
                    with bpy.context.temp_override(window=w, screen=w.screen):
                        r = bpy.ops.ed.undo_push(message='Phoenix: rescue animation')
                    if 'FINISHED' in r:
                        bpy.app.driver_namespace['phoenix_rescue_undo'] = True
            except Exception:
                pass
            return None
        bpy.app.timers.register(push_rescue_undo, first_interval=0)
for handlers, handler in ((bpy.app.handlers.save_post, phoenix_clear_saved), (bpy.app.handlers.load_post, phoenix_clear_loaded)):
    for old in list(handlers):
        if old.__name__ == handler.__name__: handlers.remove(old)
    handlers.append(handler)
'''

def install_handlers():
    exec(PHOENIX_HANDLERS_PY, {'__name__': 'phoenix_handlers'})

def register():
    install_handlers()
    for c in _classes:
        bpy.utils.register_class(c)
    start_server()   # auto-start: enabling the addon is all the user has to do


def unregister():
    stop_server()
    for c in reversed(_classes):
        try:
            bpy.utils.unregister_class(c)
        except RuntimeError:
            pass


if __name__ == "__main__":
    register()
