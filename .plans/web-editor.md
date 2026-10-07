# Voxyl Web — Editor (Phase 3)

Status: **Started** (2026-10-07). Phase 2 left a viewer: real projects in OPFS, textures and
block models, the sky, a read-only 2D view. Phase 3 makes it an editor. The gate, from
[`web-migration.md`](web-migration.md): **a real hand-build session done on the web, and the
performance targets hold while editing.** It runs entirely in the browser, with no server.

The user's direction (2026-10-07): don't skip anything, but get to the editing UX soon. So the
build order puts the edit loop first, then the panels it needs, then the rest of the scope.

The CLAUDE.md principles apply unchanged, and they shape the editor:

- **Every edit is a core command** (`Project.run`), never a direct world write. The editor,
  agents (Phase 4) and sync all speak the same commands, so undo, history labels and change
  reports come free, and an agent sees exactly what a person did.
- **The hotbar holds semantics, not blocks** (principle 1). A slot is "Wall" or "Trim"; what
  it looks like comes from the palettes. A new project starts with undecided semantics, so a
  whole build can go up before any block is chosen (principle 5).
- **Views are lenses.** The 3D view, the 2D view and every panel read the one project in the
  world worker and send it commands. Editor state that isn't the project (hotbar, camera, tool)
  lives in the app, and later in `editor.json`, never in the project.

## Scope (from the migration plan)

Fly and orbit camera with left-hand bindings, place and remove, part placement ghosts,
selection tools, paste and prefab placement with rotate and mirror, wand, slice, cutaway, 2D
grid editing, palettes, block picking, hotbar, prefabs, a project home and settings, and basic
lighting (done in Phase 0). The UX is designed for the web, not copied from Godot.

## Interaction model

Godot's model is proven with this user, so the web starts from it:

- **Fly mode** (the pointer locked, a crosshair): this is where building happens, as in
  Minecraft. Left click removes, right click places, middle click picks the targeted block's
  semantic into the hotbar. The target cell is outlined, and the cell a placement would fill
  is shown.
- **Free cursor** (Esc): for panels and looking around. A short click on the view goes back
  to flying; dragging the view turns the camera; the wheel moves it forward and back.
