# Voxyl Web — Viewer (Phase 2)

Status: **Started** (2026-10-06). Phase 1 left `packages/core` with real projects (commands,
semantics and palettes, the project format); the app still renders generated city fixtures
through a palette keyed by semantic name. Phase 2 puts the app on real projects and gives it
textures, models, a sky, a 2D grid and local storage. The gate, from
[`web-migration.md`](web-migration.md): **performance targets met with textures on, and golden
images stable.**

The CLAUDE.md principles apply unchanged: cells hold semantics, looks come from the project's
palettes, and every view is a lens on the one world in the world worker.

## Build order

1. **Projects in the viewer.** The world worker holds a `Project` (it already did, but built
   from a fixture name). Colours, glow and light come from the project's own registry: each
   cell state's look is resolved through palette inheritance. Sample builds are generated
   projects whose looks live in a linked theme palette, and switching theme is a
   `palette_sync` command that changes looks, never cells.
2. **Local storage and a home screen.** Projects saved in OPFS in the project format; a list
   to open, create from a sample, import a bundle file, export one, and delete. Saving writes
   only chunks that changed.
3. **2D grid and the multi-view shell.** A read-only layer view of the same world (slices come
   from the world worker), beside or instead of the 3D view.
4. **Trimming overlapping parts in the mesher** (Godot's `render_boxes`, Forge Microblocks'
   render-time trim), carried over from Phase 1.
5. **Block libraries and textures** (see "Block libraries" below). 5a: the library format, the
   original default set with its texture generator, and textured cubes in the renderer.
   5b: importing a vanilla Minecraft jar into an OPFS library.
6. **Block models.** Non-cube blocks (slabs, stairs, fences, custom element models) as cached
   per-state geometry, like parts; panes and fences that join their neighbours.
7. **Sky.** A sky with the time of day, replacing the flat background.
8. **The gate.** Performance with textures on; golden images (Playwright with SwiftShader).

## Textures: the user's decision (2026-10-06)

Minecraft textures can't be hosted, so Phase 2 gets textures two ways:

- **Vanilla jar import, brought forward from Phase 5.** The user picks their own Minecraft
  client `.jar` in the browser; its blockstates, models and textures become a library in
  OPFS. GTNH and mod jars stay in Phase 5.
- **An original default set, shipped with the app.** 16x16 textures that look original but
  that a Minecraft player recognises at a glance: a first pass at the basic building blocks,
  with the obvious shapes (stairs, slabs, fences, glass, glass panes). It can grow later.

## Block libraries (design, step 5 on)

- **A library is blocks, models and textures**, the same shape whether imported or built in:
  `voxyl` (the default set, always there) and `minecraft` (imported, in OPFS). A look's
  `block` names one as `library:block`. A block a viewer lacks draws as the look's tint, so a
  project still renders anywhere.
- **Models are axis-aligned boxes with per-face textures and UVs** (Minecraft's element
  format, parents resolved at import). The default set writes its stairs, slabs, fences and
  panes in the same format, so both kinds go through one path. Elements rotated by angles
  other than quarter turns (plants, torches) are left for later.
- **A cell's rotation picks the variant.** Each block's variant with front north, up up and
  defaults otherwise is its identity; a cell turned by R shows the variant whose model
  rotation is R times the identity's. The importer derives the block's placement profile
  from its blockstate properties (facing, half, axis, type), so placement stays data.
- **Neighbour-aware shapes** (fences, panes, walls; later stair corners) come from multipart
  conditions evaluated against the neighbouring cells' blocks at mesh time.
- **Rendering.** Quads gain a material id (the unused word 7): a texture layer plus how face
  coordinates map to UVs, so greedy merging still tiles. Textures go into a texture array that
  holds only what the current looks use. Cutout textures (glass, leaves) alpha-test;
  translucent ones draw in a second pass, unsorted at first.
- **Light** takes opacity from the block (glass and leaves let light through) and emission
  from a small table of known light sources, or the look's `glow`.
