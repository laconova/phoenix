# Animate says there is no rigged character (Human tab)

**Symptoms:** `ANIM_ERR:no mixamo-rigged character in scene` · "Animate" does nothing although a
figure is clearly standing in Blender · "Describe a new motion…" generates for minutes and then
cannot apply the result · **Save character** is refused with *"that skeleton has no mixamorig:Hips
bone"*.
**Applies to:** human-tab · runtime
**Root cause:** the animation path finds its target by looking for the bone **`mixamorig:Hips`**. A
figure built with **Rig = None** or **Rig = Standard** does not have it, so there is nothing to
animate onto — the character is geometry without the expected skeleton.

## Fix — do it for me
1. In the Human tab, set the **Rig** dropdown to **Mixamo (animatable)** *before* pressing Generate.
2. **Generate** → **Place in scene**.
3. Animate again — the clip now finds its target.

An existing figure cannot be upgraded in place: rebuild it with the Mixamo rig (your slider settings
stay as they are, so this costs one Generate).

## Fix — explain it
Every clip Phoenix applies — uploaded Mixamo FBX, generated text→motion, saved custom clips — is
retargeted **by bone name** onto the standard 52-bone `mixamorig:` skeleton. That one skeleton is
what makes the animation library shared: any clip fits any character wearing it. A character without
it is outside that system, which is why the save is refused rather than silently storing something
that could never be animated.

## Verify
Select the figure in Blender, open the armature in the outliner: the bones are named
`mixamorig:Hips`, `mixamorig:Spine`, … . Animate then reports how many bones it matched.

## Notes
Creature and machine rigs (deer, monsters, robots) legitimately have **no** `mixamorig:` bones —
they belong in the **Custom Rig** tab, where clips are bound to that folder's own skeleton instead.
The refusal message is the routing: if Save character rejects it, the Custom Rig tab is where it goes.
A Mixamo rig **without fingers** (an option in Mixamo's auto-rigger) is fine — the retarget skips
bones the source lacks, and the fingers simply stay still.
