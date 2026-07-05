class_name BlockIconBaker
extends Node

# Renders each library block into a 2D icon texture through the real renderer
# (shared BlockRender3D geometry + materials), so a grid icon matches exactly what
# the block looks like in-scene — a flower bakes as its crossed planes, a slab as a
# half-height box. This replaces the old hand-rolled isometric painter, which only knew
# flat cube/slab/stairs silhouettes.
#
# Baking is async (a SubViewport needs a frame to render). Blocks bake a whole grid at a
# time: an orthographic "atlas" viewport lays out BATCH blocks in a grid, renders them in
# one pass, and a single GPU→CPU readback is sliced back into per-block icons — so the
# readback stall (the dominant, un-threadable cost) is paid once per batch, not per block.
# Results are cached two ways:
#   - in memory (block name -> ImageTexture), cleared on edits/imports;
#   - on disk under user://, keyed by an appearance signature so unchanged blocks load
#     instantly on the next launch and only changed blocks re-bake.
#
# Pure material-layer helper: owns no block or voxel data, just rendered pixels.

# Emitted when a block's icon finishes baking (its grid cell should redraw).
signal icon_ready(block_name: String)

const RES := 64                           # bake resolution (square); drawn down into the cell.
										  # Cells display at ~48–64px, so 64 is 1:1-ish — 128
										  # was ~4× the pixels shown, wasting bake time + VRAM.
# Blocks baked per frame — the whole atlas grid (see _make_atlas). Every block is laid out
# in ONE off-screen viewport and the frame is read back with a SINGLE get_image(), so the
# GPU→CPU stall (formerly the dominant cost, one per block) is now paid once per `batch`.
# Measured on a 1200-block gregtech sample (threaded): total wall time is essentially flat
# across grid sizes (batch 8→2.7s, 16→2.8s, 64→2.2s) — the readback is no longer the
# bottleneck (PNG encode + disk write is), so a bigger grid buys little wall time while
# making each frame heavier (median frame batch 8→7ms, 16→13ms, 32→23ms, 64→54ms). So the
# lever is now SMOOTHNESS, not throughput: keep it small for the interactive lazy path (cells
# bake in at ~60fps while browsing), raise it only behind a modal where frame time doesn't
# matter and a bigger grid's ~20% wall-time edge is worth having. Must be set before the baker
# enters the tree (the atlas is sized from it in _ready). Small consumers (hotbar) set less.
var batch: int = 16
# 3/4 angle from the -X/-Z (WEST+NORTH) side, raised: shows top + two sides, and shows
# the STEPPED face of MC stairs (whose default model opens toward -X/WEST) facing the
# camera instead of its solid back. The higher vantage drops the near top corner toward
# the icon's center. Kept in sync with BlockPreview3D so the live preview and icon agree.
const _CAM_DIR := Vector3(-0.9, 1.0, -1.2)
# The camera is ORTHOGRAPHIC: under a parallel projection, translating a block in the screen
# plane just slides its icon to another grid cell with identical framing and shading
# (directional lights are direction-only, ambient is uniform) — which is exactly what lets a
# whole grid of blocks bake in one render + one readback. _CELL_WORLD is the world-space size
# of one icon cell (the ortho extent mapped to RES px), tuned so a unit cube fills the cell
# with a little margin. _CAM_DIST only pushes the camera back far enough that nothing clips.
const _CELL_WORLD := 1.85
const _CAM_DIST := 6.0
# On-disk icon cache location. A var (not const) so a throwaway consumer — the perf
# bench — can redirect it to a scratch dir and not clobber the shared cache; set it
# before adding the baker to the tree (its _ready creates the dir), like `batch`.
var cache_dir := "user://icon_cache/"
# Bump when the render setup (camera/lights/RES) changes, to invalidate every disk
# icon — a block's signature embeds this, so stale-look icons can't survive an upgrade.
const _BAKE_VERSION := 10   # 10: perspective → orthographic grid-atlas

var _cache := {}        # block_name -> ImageTexture (in-memory)
# Texture path -> file mtime, memoized across a run so a bulk prebake doesn't re-stat the
# same shared texture once per block that binds it. Cleared with the icon cache on
# workspace_changed (the only time a reimport could actually change a file's mtime).
var _mtime_cache := {}
var _queue: Array = []  # BlockType, FIFO of pending bakes
var _queued := {}       # block_name -> true (queue membership, for dedup)
var _baking := false

