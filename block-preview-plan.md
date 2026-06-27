# Block Library View — JEI-style grid, 3D preview, edit & add-from-texture

## Context

The Block Types tab (in `scripts/ui/HomeScreen.gd`, `_build_block_types_tab`) is
currently a plain `LibraryList` of names on the left and a color picker on the
right. We want to turn it into a JEI-style browser:

- A large, scrollable **vertical grid of block icons** as the main area.
- A **live search box at the bottom** of the grid (JEI placement).
- Clicking a block **highlights it** and shows a **detail panel** with a large,
  **real 3D rotatable preview** of the rendered block.
- The detail panel can **edit** the selected block (color, shape, tint, textures)
  and there is a **"New block…" flow that points at texture PNGs** to create a
  brand-new textured block.

**Architectural note (stays within the principles):** everything here is the
*material / palette layer* — `BlockType` + `BlockModel` + `TextureAsset` in the
workspace library. None of it touches voxel data, and palette↔data decoupling is
preserved. The grid and preview are read/write *lenses* on the block-type library,
not owners of any data. Block-type **rename is intentionally out of scope** for
this pass because palette entries reference block types by name
(`PaletteEntry.block_type_name`) and renaming would silently break those refs.

## Approach

### 1. Shared geometry: `scripts/views/BlockMesher.gd` (new, RefCounted, static)

Extract the pure mesh-building helpers currently private to `View3D` so the new 3D
preview and the existing 3D view share one source of truth for block geometry
(consistent with "views are lenses; geometry is shared, not owned"):

- `const DIR_NORMALS` (moved from `View3D._DIR_NORMALS`)
- `static func color_mesh(model: BlockModel) -> Mesh` (from `_mesh_for_model`, minus the instance cache)
- `static func textured_mesh(model: BlockModel) -> Dictionary` → `{mesh, keys, tinted}` (from `_textured_mesh_for_model`)
- `static func add_face(...)`, `static func face_corners(...)` (verbatim moves)

Then refactor `scripts/views/View3D.gd` to call `BlockMesher.*`, keeping its own
per-id caches (`_model_meshes`, `_textured_model_meshes`) wrapped around the shared
builders. Material building, tints, and slice fade stay in `View3D` (entangled with
its semantic caches) — only geometry moves. This keeps View3D byte-for-byte in
output; smoke/shell tests must stay green.

### 2. 2D isometric icon renderer: `scripts/ui/BlockIconRender.gd` (new, static)

Lightweight draw routine for the hundreds of grid cells (no 3D per cell):

- `static func resolve_faces(bt, workspace) -> {up_tex, side_tex, color}` — find the
  block's model (explicit `model_id` in `workspace.block_models`, else built-in for
  `bt.shape`); read `model.elements[0].faces` to map UP / a side dir's `texture_key`
  → `model.textures[key]` → `workspace.get_texture_asset(id)` → image via the cache
  below. Falls back to `bt.color` when there are no textures (the "undecided" path).
- `static func draw_iso(ci: CanvasItem, size: Vector2, faces, shape)` — draws top +
  two side parallelograms with `draw_colored_polygon(points, color, uvs, texture)`
  (NEAREST filtering for pixel art), with top/left/right shading multipliers like the
  current `_draw_block_preview`. Slab/stairs adjust the silhouette heights.
- A **static `ImageTexture` cache** keyed by `image_path` (reuses
  `AssetLibrary.load_texture`) so the grid and the 3D preview never reload a PNG.

### 3. JEI grid widget: `scripts/ui/BlockGrid.gd` (new, VBoxContainer)

- `ScrollContainer` → `HFlowContainer` (or `GridContainer`) of fixed-size icon cells,
  expanding to fill; **`LineEdit` search box pinned at the bottom**.
- `populate(block_types: Array)`; `_apply_filter(text)` does a case-insensitive
  substring match on the block name and rebuilds visible cells.
- Each cell is a custom `Control` (or flat `Button`) that draws its icon via
  `BlockIconRender.draw_iso`, shows the name as `tooltip_text`, draws a **selection
  border** when selected, and on click emits `block_selected(name)`.
- Signals: `block_selected(name)`. Tracks `selected` and redraws borders on change.

### 4. 3D rotatable preview: `scripts/ui/BlockPreview3D.gd` (new, Control)

