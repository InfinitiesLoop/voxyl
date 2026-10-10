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
packages/shapes/    shaped parts: microblock boxes and architecture (roof) shapes in 24 orientations
packages/mesher/    chunk mesher: greedy cube faces, shaped parts as merged quads and triangles;
                    also lists the light bricks its faces read (runs in workers)
packages/light/     Minecraft-style sky and colored block light, incremental on edits
packages/session/   WorldSession: a World, its light, mesh scheduling and the GPU light layout
packages/relay/     the relay's pure half: MCP over HTTP, call routing, tab protocol, tokens (no DOM, no Node)
packages/tools/     agent tools: a Zod registry over a ToolHost (status, place, fill, ...); see .plans/web-tools.md
packages/fixtures/  seeded test worlds (the benchmark city, plain or decorated with shaped parts)
apps/relay/         the relay as a Cloudflare Worker + Durable Object (api.voxyl.xyz)
apps/server/        the headless host (pnpm host): MCP over HTTP on one in-memory project
apps/web/           the React + Three.js app (Vite), with the in-app benchmark; src/agent/ offers
                    the agent tools to the browser (WebMCP) and the Dev panel
tools/              dev tools (shot, golden, relay-smoke, relay-e2e)
golden/             golden images for `pnpm golden`
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
pnpm shot "world=city-5m&lighting=volume" --bench
```

This is how changes get checked against exactly what `pnpm dev` serves, React's development
double mount included.

`--eval file.js` runs a script in the page once the world has meshed (the file is the body of an
async function; what it returns is printed). That is how the agent tools are driven:
`return await window.voxylTools.call("status", {})`. The Dev panel's **Tools** section does the
same by hand, and `apps/web/src/agent/webmcp.ts` offers the tools to browsers that have WebMCP.

**The relay** (`apps/relay`, `packages/relay`) is how an agent off the page reaches the open
editor: a Cloudflare Worker and one Durable Object per agent token. The agent speaks MCP over
HTTP to `/mcp`; the tab holds a WebSocket to `/tab`; the object forwards each call to the tab,
which runs it. Production is `https://api.voxyl.xyz`. `.plans/web-tools.md` ("The relay") has
the design and the deploy steps. Locally:

```
pnpm relay          # wrangler dev on http://127.0.0.1:47826 (workerd; needs apps/relay/.dev.vars)
pnpm dev            # the app; its dev build talks to that relay
```

Then in the app: Home, Agents, **Let agents use this editor**, and paste the command it shows
into Claude Code. `pnpm relay:smoke [--url ...]` checks a relay with a fake tab (it works
against production too). `node tools/relay-e2e.ts [--app ... --relay ...]` drives a real
headless tab and plays the agent. (47823 is the Godot app, 47825 the headless host.)

`pnpm host` listens on `http://127.0.0.1:47825/mcp` and runs the tools itself, on one in-memory
project, with no tab attached (`apps/server`). Edits live until the process exits and are not
shown in a browser. Claude Code, under its own name:
`claude mcp add --scope user --transport http voxyl-headless http://127.0.0.1:47825/mcp`.
`capture` and `export_schematic` answer `unavailable` here; they need an editor.

`pnpm golden` renders a fixed set of scenes (`tools/golden.ts`) on SwiftShader, Chrome's CPU
WebGPU, and compares each with its image in `golden/`, so rendering changes show up whatever
the GPU. Differences go to `shots/golden/` with a red diff; `pnpm golden --update` accepts the
new renders, `pnpm golden sky` runs only matching scenes. A full run takes about 3 minutes.

## Benchmarks

- `pnpm bench:mesh [cells ...] [--bits=5,6,7] [--parts]`: meshing and storage cost on one CPU
  thread; `--parts` decorates the city with shaped parts.
- `pnpm bench:sparse [cells]`: how much light memory sparse layouts would need (CPU bricks,
  GPU bricks, per-face light) on the city.
- `pnpm bench:light [cells ...]`: full relight, light memory, the light bricks faces read and
  their copy cost, and incremental relights for single edits, a roof hole and big fills.
- In the app, pick a world and lighting (also in the URL, e.g.
  `?world=city-5m&lighting=volume&time=0`; `world=parts-5m` is
  the same city decorated with shaped parts) and press **Run
  benchmark**: a scripted flight (frame, main-thread and GPU time), 100 single-cell edits, a
  roof hole and 100k/1M box fills, measured to the frame they appear. The result can be
  copied as JSON and is also on `window.__voxylBench`. GPU time comes from timestamp
  queries; headless frame times follow the machine's display pacing, so compare GPU time.

Lighting (`lighting=` in the URL) is `off` or `volume`: Minecraft-style light the shader reads
per fragment from a sparse light volume (bricks of light only where faces read it), so a light
change rewrites a few bricks and never remeshes. It needs WebGPU; WebGL2 draws unlit. Time of
day (`time`, in hours: 0 midnight, 12 noon) and Brightness (`brightness`, Minecraft's slider:
0 Moody, 50 default, 100 Bright) are shader values and cost nothing to change.

## ChatGPT widget probe

`pnpm probe` runs a small MCP server on port 8787 whose widget tests the ChatGPT sandbox
(WebSocket, streamed fetch, WebGPU, workers, storage, timers) and relays tool calls into the open
widget. Everything it reports is appended to `shots/widget-probe.jsonl`. To use it from
ChatGPT, expose it with `cloudflared tunnel --protocol http2 --url http://localhost:8787`, add
`<tunnel url>/mcp` at chatgpt.com/plugins (+, Create custom MCP server, no auth), then in a
chat type `@`, pick it and ask it to open the Voxyl probe. `/probe/widget.html` serves the
widget outside ChatGPT for local checks. Results are in the plan ("ChatGPT widget live probe").

## Rules of the road

- `core`, `shapes`, `mesher`, `light`, `session` and `tools` compile with no DOM or Node types, so anything that
  touches `document`, `window` or `process` fails their typecheck. Keep it that way: the same
  code runs in the tab, in workers and on the server.
- Cells store semantics, never materials. Palettes (colours, transparency, emission) live
  outside `World`, and light is derived from both, never saved.
- React draws UI chrome only. The world is rendered by Three.js from chunk data, never as React
  components.
- `web/.gdignore` keeps Godot from scanning this folder, `node_modules` included. Don't remove
  it.