# One off-screen viewport holding a grid of positioned slots, so BATCH blocks render in the
# same frame and a single frame_post_draw + get_image() captures the whole atlas at once.
# _cols/_rows is the grid derived from `batch`; each slot is a Node3D fixed at its cell's
# world position, holding the current block's mesh instance (replaced per bake).
var _atlas: SubViewport
var _cols := 1
var _rows := 1
var _slots: Array[Node3D] = []
var _slot_mesh: Array[MeshInstance3D] = []

# EXPERIMENTAL: offload each baked icon's PNG encode + disk write to a WorkerThreadPool
# thread. The render + GPU readback can't leave the main thread (they're driven by the
# RenderingServer), but the deflate-heavy save_png on an Image we own exclusively can —
# so the main thread stops stalling on compression between batches. Flip to false to
# compare against the fully-synchronous path.
var use_threads := true
var _save_tasks: Array[int] = []   # outstanding WorkerThreadPool task ids (disk writes)

# Bulk mode (set for the duration of a prebake): warm the DISK cache only. The lazy
# icon_for() path retains each baked icon as an in-memory ImageTexture and emits
# icon_ready so a visible cell repaints immediately — right for a handful of on-screen
# blocks, but for a mass bake (import / regenerate of thousands) it would upload every
# icon to the GPU and pin ~all of them in memory (a full modpack is >1GB of textures),
# which is itself a big source of the sluggishness. In bulk mode we skip create_from_image
# and retention entirely; the caller reloads only the visible cells from disk afterward.
var _bulk := false
var _bulk_done := 0     # blocks finished this prebake run (drives progress without icon_ready)

func _ready() -> void:
	DirAccess.make_dir_recursive_absolute(cache_dir)
	_make_atlas()
	# Structural changes (import/reimport, delete, new block) can alter a block's
	# look while keeping its name; drop the in-memory cache and let the disk
	# signature decide what actually needs re-baking.
	VoxelWorld.workspace_changed.connect(invalidate_all)

# Build the off-screen atlas: one viewport sized to the _cols×_rows grid, an ambient +
# key/fill rig, an orthographic camera aimed down _CAM_DIR, and a Node3D slot fixed at each
# cell's world position. Renders only on demand (UPDATE_ONCE per bake), never every frame.
func _make_atlas() -> void:
	_cols = maxi(1, ceili(sqrt(float(batch))))
	_rows = maxi(1, ceili(float(batch) / float(_cols)))

	_atlas = SubViewport.new()
	_atlas.size = Vector2i(_cols * RES, _rows * RES)
	_atlas.transparent_bg = true
	_atlas.own_world_3d = true
	_atlas.render_target_update_mode = SubViewport.UPDATE_DISABLED
	add_child(_atlas)

	# Shared lighting rig (see BlockLightRig): directional lights depend only on their aim,
	# so one rig lights every cell of the grid identically — no per-cell setup.
	BlockLightRig.apply(_atlas, _CAM_DIR)

	# Add to the tree BEFORE aiming it: look_at() no-ops on a node outside the tree. An
	# orthographic projection sized so one grid cell spans _CELL_WORLD world units → RES px.
	var camera := Camera3D.new()
	_atlas.add_child(camera)
	camera.set_orthogonal(_rows * _CELL_WORLD, 0.05, 100.0)
	camera.position = _CAM_DIR.normalized() * _CAM_DIST
	camera.look_at(Vector3.ZERO, Vector3.UP)

	# The camera's screen-plane axes: translating a slot along these keeps its block framed
	# identically (the whole point of the ortho projection). Cells run left→right, top→bottom
	# to match how the atlas image is sliced back apart in _bake_next.
	var right := camera.transform.basis.x
	var up := camera.transform.basis.y
	for i in batch:
		var col := i % _cols
		var row := i / _cols
		var slot := Node3D.new()
		slot.position = right * ((col + 0.5 - _cols * 0.5) * _CELL_WORLD) \
			+ up * ((_rows * 0.5 - row - 0.5) * _CELL_WORLD)
		_atlas.add_child(slot)
		_slots.append(slot)
		_slot_mesh.append(null)

# The icon for a block: in-memory, then disk (loaded synchronously — instant on a
# warm cache), else null + a queued bake (icon_ready fires when it lands). The cache
# survives populate/filter, so re-searching is free.
func icon_for(bt: BlockType) -> ImageTexture:
	if _cache.has(bt.name):
		return _cache[bt.name]
	var path := _disk_path(bt)
	if FileAccess.file_exists(path):
		var img := Image.new()
		if img.load(path) == OK:
			var tex := ImageTexture.create_from_image(img)
			_cache[bt.name] = tex
			return tex
	_enqueue(bt)
	return null