- `SubViewportContainer` (stretch) → `SubViewport` (`transparent_bg = true`) with a
  `WorldEnvironment` (ambient light so it isn't black), a key + fill
  `DirectionalLight3D` (mirroring `View3D._setup_viewport`), a `Camera3D` framed on
  the unit cube centered at origin, and a pivot `Node3D` holding one `MeshInstance3D`.
- `set_block(bt: BlockType)`: resolve model + textures + color directly from the
  block type (not via project/palette — library blocks aren't in a project). Build
  geometry with `BlockMesher`; assign either a color `StandardMaterial3D` or
  per-surface textured materials (small local builders mirroring
  `View3D._static_texture_material`, NEAREST filter + CUTOUT/TRANSLUCENT handling).
  Animated assets (`TextureAsset.is_animated()`) render **frame 0** via an
  `AtlasTexture` cropped to the top square (full animation is a later nicety).
- `_process`: slow auto-rotate of the pivot; **drag-to-spin** with the mouse
  (pause auto-rotate while dragging). Optional scroll-to-zoom.

### 5. Neutral texture ingest: `scripts/core/TextureIngest.gd` (new, static)

The "point at a PNG → TextureAsset" primitive, kept **voxel/MC-agnostic** in `core/`:

- `static func scan_image(img) -> {average, transparency}` — the neutral pixel scan
  (moved out of `MCTexImport`). `MCTexImport.scan_image` becomes a thin wrapper that
  delegates here, so the MC importer and its tests are unaffected and `core/` never
  depends on `mcimport/`.
- `static func ingest_file(workspace, fs_path, id) -> TextureAsset` — `Image.load`
  from an arbitrary path, save pixels under `library/pixels/custom/<id>.png` via
  `AssetLibrary`, scan average color + transparency, create + `add_texture_asset` a
  `TextureAsset` (dedup by id), return it.

### 6. Rewrite the Block Types tab + edit/add flows in `scripts/ui/HomeScreen.gd`

- Replace `_build_block_types_tab`: left = detail/edit panel (`BlockPreview3D` + the
  editable fields below), right/main = `BlockGrid`. Remove the old `LibraryList`
  usage **here only** (it stays for the Palettes tab). `_refresh` populates the grid
  from `VoxelWorld.workspace.block_types`.
- **Detail/edit panel** for the selected block:
  - Large `BlockPreview3D`.
  - Name shown as a read-only label (rename deferred — see Context).
  - Color `ColorPickerButton` (keep existing behavior) → `bt.color`.
  - Shape `OptionButton` (FULL / SLAB / STAIRS) → `bt.shape`.
  - Tint `ColorPickerButton` → `bt.tint`.
  - Texture bindings: show the model's current texture keys as swatches each with a
    **"Replace…"** `FileDialog` → `TextureIngest.ingest_file` → rebind
    `model.textures[key]`. If the block has no model yet, a **"Set texture…"** action
    creates a full-cube `BlockModel`, binds it, and sets `bt.model_id`.
  - After any edit: `VoxelWorld.notify_block_type_changed()`, refresh the preview +
    that grid icon, and `LibraryStore.save_all(VoxelWorld.workspace)` to persist.
- **New-block flow:** a "New block…" button opens a dialog (new
  `scripts/ui/NewBlockDialog.gd`, or built inline) with: name (required), an "all
  faces" texture `FileDialog` (optional), and optional Top / Bottom overrides. On
  confirm:
  - Texture(s) → `TextureIngest.ingest_file` (ids derived from the block name).
  - Build a full-cube `BlockModel` (`BlockModel.box_element` per face → bound keys);
    `workspace.add_block_model`.
  - `workspace.add_block_type(name)` with `model_id = model.id`, `color =` the all
    texture's `average_color` (or default gray when no texture — the "build before
    you decide" path stays first-class), `add_block_type`.
  - `LibraryStore.save_all`, `VoxelWorld.workspace_changed.emit()`.
  - Keep a quick name-only add too (texture optional in the same dialog).
- Keep `_on_delete_block_type` (delete from grid); persist after delete.

## Critical files

- New: `scripts/views/BlockMesher.gd`, `scripts/ui/BlockIconRender.gd`,
  `scripts/ui/BlockGrid.gd`, `scripts/ui/BlockPreview3D.gd`,
  `scripts/core/TextureIngest.gd`, `scripts/ui/NewBlockDialog.gd`.
- Modified: `scripts/ui/HomeScreen.gd` (Block Types tab rewrite + flows),
  `scripts/views/View3D.gd` (delegate geometry to `BlockMesher`),
  `scripts/mcimport/MCTexImport.gd` (`scan_image` delegates to `TextureIngest`).
- Reused: `AssetLibrary` (pixel IO + paths), `LibraryStore.save_all` (persistence,
  already the import path's saver), `VoxelWorkspace` add/get/remove for
  block_types/models/texture_assets, `VoxelWorld.notify_block_type_changed` /
  `workspace_changed`, `BlockModel.box_element` / built-ins.

## Verification

Toolchain on this Windows machine (Godot at `/c/godot.exe`):

```bash
GODOT=/c/godot.exe bash tools/validate-scripts.sh   # GDScript parse/type errors
GODOT=/c/godot.exe bash tests/run_tests.sh          # Smoke + Shell smoke tests
```

Both must pass — the `View3D`→`BlockMesher` refactor is the main regression risk,
so confirm the 3D view still renders the default build unchanged.

Manual (launch the app, open the **Block Types** tab):
1. Grid shows all block types as isometric icons; bottom search filters live.
2. Click a block → it highlights and the left panel shows a spinning 3D preview;
   drag rotates it.
3. Edit color / shape / tint → preview and grid icon update; reopen the app and the
   change persisted.
4. "New block…" → name it, point it at a PNG → it appears in the grid with that
   texture, the 3D preview shows it, and it survives a restart.
5. Imported MC blocks (via the existing "Add blocks…" path) still render correctly in
   both the grid and the 3D preview (shared `BlockMesher` + texture cache).
```
