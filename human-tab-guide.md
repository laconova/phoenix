# Characters ▸ MakeHuman — guide

The **MakeHuman source** of the **Characters** workspace (MakeHuman / MPFB2 in Phoenix) builds parametric people directly in your **open Blender scene**, through MPFB2.
No ComfyUI, no 3D generator: real, immediately editable geometry with skin, eyes, teeth, hair and
clothes — and, with the Mixamo rig switched on, something you can animate.

---

## One-time: is it working?

- **MPFB2** must be installed in **the** Blender that hangs off the Phoenix IPC bridge — your live
  Blender, not a second install. (<http://static.makehumancommunity.org/mpfb.html>, needs Blender ≥ 4.2.)
- The **system asset pack** (photoreal skins, eyes, teeth, hair, clothes) must be installed too.
  Without it everything still generates, but falls back to a procedural (skin-coloured, textureless)
  material and the appearance dropdowns stay empty.

Neither of these is configured in Phoenix — both live on the Blender side. If the workspace does nothing,
or figures come out grey and bald, see `troubleshooting/entries/human-tab-mpfb-missing.md`.

## Opening it

1. Open <http://127.0.0.1:7777> in the browser.
2. Pick **Characters** in the left rail. The workspace has three columns: the **Saved characters** list on the left,
   the preview and one animation sequencer in the middle, and the inspector on the right.
3. Press **+ New character** and choose **MakeHuman** (a human body from sliders). The other choice, **Custom rig**,
   is for your own creatures and machines — see below.

---

## The controls

The inspector works in steps — **Body · Face · Look · Rig · Animate** — pick one with the buttons above it.

**Body** (name, then sliders 0–1, centre = neutral):

| Slider | Effect |
|---|---|
| **Gender** | ♀ 0 … 1 ♂ |
| **Age** | young … old |
| **Muscle** | slim … muscular |
| **Weight** | thin … heavy |
| **Height** | short … tall |
| **Proportions** | body proportions |
| **Cup size / Firmness** | breasts (on female bodies) |
| **Race** | Caucasian / Asian / African — also drives the automatic skin choice |

**Look:**

- **Skin** — *Auto (match gender/age/race)* picks a fitting skin. *Procedural* is a plain shader
  with no photo texture (needs no assets).
- **Eye colour** — brown / blue / green / grey / … (default = the standard eye material).
- **Hair** — None, plus short / long / bob / braid / ponytail / afro.
- **Clothes** — None, plus suits and a fedora. ⚠️ Match the cut to the body: a women's cut on a
  male body does not fit cleanly and the skin pokes through.
- **Toggles** — Eyes / Teeth / Brows / Lashes (on by default).

**Rig:** **None**, **Standard** or **Mixamo (animatable)**. Choose Mixamo for anything you intend to animate — see below.

**Face** (optional): 13 fine-tuning sliders, each **bidirectional** (centre =
neutral, left/right = less/more): head width · face length · nose size/width/length/bridge · mouth
width · lip fullness · mouth height · chin height · chin forward · cheeks · eye spacing. These drive
real MakeHuman detail targets, which is what turns a character into *someone* instead of the default
face. **Reset face** returns them all to centre; a slider left at centre is simply not applied.

## Preview & Place

Under the inspector steps, **1 · Build preview** and **2 · Place in scene** work as a pair:

- **Rebuild preview** builds the figure **hidden** (in an "MH Staged" collection, excluded from the
  viewport) and shows it only as a full-body **preview** in the middle column. Your scene stays clean, and each
  rebuild *replaces* the hidden figure rather than stacking copies.
- **Place in scene** puts it at the origin, visible. It stays disabled until a preview has been built. Only
  then does the figure enter your scene — so you can iterate on the sliders freely until the preview is right.

The preview renders in isolation (other objects are briefly excluded from the render, then restored);
your scene's render settings are left untouched.

> **Rig + clothes:** with **Rig = Mixamo** the figure comes out rigged down to the fingers, and
> clothes/hair/eyes are rigged along with it. ⚠️ MPFB deletes the body underneath its own clothes,
> so for **your own** clothing generate naked (`Clothes = None`) and dress the figure yourself.

---

## Characters — saving finished figures

The **Saved characters** list (left column) answers: *my figure is finished — how do I get it back without
setting every slider again?*

- **Save to saved characters** (under Place in scene) stores the rigged figure standing in your scene — every mesh (body, eyes,
  teeth, hair, clothes), its textures (**packed**, so they survive reopening) and its skeleton — as a
  reusable `.blend`. It is always stored in **rest pose**: a running animation does not travel with it.
- Select a character in the list, then **Spawn** brings it back, **already selected**, so *Animate* /
  *Describe a motion…* hits it straight away.
- **Rename** and **Delete** are in the same row; Delete moves the character to the Library trash, where it can be restored.
- A new, unsaved character shows in the list as a draft ("MakeHuman · unsaved") until you save it.

What gets stored is the **actual mesh**, not the parameter set: sculpting, deleted vertices, custom
retopo — all of it survives the round trip.

### Your own characters from mixamo.com

The route for *"I already have a character"*: upload it to mixamo.com, let it auto-rig, import the FBX
into Blender — save it here **once** and it behaves like a MakeHuman figure from then on.

> ⭐ **All characters share the animation list below.** Every clip works on every character, because
> they all wear the same Mixamo skeleton — including the ones you generate from text. There are
> deliberately **no** per-character clips.

⚠️ **Mixamo skeletons only.** Without the `mixamorig:Hips` bone the save is **refused** (with a
pointer): animals and creatures belong to the **Custom rig** source (**+ New character ▸ Custom rig**), where clips are bound to that
folder's own skeleton. A rig **without fingers** (a Mixamo auto-rigger option) is perfectly fine —
the retarget skips missing bones and the fingers simply stay still.

💡 A **bare skeleton with no mesh** can be saved too — the quick way to keep an empty Mixamo rig to
build on.

---

## Animation

Needs **Rig = Mixamo**. All clips live in one shared library. **Add FBX** and **Save FBX** are in the
**Animate** step; the sequencer (**Animation sequence**) is in the middle column.

- **Add FBX** — drop in a Mixamo download.
- **Describe a motion…** — generate a clip from text. Text→motion runs on a GPU (~4 min for 6 s) and
  Phoenix stays usable while it does; the generated clip stays in the clip list, so reusing it is free.
  Requires setup — see *Text → motion* in the README.
- **Animate** — the picked clip, replacing what is there.
- **+ clip → Play sequence** — build a whole chain, blended at the seams (**Blend**, in frames). **+ clip** adds the
  picked clip to the chain, and once a sequence has been played it appends to the end. Each clip carries its **own**
  travel and picks up where the previous one left off. **Drift** stays at **0** for normal
  clips; only Mixamo "In Place" clips (which carry no root motion) need a value there.
- **Save FBX** — store the animation currently on the selected character as a reusable clip.

### Checking a sequence seam

When a chained sequence looks wrong, test one seam before blaming the whole chain:

1. Put **two short clips** (2–4 s each) in the sequence. Make sure the scene runs at the frame rate the
   clips were made for (Blender ▸ Output ▸ Frame Rate), or the seam lands on a different frame than
   you expect.
2. **Play sequence**, then step frame by frame through the frames around the seam — the end of clip 1
   minus the blend length up to a few frames after it.
3. Look for two things:
   - **Root jump:** the hips snap sideways or up/down in a single frame. Each clip should start exactly
     where the previous one stood.
   - **Foot contact:** the feet stay on the floor through the crossfade instead of sliding or sinking.

Three different things move a figure, and they are easy to mix up:

- **Travel** is the motion inside the clip itself (the hips walking forward). Phoenix keeps it and
  starts each clip where the last one ended.
- **Drift** is an error some generated clips carry: they slowly sink or rise while they play. Phoenix
  measures it on the footfalls and straightens it out per clip; the reason and the method are written
  up in the *Vertical drift* comment in [`animate_human.js`](animate_human.js).
- **Blend** is the crossfade at the seam. It smooths the pose; it does not move the figure.

If a seam still jumps after that, it is worth an issue — attach the two clip names and the frame number.

#### When a seam is accepted

A seam passes when all four are true while you step through it frame by frame:

- No single-frame root jump: the hips never snap sideways or up and down between two frames.
- The feet stay planted through the crossfade: no sliding, no sinking.
- No pose pop inside the blend: the limbs move smoothly from one clip into the next.
- The next clip starts where the last one ended: its first frame sits where the previous clip's last frame stood.

If one of them fails, note the frame number, check the scene frame rate first, then re-run Play sequence with a longer blend or swap the clip order. If it still fails, treat it as an issue with those two clips.

---

## Tips & limits

- **Auto skin** is usually the best choice — it matches gender/age/race for you.
- **Extreme values + clothes:** a very muscular or heavy body can poke through a tightly cut suit in
  places. That is a MakeHuman fitting limit, not a bug — moderate the values or pick a looser cut.
- Turn **Rig** on whenever the figure is meant to move. It cannot be added afterwards; the figure has
  to be generated again (your slider settings stay, so it costs one Rebuild preview).

## It also works by chat

The same engine sits behind the chat — instead of sliders you can type:

> "make a tall muscular man in a suit with short hair and blue eyes"
> "create a young woman and rig her"

The workspace is just the dial-based surface for exactly the same `make_human` tool.