- **Movement** keeps today's bindings, with a right-hand key for every action (the user flies
  with the right hand on the keyboard): WASD or arrows, up Space / right Ctrl / right Alt, down
  Shift / `/`, sprint `\`.
- **Hotbar**: 9 slots along the bottom. 1-9 or numpad 1-9 choose a slot; the wheel cycles
  slots while flying (as in Godot and Minecraft).
- **Undo** Ctrl+Z, **redo** Ctrl+Shift+Z or Ctrl+Y (either Ctrl key), from any mode.

## Layout

The 3D view fills the window. Around it, all overlays:

- **Top bar**: the project's name, undo and redo, whether it is saved, the views (3D or 3D
  beside 2D), and a View menu (lighting, time of day, brightness).
- **Hotbar** at the bottom centre.
- **Palette drawer** on the right (later step): semantics grouped by palette, their looks,
  adding and editing.
- **Tool rail** on the left (later step): Build, Select, Wand, Paste.
- **Dev panel**: today's HUD (samples, chunk size, frame stats, benchmark) folds into a
  panel that starts closed.

## Build order

1. **The edit loop.** Place and remove through commands, the target outline, the hotbar
   with semantic slots, picking, placement rotation from the semantic's placement profile,
   undo and redo, a ground plane to build on in an empty world, a new empty project, and the
   editor shell (top bar, hotbar, dev panel).
2. **Palettes.** The palette drawer: semantics by palette, add and rename, pick a look's block
   from the libraries (search, with textures) or a tint, glow, palettes with inheritance, drag
   a semantic into the hotbar. Placement profiles from the look's block (stairs face the
   player, logs follow the clicked face).
3. **Selection.** A box selection made in fly mode (two corners, then grow or shrink), region
   commands on it (fill, clear, replace, re-semantic, delete), the selection outline, and a
   stats panel counting semantics or blocks with stack counts. The wand (connected cells,
   `structure`).
4. **Clipboard and prefabs.** Copy, cut and paste with a ghost preview drawn from a fork,
   turning and mirroring while placing, saving a selection as a prefab, a prefab browser with
   thumbnails.
5. **Parts.** Microblock and shape placement with ghosts (slot from where the face is hit,
   an alternate placement on the thumb buttons), rotate on face.
6. **2D grid editing.** Painting and selecting in the layer view, following the 3D hotbar.
7. **Slice and cutaway.** Hide everything above a layer in 3D, or cut a box away.
8. **Project home and settings.** A home screen (projects with thumbnails, new, samples,
   import), project settings (name, north, grid offset), app settings (key bindings), and an
   autosave that writes only chunks changed since the last save.
9. **The gate.** A real hand-build session, and the performance targets measured while
   editing.

Orbit (turning about a point rather than in place) comes with selection (step 3), where
there is a point worth orbiting.

## Progress

- **Phase 2 gate (2026-10-07)**, the last viewer step, done first; see
  [`web-viewer.md`](web-viewer.md) step 8.
- **Step 1 done (2026-10-07).** The edit loop, in the browser with no server.
  - Every edit is a core command from the world worker (`apps/web/src/world/editing.ts`):
    place, erase, undo, redo, rename, and the scripted set and fill the benchmark still uses.
    Place turns the block with the semantic's placement profile. A full cell is left alone.
    The crosshair ray rests on the ground plane (the top of layer -1) when it hits nothing,
    so an empty world has somewhere to build. Commands are labelled ("Place Wall") and that
    label is what undo and redo show.
  - A new project (`New project`) is empty, saved at once, with nine undecided starter
    semantics in the root palette (Base, Wall, Floor, Roof, Trim, Accent, Glass, Light,
    Detail). Light glows. No block is chosen yet.
  - The hotbar holds nine semantics, filled from the root palette, chosen with 1–9, the
    numpad, the wheel while flying, or a click. Middle click picks the aimed cell's semantic
    into its slot, or into the chosen slot. A re-skin updates colours and names; the slots
    stay. Editor state, not project state.
  - Fly mode (pointer locked): left click removes, right click places, the aimed cell is
    outlined, and the ground shows the cell a block would fill. Esc releases the pointer. A
    short click on the view flies again; dragging turns the camera; the wheel moves forward
    and back. Speed is `=` and `-`. A faint ground grid follows the camera, its major lines
    on the project's grid offset.
  - The shell: a top bar (name, saved or not, undo, redo, new project, 2D view, the View
    menu for lighting, time of day and brightness) and the hotbar. The old HUD is the Dev
    panel, closed until opened, and still in the page so `pnpm shot` can read it. Rename is
    a settings command, so it undoes, and a saved project autosaves it.
- **Step 2 done (2026-10-07).** The palette drawer, on the right, opened from **Palettes** in
  the top bar (open until closed; the choice is remembered).
  - Semantics are grouped by palette. A row's swatch is the resolved look. Click a row to
    edit it: rename, choose a block, set the colour it draws when no block is chosen, and
    glow. Add a semantic, add a palette (extending another, Main by default, so a group of
    the build starts with the parent's semantics), rename a palette. Every one of those is a
    core command, so it undoes. A linked palette (a city theme) is read-only; extend it to
    override a look.
  - The block picker searches the libraries in this browser, with a 16×16 icon per block
    (a cube's top texture, or its largest face). Choosing writes only that field of the
    semantic's own look, so changing a derived semantic's glow does not freeze the block it
    inherits. Clear removes its own block. An inherited block can't be dropped (looks merge,
    and there is no "unset"); the picker says so.
  - Drag a semantic onto a hotbar slot. Double-click puts it in the chosen slot.
  - **Placement follows the look's block** when the semantic's form sets no profile. The
    form still wins: intent over the material. `profileOfBlock` reads the blockstate
    properties (no per-block code): an axis is a log, `type` bottom/top is a slab, a
    horizontal facing with a top/bottom half is stairs, a `face` property attaches, a
    facing of down and the sides is a hopper, all six facings point the front, a horizontal
    facing points at the player, and anything else is a cube. The world worker gives
    `Project.setBlockProfiles` that reading; it is not saved, and a fork keeps it. Stairs
    face the player. A log lies along the face that was clicked (either end, since the two
    ends look the same). A cube stores one rotation.
  - Next is step 3, selection.