# Drop one block's in-memory icon (after an edit) so its next request re-resolves; the
# disk signature changes too, so the stale on-disk icon is bypassed and re-baked.
func invalidate(block_name: String) -> void:
	_cache.erase(block_name)

func invalidate_all() -> void:
	_cache.clear()
	_mtime_cache.clear()

# Pre-bake a set of blocks into the disk cache, returning once they're all done (or the
# baker leaves the tree). The import flow calls this so freshly imported blocks are warm
# before the grid is ever shown — the same disk cache every UI baker reads, so this is a
# pure pre-cache, not a replacement for the lazy icon_for() path. Blocks already cached
# on disk are skipped, so a re-import only bakes what actually changed.
func prebake(block_types: Array, on_progress := Callable(), force := false) -> void:
	# One directory listing instead of a file_exists() syscall per block: a full modpack
	# prebake is tens of thousands of blocks, so this is one readdir versus ~20k stat calls.
	# `force` re-bakes everything, so it never consults the snapshot.
	var on_disk := {}
	if not force:
		var dir := DirAccess.open(cache_dir)
		if dir != null:
			for f in dir.get_files():
				on_disk[f] = true
	var pending := {}   # names actually enqueued this run, for progress accounting
	var baked: Array = []  # the BlockTypes enqueued this run, for the end-of-run stale sweep
	for bt in block_types:
		if bt == null:
			continue
		# `force` re-bakes every block (the "Regenerate previews" path / perf timing),
		# overwriting both caches; otherwise skip anything already warm in memory or present
		# on disk (membership-tested against the one-shot snapshot above).
		if not force and (_cache.has(bt.name) or on_disk.has(_disk_path(bt).get_file())):
			continue
		pending[bt.name] = true
		baked.append(bt)
		_enqueue(bt)
	var total := pending.size()
	if total == 0:
		return
	# Warm the disk cache only (see _bulk): no per-icon GPU upload, no retained textures.
	_bulk = true
	_bulk_done = 0
	# Progress is driven by the _bulk_done counter (bumped in _bake_next), not icon_ready,
	# so the bar advances per batch while the await-loop yields a frame between batches.
	var last := -1
	if on_progress.is_valid():
		on_progress.call(0, total)
	while (_baking or not _queue.is_empty()) and is_inside_tree():
		await get_tree().process_frame
		if on_progress.is_valid() and _bulk_done != last:
			last = _bulk_done
			on_progress.call(mini(_bulk_done, total), total)
	_bulk = false
	# The last batch's disk writes may still be in flight on worker threads; block until
	# they land so a caller that awaited prebake() can rely on the PNGs being on disk.
	_drain_save_tasks()
	# Remove any older-signature icons for the blocks just baked in ONE directory pass,
	# instead of _write_icon rescanning the whole (growing) cache dir on every write — O(n²).
	_reconcile_stale(baked)

# --- Internals --------------------------------------------------------------

func _enqueue(bt: BlockType) -> void:
	if _queued.has(bt.name):
		return
	_queued[bt.name] = true
	_queue.append(bt)
	if not _baking:
		_baking = true
		_bake_next.call_deferred()

