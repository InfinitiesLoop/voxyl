# Voxyl Web — Editor (Phase 3)

Status: **Every editor feature is built; waiting on the gate's hand-build session** (2026-10-07), plus, added 2026-10-08, a plan for pre-1.8 and GTNH import that the gate now includes ("Gate item: pre-1.8 and GTNH import"; nothing of it is built). Phase 2 left a viewer: real projects in OPFS, textures and
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
  it looks like comes from the palettes. A new project starts with starter semantics on
  default blocks, and a semantic can still be undecided, so a whole build can go up before any
  block is chosen (principle 5).
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
- **Inventory**: E, or Delete for the right hand, opens and closes it (Esc closes it too). It
  holds the tools as well as the palettes, as in Godot.
- **Backspace** empties the selection, only while Select is in hand (as in Godot).
- **Q** (alternate Num \*) steps through the tools; **R** (alternate Num 0) turns the aimed block.
- **Keys** in the top bar lists every binding and its alternate (`editor/keymap.ts`).
- **Undo** Ctrl+Z, **redo** Ctrl+Shift+Z or Ctrl+Y (either Ctrl key), from any mode.

## Layout

The 3D view fills the window. Around it, all overlays:

- **Top bar**: the project's name, undo and redo, whether it is saved, the arrangement (Full,
  side by side, stacked, or a grid of four), palettes, lighting and brightness, and Keys.
  Time of day is each 3D pane's own control. A 2D pane has no lighting and no time of day.
- **Each pane's bar** (`editor/ViewBar.tsx`): the kind (3D or 2D), then that kind's controls
  as small menus, then readouts on the right. The overlays a pane can hide are one registry
  (`editor/view-options.ts`) that builds its Show menu. Later view options (render modes,
  camera presets, orbit) are more menus in the same bar.
- **Hotbar** at the bottom centre, with a badge on its left naming the tool in hand.
- **Palette drawer** on the right: semantics grouped by palette, their looks, adding and
  editing. The panes shrink beside it rather than going under it.
- **Tools** live in the inventory, beside its hotbar (Build, Build to me, Wand, Exchange,
  Select; Paste later), so
  flying never gives up the pointer for a tool rail. The badge opens the inventory.
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
   Since 2026-10-08 it also includes the plan for pre-1.8 and GTNH import (at the end of this
   file) being accepted; the import itself is Phase 5 work.

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
  - A new project (`New project`) is empty, saved at once, with nine starter
    semantics in the root palette (Base, Wall, Floor, Roof, Trim, Accent, Glass, Light,
    Detail). Light glows. They began undecided; each now looks like a default-set block (see
    "New builds start on blocks" below).
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
- **Step 3 done (2026-10-07).** Selection, the wand, and orbiting a selection.
  - The tool rail on the left: **Build** (place and remove, as before), **Select**, and
    **Wand**. Paste waits for step 4. The choice is remembered.
  - **Select**, in fly mode: right-click marks two corners (the ground counts, so an empty
    world can be boxed). The first corner is a one-cell outline until the second click. A
    third right-click clears. Left click still removes; middle click still picks. **Delete**
    empties the selected cells.
  - The selection is a core `select` command, so it is the same value an agent will use, and
    it is not itself an undo step. **Grow** and **Shrink** are `{ grow }` and `{ shrink }`
    through faces (Shift+click does five). On a plain box, each face nudges on its own and
    stops at the opposite face. The outline is the silhouette (a plain box is its twelve
    edges; collinear edges merge). Past 60,000 cells that aren't a plain box, the outline
    falls back to the bounding box and the panel says so.
  - Region commands, all core commands on `{ selection: true }` or the occupied cells inside
    it: **Fill** writes the hotbar semantic into every selected cell (stairs face the player).
    **Clear** empties them (the Delete key). **Replace** turns occupied cells into whole
    blocks of the hotbar semantic and leaves empty cells empty. **Re-semantic** switches one
    semantic for another and keeps each cell's shape, and says how many it skipped.
  - The panel counts the selection **by semantic** or **by block**, with stack counts (64),
    and copies the list. Empty cells are listed with the semantics. Each swatch is the
    resolved look.
  - **Wand**: right-click selects the connected cells of that block's semantic (`structure`,
    face to face). Shift+right-click selects whatever is connected, of any kind. It stops at
    a gap.
  - With a selection, dragging the view with a free cursor **orbits** the selection's centre
    instead of turning in place. The wheel still moves in and out. Flying stays first person.
- **Feedback, before step 4 (2026-10-07).** The user asked to settle the shell before the
  clipboard, because where the panes go decides where the toolbars go.
  - **Panes.** The workspace is one, two (side by side or stacked) or four views. Each pane is
    a 3D view or a flat 2D slice, and one pane is focused (click it to fly that one). A 3D
    pane has its own camera and its own time of day, so one can be noon and
    another night; the light volume is still computed once and the time of day is the shader's
    darkening. A 2D pane is always flat: no lighting, no time of day. The hotbar, tool rail and
    actions sit on the workspace, not inside a pane. Each pane's bar is only that pane (3D or
    2D, and the clock when it is 3D). Lighting and brightness stay global, in the Light menu.
  - **The wheel** while flying moves one hotbar slot a notch. It had been half a notch, so it
    skipped every other slot.
  - **Undo** of a chunk that is already being meshed starts the new mesh at once and drops the
    picture of the older world, and a mesh is drawn before that frame's light upload. Two quick
    undos no longer wait out a stale mesh and then both appear together.
  - **Selection.** The panel is the shape of the region: counts (empty cells are not a row, and
    have no stack count), Grow, Faces, Shrink, nudging a face, deselect. **Grow** adds every
    neighbour including diagonals, so a box stays a box. **Faces** is the old grow, through the
    six faces only (`{ grow }` without `corners`); it is a different thing from pushing the
    bounding box out by one, and it stays because a cross-shaped shell is still useful. The
    outline and the panel show while Select or Wand is the tool and something is selected, as
    in the Godot app: leaving the tool hides them, and the selection itself remains. **Actions**
    (a menu, whenever something is selected) is where operations on the cells live, and where
    new ones get added: fill, replace, clear, re-semantic. They are not part of the selection
    panel.
  - **The ground grid** is a shader on a quad that follows the camera. Lines stay about a pixel
    wide, fade out before they alias, and the fade reaches farther as you climb (about 25 cells
    of fade per cell of height), so it does not end in a square when you leave the ground. It
    is quieter than the old line mesh.
  - **The moon** is a disc. Stars are hidden where it covers them. The sun stays a square.
  - **Inventory** (E, or Esc to close) loads the hotbar: pick a palette, click a semantic, it
    fills the chosen slot and advances. The palette drawer is still where a look is edited.
    The migration plan listed an inventory and the editor plan never gave it a step; the drawer
    was the editing half, and this is the picking half.
- **Feedback, second round (2026-10-07).** The shell, before step 4.
  - **Pane toolbars.** Every pane has one bar built from shared pieces (`editor/ViewBar.tsx`):
    the 3D/2D switch, that kind's menus, and readouts on the right. A 3D bar has **Time** (a
    slider and Sunrise, Noon, Sunset, Midnight) and **Show**. A 2D bar has the slice (plan or a
    cut), the layer, Show, and what is under the pointer; the 2D view's own second toolbar is
    gone. Show is built from `editor/view-options.ts` (ground grid, 2D slice, 3D cameras,
    compass); each pane remembers its own choices in the layout. The one-view arrangement is
    called **Full**.
  - **The 3D cameras in a 2D view** are a dot and a cone, as a GPS app draws you: the cone is
    as wide as the camera's view and points where it looks. It shortens as the camera looks out
    of the slice (straight down on a plan), until only the dot is left. Every 3D pane has one;
    the focused pane's is cyan, the others grey.
  - **The 2D slice in the 3D views.** The active 2D pane (the focused one, else the 2D pane
    focused last) shows its layer in every 3D pane as an amber one-cell slab, as wide as the 2D
    view's window, so panning or zooming the 2D view moves it. Its edges are drawn crisp where
    nothing hides them and faint through blocks; its faces are a 5% tint. Godot's sheet with a
    cell grid was too much. Show → 2D slice turns it off per pane.
  - **A compass** in the top right of each pane (Show → Compass). 3D: a disc that turns with
    the camera, the needle on the project's real north (settings.north). A 2D plan always has
    north at the top. A cut stands up, so it names the directions to the left and right
    ("W ◂ ▸ E") instead. The math is `editor/compass.ts`, tested.
  - **The ground grid** reads by day and stays quiet at night: dark lines by day, faint pale
    ones at night (blending is in linear light, so a pale line on black looks far stronger than
    its alpha; the night values are small on purpose). Each family of lines (along x, along z)
    fades on its own as it crowds on screen, over a long gradient (whole at ~8 px apart, gone at
    ~2.5), so lines running away from you outlast the ones packing toward the horizon; majors
    fade the same way at their own spacing. Minor lines also end at 56 cells plus 3 per cell of
    height: farther than before near the ground, much nearer from high up. The whole grid fades
    over a longer gradient (from a tenth of the way out).
  - **Tools moved into the inventory**, beside its hotbar, with a line saying what the tool in
    hand does. A badge left of the workspace hotbar names the tool and opens the inventory.
    The left rail is gone, and the selection panel and Dev panel moved to the left edge.
  - **Delete** opens and closes the inventory, with E (the right-hand key, as in Godot).
    **Backspace** now empties the selection, and only while Select or Wand is in hand.
  - **Keys.** The hint along the bottom is gone. **Keys** in the top bar opens a panel of every
    binding by what it is for (moving, building, selecting, the wand, hotbar and inventory,
    history, the 2D view), right-hand keys in their own column, and the tool in hand marked.
    The list is `editor/keybindings.ts`, where a rebinding screen would start.
  - **The palette drawer** no longer covers the panes: they shrink beside it.
  - Choices to review:
    1. The slice guide follows the 2D pane's visible window (it moves when you pan the 2D view)
       rather than the build's bounds.
    2. Tools change only through the inventory (and its badge), as in Godot; there are no tool
       keys yet.
    3. The hint bar is gone with nothing in its place, so a first visit has no "click to fly"
       on screen; Keys is the help.
    4. A cut's compass names left and right instead of drawing a disc.
