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
    "version": (1, 0, 0),
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
    except Exception:
        return {"status": "error", "stdout": buf.getvalue(), "message": traceback.format_exc()}


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


def register():
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
