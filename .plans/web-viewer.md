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

(Steps are recorded here as they land.)
