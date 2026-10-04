# Voxyl — Project Guidelines for Claude

## The Core Principles

These are the load-bearing ideas behind voxyl. Every significant decision should be evaluated against them.

### 1. Data stores intent, not materials
Voxel data maps positions to **semantic block type IDs** (e.g. "base", "accent", "trim"). It never stores colors, textures, or concrete material names. The palette is a separate, swappable layer that maps those IDs to visuals. This is the heart of the project — never compromise it.

### 2. Views are lenses, not owners
There is one source of truth: `VoxelWorld`. Views (2D grid, 3D, etc.) are read/write lenses on that data. A view should never be the canonical home for any piece of data. If a feature is being added to a view that would make sense in all views, it belongs in the data layer or `VoxelWorld`, not the view.

### 3. Palette and data are always decoupled
You must always be able to change the entire palette without touching a single voxel. If a proposed feature would make the voxel data depend on visual properties, it's wrong.

### 4. Voxel-agnostic, Minecraft-inspired
The tool is inspired by Minecraft builds but must not be coupled to Minecraft. Default block type names, UI language, and features should work equally well for any voxel-based creative project. Minecraft-specific features (e.g. importing schematics) are acceptable as optional extensions, not core assumptions.

### 5. Build before you decide
The user should be able to build an entire scene without ever choosing a specific material. The tool must always support an "undecided" state gracefully.

---

## Development Workflow

**Godot version:** 4.7 — binary at `/Applications/Godot.app/Contents/MacOS/Godot` (macOS) or `C:\godot.exe` (Windows). Scripts in `tools/` and `tests/` auto-detect whichever is present; override with the `GODOT_EXECUTABLE` env var (`tools/validate-scripts.sh`) or `GODOT` env var (`tests/run_tests.sh`) if it lives elsewhere.

**Before committing any code change, always run both:**
```bash
bash tools/validate-scripts.sh   # validates all GDScript, shows errors/warnings with file+line
bash tests/run_tests.sh          # functional smoke tests against the real autoload
```

**Project structure:**
```
scripts/core/       — data model (VoxelData, VoxelProject, VoxelWorkspace, VoxelWorld autoload)
scripts/views/      — view implementations (View2DGrid, future 3D view, etc.)
scripts/ui/         — UI components (HomeScreen, PalettePanel, LibraryList, Main, SettingsDialog)
scripts/automation/ — the in-app MCP server (McpServer autoload), its tools (tools/), CaptureService
scenes/             — Godot scene files
tests/              — SmokeTest, ShellTest, McpTest (+ run_tests.sh)
tools/              — validate-scripts.sh
```

**Key architectural patterns:**
- `VoxelWorld` is the autoload singleton — all views and UI talk to it, never to each other
- Adding a new view: extend a Control, connect to `VoxelWorld.project_opened`, `block_changed`, `palette_stack_changed` signals, read from `VoxelWorld.active_project`
- All palette mutations go through `VoxelWorld` methods (add/remove/move_palette_in_stack) so signals fire correctly
- UI is built programmatically in GDScript — minimize `.tscn` complexity

---

## Web version (`web/`)

Voxyl is being ported to a TypeScript web app in gated phases; the plan, phase status and
decisions live in `.plans/web-migration.md` (lighting in `.plans/web-lighting.md`). All web
code stays inside the top-level `web/` folder (a pnpm workspace with its own `README.md`). The
principles above apply unchanged.

**Keep the plans current as work lands**, in the same commit: what is done, what is proven
(with numbers), decisions the user made, and the next steps. Anyone should be able to pick
the work up from the plans alone.

- Needs Node 24+ and pnpm. From `web/`: `pnpm install`, `pnpm dev`.
- **Before committing a web change, run `pnpm check`** (Biome lint, `tsc` typecheck per package,
  Vitest) from `web/`. The Godot validate/test scripts are only needed when GDScript changes.
- `packages/core`, `mesher`, `light` and `session` must stay free of DOM and Node APIs; their
  tsconfigs enforce this. The World and light engine run in a worker (`apps/web/src/world/`),
  never on the main thread.
- Check UI changes against the dev server, not just the build: `pnpm shot "<query>"` drives the
  user's running `pnpm dev` headless and reports console problems, the HUD and a screenshot.
- `web/.gdignore` stops Godot scanning `node_modules`; never remove it.

---

## Claude's Role

Challenge direction when it risks compromising the principles above. This isn't about second-guessing every task — routine work (bug fixes, commits, refactors) doesn't need interrogation. But when a proposed feature, shortcut, or architectural decision would undermine the separation of concerns, the view-agnostic model, or the voxel-agnostic identity of the project, push back before implementing.

The question to ask: *does this change make the project more coupled, more Minecraft-specific, or harder to add new views to?* If yes, say so.
