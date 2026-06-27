# Block Library View — JEI grid + 3D preview

The **Block Types** tab (`HomeScreen._build_block_types_tab`) is a JEI-style browser:
a scrollable grid of block icons with a live search box at the bottom, and a left
detail panel that shows a large rotatable 3D preview of the selected block and edits
its color / shape / tint / textures. "New block…" and "Add blocks…" (MC import) feed
the same grid.

Everything here is the **material / palette layer** (`BlockType` + `BlockModel` +
`TextureAsset` in the workspace library). None of it touches voxel data; the grid and
preview are read/write *lenses* on the block-type library. Block-type **rename is out
of scope** — palette entries reference block types by name (`PaletteEntry
.block_type_name`), so renaming would silently break those refs.

## How a block gets rendered (one source of truth)

A block's appearance is resolved + built in exactly one place so every surface matches:

- `scripts/views/BlockMesher.gd` — pure, stateless geometry for a `BlockModel`
  (`color_mesh`, `textured_mesh`). Shared by the 3D scene view and the library preview.
- `scripts/ui/BlockRender3D.gd` — builds a block's real appearance onto a fresh
  `MeshInstance3D`: `BlockMesher` geometry + per-surface textured materials (NEAREST,
  CUTOUT/TRANSLUCENT, optional biome tint), or one flat-color material for the
  planning/"undecided" path. `build_into(mi, bt)` + `model_for(bt)`.
- `scripts/ui/BlockTextureCache.gd` — shared decode cache for loose library PNGs
  (`cached_texture`, `face_texture`); animated strips resolve to a real frame-0
  sub-image. So a PNG decodes once across swatches, preview, and baker.

`View3D` keeps its own appearance path (entangled with its per-semantic material/tint
caches and slice fades) but uses the shared `BlockMesher` geometry.

## Grid icons are baked through the real renderer

Grid icons are **not** hand-drawn — there is no 2D isometric painter (the old
`BlockIconRender.draw_iso` was retired; it only knew flat cube/slab/stairs
silhouettes and smeared textures across faces, so e.g. a flower drew as a box). We
*could* bring back an isometric look later as a real 3D **view mode**, but not as a
faked 2D icon.

- `scripts/ui/BlockIconBaker.gd` (Node, owned by `BlockGrid`) — a **pool of hidden
  `SubViewport`s** (transparent, own World3D, ambient + key/fill rig, near-isometric
  camera framed on the unit cell). `icon_for(bt)` returns a cached `ImageTexture` or
  null + queues a bake. Bakes run **`BATCH` (50) blocks per frame** — each pool viewport
  renders one, all captured after a single `frame_post_draw` — then emit `icon_ready`.
- Two-level cache: **in-memory** (block name → texture) and **on-disk** under
  `user://icon_cache/`, keyed by an appearance *signature* (model + shape + color + tint
  + each bound texture's id/path/**mtime**, plus a `_BAKE_VERSION`). So a warm launch
  loads every unchanged icon from disk instantly and only changed blocks re-bake; the
  signature self-invalidates on edits and reimports (even an overwritten same-path PNG).
- In-memory invalidation: `invalidate(name)` after a single-block edit (driven by
  `HomeScreen._after_block_edit → BlockGrid.refresh_icons(name)`); `invalidate_all()` on
  `VoxelWorld.workspace_changed`. The disk signature decides what actually re-bakes.
- `scripts/ui/BlockGrid.gd` — draws each cell's baked icon (or a faint planning-color
  placeholder while a bake is pending), redraws the one cell on `icon_ready`, sets the
  block name as the cell tooltip, and emits `block_selected(name)` on click.
- `scripts/ui/BlockPreview3D.gd` — the detail panel's rotatable live preview; calls the
  same `BlockRender3D.build_into`, so preview and baked icon are identical.

## Verification

Toolchain on this Windows machine (Godot at `/c/godot.exe`):

```bash
GODOT=/c/godot.exe bash tools/validate-scripts.sh   # GDScript parse/type errors
GODOT=/c/godot.exe bash tests/run_tests.sh          # smoke + shell tests
```

New `class_name` scripts must be in Godot's global class cache before validation sees
them — run `/c/godot.exe --headless --import --path .` once after adding a new one.

Manual (Block Types tab): grid icons match the in-scene render for *every* geometry —
a flower shows its crossed planes, a slab a half box, full cubes the same perspective
as the 3D view; bottom search filters live; editing color/shape/tint/textures updates
the icon + preview and persists across restart; imported MC blocks render correctly in
both grid and preview.
