# Voxyl Web — Storage by Content and Lighting

Status: **First version built and measured** (2026-10-03). Storage by content, the light
engine, lit meshing and the Lighting / Daylight settings work end to end; numbers and next
steps are under "Findings". Part of Phase 0 in [`web-migration.md`](web-migration.md).

Lighting is a setting (`Off` or `Smooth`). With it off, no light is computed or stored and
the mesher behaves exactly as before, so if it doesn't scale it can be switched off rather
than ripped out.

## Storage by content

Chunks stay the unit of meshing and dirty tracking (64³ by default), but memory follows the
blocks, not the volume.

- A chunk is split into bricks of 16³ cells (smaller chunks use one brick). A brick is
  empty (no memory), uniform (one id, no array), or an array of one-byte indices into the
  chunk's own palette of up to 256 cell states. A chunk whose palette overflows switches its
  bricks to two-byte ids.
- Box fills that cover a whole brick set it uniform in O(1).
- The mesher still gets dense snapshots: a chunk writes itself into a padded array per job.

## Light model

Seed of Andromeda's flood fill, which is what Minecraft-style engines converge on:

- **16 bits per cell: sky, red, green, blue, 4 bits each.** Block light is colored from day
  one, since the cost is the same 16 bits and retrofitting color later would touch the
  engine, the mesher and the shader. Light is derived from cells plus the palette and is
  never saved, so changing its layout later needs no migration.
- **Sky light** comes from a per-column heightmap of the highest light-blocking cell. Cells
  above it are 15 without being stored. Light spreads sideways and downward from exposed
  cells, losing one level per step.
- **Block light** spreads from emitters, losing one level per step per channel. Colors shift
  slightly with distance, a known and accepted quirk of per-channel falloff.
- **Edits** use the two-queue method (removal queue, then refill queue), per channel,
  seeded from the changed cells. The Godot `lighting` branch proved this matches a full
  recompute; the same property is the main test here.
- **Materials decide opacity and emission.** For now palette entries carry `emits` (a color
  and level) and `transparent`. Later these come from block types and importer heals, as on
  the Godot branch. A palette swap relights everything, because light is derived data.
- Light storage uses the same bricks: no brick where light equals the default (open sky above
  the heightmap, or darkness), a 16-bit array where it varies.

## Rendering

Per-vertex light baked into the quads, as in Minecraft, Sodium and the 0fps write-up.

- Each quad stores the light of its four corners: sky, red, green and blue at 8 bits, with
  Minecraft-style smooth light (the average of the four cells around the corner in front of
  the face) and ambient occlusion (side, side and corner rule) folded in.
- Greedy merging only joins faces whose four corner values match. Lit exteriors under open
  sky stay merged; gradients split.
- The fragment shader blends the four corners bilinearly rather than relying on the two
  triangles' interpolation, which removes the triangle-split anisotropy without flipping
  quads.
- The final colour is the palette colour times the larger of sky (scaled by daylight) and
  block light, times the fixed face shade, with Minecraft's brightness curve. Daylight is a
  uniform, so day and night cost nothing.
- A light change remeshes the affected chunks (radius 15 for block light, the column below
  for sky light).

Quads grow from 8 to 24 bytes; with lighting off they stay 8.

## Considered, not chosen (yet)

- **A light volume texture sampled in the shader.** This keeps meshes independent of light
  and gives smooth filtering for free, and it is what modern Minecraft shader packs do on the
  GPU. But it costs up to 1 MB of GPU memory per 64³ chunk, and three.js makes a texture per
  chunk awkward. Revisit if remeshing on light changes proves too slow.
- **GPU flood fill or radiance cascades.** These are the frontier for colored GI, but too
  much for Phase 0. The CPU engine's API (`light at cell`, `chunks changed`) leaves room for
  them.
- **Multi-draw indirect and vertex pulling** (Sodium, vertex pooling) to cut draw calls.
  WebGPU's multi-draw is still a Chromium experiment; draw batching covers the same need
  later.

## Measures

