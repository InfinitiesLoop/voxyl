# Voxyl Web — Storage by Content and Lighting

Status: **Two lighting renderers built and measured** (2026-10-03). Storage by content, the
light engine, Minecraft's lightmap, and both ways of drawing light (baked into quads, or read
from a light volume) work end to end; numbers and next steps are under "Findings". Part of
Phase 0 in [`web-migration.md`](web-migration.md).

Lighting is a setting: `Off`, `Baked in meshes` (`vertex`) or `Light volume` (`volume`).
With it off, no light is computed or stored and the mesher behaves exactly as before, so if
it doesn't scale it can be switched off rather than ripped out.

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
  above it are 15 without being stored (so light passes straight down through glass, as in
  Minecraft). Light spreads sideways and downward from exposed cells, losing one level per
  step.
- **Block light** spreads from emitters, losing one level per step per channel. Colors shift
  with distance: a cyan lamp (red 2, green 12, blue 14) runs out of green before blue, so
  its pool has a blue rim. This is inherent to per-channel falloff; an intensity-plus-colour
  model would keep the hue (see next steps).
- **Edits** use the two-queue method (removal queue, then refill queue), per channel,
  seeded from the changed cells. Tests check that this matches a full recompute.
- **Materials decide opacity and emission.** For now palette entries carry `emits` (a color
  and level) and `transparent`. Later these come from block types and importer heals, as on
  the Godot branch. A palette swap relights everything, because light is derived data.

## Minecraft's look

The shader reproduces Minecraft's lightmap (Java `LightTexture`) and block shading, so light
reads the way it does in a dark Minecraft world:

- Each level goes through `f / (4 - 3f)`; **block light is boosted 1.5x and added to sky
  light**, not maxed, then clamped. Near a lamp the light saturates, and lamps still show in
  shade. (The first version used `max` and no boost, which is why light looked subtle.)
- **Time of day** is Minecraft's sky darkening: noon full, midnight 0.2 with a blue tint
  (`skyColor = mix((d, d, 1), 1, 0.35)`), never black.
- **Brightness** is Minecraft's slider: `mix(c, 1 - (1 - c)^4, brightness)`, with 0 Moody,
  0.5 the default, 1 Bright, plus its 4% pull toward grey.
- **Ambient occlusion** counts a blocking neighbour as 0.2 in a four-sample average (corner
  factors 1, 0.8, 0.6, 0.4) and multiplies the colour, separate from light.
- **Face shade**: top 1, east/west 0.6, north/south 0.8, bottom 0.5.
- Emitting materials draw at full brightness (flagged in the palette texture's alpha).
- Not copied: Minecraft's warm torch tint and flicker. An emitter's colour comes from its
  palette entry instead (principle 3), so a warm palette makes warm light.

Time of day and Brightness are shader values: changing them costs nothing.

## Rendering

Both lit renderers compute identical light. Corner light is the average of the open cells
around the corner in front of the face; corners are blended bilinearly across each cell in
the fragment (no triangle-split artefacts). Screenshots of the two modes differ only in edge
antialiasing.

- **Baked (`vertex`).** Quads carry their four corners' light and occlusion: 28 bytes per
  quad instead of 8. Faces merge only when corners match, so gradients split quads. A light
  change remeshes every chunk it touches.
- **Light volume (`volume`).** Quads stay plain (8 bytes) and merge on cell state alone. Each
  chunk with a mesh gets a slot in a 3D texture holding its padded light, (size + 2)³ cells
  at 16 bits, with light-blocking cells marked 0xffff so occlusion needs no extra memory.
  The fragment shader finds the empty cell in front of its face, reads the 3 x 3 cells around
  it, and does what the mesher does. A light change rewrites the chunk's slot (1.5 ms: a
  1.2 ms copy and a 0.3 ms write) instead of remeshing it. Slots live in pages of about
  16 MB, one material per page; each mesh passes its slot origin through a per-object
  uniform. Pages are written directly through the WebGPU queue, so this mode needs WebGPU.

## Findings