- **Packages.** `packages/blocks` (no DOM): the library format, variant and profile
  resolution, the default set and its texture generator. `packages/mc-import` (no DOM): zip
  reading (DecompressionStream), a small PNG decoder, and the jar importer, testable in Node.
  Textures are stored as raw RGBA, so nothing encodes PNG.

## Progress

- **Step 1 done (2026-10-06).** Looks come from the project.
  - `packages/session/src/looks.ts`: `stateLooks(states, registry)` resolves every cell state's
    look through palette inheritance: a colour (the look's `tint`, else undecided grey), whether
    it glows, and the light engine's opacity and emission. A cell of parts glows if any part
    does. Until block libraries exist (step 5), every whole block is opaque.
  - The world worker sends the table (`looks`) whenever states appear or the registry's
    revision moves; the renderer's palette texture is filled from it. The app's own
    name-keyed palettes (`palettes.ts`) are gone.
  - Sample builds (`packages/fixtures/src/themes.ts`): `prepareCityProject` brings a city theme
    in as a linked shared palette ("City", key `voxyl.city`), makes the root palette extend it
    and derives the city's semantics into the root, as a person would. The Theme picker
    (Concrete, Brick, Undecided) runs `palette_sync` with a newer version of the same shared
    palette: looks change, semantic ids and cells don't.
- **Step 2 done (2026-10-06).** Saved projects.
  - `packages/session/src/store.ts`: `ProjectStore` over a small `Folder` interface (read,
    write, remove, list), with `MemoryFolder` for tests and `OpfsFolder`
    (`apps/web/src/world/opfs-folder.ts`) in the app. Layout: `projects/<id>/entry.json` (what
    the list shows: name, cells, saved time, bytes), `projects/<id>/manifest.json`, and
    `blobs/<hash>` shared by every project, so a save writes only blobs the folder lacks and
    a delete removes only blobs nothing else uses. The manifest is written after its blobs.
    Importing a bundle whose id is taken stores a copy under a new id.
  - The world worker owns the store and runs commands one at a time, in order, even across
    storage waits. A saved project autosaves 1.5 s after a change (the theme, the debug
    edits) and before another project replaces it.
  - The app: the World picker lists samples and "My projects"; a project row shows the open
    project's name with Save (a sample becomes a saved project, without reloading), Export (a
    `.voxyl` bundle), Delete and Import. `?world=saved:<id>` opens a saved project. The Theme
    picker follows the opened project's looks (`cityThemeOf`) and is disabled for projects
    without the city palette. Saved projects are framed by their exact bounds (by whole
    chunks above 4M cells).
  - Measured in headless Edge (OPFS, world worker, B580 desktop):

    | Build | Stored | First save | Save again (no blob written) | Open |
    | --- | --- | --- | --- | --- |
    | City, 5M cells | 474 KB | 3.4 s | 1.5 s | 1.8 s |
    | Shaped city, 5M cells | 683 KB | 3.2 s | 1.4 s | 1.8 s |

    Saving again still encodes, hashes and deflates every storage chunk; the editor's autosave
    (Phase 3) should encode only chunks edited since the last save, and skip deflating blobs
    the folder already has.