Added to the in-app benchmark: initial light time, light memory, edit-to-visible with
lighting on (placing a Glow block is an emitter), and a roof hole that floods sky light into
a building. Run the same worlds with lighting off and on.

## Findings

Measured 2026-10-03 on the 5M-cell city with 64³ chunks: in-app numbers from headless Edge on
an Intel Arc B580; engine numbers from `pnpm bench:light` (one thread).

| Measure | Lighting off | Lighting on |
| --- | --- | --- |
| Flight frame time p50 / p95 | 16.7 / 16.8 ms | 16.7 / 16.8 ms |
| Main thread per frame p50 | 2.7 ms | 2.7 ms |
| Single edit to visible p50 / p95 | 16.6 / 17.6 ms | 33 / 49 ms |
| Roof hole (5x5) open, to visible | 17 ms | 34 ms |
| 100k-cell fill, to visible | 35 ms | 450 ms |
| 1M-cell fill / clear, to visible | 67 / 27 ms | 2.2 / 2.8 s |
| Light the whole world | – | 3.1 s on the main thread (scan 0.2, sky 1.6, block 0.4 s) |
| Quads | 0.68M (16 MB) | 5.04M (116 MB) |
| Light memory | – | 249 MB (901 MB at 20M cells) |
| Cell storage | 34 MB (was 162 MB dense) | same |

- **Storage by content works.** 64³ chunk storage fell from 162 MB to 34 MB at 5M cells and
  from 730 MB to 132 MB at 20M.
- **The light engine is correct.** It matches a brute-force reference on random worlds, and
  incremental updates match a full recompute across random edit sequences.
- **Everyday edits are cheap.** Placing a light or opening a roof relights in 0.3 to 2 ms and
  shows up within two frames. Flying is unaffected.
- **Baked per-vertex light multiplies quads by about 7** on interior-heavy builds. Building
  interiors are lit from windows on every side, so their faces carry two-way gradients and
  cannot merge. Strip merging (0fps) only took 5.38M to 5.03M. The GPU copes (frame time is
  unchanged on the B580), but it costs memory and meshing time (12.5 ms per 64³ chunk lit vs
  about 6 ms unlit).
- **Full relights and bulk edits are slow** and run on the main thread: 3 s to light the city,
  2 to 3 s to relight a 1M-cell fill.

**Next, in order of payoff:**

1. Run full relights off the main thread. This is easiest once the World itself lives in a
   worker, as the architecture plans for agent tool calls anyway.
2. Store light in bricks like cells, so open air and dark interiors cost nothing (249 MB now).
3. Tighten the flood-fill inner loop: neighbours inside the same chunk by index arithmetic
   instead of a chunk lookup per neighbour. Sky light is 1.6 of the 3.1 s.
4. Relight big fills as volumes: clear the box's light directly and seed only its surface.
5. Prototype the light volume texture renderer. It keeps meshes at 0.68M quads, and a light
   change becomes a texture upload instead of a remesh. Compare memory and frame time with
   the per-vertex approach before choosing.

## Sources

- [Fast flood fill lighting in a blocky voxel game (Seed of Andromeda, archived)](https://notverymoe.github.io/md-gamedev-gems/voxel/lighting/soa/index.html)
- [Ambient occlusion for Minecraft-like worlds (0fps)](https://0fps.net/2013/07/03/ambient-occlusion-for-minecraft-like-worlds/)
- [Starlight light engine rewrite](https://github.com/Tuinity/Starlight)
- [Sodium block rendering and vertex format](https://deepwiki.com/CaffeineMC/sodium/3.2-block-and-fluid-rendering)
- [Binary greedy meshing](https://github.com/cgerikj/binary-greedy-meshing)
- [High performance voxel engine: vertex pooling](https://nickmcd.me/2021/04/04/high-performance-voxel-engine/)
- [Vertex pulling (voxel.wiki)](https://voxel.wiki/wiki/vertex-pulling/)
- [WebGPU multi-draw indirect in Chrome](https://developer.chrome.com/blog/new-in-webgpu-131)
- [Rethinking Voxels: voxelized colored lighting in Minecraft shaders](https://minecrafthub.io/shaders/rethinking-voxels)
