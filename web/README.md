# Voxyl web

The TypeScript web version of Voxyl, built in phases alongside the Godot app. The plan, phases
and gates are in [`../.plans/web-migration.md`](../.plans/web-migration.md); lighting has its own
plan in [`../.plans/web-lighting.md`](../.plans/web-lighting.md).

## Setup

Needs Node 24+ and pnpm (`npm install -g pnpm`).

```bash
cd web
pnpm install
pnpm dev        # app at http://localhost:5173, reloads itself as files change
pnpm check      # lint + typecheck + tests; run before every commit
```

To stop the dev server, press `q` then Enter (Vite's own quit). Ctrl+C also works; on Windows
pnpm then prints an `ELIFECYCLE` error because the server was interrupted, which is harmless.
`r` then Enter restarts the server in place, and `h` then Enter lists the other shortcuts.

Other scripts: `pnpm test:watch`, `pnpm format` (Biome, fixes formatting and import order),
`pnpm build`.

## Layout

```
packages/core/      world, chunks (stored by content), cell states, raycast: no DOM, no Node
packages/mesher/    greedy chunk mesher with smooth light and ambient occlusion (runs in workers)
packages/light/     Minecraft-style sky and colored block light, incremental on edits
packages/session/   WorldSession: a World, its light and the mesh/light scheduling, headless
packages/fixtures/  seeded test worlds (the benchmark city)
apps/web/           the React + Three.js app (Vite), with the in-app benchmark
tools/              dev tools (shot)
```

Threads: the page runs a **world worker** (`apps/web/src/world/`) that owns the World, the
light engine and a `WorldSession`, and several **mesh workers** it feeds over MessagePorts.
The main thread only draws, takes input and sends commands (`Engine.world.request(...)`); it
applies the meshes and light the world worker sends in arrival order. Generating and lighting
a world never block drawing.

Later phases add `formats`, `tools`, `raster`, `render`, `mc-import` and `apps/server`, as
listed in the plan.

## Checking the running app

`pnpm shot` opens the app headless in the installed Edge or Chrome, against the dev server by
default, waits for the world to mesh, and prints console problems, the HUD and the canvas
count, plus a screenshot in `shots/`. Add a query and `--bench` to run the benchmark too:

```bash
pnpm shot "world=city-5m&chunk=64&lighting=volume" --bench
```

This is how changes get checked against exactly what `pnpm dev` serves, React's development
double mount included.

## Benchmarks

- `pnpm bench:mesh [cells ...] [--bits=5,6,7]`: meshing and storage cost on one CPU thread.
- `pnpm bench:sparse [cells]`: how much light memory sparse layouts would need (CPU bricks,
  GPU bricks, per-face light) on the city.
- `pnpm bench:light [cells ...]`: full relight, light memory, lit quad counts, the light
  volume copy per chunk, and incremental relights for single edits, a roof hole and big fills.
- In the app, pick a world, chunk size and lighting (also in the URL, e.g.
  `?world=city-5m&chunk=64&lighting=volume&daylight=0&brightness=50`) and press **Run
  benchmark**: a scripted flight, 100 single-cell edits, a roof hole and 100k/1M box fills,
  measured to the frame they appear. The result can be copied as JSON and is also on
  `window.__voxylBench`.

Lighting (`lighting=` in the URL) is `off`, `vertex` (light baked into the quads, so a light
change remeshes) or `volume` (plain quads; the shader reads light from a 3D texture per chunk,
so a light change rewrites the texture). Both lit modes compute the same Minecraft-style light;
`volume` needs WebGPU. Time of day (`daylight`, 0 midnight to 100 noon) and Brightness
(`brightness`, Minecraft's slider: 0 Moody, 50 default, 100 Bright) are shader values and cost
nothing to change.

## Rules of the road

- `core`, `mesher` and `light` compile with no DOM or Node types, so anything that touches
  `document`, `window` or `process` fails their typecheck. Keep it that way: the same code runs
  in the tab, in workers and on the server.
- Cells store semantics, never materials. Palettes (colours, transparency, emission) live
  outside `World`, and light is derived from both, never saved.
- React draws UI chrome only. The world is rendered by Three.js from chunk data, never as React
  components.
- `web/.gdignore` keeps Godot from scanning this folder, `node_modules` included. Don't remove
  it.