- **Step 3 done (2026-10-06).** The 2D view, beside the 3D one ("2D view" button,
  `?views=split`).
  - `apps/web/src/views/plane.ts`: slices and screen orientation. A plan puts the project's
    real north at the top with east to the right (`settings.north`); cuts across x or z show
    up as up. Tested both ways round for every north.
  - `GridView` draws a slice on a 2D canvas, one pixel per cell into an offscreen image
    scaled up without smoothing, with the layer below showing faintly through empty cells,
    grid lines (major every 16 from the project's grid offset), the 3D camera as a dot, and
    the hovered cell outlined. It asks the world worker for the cells it shows (`slice`: the
    ids of a rectangle and the layer below, up to 1M cells) and colours them from the same
    looks table as the 3D view, so it owns nothing and follows edits and re-skins (it
    refetches when the Engine's revision moves, at most every 120 ms). Pan by dragging, zoom
    about the pointer with the wheel, step layers with `[` `]` or Page Up and Page Down
    (Shift for 4). The toolbar has the slice axis, the layer and what the hovered cell holds
    (`cell`: "Trim", or each part with its shape and slot name, palette named when not the
    root).
  - Parts draw as their first part's colour; drawing their footprints is editor work.
- **Step 4 done (2026-10-06).** Overlapping parts. The web mesher fills one 8³ grid of eighths
  from all of a cell's parts and meshes its faces, so overlapping parts can never z-fight
  (the reason Forge Microblocks and the Godot app trim boxes). What the trim still decides is
  whose colour the shared eighths show. `renderOrder` (`packages/shapes/src/rules.ts`) sorts
  parts into painting order from the mod's rules: strips yield to corners, corners to faces,
  thinner to thicker, lower slot to higher; centered posts yield to faces capping them, and
  between posts the thinner, then the higher slot, yields. A test with a slab and a hollow
  cover (which sorts after the slab in the state) fails without it.
- **Step 5a in progress (2026-10-06).** Textured whole cubes, from the default set.
  - `packages/blocks` (commit d963afd): the library format, variant choice from a cell's
    rotation, face uv maps as affine matrices (uv = A·q + b, q the point in its cell), whole
    cube compilation (`compileBlock`), and the default set: 25 cubes, logs, grass, sandstone,
    quartz, 9 slab and 8 stair families, oak and spruce fences, glass panes, 37 textures
    painted in code from seeded painters.
  - Looks (`packages/session/src/looks.ts`): `stateLooks(states, registry, blocks)` takes a
    `BlockMaterials` (one per open world). A look whose block a library has draws with that
    block: its colour is the block's average colour (also in the 2D view), light follows it
    (transparent blocks let light through, `emits` gives light), and each face of a whole cube
    gets a material: a texture layer, its uv map and a tint. Materials and layers are numbered
    as they first appear and only grow. `StateLooks.faces` holds 8 entries per state (6
    faces), `clear` marks see-through cubes (any face cut out or missing).
  - Mesher: `ShapeTable.clear`. A clear cube hides none of its neighbours' faces, and only
    its own faces against cells of the same state (glass beside glass); parts show beside it.
    The world worker sends `clear` to the mesh workers whenever it changes and remeshes every
    chunk if an existing state flipped (`WorldSession.remeshAll`). Nothing else about looks
    reaches the meshes: a re-skin is still table updates only.
  - Renderer (`apps/web/src/scene/block-textures.ts`, `surfaceColor` in quad-material.ts): a
    face table (state × face → material, float texture, 2 MB), a material table (3 texels a
    material) and a 16×16 texture array (grows by doubling, three generates mipmaps). Per
    vertex the shader picks the material; per fragment it maps the position in the cell to
    texture coordinates and samples with gradients from the unwrapped position, so greedy
    quads repeat the texture once a cell without mip seams at cell edges. Cut-out texels are
    discarded. Microblock parts pick up the texture of their semantic's block for free (their
    quads carry a plain state of it); slopes take the texture of the side they face most.
  - Sample builds: a fourth city theme, **Blocks** (`?theme=blocks`): grass ground, gray
    concrete roads, stone brick walls, glass, quartz trim, spruce roofs, glowstone lights.
  - Seen: `world=city-1m&theme=blocks` in headless Edge on the dev server renders textured,
    no console problems, initial mesh 283 ms, GPU p50 1.5 ms (B580).
  - **Choices to review:** (1) with a block that resolves, the look's `tint` is only the
    fallback colour, not multiplied in; (2) slabs, stairs, fences and panes draw as coloured
    whole cubes until step 6; (3) blended textures are treated as cut-out until a translucent
    pass exists; (4) only 16×16 textures go in the array (others draw in their colour).
  - **Next:** close-up checks (glass from inside and out, logs on their side, stairs/slab
    colours, texture orientation on all six sides, distant mips, microblocks and slopes with
    textures, lit at night with a lamp), a benchmark with textures on (`?theme=blocks
    --bench` on city-5m) against the Concrete theme, then 5b (the vanilla jar importer).
    The close-up script is `web/shots/blocks-close.ts` (gitignored): it raycasts from the
    home view and shoots from 3, 10 and 40 cells.
