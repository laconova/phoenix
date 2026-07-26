# Human tab does nothing / figures come out grey and bald (MPFB)

**Symptoms:** Generate in the Human tab errors or produces nothing · the preview stays empty ·
a figure appears but is a plain skin-coloured shape with **no photo skin, no hair, no clothes**, and
those dropdowns are empty or fall back to *Procedural* · Blender's console mentions `mpfb`.
**Applies to:** human-tab · setup
**Root cause:** two separate installs, and they fail differently.
① The **MPFB2 extension** itself is missing from the Blender that Phoenix drives → nothing generates.
② The extension is there but the **system asset pack** is not → geometry generates fine, but every
appearance asset (skins, hair, clothes, eyes, teeth) is unavailable and Phoenix falls back to a
procedural skin. A bald grey human is the signature of ② and is **not** a Phoenix bug.

## Fix — do it for me
1. Install **MPFB2** (2.0.16 or newer, needs Blender ≥ 4.2) from
   <http://static.makehumancommunity.org/mpfb.html> — into the **same Blender** that has the Phoenix
   IPC addon enabled. Blender ▸ *Edit ▸ Preferences ▸ Get Extensions ▸ Install from Disk…*
2. Install the **system asset pack** (`makehuman_system_assets_cc0.zip`, ~267 MB, CC0) from
   `files2.makehumancommunity.org`. Use MPFB's own loader in Blender (MPFB panel ▸ load pack) rather
   than unzipping by hand — it belongs in the writable `.user` overlay, **not** next to the extension:
   `…/extensions/.user/user_default/mpfb/data/`, which is a different folder than
   `…/extensions/user_default/mpfb/data/`. Unzipping into the wrong one leaves the assets invisible.
3. Restart Blender, then generate again.

## Fix — explain it
The Human tab is a remote control for MakeHuman's engine running **inside your Blender** — Phoenix
sends it parameters over the file bridge, it builds the mesh. So both pieces live on the Blender
side: no extension, no human; no asset pack, no materials to dress it with. Nothing about this is
configured in Phoenix.

## Verify
In Blender's Python console:
```python
import mpfb   # no ImportError  -> extension present
```
Then generate with *Skin = Auto (match)*: the figure arrives with a photo skin, and the Hair/Clothes
dropdowns list entries. Phoenix's own preview shows it before anything is placed in the scene.

## Notes
Phoenix drives whichever Blender has the Phoenix IPC addon enabled — installing MPFB into a *second*
Blender build is a common way to end up with "installed, but still not working".
For your own clothing, generate with **Clothes = None**: MPFB deletes the body underneath its own
garments, which is fine for its presets and unhelpful for custom ones.
