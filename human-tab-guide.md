# Human tab — guide (MakeHuman / MPFB2 in Phoenix)

The **Human tab** builds parametric people directly in your **open Blender scene**, through MPFB2.
No ComfyUI, no 3D generator: real, immediately editable geometry with skin, eyes, teeth, hair and
clothes — and, with the Mixamo rig switched on, something you can animate.

---

## One-time: is it working?

- **MPFB2** must be installed in **the** Blender that hangs off the Phoenix IPC bridge — your live
  Blender, not a second install. (<http://static.makehumancommunity.org/mpfb.html>, needs Blender ≥ 4.2.)
- The **system asset pack** (photoreal skins, eyes, teeth, hair, clothes) must be installed too.
  Without it everything still generates, but falls back to a procedural (skin-coloured, textureless)
  material and the appearance dropdowns stay empty.

Neither of these is configured in Phoenix — both live on the Blender side. If the tab does nothing,
or figures come out grey and bald, see `troubleshooting/entries/human-tab-mpfb-missing.md`.

## Opening the tab

1. Open <http://127.0.0.1:7777> in the browser.
2. Pick the **Human** tab in the artifact bar.

---

## The controls

**Body** (sliders 0–1, centre = neutral):

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

**Appearance:**

- **Skin** — *Auto (match)* picks a skin that fits gender/age/race. *Procedural* is a plain shader
  with no photo texture (needs no assets).
- **Eye color** — brown / blue / green / grey / … (default = the standard eye material).
- **Hair** — None, plus short / long / bob / braid / ponytail / afro.
- **Clothes** — None, plus suits and a fedora. ⚠️ Match the cut to the body: a women's cut on a
  male body does not fit cleanly and the skin pokes through.
- **Toggles** — Eyes / Teeth / Brows / Lashes (on by default) · **Rig** (turn this on for anything
  you intend to animate — see below).

**Face — advanced (collapsible, optional):** 13 fine-tuning sliders, each **bidirectional** (centre =
neutral, left/right = less/more): head width · face length · nose size/width/length/bridge · mouth
width · lip fullness · mouth height · chin height · chin forward · cheeks · eye spacing. These drive
real MakeHuman detail targets, which is what turns a character into *someone* instead of the default
face. **`reset face`** returns them all to centre; a slider left at centre is simply not applied.

## Preview & Place

- **Generate 🧍** builds the figure **hidden** (in an "MH Staged" collection, excluded from the
  viewport) and shows it only as a full-body **preview**. Your scene stays clean, and each Generate
  *replaces* the hidden figure rather than stacking copies.
- **Place in scene ✓** puts it at the origin, visible. Only then does it enter your scene — so you
  can iterate on the sliders freely until the preview is right.

The preview renders in isolation (other objects are briefly excluded from the render, then restored);
your scene's render settings are left untouched.

> **Rig + clothes:** with **Rig = Mixamo** the figure comes out rigged down to the fingers, and
> clothes/hair/eyes are rigged along with it. ⚠️ MPFB deletes the body underneath its own clothes,
> so for **your own** clothing generate naked (`Clothes = None`) and dress the figure yourself.

---

## Characters — saving finished figures

The **Characters (saved skins)** block answers: *my figure is finished — how do I get it back without
setting every slider again?*

- **💾 Save character** stores the rigged figure standing in your scene — every mesh (body, eyes,
  teeth, hair, clothes), its textures (**packed**, so they survive reopening) and its skeleton — as a
  reusable `.blend`. It is always stored in **rest pose**: a running animation does not travel with it.
- **Spawn 🧍** brings a saved character back, **already selected**, so *Animate* / *Describe a motion*
  hits it straight away.
- ✏ / 🗑 rename and delete.
- The entry **"MakeHuman (use Generate above)"** is not a file — it is the generator above. That is
  why it can be neither renamed nor deleted.

What gets stored is the **actual mesh**, not the parameter set: sculpting, deleted vertices, custom
retopo — all of it survives the round trip.

### Your own characters from mixamo.com

The route for *"I already have a character"*: upload it to mixamo.com, let it auto-rig, import the FBX
into Blender — save it here **once** and it behaves like a MakeHuman figure from then on.

> ⭐ **All characters share the animation list below.** Every clip works on every character, because
> they all wear the same Mixamo skeleton — including the ones you generate from text. There are
> deliberately **no** per-character clips.

⚠️ **Mixamo skeletons only.** Without the `mixamorig:Hips` bone the save is **refused** (with a
pointer): animals and creatures belong in the **Custom Rig** tab, where clips are bound to that
folder's own skeleton. A rig **without fingers** (a Mixamo auto-rigger option) is perfectly fine —
the retarget skips missing bones and the fingers simply stay still.

💡 A **bare skeleton with no mesh** can be saved too — the quick way to keep an empty Mixamo rig to
build on.

---

## Animation

Needs **Rig = Mixamo**. All clips live in one shared library.

- **+ Add FBX** — drop in a Mixamo download.
- **✨ Describe a new motion…** — an entry in the clip list, not a second button: generating and
  picking a clip are the same intent. Text→motion runs on a GPU (~4 min for 6 s) and Phoenix stays
  usable while it does; the generated clip stays in the list, so reusing it is free.
  Requires setup — see *Text → motion* in the README.
- **Animate** — one clip, replacing what is there. **Append** — add a clip to the end.
- **Playlist → Sequence** — build a whole chain, blended at the seams. Each clip carries its **own**
  travel and picks up where the previous one left off. **Extra drift** stays at **0** for normal
  clips; only Mixamo "In Place" clips (which carry no root motion) need a value there.
- **💾 Save FBX** — store the animation currently on the selected character as a reusable clip.

---

## Tips & limits

- **Auto skin** is usually the best choice — it matches gender/age/race for you.
- **Extreme values + clothes:** a very muscular or heavy body can poke through a tightly cut suit in
  places. That is a MakeHuman fitting limit, not a bug — moderate the values or pick a looser cut.
- Turn **Rig** on whenever the figure is meant to move. It cannot be added afterwards; the figure has
  to be generated again (your slider settings stay, so it costs one Generate).

## It also works by chat

The same engine sits behind the chat — instead of sliders you can type:

> "make a tall muscular man in a suit with short hair and blue eyes"
> "create a young woman and rig her"

The tab is just the dial-based surface for exactly the same `make_human` tool.
