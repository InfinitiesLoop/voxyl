# Voxyl Web — Storage by Content and Lighting

Status (2026-10-05): **Sparse light, CPU and GPU, done.** The World and light engine run in
a worker; CPU light lives in 8³ bricks (249 MB to 54 MB at 5M cells); GPU light is a sparse
light volume of 4³ bricks (178 MB to 60 MB) read through a chunk grid and brick tables, and
costs about 0.3-0.6 ms of GPU per frame. Baked light is gone. A shader bug that misread light
along every brick boundary was found by the user and fixed (see "Shader bug" below). Next: faster flood fill and volume
relights for big fills, then the M4. Part of Phase 0 in [`web-migration.md`](web-migration.md).

Lighting is a setting, `Off` or `On` (`lighting=off|volume`). With it off, no light is
computed or stored, so if it doesn't scale it can be switched off rather than ripped out.

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
- **All of these multiply in sRGB, as in Minecraft.** Minecraft never linearises: it
  multiplies texture colour by shade, occlusion and lightmap and shows the result. three
  multiplies in linear light, which lifts darks a lot (Minecraft's darkness factor of 0.1
  showed as about 0.35). The shader raises the combined factor to 2.2 before multiplying,
  so the linear product displays as Minecraft's. This made darkness read as dark (the
  user's second complaint: "in MC when it is fully dark you can barely see").
