# Voxyl web

The TypeScript web version of Voxyl, built in phases alongside the Godot app. The plan, phases
and gates are in [`../.plans/web-migration.md`](../.plans/web-migration.md).

## Setup

Needs Node 24+ and pnpm (`npm install -g pnpm`).

```bash
cd web
pnpm install
pnpm dev        # app at http://localhost:5173
pnpm check      # lint + typecheck + tests; run before every commit
```

Other scripts: `pnpm test:watch`, `pnpm format` (Biome, fixes formatting and import order),
`pnpm build`.

## Layout

```
packages/core/   world, chunks, cell states: no DOM, no Node, runs anywhere
apps/web/        the React + Three.js app (Vite)
```

Later phases add `formats`, `tools`, `raster`, `mesher`, `render`, `mc-import` and
`apps/server`, as listed in the plan.

## Rules of the road

- `core` compiles with no DOM or Node types, so anything that touches `document`, `window` or
  `process` fails its typecheck. Keep it that way: the same core runs in the tab, in workers
  and on the server.
- Cells store semantics, never materials. Palettes live outside `World`.
- React draws UI chrome only. The world is rendered by Three.js from chunk data, never as React
  components.
- `web/.gdignore` keeps Godot from scanning this folder, `node_modules` included. Don't remove
  it.
