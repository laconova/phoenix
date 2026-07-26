# Binding a mesh to a custom rig fails or deforms wrongly

**Symptoms:** `Bone Heat Weighting: failed to find solution for one or more bones` · Bind reports
`... carry NO weight and will not follow the rig` · parts of the creature stay behind when the rig
moves · Bind refuses with *"the rig carries N posed bone(s)"* · *"is not this folder's skeleton"* ·
Blender appears to **freeze for ~2 minutes** during a save on a heavy rig.
**Applies to:** custom-rig · runtime
**Root cause:** several distinct causes with the same feeling of "it just doesn't work". Match yours:

## Fix — do it for me

**① "failed to find solution" / many unbound vertices — the mesh is not one closed piece.**
Automatic weights need a manifold mesh. Generated meshes arrive as a pile of disconnected fragments.
→ Select the mesh, press **Prepare** with **Remesh** ticked (leave Voxel at `0` so the size is derived
from the mesh's own dimensions), then Bind again. If some vertices are still unbound, prepare again
with a **smaller** voxel value — a finer remesh closes narrow gaps like fingers, ears or antennae.

**② "the rig carries N posed bone(s)" — you fitted the skeleton in Pose mode.**
Pose mode is a *temporary* pose on top of an unchanged rest pose. Binding there looks correct at that
moment and collapses on the first animation.
→ Fit bones in **Edit mode** (editing bones there *is* editing the rest pose), or convert what you
have: **Pose ▸ Apply ▸ Apply Pose as Rest Pose**, *before* the mesh is bound. Then Bind.

**③ "is not this folder's skeleton" — wrong armature selected.**
Each folder binds one specific skeleton, and clips only work against it.
→ Press **Spawn** in that folder to bring in its own rig, select mesh **+** that rig, Bind.

**④ The mesh deforms, but rigid parts bend like rubber.**
Automatic weights are for flesh. Machines (robot arms, spaceships, hard-surface props) want their
parts **bone-parented rigidly**, one part per bone (`Ctrl+P ▸ Bone` in Blender), and must **not** be
remeshed — remeshing rounds off exactly the crisp edges that make them look manufactured.
→ Turn **Remesh off**, parent each part to its bone by hand, then **Save Mesh** as usual; parented
parts are stored with the variant just like weighted ones.

## Fix — explain it
Bind reports a **measured** result, not a guess: it counts vertices that carry no deform weight at
all. That number matters because bone-heat weighting often reports its failure as a *warning* — the
operator "succeeds", and the breakage only shows up later when a limb stays behind. `0 unbound` means
every vertex will follow the rig.

## Verify
After Bind: `... — N vertices, 100% weighted`. Then pose one bone in Pose mode and watch the mesh
follow. Undo the pose before saving the variant.

## Notes
Voxel size is **scale-dependent** — it is derived from the object's bounding box for exactly that
reason; a value that suits a deer would shred a mouse. Prepare **applies object scale** (the remesh
computes in local space) and says so in its report.
A ~2-minute freeze while saving a heavy rig (70+ bones) is **not a crash** — the Blender bridge is
synchronous, so the UI blocks until the export finishes. A scene running at ~1 fps makes it worse.
Wait it out, or lighten the scene first.
