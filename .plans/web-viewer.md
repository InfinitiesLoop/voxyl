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
5. **Block libraries and textures.** A library format (blocks, models, textures, average
   colours), GPU texture arrays, and a per-state face table so a look's `block` draws
   textured. Depends on where Phase 2 gets its textures (open question below).
6. **Block models.** Non-cube blocks (slabs, stairs, fences, custom element models) as cached
   per-state geometry, like parts; panes that join their neighbours.
7. **Sky.** A sky with the time of day, replacing the flat background.
8. **The gate.** Performance with textures on; golden images (Playwright with SwiftShader).

## Open questions

- **Where do Phase 2's textures come from?** Minecraft and mod textures can't be hosted, and
  in-browser import is Phase 5. Options: a dev-only converter from the Godot app's
  `library/` (the user's own imports, never served); bringing the vanilla-jar part of Phase 5
  forward; or an original procedural set (the eventual hosted default).

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