- **The user's answers (2026-10-07, third round).**
  - Keys say **Binding** and **Alternate**, never "left hand" or "right hand".
  - **The wand is a building tool**, not a selection tool: right-click grows a surface by a
    layer, as in Godot. (Selecting connected blocks moved to Select, with Shift.)
  - Making your own blocks is dropped: blocks only come from imports and the default set.
  - Animated textures go to the new **Polish** phase unless trivial (they aren't).
  - Home and shared palettes: **yes**, and the app opens on **Home**; with no projects yet it
    offers a link straight into a new build. New projects' starter palette uses the voxyl
    default block set, not plain colours.
  - The hotbar keeps 9 slots.
  - **Tools get keys** (which keys is open), and anything with a key must also be doable from
    the UI.
  - No on-screen "click to fly" is fine.
  - **Do now:** every gap in the table below except the two above (own blocks; animated
    textures). Views as tabs stays out, as suggested.
- **Third round, as built** (one commit per part):
  1. **Keys and tools.** `editor/keymap.ts` holds every keyboard binding (binding and
     alternate, as `KeyboardEvent.code`); FlyCamera, Engine and GridView read it and the Keys
     panel lists it, so the two can't drift. Tools are Build, **Build to me**, **Wand**,
     **Exchange** and Select (`world/tools.ts`, tested): Build to me lays a column from the
     aimed face toward the camera, stopping one short of it, as wide as the brush; the Wand
     puts a block on every open face of the clicked semantic's run in that face's plane (4-way
     connected, 32 cells each way), keeping a turnable block's turn; Exchange swaps the clicked
     block and its connected run within the brush, in place. Each click is one `set` command
     ("Wand: 18 Wall"). The aim request also returns the cells the tool in hand would build,
     drawn as one box per cell (Godot's builders'-wand look). The brush (1×1 to 9×9) and
     Select's "Shift takes any kind" are tool options under the inventory's tool strip; the
     badge shows the brush. **Q** steps through the tools (Shift back), alternate **Num \***;
     **R** turns the aimed block about the face hit (Shift the other way, the `rotate`
     command), alternate **Num 0**; **sprint** is a left Ctrl tap (sprints on release if no
     other key came between, so Ctrl+Z doesn't), alternate `\`. Tool keys are a proposal.
  2. **Camera menu** in each 3D bar. Presets: Overview, From north / east / south / west
     (the real compass, settings.north), Top (north up the screen, as on the plan), Iso (the
     nearest corner, 35.26°), Selection. Each frames the build's exact bounds (a new `bounds`
     request) or the selection, backing off until all eight corners fit
     (`scene/framing.ts`, after Godot's CameraFraming, tested). **Orbit** off / slow / medium
     / fast (6, 12, 24°/s) turns the pane's camera about the build's centre; flying or
     dragging that pane turns it off. **Projection** perspective or orthographic: an
     orthographic twin camera shares the pane's position and turn, sees 4000 cells either
     side, and the wheel zooms it; the sky sphere is scaled up so it still fills the view.
     **Speed** is a slider (2 to 400 cells a second), so = and - have a UI. Each pane keeps
     its view settings (render mode, shading, projection, background, orbit) in the layout,
     from one registry in `editor/view-options.ts`.
  3. **Render menu** in each 3D bar, per pane, from Godot's ViewOptions. **Render**:
     Textured; **Intent** (each semantic in its own colour, golden-angle hues from its id,
     never anything a palette says: StateLooks.intent, a second lookup texture); **Clay**
     (one neutral material); **Outline** (the looks' flat colours with dark feature edges);
     **X-ray** (faces at 14% and every edge in intent colours, through everything); **Wire**
     (edges only). **Shading**: App (the light volume when lighting is on), Studio (bright
     and even), Flat (none). **Background**: Sky, or Plain (no sky, grid or fog). The
     materials are shared, so each pane sets two shader values before it draws and swaps
     the meshes' material set only when it differs (lit, unlit, or x-ray).
     **Feature edges** come from the mesh workers (`packages/mesher/src/edges.ts`, tested):
     an edge is drawn where one or three of its four cells are full (a corner), two diagonal
     ones (a crease), or two side by side of different states (a seam); runs along an axis
     merge. They are opt-in: the world worker remeshes with edges when a pane first picks a
     line-drawing mode and stops sending them when none does. Shaped parts and block models
     outline as their cell. Faces now sit back by polygon offset (1, 1) so lines win; the
     ground grid moved to (2, 4).
  4. **Slicing from 3D.** While flying, **Tab** (alternate Enter) points the active 2D view
     at the aimed cell: same kind of slice, through that cell, centred on it, zoom kept.
     **Shift+Tab** also turns the slice (plan, cut across x, cut across z). With no 2D pane on
     screen, the next pane over becomes one (Full becomes Side). The 2D bar's **3D aim** does
     the same from the middle of the focused 3D view, so the key has a UI. This is lighter
     than Godot's modal slice-select (a plane to steer and confirm): the 2D view itself is the
     preview. Every 2D view now records what it shows, and each draws the **other 2D views'
     slices** across it as amber one-cell bands (a slice parallel to it draws nothing).
  5. **Home, shared palettes, descriptions, a textured start.**
     - **Home** (`editor/Home.tsx`) is where the app opens when the link names no build, and
       the top bar's Home (or the Voxyl mark) goes back to it. Tabs: **Builds** (new, import,
       samples, each saved build with its size and age, open, export, delete; with none yet,
       "Start building" goes straight into a new build), **Palettes** (shared palettes: new,
       edit, duplicate, delete) and **Blocks** (the default set and imported jars: browse,
       import, remove). The 3D view stops drawing while Home covers it. Deleting the open
       build goes back to Home. Prefabs join Home with step 4.
     - **Shared palettes** live in OPFS (`PaletteStore`, `packages/session/src/palettes.ts`,
       tested): one JSON record each, and saving changed content bumps its version. A build's
       drawer **Shares** a palette (a copy, with what each semantic resolves to now, keyed by
       semantic id so sharing again matches) and **Uses a shared palette** (a `palette_sync`
       linked copy; if the build has a palette of that name the copy is "Name (shared)").
       A linked copy says its version and offers **Update to vN** when the shared one is
       newer: a build never changes by itself. Not done: turning the shared-from palette
       itself into a linked copy (it needs a core command to rebase a palette's semantics
       onto a linked copy's); recorded as a follow-up.
     - **What it is for**: a semantic's description is edited in the drawer and in Home's
       palette editor (`describeSemantic`, a `semantic_update`; empty clears it).
     - **New builds start on blocks**: the starter semantics map to the voxyl default set
       (Base stone bricks, Wall white concrete, Floor oak planks, Roof grey concrete, Trim
       quartz, Accent cyan concrete, Glass, Light glowstone, Detail oak log), each with a
       description. **Undecided is still a state** (principle 5), but it no longer draws as a
       flat colour: an undecided look draws as a voxyl placeholder panel (a frame and faint
       hatching, `voxyl:undecided`, hidden from the picker) tinted with its hint colour, so a
       build before any block is chosen still reads as blocks, each semantic its own colour.
     - **Golden images regenerated** (they were stale since the editor shell: the view now
       sits under the top bar, 640×320). The tool now hides the chrome and closes the palette
       drawer; the 2D capture uses `.grid-canvas`.
     - **Fixed on the way:** the moon disc drew a faint dotted line along the great circle
       90° from the moon at night (its edge width blew up there), and the ground grid now
       also fades as a whole once cells are below a pixel in the crowded direction, so lines
       running away from the camera no longer fan into a bright band at the horizon.
  6. **Inventory and block chooser.**
     - The inventory has a **search** (a name, what it is for, or a block) across palettes,
       which narrows the palette list to those with a match; a **"+" tile** adds a semantic to
       the palette shown; **right-click** removes one. Removing is a new core command,
       `semantic_remove` (tested): refused while any cell uses the semantic ("re-semantic
       them first"), while another palette's semantic derives from it, or in a linked palette;
       it undoes like any other. A tile's tooltip shows what the semantic is for and its block.
     - **The block chooser** (`editor/BlockPicker.tsx`), after Godot's: libraries down the
       left (all, or one), a search and icon grid, and a **turning preview** of the block you
       explore on the right, alone, three in a row or a 3×3 wall, to see how it tiles. It is
       drawn with CSS 3D from the block's six face textures (a `blockPreview` request), so no
       second renderer; a non-cube block shows its side textures on a cube. A click explores;
       "Use this block" or a double-click picks. It opens as a dialog over the page from the
       drawer's Choose and from Home's palette editor, and Home's Blocks tab is the same
       chooser for browsing.
  7. **2D editing** (editor step 6, brought forward). In a 2D view the left button draws
     with the hotbar semantic and the right button erases; how Build draws is the 2D bar's
     **Draw** menu: Pencil, Line, Rectangle (filled) or Fill (the touching cells of the same
     kind on the layer, within the view's window). A stroke is previewed in the 2D view while
     it is drawn and becomes **one `set` command** on release ("Rectangle 6 Wall"), so it is
     one undo step and what an agent would send (`world/flat-edit.ts`, tested). Blocks face
     the way the press was from the cell's middle, as Godot did, so dragging stairs right
     faces them right. **Exchange** works in 2D (the run in the slice's plane, within the
     brush); the Wand and Build to me stay 3D tools and the bar says so. **Select** takes
     corners on right-click, shared with 3D, so a box can start on one layer (or in 3D) and
     end on another; Shift+right-click selects what touches. **Middle click** picks a
     cell's semantic; panning moved to middle-drag, Space+drag, or left-drag with Select.
     **R** over a cell turns it about the slice's axis; **F** mirrors the picture. The
     selection shows on the slice (filled and bright on its layers, a dim outline off them)
     with the first corner of a box being chosen. Zoomed in, **turnable blocks show their
     facing** (an arrow in the plane, a diamond out of it, hollow when upside down) and cells
     of parts a corner mark, from a per-state facing table sent with the looks. The bar's
     **View** menu turns the picture left or right and mirrors it (`turnedOrientation`,
     tested). An empty build's plan starts on layer 0. Not done: part footprints drawn
     slot by slot (cells of parts only get a mark).
- **Next (written before the work below; all of it is done now, see Finishing the editor):** the user's review of this round. Then editor step 4 (clipboard and prefabs,
  which also brings the Prefabs tab to Home), step 5 (parts), step 7 (slice and cutaway in
  3D) and the gate.

- **Finishing the editor (2026-10-07).** The user passed round 5 and asked for every remaining
  editor feature, in parts, each its own commit. Parts so far:
  1. **Shapes and the semantic editor.**
     - **Shape selection.** A semantic's form names the shape it places (`Form.shape`), and the
       entry dialog has a **Shape** picker (`ShapePicker`: Whole block, then Microblocks,
       Roofing, Slopes, each with a small isometric picture from `editor/shape-icon.ts`,
       tested) and a **Placing** select for whole blocks (from the block, or a preset: cube,
       faces the player, stairs, slab, log, facing, torch, hopper). The shape is intent, so it
       sits on the semantic and no palette changes it (web-core.md, section 2). `semantic_update`
       now rejects a form naming an unknown shape. A semantic that inherits a shape can pick
       another but can't go back to whole blocks (forms merge, as looks do).
     - **Placing parts** (editor step 5, the placing half). `packages/shapes/src/placement.ts` is
       Forge Microblocks' placement ported (the Godot `ShapePlacement`): the click's face and
       where on it pick the slot (a face zone, a corner quadrant, an edge zone, a centred post),
       an inner face of a thin part places into the same cell, and ArchitectureCraft's
       `orientOnPlacement` turns roof shapes toward the click and lines them up with a
       neighbouring roof. All of it is pure and tested (`packages/shapes/test/placement.test.ts`).
       `raycast` now meets a cell of parts only where the ray touches a part (`hitPart`: boxes for
       microblocks, triangles for roofs), and says which part and which face, so a slab leaves the
       rest of its cell open to aim through. Right click places the hotbar semantic's part; **left
       click removes only the part aimed at**; middle click picks that part's semantic. The aim
       outlines the part it meets rather than the cell, and a cyan **ghost** (drawn over everything)
       shows the part a click would place.
     - **The far side.** A shaped part can go on the far side of its cell (FMP's `opposite`).
       Hold **Left Ctrl** (alternate Num / or .) or a **mouse thumb button**, or tick **Far side**
       in the inventory's Build options. A click while Ctrl is held cancels the sprint tap.
     - **Whole-block tools refuse a shaped semantic** (Build to me, Wand, Exchange, 2D drawing)
       with a line over the hotbar (`engine.say`, the new `Toast`), rather than put a cube where a
       cover was meant. Shaped parts are placed with Build in a 3D view. Not done: part footprints
       drawn slot by slot in 2D, and the face grid Godot draws on the aimed face.
     - **Semantic editor** (`SemanticEditor`, from **Semantics** in the palette drawer and the
       inventory): the project's semantics once each, however many palettes offer them. It edits
       what belongs to the semantic (name, what it is for, shape, placing) in one place, and shows
       a table of every palette that can place it with the look each gives it (choose a block, or
       use the inherited look). Cells hold ids, so renaming touches no cell and no palette. This is
       the "top-level semantic editor" of the cross-project proposal below (item 4). The model
       underneath is unchanged: a semantic still lives in one palette (its group), and other
       palettes derive it to override a look.
     - **Fixed on the way.** Dialogs taller than their content wants (the entry dialog) were
       centred in a grid track as tall as the content, so on a window under about 1300 px they
       slid off the bottom. The `.keys` track is now the window's size.
     - **Not yet seen on screen:** the ghost and aimed-part outline need a pointer-locked 3D view;
       the rules, the ray, the commands and the outline geometry are tested.

  2. **Clipboard and prefabs** (editor step 4).
     - **Copy, cut, paste.** **Ctrl+C** copies the selection, **Ctrl+X** cuts it, **Ctrl+V** takes
       the new **Paste** tool (also Actions → Copy and Cut, and the inventory). The clipboard is a
       core *piece* (`cutPiece`) kept in the world worker, so it survives opening another build
       and pastes into it: the piece carries its semantics by name and palette, and `paste`
       maps or creates them (`importSemantics`). Right click places it with the middle of its
       footprint, on its floor, on the cell aimed at (the anchor, set when it is copied). **R**
       turns it (Shift back), **M** mirrors it east for west (Num 0 and Num . for the other
       hand); the tool options also have buttons for both, **Clear what it lands on** (the
       piece's empty cells clear: `air`), and a shift along x, y and z. A paste is one `paste`
       command ("Paste 421 blocks"), so it undoes as one step and is what an agent would send;
       north stays north when the build's north differs from the piece's (`turnsBetween`).
     - **The ghost** is the piece's cells as translucent cubes in their semantics' colours,
       with an amber box round them, drawn over the world (`scene/paste-ghost.ts`). The worker
       sends the cells the paste would fill (`placedPositions`), and a test proves they are
       exactly the cells a real `paste` fills, for all four turns, mirrored and not. Past
       60,000 cells it is the box only. The plan said "drawn from a fork" of the world; cubes
       are cheaper and read just as well, so the fork stays a possible later upgrade.
     - **Prefabs.** **Ctrl+P** (or Actions → **Save as prefab…**) names and tags the selection
       (`PrefabStore`, `packages/session/src/prefabs.ts`, tested): a deflated piece, an entry
       (name, tags, size, blocks, content hash) and a 64×64 picture, in OPFS beside the
       libraries, outside any build. The picture is a small isometric drawing of the piece in its
       semantics' colours, made on the world worker (`pieceThumbnail`, tested). **Home →
       Prefabs** lists them as picture cards (search by name or tag, rename, retag, delete),
       and the inventory has a **Prefabs** page beside the palettes. Clicking a prefab puts it
       in the clipboard and takes Paste, so the next right click places it. A prefab is a piece,
       not yet the saved-project form `savePrefab` makes; Phase 4 pins agents' pastes by hash,
       and the entry's hash is of the piece.
     - **Shape on shared palettes.** Home's shared palette editor has the same Shape and Placing
       controls on each semantic (`FormCell`), so a theme can carry shaped semantics.
     - Not done: the Paste tool in a 2D view (the 2D bar says it works in 3D), and the Godot
       app's modal offset panel (the options row has the shift instead).
     - **Checked on screen** with the browser pane's page driven through `__voxylEngine` (the
       pane can't lock the pointer): the picture cards, the dialogs, the tool options, and the
       paste and part ghosts at an aimed cell.

  3. **Cutaway and isolation** (editor step 7).
     - **A lens, not an edit.** The cutaway hides a box of cells in every 3D view; isolation hides
       everything outside the selection's box. Neither touches a cell or the history. Hidden
       cells are not drawn and **rays pass through them**, so the aim, a click and the ghost all
       ignore what is hidden (`raycast` takes a `hidden` test).
     - **Done in the mesh job, so a cut looks like a cut.** The session (`WorldSession.setVisibility`,
       `packages/session/src/visibility.ts`) makes hidden cells read as empty in each chunk's
       copied cells, so the neighbours show the faces that were buried and the walls of the cut
       are real faces, not a see-through hole in a shell. Only the chunks meeting the old and
       new cutaway are meshed again, or every chunk when the isolated box moves. Tested: a cut
       meshes exactly like a world where those cells were removed, and clearing it restores the
       original meshes. Light is left alone, so a cut surface keeps the light it had.
     - **The Cutaway menu** in each 3D bar, as in Godot: **Cut above camera** (everything above
       eye level, over the whole build: lift the roof off), **Cut away selection**, **Adjust
       bounds…** (a panel with each of the box's six faces to step, Shift moves five, and the
       box outlined in orange while it is open), **Cutaway on** (**H**, or **End**) and **Clear**,
       plus **Show only the selection**. Actions on a selection also has Cut away this region and
       Show only the selection. The cut is the same in every 3D pane; a new project starts with
       none.
     - **Isolation is the selection's bounding box**, exact for a box and a bounding box for any
       other shape (Godot hid exactly the selected cells). With the selection gone there is
       nothing to isolate, so it switches itself off.
     - **Checked on screen**: a notch cut into a solid block shows its real inside walls, the
       frame and the panel draw, and the toggle, Clear and Cut above camera work.

  4. **Project and app settings** (editor step 8, what was left).
     - **Project settings**, from **Project** in the top bar: the name, **real north** (which of
       the build's own directions is north: -Z by default, or +X, +Z, -X) and the **major grid
       offset** (0 to 15 on x and z). Each change is a `settings` command, so it undoes, and a
       saved build keeps it. North moves no cell: it turns the compass and the camera presets and
       turns what crosses between builds (a prefab keeps its own north, so it lands the right
       way round). The editor follows a change at once, including an undo of one.
     - **Rebinding keys**, in the Keys panel: **Rebind**, click a key, press the new one.
       Esc is reserved (it lets go of the pointer); Backspace clears an alternate; a binding
       always keeps a key; a key already used elsewhere is mentioned, not refused (some are
       shared on purpose, as R turns a block while flying and the clipboard with Paste in hand).
       Per-row **Reset** and **Reset all**; saved in this browser. `editor/keymap.ts` is now
       the live table (`KEYMAP` over `DEFAULT_KEYMAP`): FlyCamera and every handler read it each
       time, so a change takes effect at once. Mouse and combination rows (Ctrl+C and so on)
       are fixed. The slot keys 1 to 9 are fixed too.
     - **Autosave** was already incremental (a save writes only chunk blobs the folder does not
       have, `ProjectStore`), so nothing to add there.

  5. **Footprints in 2D, and promoting a palette.**
     - **Part footprints in the 2D view.** Zoomed in (14 px a cell and up), a cell of parts draws
       its parts: a microblock's boxes as rectangles, a roof's triangles as polygons, each in
       its semantic's colour, nearer ones over farther (`views/footprint.ts`, tested; the world
       worker sends each state's parts with the looks, `statePartDraws`). Below that size the
       corner mark stays. It follows the pane's turn and mirror, and works in plans and cuts.
     - **Make shared / Make a local copy.** On a palette that stands alone (extends nothing,
       derives nothing), **Make shared** in the drawer saves it to your shared palettes and turns
       it into the linked copy of what it just saved, in one undoable step (`palette_link`, a
       core command: ids and cells stay, the semantics are matched to the shared ones by key, so
       a later update lands in place). A linked copy has **Make a local copy** (`palette_unlink`).
       A palette that extends another can't be promoted (a linked copy has no parents), and the
       button isn't offered; **Share** still copies it.
     - **Rename wording.** An inherited semantic's entry dialog now says a new name there is that
       palette's own, and that **Semantics** renames it everywhere.
  6. **The gate's performance half, measured** (headless Edge, B580, 1280×860, 5M-cell city,
     lighting on, `pnpm shot "world=city-5m&lighting=volume" --bench`, after all of the above):
     frame 16.7 ms p50 / 16.8 ms p95 (60 fps), 3.7 ms main thread, GPU 3.1 ms p50; **single
     edits visible in one frame** (16.7 ms p50, 22.5 ms p95); roof-hole open/close 17 ms; 100k
     fill 0.4 s, 1M fill 2.0 s (as before). Cutaway on the same city: lifting the whole roof
     (every chunk above the camera remeshes) 0.7 s; nudging a face, or toggling it, 0.5 to 0.7 s;
     a 60×40×60 notch you would adjust by hand 33 ms (two frames); clearing 0.5 s.
     (`tools/shot.ts --bench` now opens the Dev panel itself; in a fresh profile it starts
     closed.)

- **The gate is yours:** a real hand-build session on the web, with the keys and the new tools
  (Paste, shapes, the cutaway). The measured half holds (item 6). What I could not check from here
  is the feel: the part ghost and the paste ghost were seen only through a page driven by script
  (the browser pane can't lock the pointer), so the first pointer-locked session is the real
  test of aiming at parts.
- **Left, deliberately:** the Paste tool in a 2D view; the face grid Godot draws on the aimed face
  to show the part zones (the ghost shows the result instead); Godot's modal paste offset panel
  (the options row has the shift); animated textures, clouds and the placement pop (Polish).

## Cross-project resources (what is planned, and what is not)

The user asked (2026-10-07) how resources that span projects fit: palettes as a top-level
thing beside each project's own, promoting one, a semantic editor with descriptions (which
tell agents what a semantic is for), and a way in that is less abrupt than opening straight
into a project.

**Already decided or built.**

- **Shared palettes** are user-level palettes (web-core.md, confirmed 2026-10-06). A project
  palette can extend one; the project holds a read-only *linked copy*, made and refreshed by
  `palette_sync`, so the project renders anywhere without the owner's palettes. The core
  command exists and the sample city themes use it. Nothing stores user-level palettes yet,
  and no screen shows them.
- **Semantics carry a description** in the core model (`Semantic.description`), inherited
  like the name. The palette drawer cannot edit it yet.
- **Block libraries** are already user-level (OPFS `LibraryStore`); the jar import sits in the
  Dev panel for now.
- **Step 8** (project home and settings) covers projects only: a list with thumbnails, new,
  samples, import, project settings, app settings.

**Not planned yet.** A store and screen for shared palettes; promoting a project palette to a
shared one; a semantic editor with descriptions; where libraries and prefabs are managed
outside a project; what the app opens on.

**Proposal (awaiting the user).**

1. **Home** replaces step 8's project list with four tabs: **Projects**, **Palettes** (the
   shared ones), **Blocks** (libraries: import a jar, browse), **Prefabs**. The top bar gets a
   Home button.
2. **Shared palettes** are stored in OPFS beside the libraries (later synced with the
   account). Editing one there is the same editor as the drawer. Each project that links it
   shows "a newer version is available" and re-syncs with one click (`palette_sync`), never
   silently, so a project only changes when its owner says so.
3. **Promote**: on a project palette, "Share as a palette" copies it to the shared palettes
   and turns the project's palette into a linked copy of it (cells keep their semantic ids;
   `palette_sync` matches by key). The reverse, "Make a local copy", unlinks it.
4. **Semantic editor**: name, description (a line on what it is for: the hint an agent and a
   teammate read), placement form and look, in the drawer and in Home's palette editor. The
   new-project starter semantics get descriptions ("Wall: vertical structure of the outer
   shell", ...).
5. **What opens first**: the first visit goes straight into a new empty build (the simplicity
   the user likes); after that the app opens on Home, with the last project a click away
   ("Continue New build"). Or: always reopen the last project, with Home one click away.

## Gaps from the Godot app (2026-10-07)

A survey of `scripts/` against the web plans, so differences are chosen, not missed. Items
the editor steps already cover are listed last.

**Not in any plan yet** (when surveyed). **Status, end of the third round:** every row is
done (see "Third round, as built" above) except views as tabs (not wanted), making your own
blocks (dropped), animated textures (Polish), the inventory's Prefabs page (with step 4) and
part footprints drawn slot by slot in 2D (with step 5).

| Godot feature | Where it lives in Godot | Suggestion |
| --- | --- | --- |
| Render modes per 3D view: Textured, Intent (flat colour per semantic), Clay, Outline, X-ray, Wire; lighting App/Studio/Flat; orthographic projection; plain background | `ViewOptions.gd`, `ViewToolbar.gd` | A Render menu in the 3D bar. Intent first: it is principle 5 made visible, and agents' tier 1 captures use the same look |
| Camera presets (frame all; from N/S/E/W; top; iso) and auto-orbit at three speeds | `ViewToolbar.gd`, `CameraFraming.gd` | A Camera menu in the 3D bar; `CameraFraming` math is also what agent captures need (Phase 4) |
| Choosing the 2D slice from the 3D view (Tab or Enter: a plane through the aimed cell, cycle the axis, move it, confirm) | `View3D.gd` slice-select | With step 7, or as a 2D-bar action "slice at the crosshair" |
| A 2D view showing another 2D view's slice as a line | `View2DGrid.gd` guide line | Cheap once there are two 2D panes |
| Build-to-me (fill from the aimed cell to where you stand), Exchange (swap blocks in place), brush size | `View3D.gd`, `ToolsPanel.gd` | New tools in the inventory's tool strip, after step 4 |
| R turns the aimed block in place (Shift backwards) | `View3D.gd` `_rotate_targeted_block` | Step 5 already has "rotate on face"; add the key there |
| Twelve hotbar slots (keys 1-9, 0 for the tenth; the wheel reaches all twelve) | `VoxelWorld.gd` `HOTBAR_SIZE`, `Hotbar.gd` | Decided: 9 is fine |
| Sprint on a left Ctrl tap (the web has only `\`, a right-hand key) | `View3D.gd` `_tap_sprint` | Add left Ctrl tap, so each hand has a sprint |
| Inventory: a "+" tile adds a semantic, right-click removes one, a search box (Tab) that also narrows the palettes, a Prefabs page | `InventoryScreen.gd`, `PalettePanel.gd` | Search and "+" soon; Prefabs page with step 4 |
| Block chooser with a library filter rail and a turning 3D preview (1×1, 1×3, 3×3) | `BlockChooser.gd`, `BlockPreview3D.gd` | Improve the drawer's block picker when Home's Blocks tab is built |
| Browsing a library's blocks | `HomeScreen.gd` Block Types tab | Home → Blocks. Making your own blocks is dropped (the user, 2026-10-07): blocks only come from imports and the default set |
| Animated textures (water, lava, portals) and a placement pop | `View3D.gd` | The Polish phase (web-migration.md): not trivial |
| Selection shown in a 2D view (bright on its layers, dim off them), part footprints and facing glyphs, rotating and flipping the 2D view, pencil, line, rectangle and fill | `View2DGrid.gd` | Step 6 |
| Views as tabs you drag between panes, any split tree | `MultiViewShell.gd`, `ViewPane.gd` | Deliberately not: four presets are simpler. Revisit if the user misses it |

**Covered by the editor steps**: copy, cut and paste with R and M and the ghost (step 4); save
a selection as a prefab, Ctrl+P, prefab handle and tags (step 4); part ghosts and the
alternate placement on left Ctrl and the thumb buttons (step 5); cutaway with H and End,
"cut above camera", isolation (step 7); project settings, north, grid offset, app settings
(step 8). In Phase 4: export to schematic (with the include/exclude preview), agent
connections and their settings tab.

## Feedback, fourth round (2026-10-07)

- The amber slice in a 3D view is drawn only while that 2D pane is the focused one. Tab still
  retargets the 2D pane focused last.
- The ground grid's minor lines, major lines, and the horizon cutoff each fade over about
  twice the old distance, starting where they did.
- A plan's compass follows View → Turn and Mirror (east runs the other way when mirrored).
  A turned cut names up and down when those are the left and right edges.
- Inventory: right-click is Edit or Delete. "+" opens the entry editor with "New" filled in;
  the block is chosen in that editor (the Godot dialog), and Create writes the semantic,
  its description, its fallback colour and glow in one step. A preview of the selected
  semantic sits on the right. The card is larger. Tool buttons and the hotbar badge are
  icons. Each hotbar slot shows its name under the block.
- Block pictures are baked from the real model (slab, stairs, fence post) on the world
  worker, a few at a time, and cached for the hotbar, the inventory, and every block list.
  A whole cube's detail preview can still turn; anything else shows the bake. There is no
  disk cache yet — a big jar's first browse bakes what is on screen.
- Home → Blocks is one library list (an import *is* a library, beside the built-in set), as
  wide as the window, with import and remove on that list. The "showing x of y" line is gone.

## Feedback, fifth round (2026-10-07)

- **Inventory follows the hotbar.** Opening it selects the active slot's semantic and that
  semantic's palette. Choosing another slot (click, 1–9, or the wheel) does the same, including
  while the inventory is open. Clicking a semantic still loads the chosen slot and advances.
- **Fly mode resumes.** Opening the inventory still releases the pointer. Closing it locks the
  pointer again when it was flying before.
- **One block preview.** The inventory's preview and Home → Blocks share `BlockStage`: the
  turning cube, and 1×1 / 1×3 / 3×3, and the choice is remembered across both. Dragging the
  cube turns it by hand (`editor/turntable.ts`, the same yaw and pitch a prefab thumbnail can
  use). It spins on its own until that drag.
- **Block lists page.** A search returns 60 hits unless asked for more, so a Minecraft jar
  stopped in the B's. The chooser now asks for the next page as you scroll, and says how many
  are still unloaded. Icons bake when they scroll into view.
- **Block tiles stay square** (104px), aligned to the start of the grid, so a short list no
  longer stretches each tile into a tall panel.
- **Light** opens above the palette drawer.
- The camera menu's slider is labelled **Fly speed**.
- **Right-click a hotbar slot** (inventory open or not) is the same Edit or Delete.


## Feedback, sixth round (2026-10-07)

- **Undo lag was the autosave.** A saved project's autosave (1.5 s after the last edit) ran
  `saveProject` in one synchronous pass on the world worker, so an undo pressed during it
  waited for it: measured 810 to 1,500 ms on the 5M-cell sample, 30 to 50 ms otherwise. It now
  saves a `fork()` (chunks are shared copy-on-write) and `saveProject` takes a `pace` callback
  it awaits every ~6 ms, so commands in the queue run between slices. Undo during a save is
  35 to 50 ms again. One autosave runs at a time; an edit during it queues one more.
- **Shaped sample cities have a semantic per part.** `CITY_PARTS` in `packages/fixtures`: Trim
  Post, Strip, Pillar, Hollow Cover, Mass Panel, Cover, Roof Tile, Outer Corner, Gabled and Hip
  Roof Ridge. Each is in the linked City palette with `form.shape` and its block's look, derived
  into Main, and the parts of the city use them. Middle click on a roof tile now puts "Roof
  Tile" in the hand, which places the tile, not a cube. Re-skinning keeps them (the theme sync
  includes them when the palette has them). Plain city samples don't get them.
- **Paste pins and has its own panel.** Left click with the Paste tool pins the paste at the cell
  it was aimed at (`PasteArgs.at`; the ghost stays while you fly); again lets it follow. Right
  click places and lets go of the pin. Middle click frees the cursor and opens `PasteOverlay`: a
  small panel in the corner (turn, mirror, shift x/y/z, clear what it lands on, Place, Pin, Fly,
  Cancel) with the ghost frozen where it was aimed, so the result stays in view. While flying
  it shrinks to a quiet status line. Prefab placement is the same tool, so the same panel.
  The offsets left the inventory's tool area; it only has the tool's hint now.
- **Esc stops pasting.** It goes back to the tool held before and keeps the clipboard. In
  pointer lock the browser takes Esc for itself, so the engine treats an unprompted release of
  the lock while pasting (window still focused, inventory closed, no panel requested) as that
  Esc, and asks for the lock back when Esc is released, as the inventory already does. That
  re-lock on key-up is the part only a real Esc in a real browser proves (synthetic keys don't
  leave pointer lock): if the browser refuses, a click flies again.
- **Starter palettes.** Four shared palettes of default-set blocks (Stone and brick, Timber,
  Concrete, Landscape) are put in the user's palettes once per browser (`PaletteStore.seed`,
  marked by `palettes/starters-v1.seeded`, so a deleted one stays gone). They show under "Or
  use one of yours" and in Home → Palettes.
- **Palettes can be removed from a project.** `palette_remove` (core): refused for Main, for a
  palette others extend, and while cells use its semantics; undoable. The list asks first and
  says which palette it is and whether it is a link (the shared palette stays) or only here.
- **The palette pane is a list.** One row per palette: a link icon (blue when it is a shared
  palette linked in), the name, semantic count, what it extends, "update available"; a click
  opens its actions (Open in the inventory, Rename, Share a copy, Make shared, Update, Make a
  local copy). The semantics and the look editor left the drawer: the inventory and the
  Semantics editor already do that. Adding is its own card below: a new palette (name, what it
  builds on) and a list of your shared palettes with Add.
- **Paste panel and tool strip, roomier.** The panel is 300 px wide with one row per axis: a
  coloured letter (X red, Y green, Z blue), a 32 px minus, the shift, a 32 px plus. The
  inventory's tool buttons are 68 px tall with a 32 px icon and the tool's name under it.
- **Inventory footer is a column.** Tools over the hotbar (a rule between it and the blocks),
  both centred, instead of side by side: the two needed ~1250 px and collided in a 1240 px
  card. Checked at 1600×900 and 1100×700.
- **Inventory layout, second pass (replaces "Inventory footer is a column").** The left column is
  Prefabs (a button), the palettes, then the tools (one row each: icon and name; scrolls once there are more),
  The footer is one row: what the tool in hand does and its options (a
  fixed 340x92 px box, so choosing a tool never moves anything), left of the hotbar. The
  footer fell from ~270 px to ~90 px, and the inventory card no longer overflows a 720 px
  window (its grid row is `minmax(0, 1fr)`). Tried and dropped: a dock with the tools as a
  3x2 grid beside the hotbar (buttons too small), and tools under the preview (right column
  crowded). Checked at 1600x900, 1280x720 and 1280x520.
- **Block details (2026-10-08).** While flying, the focused 3D view shows a small readout
  centered at the top of the picture: the semantic you are looking at, the palette that
  semantic lives in (the one its look resolves through, so a derived Wall says Walkway rather
  than Main), the block it is assigned (or Undecided), the block library that block comes from
  (Voxyl defaults, or an imported library's own name), and "Glowing" when its look glows. A
  part shows that part's semantic, and its picture is the part on its own in the semantic's
  colour; a whole block's picture is the block's model. Show → Block details turns it off per
  pane (on by default). It reads the palettes; it is a lens.

## Feedback, seventh round (2026-10-08)

Before the gate. Everything here is built and `pnpm check` is green (59 files, 492 tests).

- **One selection panel.** The separate Actions menu is gone. Cut, Copy, Save as prefab and
  Export schematic are icon buttons across the top of the selection panel, each with its
  description as the tooltip (`SelectionToolbar`, `action-icons.tsx`). The rest (cut away,
  show only the selection, fill, replace, clear, re-semantic) sit under "More actions" in the
  same panel. The panel opens with the Select tool; with another tool in hand the keys
  (Ctrl+X, C, P) do the same as before.
- **The "weird character".** `selection-actions.tsx` and `ProjectSettings.tsx` held a lone
  cp1252 byte where "…" was meant (the housekeeping item in web-migration.md). Both are UTF-8
  now, and Biome no longer reports an internal error on them.
- **Tool badge = hotbar slot.** The active-tool box left of the hotbar is a slot's size
  (76 px wide), shows the tool's name under its icon, and the slots stretch to one height so
  the badge lines up with them whatever a slot's name does.
- **One dialog for taking a region apart** (`RegionDialog.tsx`, `engine.regionDialog`).
  Save as prefab, Export as a schematic (the selection, the whole build or a prefab) and a
  prefab's new **Details** (Home → Prefabs) are the same dialog with different fields and a
  different last step:
  - right: what would be **kept**, turning (drag) and zooming (wheel): the visible cells as lit
    cubes in their semantics' colours, inside the box (`PiecePreview.tsx`: three's WebGL
    renderer, loaded when a dialog first opens, on a canvas of its own). **Shaped parts draw
    as their real shapes** (see "Previews draw shaped parts" below).
  - left: the include list is the selection panel's own **Manifest** (`Manifest.tsx`):
    Semantics | Blocks tabs, counts with stacks, Copy. In Semantics a tick per row leaves a
    semantic out (All / None); Blocks reads what is kept by the block each look names. In a
    schematic the Blocks tab is the Minecraft material list, and a row says why it is left out.
  - **Shrink the box to what is kept** turns itself on when something is unticked, until set
    by hand (Godot's rule). Prefab fields: name (a free "Prefab N" to start), handle (bottom
    centre or bottom corner), tags. Saving over a name that exists says so, and the button
    reads Replace. A prefab saved with semantics left out stores only what is kept
    (`filterPiece` in core: the parts of a cell are filtered, unused semantics dropped and the
    rest renumbered).
  - the worker answers all of it with one `regionPlan` request (`schematic: true` adds the
    file's report and material text). `schematicPlan` and the two old dialogs are gone.
- **Previews draw shaped parts** (2026-10-08). The prefab, schematic and details previews drew
  a cell of parts as a whole cube of its first part's colour. Now `pieceSurface` lists a cell
  that holds parts as those parts (`PieceSurface.parts`: cell, shape, slot, colour per part),
  never as a cube, and a parts cell no longer counts as solid for hiding its neighbours' faces.
  `partMesh` (`part-mesh.ts`) builds their triangles from the same two sources the editor
  draws from: `microBoxes` (a box each) and `archTriangles` (roofs, slopes), flat shaded in the
  part's semantic colour, in one mesh beside the instanced cubes. A shape the catalog doesn't
  know still draws as a cube, as the mesher does. A piece with more than `MAX_SURFACE_PARTS`
  (40,000) parts draws them as cubes again rather than building millions of triangles; past
  `MAX_SURFACE_CELLS` it still says "too big to draw". Tests: `pieceSurface` (parts listed,
  unknown shape as cube, fallback), `partMesh` (box = 12 triangles of the right thickness,
  winding agrees with normals, roofs stay in their cell, sRGB to linear). Checked in the dev
  server with a probe page of slab, roof tiles, post and hollow panel: all read as their
  shapes. Model-based shapes (stairs and fences from a look's block model, not parts) still
  draw as cubes in the preview.
- **Pinholes: the cause was not the mesh.** Reproduced on the 5x5 patch of dark blocks seen
  from straight above (headless Edge, `world=city-1m`): 1-pixel dots in a dotted line along
  every cell edge, a *pale* colour (127,127,118, light grey concrete). Growing the quads 20
  times as far changed nothing, hiding the ground grid changed nothing, removing the alpha
  discard changed nothing, and flat colours instead of textures removed them. So they were
  texture reads that fell into the neighbouring tile of the atlas. The shader clamped a tile's
  uv to 0.9999, but a GPU rounds a texel coordinate to a few fractional bits before it chooses
  the texel, so 15.998 of 16 became the next tile's 0. A dark block beside a pale one in the
  atlas shows it most. **Fix:** clamp to the centres of the edge texels at the mip level in use
  (`margin` in `surfaceColor`, quad-material.ts). The dots are gone in flat, volume-lit and
  night views. **`SEAM_OVERLAP` (growing every quad by 0.003 cell) is removed**: it never
  fixed this, and when lit its sliver reads the neighbouring cell's light. With it removed, a
  64x48 wall of random dark and grey blocks over a pale back wall (as many T-junctions as the
  greedy mesher makes) shows no pale pixel at two distances. Headless SwiftShader may not show
  what a real GPU does, so if cracks come back on the user's, the repro is that wall, and the
  fix to try is splitting long edges at their T-junctions in the mesher, not growing quads.
  The golden images were already out of date (the grid fade changed after they were taken:
  `sky-dawn` differs only along the ground grid). `city-concrete` now differs in 0.16% of
  pixels, scattered one-pixel dots along cell edges: the pinholes the old golden had.
  Re-take the goldens (`pnpm golden --update`) once the user has looked.
- **Deploy.** Checked for the user, see "Production (voxyl.xyz)" in web-migration.md. The
  workflow no longer goes through `cloudflare/wrangler-action`; it runs `wrangler@4` itself.
  `gh` is installed (winget, 2.102.0) but not signed in: `gh auth login` is the user's.

## Gate item: pre-1.8 and GTNH import (engine built and proven; UI in progress)

The user (2026-10-08): add pre-1.8 import and every GTNH healer the Godot app has to the editor
gate, so people can import from GTNH. Full parity with Godot's features; the implementation is
greenfield. This is the plan, to be built as Phase 5 work and checked at this gate.

### Status (2026-10-08, later the same day)

Built and proven against the Godot importer, in `packages/mc-import` (order below = the plan's):

1. **Sources** (`src/sources/`): ranged zip reading over a `ByteSource` (end record and directory
   only, entries on demand), `AssetSource`/`PathIndex`/`MultiSource`, `DirAssetSource`, and
   `scanInstance` over an `FsDir` abstraction (the app backs it with the File System Access API or a
   `webkitdirectory` list, tests with Node fs in `tools/mc-import/node-fs.ts`). 245 jars open in ~0.9 s.
2. **NEI roster** (`src/legacy/`): CSV and dump parsing, the narrow texture match, `LibraryDraft`
   (a mutable library with `addCube`), `importRoster`. GTNH 2.9 Beta 2: 18,754 roster rows, 1,563
   imported and 17,191 left out, in ~2 s and 280 MB (Godot: ~10 min, 5 GB). **Parity with
   Godot's `nei-manifest`**: 1,327 identities identical on all six faces; the only differences are
   24 blocks whose texture is a non-square sprite sheet (IC2, Railcraft, Avaritia...), which Godot
   stretches over the faces and the web leaves out on purpose, and 27 names that only differ by
   an unstable sort of ties ("Torch (n)").
3. **Healer framework** (`HealContext`, `Extension`, `runHealers`, `extensions/gtnh.ts`), the shared
   junk strip and the torch attachment flag (`Block.attachment`, recorded; nothing reads it yet).
4. **Healers**, one file each in `src/extensions/`: GregTech, Et Futurum, Catwalks, Chisel (with
   `chisel-variations.ts` ported as data, and the dyed glass names), ProjectRed Illumination, Extra
   Utilities, Ztones. Pane geometry is `legacy/pane-geometry.ts` (a multipart blockstate).
   **`final-diff` against Godot's healed manifest is clean for every healed namespace** (gregtech 1,224,
   chisel 1,170 incl. 113 panes, etfuturum 146, catwalks 10, ProjRed 32, ExtraUtilities 39, Ztones 551,
   minecraft 68), apart from the same 24 skipped sheets. The whole heal pass takes ~0.7 s.
5. **`import-service.ts`**: `planInstance` (what the folder offers; refuses without the NEI dumps and says
   how to make them) and `importInstance` (roster, healers, the `microblocks.cfg` saw whitelist applied
   to `Block.mc.sawable` automatically, one `Library` per mod). Real run: 133 libraries, 3,772 blocks.

Parity tooling (all in `web/tools/mc-import/`, the Godot side in `tools/parity-manifest.{gd,sh}`, which runs
sandboxed so it never touches the user's libraries): `roster-manifest.ts` + `manifest-diff.ts` (pre-heal),
`final-manifest.ts` + `final-diff.ts` (after healing). The gated tests (`instance`, `roster`, `service`)
run when the Beta 2 instance and the 1.7.10 jar exist and skip otherwise.

Things to know:

- **GTNH 2.9 RC2 has no NEI `dumps/` folder**; only Beta 2 does. RC2 needs the dumps made in game
  (Items, Item Panel in CSV mode, Blocks) before it can import; the plan step says so.
- The vanilla 1.7.10 jar is not in a Prism instance (it lives in `PrismLauncher/libraries/com/mojang/minecraft/1.7.10/`),
  so the dialog offers an optional jar pick for the `minecraft` textures.
- Resource packs in `resourcepacks/` are not read as sources (Godot picked them up as a side effect of its scan).
- Blocks do not carry Godot's search tags (the web `Block` has none). GregTech machines carry no Minecraft
  identity, as in Godot; 421 Chisel blocks have no numeric id either (their group name is not a registry
  name in `block.csv`), as in Godot. Both are candidates for later improvements.
- Libraries are named `<prefix><namespace>` (default prefix `pack-`) so a legacy `minecraft` library does not
  collide with the 1.13+ vanilla one.

Still to do for this item: the import worker and dialog (in progress), checking a schematic export of a GTNH
build against Godot's (ids, metas, legacy ids, a GregTech machine over 15 and an `orient` block), the user's
twelve-block look check and loading an export in the game, and the common-locations/remember-folder polish.

### What Godot does (the features to match)

| Piece | Godot | What it does |
| --- | --- | --- |
| Sources | `MCDirSource`, `MCZipSource`, `MCMultiSource`, `MCInstallLocations` | A folder, a jar or zip (central directory read, entries inflated on demand), or many at once, with the known launcher install folders offered |
| 1.8+ JSON import | `MCImporter` | Blockstates, parent-resolved models, textures, animation strips, tints. The web has this for a vanilla jar (`packages/mc-import`, 1.13+ only) |
| NEI roster | `NeiRosterImporter` | Pre-1.8 mods have no models, so NEI's own Data Dumps give the confirmed list: `item.csv` (which registry names are blocks, and their mod), `itempanel.csv` (every real subtype: registry, meta, display name) and `block.csv` (every registered block's numeric id, which schematic export needs) |
| Narrow texture attach | `NeiRosterImporter._attach_texture` | For each confirmed (registry, meta), look in the mod's own `textures/blocks/` and vanilla's shared domain for a file whose name correlates with the registry and, for a packed meta, its number; face suffixes (top, side, bottom, front…) pick faces. No match, or an ambiguous one, means the entry is **dropped**, never guessed; drops are counted per mod |
| Texture ingest | `MCTexImport` | Copy pixels, average colour, transparency class, `.mcmeta` animation |
| Healer framework | `MCImportExtension`, `MCHealContext` | A mod-specific pass after a namespace imports, with a toolkit: ensure, composite, crop and solid textures, add a cube or pane, confirm a registry+meta identity, remove blocks, read a text file beside the source. Healed blocks are keyed by registry+meta, so a re-run updates them in place |
| GTNH pack healer | `GTNHExtension` | Below |
| Panes | `PaneGeometry` | The five-model multipart a connecting pane needs, lifted from a vanilla pane |
| Chisel table | `ChiselVariations` | Chisel's meta to texture mapping, decompiled once from its bytecode, group by group, with three groups left out as ambiguous |
| Saw whitelist | `MicroblocksCfgImporter` | ForgeMultipart's `microblocks.cfg`: which blocks the saw can cut, so an export can warn |
| Torches | `GTNHExtension._flag_attachments` | Torch-like blocks get the attachment flag (real torch geometry and metadata) |

What `GTNHExtension` heals (one pack script, many namespaces):

- **Shared junk strip** (gregtech, ggfab, etfuturum, catwalks, chisel, ProjRed|Illumination,
  ExtraUtilities, Ztones): delete blocks whose textures are all GregTech overlays (`*_GLOW`,
  `ARROW_*`, `PIPE_RESTRICTOR*`, `*_SIGN`, cover overlays). Healed blocks are never touched.
- **GregTech**: tier casings (ULV to UIV) from `iconsets/MACHINE_<TIER>_{SIDE,TOP,BOTTOM}`;
  every basic machine, per tier (LV to UMV) and in an Active variant, composited from the hull
  and the machine's transparent `OVERLAY_<FACE>[_ACTIVE]`; named from `GregTech.lang`
  (`gt.blockmachines.basicmachine.<folder>.tier.<NN>.name`, with two folder aliases); the
  cubes this supersedes are removed. GregTech metas can exceed 15 and are stored as they are.
- **Et Futurum**: concrete and concrete powder, 16 packed metas in vanilla dye order, each a
  colour-prefixed file in vanilla's shared domain.
- **Catwalks**: four sturdy rails, support column, builder's scaffold, catwalk (plain, and
  taped, which is a separate block) and caged ladder, as cube stand-ins (real shapes are
  future work in Godot too).
- **Chisel**: every group in the variations table, resolved to a file by a fallback chain
  (bare, group prefix, side+top pair, `-ctmv`/`-ctmh` pair), about 97% of the table; names
  from Chisel's lang, including the dyed glass families' own key shape; glass panes, iron bars
  and the 16 stained panes get real pane geometry; a few controller-icon crops.
- **ProjectRed Illumination**: the lamp, 32 metas (16 colours, normal and inverted).
- **Extra Utilities**: Lapis Caelestis, 16 solid colours synthesised (the art is blank).
- **Ztones**: the three flat lamps drawn as a 0.1-thick ceiling plate.
- **Attachments** (minecraft, GalacticraftCore, BloodArsenal, and the packs above): torches.

### How the web version does it

Greenfield, in `packages/mc-import` (no DOM or Node APIs; it runs in a worker and writes to
OPFS libraries), keeping what the web already decided:

- **Output is a `Library`** (blocks, models, textures) per namespace, with the identity in
  `Block.mc` (`registry`, `meta`, `orient`, `legacyId`, `sawable`), which already exists and
  already feeds schematic export. Nothing of Minecraft enters a cell, a semantic or a palette
  (principles 1, 3 and 4). A pre-1.8 block is a cube model with per-face textures, one library
  block per (registry, meta), named from its display name.
- **Sources** (`sources/`): one `AssetSource` interface (namespaces, list, has, bytes, text,
  image). A zip source reads a `File`'s central directory by slicing it (a GTNH `mods/` folder
  is 300+ jars: only directories are read up front, entries on demand); a directory source over
  a `FileSystemDirectoryHandle` with a `webkitdirectory` fallback; a multi-source. **The user
  picks one folder, the launcher instance.** The scan finds `mods/`, `versions/<v>/<v>.jar`,
  `resourcepacks/`, `config/` (for `microblocks.cfg` and `GregTech/GregTech.lang`, which Godot
  finds by walking up from the source) and the NEI `dumps/` folder. The handle is kept
  (IndexedDB), so a re-import asks for permission rather than for the folder again.
- **Pre-1.8** (`legacy/`): `nei.ts` (the three CSVs), `roster.ts` (the confirmed entries),
  `attach.ts` (tokenizer, base tokens, face suffixes and the narrow match, ported with tests
  from the Godot cases), `bind.ts` (a cube from resolved faces), `microblocks-cfg.ts`. Same
  rule as Godot: no confirmed match means the entry is left out and counted.
- **Healers** (`extensions/`): `Extension { handles(ns), heal(ctx) }` and a `HealContext` over
  RGBA arrays in memory (`composite`, `crop`, `solid`, `addCube`, `addPane`, `confirm`,
  `remove`, `siblingText`, `existingFor`), so they are pure functions that test in Node with no
  canvas. Libraries hold raw RGBA, so there is no PNG encode step as there is in Godot. One
  file per mod (`gregtech.ts`, `etfuturum.ts`, `catwalks.ts`, `chisel.ts`, `projred.ts`,
  `extrautils.ts`, `ztones.ts`), plus `junk.ts`, `attachments.ts`, `panes.ts` (the pane boxes
  become a blockstate `multipart`, which the mesher already evaluates), a `gtnh.ts` that
  registers them as a pack, and the Chisel table as a data file (`chisel-variations.ts`).
  Tables (tiers, dye colours, lamp colours, lang key shapes) stay data, so a later pack is a
  new file, not a change to the framework.
- **Run it** (`import-service.ts`): plan (what the sources offer), select, run with progress
  and cancel, in an import worker beside the world worker; results land per namespace library,
  warnings listed per mod. The UI is Home → Blocks → "Import Minecraft": one entry point and
  two routes chosen by what it finds (a 1.13+ jar: today's path; a legacy instance: the NEI
  route, which says how to make the dumps and refuses a folder without `block.csv`, as Godot
  does).
- **Not ported until the editor has them**: torch *geometry and placement* (the web has no
  attachment kinds yet; the heal records the flag on the block and nothing reads it until that
  feature lands) and animated textures (Polish).

### Order, and how each step is proven

1. Sources and a zip reader with random access. A probe opens the user's real GTNH 2.9
   instance (`%APPDATA%/PrismLauncher/instances/GTNH 2.9 Beta 2`) and reports time and memory.
2. Move today's modern-jar import onto the sources, with no change in behaviour (existing tests).
3. NEI roster to plain cubes. **Parity harness**: the Godot importer, run headless on the same
   instance, writes a manifest (registry, meta, display, texture refs, drop reasons) per mod;
   the web importer must produce the same manifest, and each difference is read and either
   fixed or recorded as intended. This is also the proof for every later step.
4. Healer framework, junk strip, attachments flag, `microblocks.cfg`.
5. GregTech (casings, machines, lang), then Et Futurum, Catwalks, ProjectRed, Extra Utilities
   and Ztones, each against the manifest.
6. Chisel with its table and pane geometry, then the dyed glass names.
7. The import UI. Schematic export of a GTNH build checked against the Godot export of the
   same build (ids, metas, legacy ids), including a GregTech machine over 15 and an `orient`
   block.

**The gate for this item:** the user's own GTNH 2.9 instance imports in the browser without
freezing the editor; per-mod counts match Godot's manifest, or each difference is explained;
twelve blocks the user picks look like the game; and the exported schematic of a small build
loads in the game. Schematic *import* (with "north is north") stays a separate Phase 5 step and
must follow `turnsBetween`.

### Decided with the user (2026-10-08)

1. **Whole instance folder only**, not single jars and zips. Simpler to explain.
2. **Chisel table: port it as data**, and leave a comment on the table saying it was decompiled
   once and its extractor is not in the repo (so the next Chisel build means redoing that by
   hand). No `tools/` extractor for now.
3. **Healers stay code.** Fold the table-shaped ones into data only if a second pack wants
   them.

### Import UI built (2026-10-08)

Home, Blocks, **Import Minecraft...** opens one dialog (`editor/ImportMinecraft.tsx`) with two
routes: a game folder or modpack instance (new), and a Minecraft jar or resource pack (the old
`importJar`, unchanged, then the dialog closes).

- **Folder step**: `Choose folder...` uses `showDirectoryPicker` (`id` and `startIn` the
  remembered handle, mode read) and falls back to `<input webkitdirectory>`. Common launcher
  locations per platform with copy buttons (`import/locations.ts`); a remembered folder is
  offered as "Use <name> again" and goes through `requestPermission`. Handles live in IndexedDB
  (`voxyl-folders`, key `mc-instance`). The fallback can't remember a folder.
- **Plan** (from `planInstance`): mods, NEI dumps, vanilla jar, saw list. Problems (missing
  dumps) disable Import and show `NEI_HOWTO`; "Check again" rescans a handle-picked folder. A
  missing vanilla jar is not a problem: the dialog offers "Add the Minecraft 1.7.10 jar..." with
  where Prism and the vanilla launcher keep it. Library name prefix (default `pack-`, lower-case,
  required).
- **Run** in `import/import-worker.ts`, one module worker per plan or run; the page never reads
  the folder. It runs `importInstance` and saves every library to the same OPFS store the world
  worker reads (`LibraryStore(new OpfsFolder("voxyl"))`), with progress (phase, done, total),
  then the page sends the world worker `reloadLibraries` and refreshes its list. Cancel
  terminates the worker (not offered once libraries are being saved). Adapters
  (`import/fs-browser.ts`): handle -> `FsDir` (listings cached), `File[]` -> `FsDir` (grouped by
  `webkitRelativePath`), ranged reads by `File.slice`.
- **Report**: libraries, blocks, roster entries left out for lack of a texture match with the
  biggest mods, healed namespaces, warnings count, time.
- **Library ids are lower-cased** (`libraryIdFor`): the library store only accepts
  `[a-z0-9_.-]{1,64}`, and the first real run failed on `pack-Automagy`. Two namespaces that
  differ only in case would share an id.
- **Proven in Edge (Playwright, `webkitdirectory` path)** on the real GTNH 2.9 Beta 2
  `.minecraft` (16,508 files, 244 mods) with the vanilla 1.7.10 jar added: plan appears, import
  takes about 9 s (opening mods 1 s, matching textures 4 s, healing 4 s, saving 0.3 s), 64
  libraries, libraries persist across a reload, cancel mid-run returns to the plan, no console
  errors; the main thread's worst timer delay was 36 ms (frame gap 52 ms). Counts at that time,
  with healers still being completed: 3,772 blocks imported, 17,191 left out. Not proven: the
  real `showDirectoryPicker` (needs a user gesture; the handle adapter, IndexedDB round trip and
  a plan through the worker were checked on an OPFS folder).

### Added to the import UI (now built, see above)

- **Common locations.** The folder step offers places people keep Minecraft: the vanilla
  `.minecraft` (and its `versions/`), CurseForge instances, Prism Launcher instances (and
  MultiMC), by platform (Windows `%APPDATA%`, macOS `~/Library/Application Support`, Linux
  `~/.minecraft`, `~/.local/share/PrismLauncher`). A browser can't read those paths itself:
  the File System Access picker takes a `startIn` of a well-known directory (`documents`,
  `downloads`...), not an arbitrary path, so the picker opens at the nearest well-known one
  and the dialog shows the exact path to paste or navigate to, with a copy button. Prism and
  CurseForge instance folders are listed by name once the user has picked their `instances/`
  root once (the handle is remembered).
- **Remember the last folder, everywhere a folder is asked for.** Any dialog that asks for a
  folder (importer, schematic or prefab export where a directory is chosen) starts the picker
  where the last one was, per purpose: pass the stored `FileSystemDirectoryHandle` as
  `startIn` (the picker also supports an `id` that remembers a directory by itself, which is
  the cheap first step) and keep the handle in IndexedDB beside the importer's. Falls back
  quietly where the picker has no `startIn` (the `webkitdirectory` fallback can't).
