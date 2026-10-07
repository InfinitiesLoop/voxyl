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
  4. slicing from 3D, 5. Home and shared palettes, 6. inventory and block chooser, 7. 2D
     editing: in progress.

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

**Not in any plan yet**

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