# Bake up to BATCH queued blocks in one frame: fill that many grid slots, render the whole
# atlas at once, then slice the single readback back into per-block icons. The block's live
# state is read at build time, so rapid edits coalesce to the latest look.
func _bake_next() -> void:
	if _queue.is_empty():
		_baking = false
		return
	var jobs: Array = []  # [BlockType, slot_index]
	var n: int = mini(batch, _queue.size())
	# Pop this batch's blocks and gather every texture they'll need, then decode those PNGs in
	# parallel on worker threads (BlockTextureCache.predecode) BEFORE building — so build_into
	# only uploads ready images instead of decoding serially on the main thread, which was
	# ~all of a cold bake's cost. Then build each block into its slot.
	var picked: Array = []
	var paths := {}
	for i in n:
		var bt: BlockType = _queue.pop_front()
		_queued.erase(bt.name)
		picked.append(bt)
		BlockRender3D.collect_texture_paths(bt, paths)
	BlockTextureCache.predecode(paths.keys())
	for i in picked.size():
		var bt: BlockType = picked[i]
		# Fresh instance per bake so a previous block's per-surface overrides never
		# linger. Free synchronously (not queue_free): the old node must leave the tree
		# before we render, or it would draw on top of the new one in the capture.
		if _slot_mesh[i] != null:
			_slot_mesh[i].free()
		_slot_mesh[i] = MeshInstance3D.new()
		_slots[i].add_child(_slot_mesh[i])
		BlockRender3D.build_into(_slot_mesh[i], bt)
		jobs.append([bt, i])
	_atlas.render_target_update_mode = SubViewport.UPDATE_ONCE

	await RenderingServer.frame_post_draw

	# ONE GPU→CPU readback for the whole grid; each icon is then a cheap CPU-side sub-region.
	var atlas_img := _atlas.get_texture().get_image()
	if atlas_img == null or atlas_img.is_empty():
		_bake_next.call_deferred()
		return
	for job in jobs:
		var bt: BlockType = job[0]
		var slot: int = job[1]
		var img := atlas_img.get_region(Rect2i((slot % _cols) * RES, (slot / _cols) * RES, RES, RES))
		if img.is_empty():
			continue
		# Lazy path: keep the icon in memory + tell the cell to repaint now. Bulk path:
		# disk only — skip the GPU upload + retention, just bump the progress counter.
		if not _bulk:
			_cache[bt.name] = ImageTexture.create_from_image(img)
		else:
			_bulk_done += 1
		# get_region()/create_from_image() have copied the pixels, so `img` is ours alone —
		# hand the encode + write to a worker (see use_threads) instead of blocking the bake
		# loop on save_png. _disk_path/_safe are computed here on the main thread (they read
		# the workspace); the worker only touches the Image + disk.
		# Bulk bakes skip the per-write stale-icon prune (prebake reconciles once at the end);
		# the lazy path prunes inline since it only ever writes a handful of icons.
		var prune := not _bulk
		if use_threads:
			_save_tasks.append(WorkerThreadPool.add_task(
				_save_image_worker.bind(img, _disk_path(bt), _safe(bt.name) + "__", prune)))
		else:
			_save_to_disk(bt, img, prune)
		if not _bulk:
			icon_ready.emit(bt.name)
	_bake_next.call_deferred()

# --- Disk cache -------------------------------------------------------------

# Persist the baked icon, pruning any older-signature file for the same block so the
# cache holds exactly one PNG per block (latest look only).
func _save_to_disk(bt: BlockType, img: Image, prune: bool) -> void:
	var t := Time.get_ticks_usec()
	_write_icon(img, _disk_path(bt), _safe(bt.name) + "__", prune)
	prof_write_us += Time.get_ticks_usec() - t

# The threaded half of _save_to_disk: prune older-signature files for this block, then
# encode + write the PNG. Runs on a WorkerThreadPool thread when use_threads is on, so it
# must touch only the (exclusively-owned) Image + file I/O — never the workspace or the
# RenderingServer. The path + prefix are resolved by the caller on the main thread.
func _save_image_worker(img: Image, path: String, prefix: String, prune: bool) -> void:
	_write_icon(img, path, prefix, prune)

# Shared prune-then-write used by both the sync and threaded paths.
#
# More than one BlockIconBaker can be alive at once (e.g. the editor chrome's persistent
# hotbar plus the Inventory screen's own overlay hotbar — see Hotbar.gd) and both read the
# SAME on-disk cache_dir. A single edit (like subscribing a palette to another library) fires
# workspace_changed, which invalidates every baker at once, so they can end up re-baking and
# writing the exact same disk path in the same frame. Writing straight to `path` via
# save_png() lets two concurrent writers interleave bytes into one file — readable as a
# corrupt/blank (often solid white) image. Writing to a private temp file and renaming into
# place means `path` only ever holds one writer's complete output: POSIX rename() atomically
# replaces, and on Windows a rename onto an existing file simply fails (harmlessly, since
# that file's content is already the same signature) rather than corrupting it.
func _write_icon(img: Image, path: String, prefix: String, prune: bool) -> void:
	# Prune older-signature files for this block. Only the lazy path does this inline (it
	# writes a handful of icons); a bulk prebake passes prune=false and reconciles once at the
	# end (see _reconcile_stale) so a mass bake never rescans the whole growing cache dir per
	# write, which was O(n²).
	if prune:
		var keep := path.get_file()
		var dir := DirAccess.open(cache_dir)
		if dir != null:
			for f in dir.get_files():
				if f.begins_with(prefix) and f != keep and not f.ends_with(".tmp"):
					dir.remove(f)
	var tmp := "%s.%d_%d.tmp" % [path, OS.get_process_id(), Time.get_ticks_usec()]
	if img.save_png(tmp) != OK:
		return
	if DirAccess.rename_absolute(tmp, path) != OK:
		DirAccess.remove_absolute(tmp)