- Emitting materials draw at full brightness (flagged in the palette texture's alpha).
- Not copied: Minecraft's warm torch tint and flicker. An emitter's colour comes from its
  palette entry instead (principle 3), so a warm palette makes warm light.

Time of day and Brightness are shader values: changing them costs nothing.

## Rendering: the sparse light volume

Quads stay plain (8 bytes) and merge on cell state alone. Light is read per fragment: the
shader finds the empty cell in front of its face and the 8 around it in the face's plane,
then per corner averages the light of the open cells around it and applies Minecraft's
occlusion, blending the corners bilinearly across the cell. Light-blocking cells are stored
as OPAQUE_LIGHT (0xffff) in the light itself, so occlusion needs no extra memory.

- **What is kept.** Only 4³ bricks holding a cell some face reads. Mesh workers list them per
  chunk (`ChunkMesh.lightBricks`); the session's `LightLayout` reference-counts them across
  meshes, so a brick lives while any mesh reads it.
- **Where it lives.** A pool of brick slots (64 cells at 16 bits each, a row segment of one
  3D texture), a table per chunk (slot + 1 per brick, 0 = none), and a grid over chunk
  coordinates (table + 1). A cell's light is grid -> table -> pool; a missing brick reads as
  open sky. The 9 cells a fragment reads span at most 2 x 2 bricks, so it does 4 grid/table
  lookups and 9 pool reads.
- **Who decides.** The world worker's `LightLayout` allocates slots and tables and builds the
  grid; it sends updates of up to 4096 bricks, bricks before the tables that point at them,
  so the GPU never points at light that isn't there. The main thread only copies updates into
  three textures (`LightVolume`), growing them a layer at a time with a GPU copy.
- **Dirty tracking.** The light engine reports changed light per 4³ brick (light-blocking
  changes included); only bricks some mesh reads are resent.
- **Showing it.** Meshes draw flat until the worker reports idle after lighting turns on or a
  world loads, then the whole world switches to lit at once.

This was chosen over per-face light (42 MB, slightly smaller) because a volume also lights
sub-cell geometry (shaped parts, Phase 2) and leaves room for volumetric effects; the user
decided on 2026-10-04.

## Findings: dense volume vs baked (2026-10-03, superseded)

Measured on the 5M-cell city with 64³ chunks, headless Edge on an Intel Arc B580 at
1600x900. Baked light and the dense volume have since been replaced by the sparse volume
(see "Sparse light volume (done)" below); kept for the comparison.

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

- **Real Chrome at 4K agrees** (user's run, 3840x1906, B580, volume mode): flight 16.7 /
  16.8 ms p50 / p95 with 3.7 ms main thread, so the 9-texel fragment shader costs nothing
  visible at 4K; single edits 16.5 / 17.7 ms (one frame); roof hole 17 ms; initial mesh
  1.7 s; 100k fill 388 ms; 1M fill / clear 1.9 / 2.5 s; GPU light 192 MB.
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

**Decisions (user, 2026-10-04):** the light volume is the lit renderer, and baked light was
removed once the volume's memory was fixed. Baked light couldn't get its quad count back.
WebGL2 (no WebGPU) now draws unlit.

## World worker (done, 2026-10-04)

The World, the light engine and mesh scheduling moved off the main thread:

- `packages/session` holds `WorldSession`: a World, its light, and which chunks to mesh
  (nearest the camera first, one job per chunk in flight) and whose light to send. It is a
  plain state machine with no DOM, workers or timers, property-tested in Node: after any
  edits, lighting switches and palette changes, the meshes and light it has handed out equal
  a fresh build.
- `apps/web/src/world/world-worker.ts` wraps it: commands in (load, lighting, palette,
  intern, setId, fillBox, raycast, rayEdit), replies out. Mesh workers get jobs from it over
  MessagePorts; it forwards their results and the light to the main thread in one ordered
  stream, tagged with a world id, plus an "idle" marker per command once its work is sent.
- The main thread (`Engine`, `ChunkRenderer`) only draws, takes input and applies that stream
  within a per-frame budget. Mouse edits and the benchmark go through `rayEdit`/`fillBox`, so
  edit-to-visible timings include the round trip.

Measured on the 5M city, headless Edge, B580, volume lighting:

| Measure | Main thread (before) | World worker |
| --- | --- | --- |
| Turning lighting on | page frozen 2.8 s | page keeps drawing (frame p50 16.7 ms); lit in 2.8 s, on screen at 4.9 s; hitches up to 164 ms while light uploads |
| Unlit initial mesh | 0.71 s | 0.54 s |
| Lit initial mesh | 3.0 s | 5.2 s |
| Single edit to visible p50 / p95 | 17 / 33 ms | 17 / 26 ms |
| 1M-cell fill / clear | 2.0 / 3.1 s | 2.7 / 3.5 s |
| Flight main thread p50 | 4.1 ms | 3.9 ms |

The lit initial mesh and bulk fills got slower: every chunk's light now crosses to the main
thread as a fresh 575 KB buffer (186 MB of garbage for the city), the worker yields between
light batches through a clamped timer, and each of the seven light pages compiles its own
material on first use (the hitches). Sparse light replaces exactly that traffic.

## Sparse light: measurements

`pnpm bench:sparse` on the 5M city (64³ chunks, 8.9M visible faces):

| Layout | Memory |
| --- | --- |
| CPU light today (dense per chunk) | 239 MB |
| **CPU light in 8³ bricks, only where it differs from the default** | **38 MB** (16³: 65 MB) |
| GPU dense padded slots (today) | 177 MB |
| GPU bricks holding a face's front cell, one-cell apron (4³ / 8³ / 16³) | 143 / 131 / 150 MB |
| GPU bricks as above, and only where light differs from a heightmap default | 88 MB (8³) |
| **GPU per-face light**: each quad carries its (w + 2) x (h + 2) light grid | **42 MB** |

- **CPU bricks are a clear win** under any GPU choice. The default is open sky above each
  column's highest light-blocking cell and darkness below; no brick in the city was uniform
  but non-default, so uniform bricks need no special case.
- **GPU bricks barely pay.** A face reads the 3 x 3 cells around its front cell, so a brick
  needs a one-cell apron, which nearly doubles an 8³ brick and eats most of the saving.
- **Per-face light is 4x smaller than today and scales with surface area, not volume.** Each
  quad would carry an offset into one storage buffer holding the light (with opaque marks) of
  the front-cell plane around it; the fragment reads its 9 values directly, with no table
  lookups. A light change rewrites the affected chunks' grids (computed from the chunk's
  quads and padded light, in a worker), never remeshes. The cost: light exists only on voxel
  faces. A volume can also light things that are not voxel faces (entities, particles, fog,
  sub-cell parts at arbitrary positions), which per-face light cannot without a second
  mechanism.

A follow-up measurement settled it: **4³ bricks without an apron**, holding every cell a face
reads (front cell and its 3 x 3 neighbours) with opacity marks inline, need 43 MB plus 7 MB
of tables (8³: 68 MB; 16³: 108 MB). That is a volume at nearly per-face cost.

## Sparse light volume (done, 2026-10-04)

CPU: the light engine stores 8³ bricks only where a cell differs from its default. GPU: the
4³ brick volume described under "Rendering". Baked light (`vertex` mode, 28-byte lit quads,
light in mesh jobs, the mesher's lit path) is removed.

Tests: the mesher's light-brick lists are checked against brute force; the light engine's
dirty bricks are checked to cover every 4³ brick whose light or opacity marks an edit
changed; and the session test applies every layout update to a simulated GPU and checks that
every cell a face reads looks up (grid -> table -> pool) to exactly a fresh build's light,
with no table entry left pointing at a brick nothing reads, across random edits, lighting
switches and palette changes. A deliberate bug (light sent without opacity marks) fails it.

Measured on the 5M city, headless Edge, B580 (light memory also at 20M):

| Measure | Dense volume, main thread | Sparse volume, world worker |
| --- | --- | --- |
| Light on the GPU | 178 MB | **60 MB** (350K bricks, 48 MB pool) |
| Light on the CPU | 249 MB (901 MB at 20M) | **54 MB** (198 MB at 20M) |
| GPU time per frame p50 / p95 | not measured | 1.3 / 2.6 ms after the shader fix (1.0 / 2.0 ms unlit) |
| Lit initial mesh | 3.0 s | 3.6 s (light fills in, then shows at once) |
| Single edit to visible p50 / p95 | 17 / 33 ms | 17.5 / 18.6 ms |
| Roof hole open | 18 ms | 17 ms |
| 100k-cell fill / clear | 421 / 416 ms | 475 / 457 ms |
| 1M-cell fill / clear | 2.0 / 3.1 s | 2.6 / 3.4 s |
| Rendering matches dense | – | 1 of 55K sampled pixels differs, by 3/255 (but see "Shader bug") |

- GPU time comes from timestamp queries (now in the HUD and the benchmark's flight). The
  shader's 4 lookups and 9 pool reads cost about 0.3-0.6 ms at 1600x900; at 4K expect
  ~2.5 ms. The first figures came from the buggy shader, which skipped lookups; with the
  fix, flight GPU time is 1.3 / 2.6 ms p50 / p95, the same within noise.
- Headless frame times this session paced at 17.6 ms for every mode, lighting off included:
  that is the machine's display pacing, not rendering. Compare GPU time instead.
- Bulk fills are still bound by the light engine (steps 1 and 2 below).

### Shader bug (found and fixed 2026-10-05)

The user saw a bright blob in the middle of every cell at night, with dark seams every 4
cells. Each of the 9 light samples was right on its own (checked by drawing one at a time);
combined, the corners read some neighbours as "no brick" (open sky, no block light) wherever
a neighbour sat in a different 4³ brick from the front cell.

Cause: three's TSL assigns a `.toVar()` lazily, at its first use, when it is built outside a
`Fn`, and compiles `select()` to `if`/`else`. The four brick-slot variables were first used
inside the branch that picks the front cell's brick, so only one was assigned; neighbours on
other paths read the others as 0. Building the light inside `Fn(() => ...)()` assigns every
variable where it is created, before any branch. **Any TSL that shares `.toVar()` values
between `select()` branches must be built inside a `Fn`.**

Why tests and the dense comparison missed it: the session test checks the layout on the
CPU, not the shader; the pixel comparison was by daylight, where a missing brick (sky 15, no
block light) looks almost the same as the real light. Block-lit scenes at night show it. A
check worth adding: compare the lit render at midnight with a lamp against a CPU reference.

## Next steps

1. **Faster flood fill.** Within a chunk, step to neighbours by index arithmetic instead of a
   chunk lookup per neighbour, and cache the current brick. Sky light is 1.7 of the 2.3 s
   full relight; the brick storage added about 15% to bulk fills.
2. **Relight big fills as volumes.** Clear the box's light directly and seed only its
   surface; 1M-cell fills take 2.6-3.4 s, nearly all of it in the light engine.
3. **Measure on the M4** (the Phase 0 reference laptop) and in Chrome at 4K, GPU time
   included.
4. Compact light bricks: CPU bricks are never freed until the next full relight, and GPU
   slots are reused but the pool never shrinks. Fine for now; revisit if long sessions grow.
5. Maybe: intensity-plus-colour block light, so coloured lamps keep their hue as they fade
   (a cyan lamp's pool has a blue rim today).

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