Measured 2026-10-03 on the 5M-cell city with 64³ chunks, headless Edge on an Intel Arc B580
at 1600x900 (frame time is capped by vsync, so GPU cost doesn't show yet).

| Measure | Off | Baked | Light volume |
| --- | --- | --- | --- |
| Quads | 0.68M, 5 MB | 5.04M, 135 MB | 0.68M, 5 MB |
| Light on the GPU | – | in the quads | 178 MB (192 MB after the bulk edits) |
| Light on the CPU | – | 249 MB | 249 MB |
| Light the whole world | – | 2.5 s | 2.6 s |
| Initial mesh | 0.71 s | 1.67 s | 3.0 s |
| Flight frame p50 / p95 | 16.7 / 16.8 ms | 16.7 / 16.8 ms | 16.7 / 16.8 ms |
| Flight main thread p50 | 3.2 ms | 3.5 ms | 4.1 ms |
| Single edit to visible p50 / p95 | 16.5 / 17.4 ms | 33 / 50 ms | 17 / 33 ms |
| Roof hole open | 17 ms | 32 ms | 18 ms |
| 100k-cell fill | 33 ms | 452 ms | 421 ms |
| 1M-cell fill / clear | 63 / 32 ms | 1.9 / 2.8 s | 2.0 / 3.1 s |

- **The light volume does what it promised.** Quads stay at the unlit count (7.4x fewer,
  26x less quad memory than baked), meshing costs what it does unlit, and everyday edits
  show up in one frame instead of two.
- **But dense slots cost GPU memory**: 178 MB, more than the baked quads (135 MB). Most of a
  slot is never read: only cells in front of visible faces matter.
- **Initial upload is slow** (3.0 s): each slot is copied from the light engine on the main
  thread (1.2 ms per chunk) inside the per-frame budget. Moving the engine to a worker turns
  this into a 0.3 ms write.
- **Main thread per frame is about 0.6 ms higher** than baked (300 draws). The likely cause,
  not yet confirmed, is the per-object slot uniform; a chunk table looked up in the shader
  would avoid it.
- **Bulk edits are bound by the light engine**, not by meshing or uploads: the same 2-3 s
  in both lit modes.
- Storage by content: 64³ chunk storage fell from 162 MB to 34 MB at 5M cells and from
  730 MB to 132 MB at 20M.

**Recommendation:** make the light volume the lit renderer and drop baked light once the
volume's memory is fixed. Baked light can't get its quad count back; the volume's costs
are all fixable without changing what it draws.

**Next, in order of payoff:**

1. Run the World and light engine in a worker. Full relights stop freezing the page, and
   slot uploads become a GPU write.
2. Sparse light: store light in bricks (8³ or 16³) on both sides, CPU and GPU, keeping only
   bricks next to visible faces on the GPU, with a brick table instead of per-chunk slots.
   This fixes the GPU memory and replaces the per-object uniform.
3. Tighten the flood-fill inner loop (index arithmetic within a chunk). Sky light is 1.7 of
   the 2.3 s full relight.
4. Relight big fills as volumes: clear the box's light directly and seed only its surface.
5. Maybe: intensity-plus-colour block light, so colored lamps keep their hue as they fade.
6. Measure GPU time (timestamp queries) at 4K, and on the M4.

## Sources

- [Fast flood fill lighting in a blocky voxel game (Seed of Andromeda, archived)](https://notverymoe.github.io/md-gamedev-gems/voxel/lighting/soa/index.html)
- [Ambient occlusion for Minecraft-like worlds (0fps)](https://0fps.net/2013/07/03/ambient-occlusion-for-minecraft-like-worlds/)
- Minecraft Java `LightTexture.updateLightTexture` and `ModelBlockRenderer.AmbientOcclusionFace`
  (decompiled): the lightmap, gamma and ambient occlusion reproduced above.
- [Starlight light engine rewrite](https://github.com/Tuinity/Starlight)
- [Sodium block rendering and vertex format](https://deepwiki.com/CaffeineMC/sodium/3.2-block-and-fluid-rendering)
- [Binary greedy meshing](https://github.com/cgerikj/binary-greedy-meshing)
- [High performance voxel engine: vertex pooling](https://nickmcd.me/2021/04/04/high-performance-voxel-engine/)
- [Vertex pulling (voxel.wiki)](https://voxel.wiki/wiki/vertex-pulling/)
- [WebGPU multi-draw indirect in Chrome](https://developer.chrome.com/blog/new-in-webgpu-131)
- [Rethinking Voxels: voxelized colored lighting in Minecraft shaders](https://minecrafthub.io/shaders/rethinking-voxels)