# One-pass removal of older-signature icons for the blocks baked this run — replaces the
# per-write full-dir scan that made a mass bake O(n²). Only files belonging to a baked block
# are touched, so icons from other libraries sharing cache_dir are left alone. Filenames are
# "<safe_name>__<16-hex-sig>.png": the current-signature file is kept (in `expected`), any
# other file sharing a baked block's "<safe_name>__" prefix is a stale older look and removed.
func _reconcile_stale(blocks: Array) -> void:
	var t := Time.get_ticks_usec()
	var prefixes := {}   # "<safe_name>__" -> true, for blocks baked this run
	var expected := {}   # current-signature filename -> true, to keep
	for bt in blocks:
		prefixes[_safe(bt.name) + "__"] = true
		expected[_disk_path(bt).get_file()] = true
	var dir := DirAccess.open(cache_dir)
	if dir != null:
		for f in dir.get_files():
			# 16-char sig + ".png" = 20 trailing chars; anything shorter can't be one of ours.
			if not f.ends_with(".png") or f.length() <= 20 or expected.has(f):
				continue
			if prefixes.has(f.substr(0, f.length() - 20)):
				dir.remove(f)
	prof_reconcile_us += Time.get_ticks_usec() - t

# Block until every dispatched disk-write task has completed, so a caller (prebake) can
# rely on the PNGs being on disk before it returns. Cheap when use_threads is off (no
# tasks are ever queued).
func _drain_save_tasks() -> void:
	for tid in _save_tasks:
		WorkerThreadPool.wait_for_task_completion(tid)
	_save_tasks.clear()

func _disk_path(bt: BlockType) -> String:
	return cache_dir + _safe(bt.name) + "__" + _signature(bt) + ".png"

# A short hash of everything that determines a block's rendered look: its model +
# shape + color + tint, plus each bound texture's id, path and file mtime (so a
# reimport that overwrites the same PNG still invalidates). Bump _BAKE_VERSION to
# invalidate every icon at once. Only computed on a cache miss, never per redraw.
#
# A multipart block's rendered look is its whole preview-state part list (see
# BlockRender3D.preview_parts), not just the always-on post named by bt.model_id, so
# every part's model + textures are folded in — otherwise a texture-only change to a
# non-post part (e.g. a pane's side filler) would never invalidate the cached icon.
func _signature(bt: BlockType) -> String:
	var parts := PackedStringArray()
	parts.append(str(_BAKE_VERSION))
	parts.append(bt.model_id)
	parts.append(str(bt.shape))
	parts.append(bt.color.to_html(true))
	parts.append(bt.tint.to_html(true))
	var sm := bt.state_map
	if sm != null and sm.is_multipart():
		for part in BlockRender3D.preview_parts(sm):
			var model := VoxelWorld.workspace.get_block_model(str(part.get("model_id", "")))
			parts.append_array(_model_signature_parts(model))
	else:
		parts.append_array(_model_signature_parts(BlockRender3D.model_for(bt)))
	return "|".join(parts).sha256_text().substr(0, 16)

func _model_signature_parts(model: BlockModel) -> PackedStringArray:
	var out := PackedStringArray()
	if model == null or not model.has_textures():
		return out
	var keys: Array = model.textures.keys()
	keys.sort()
	for k in keys:
		var aid = model.textures[k]
		out.append(str(k) + "=" + str(aid))
		var asset := VoxelWorld.workspace.get_texture_asset(aid)
		if asset != null and not asset.image_path.is_empty():
			out.append(asset.image_path)
			out.append(str(_mtime_for(AssetLibrary.path_for(asset.image_path))))
	return out

# File mtime, memoized for this baker's lifetime (see _mtime_cache). A bulk prebake asks
# for the same shared texture's mtime once per binding block; without this that's a stat
# syscall each time.
func _mtime_for(path: String) -> int:
	if _mtime_cache.has(path):
		return _mtime_cache[path]
	var t := int(FileAccess.get_modified_time(path))
	_mtime_cache[path] = t
	return t

func _safe(s: String) -> String:
	var out := ""
	for c in s:
		out += c if (c.is_valid_identifier() or c.is_valid_int() or c == "_" or c == "-") else "_"
	return out
