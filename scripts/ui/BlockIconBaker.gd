class_name BlockIconBaker
extends Node

# Renders each library block into a 2D icon texture through the real renderer
# (shared BlockRender3D geometry + materials), so a grid icon matches exactly what
# the block looks like in-scene — a flower bakes as its crossed planes, a slab as a
# half-height box, with the same perspective as the 3D view. This replaces the old
# hand-rolled isometric painter, which only knew flat cube/slab/stairs silhouettes.
#
# Baking is async (a SubViewport needs a frame to render). A pool of viewports bakes
# many blocks per frame, and results are cached two ways:
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
# Blocks baked per frame (one off-screen viewport each, allocated up front). Each frame
# does `batch` renders + GPU readbacks on the main thread — the unavoidable, can't-be-
# threaded cost — so this is THE lever on per-frame time and thus app responsiveness while
# baking. Measured on a large library: batch=50 ran the app at ~16fps (≈60ms/frame, very
# sluggish); batch=8 holds ~60fps (≈17ms/frame, p95 under the 33ms jank line) for only
# ~40% more total wall time. 8 is the sweet spot; raise it to favor throughput over a
# smooth UI (e.g. behind a modal). Small consumers like the hotbar set a lower pool still.
var batch: int = 8
# 3/4 angle from the -X/-Z (WEST+NORTH) side, raised: shows top + two sides, and shows
# the STEPPED face of MC stairs (whose default model opens toward -X/WEST) facing the
# camera instead of its solid back. The higher vantage drops the near top corner toward
# the icon's center. Kept in sync with BlockPreview3D so live preview and icon match.
const _CAM_DIR := Vector3(-0.9, 1.0, -1.2)
# A narrow FOV pulled back reads almost isometric — the block fills the icon with
# minimal perspective distortion, rather than a small head-on cube.
const _CAM_FOV := 30.0
const _CAM_DIST := 3.2
# On-disk icon cache location. A var (not const) so a throwaway consumer — the perf
# bench — can redirect it to a scratch dir and not clobber the shared cache; set it
# before adding the baker to the tree (its _ready creates the dir), like `batch`.
var cache_dir := "user://icon_cache/"
# Bump when the render setup (camera/lights/RES) changes, to invalidate every disk
# icon — a block's signature embeds this, so stale-look icons can't survive an upgrade.
const _BAKE_VERSION := 9   # 9: RES 128 → 64

var _cache := {}        # block_name -> ImageTexture (in-memory)
# Texture path -> file mtime, memoized across a run so a bulk prebake doesn't re-stat the
# same shared texture once per block that binds it. Cleared with the icon cache on
# workspace_changed (the only time a reimport could actually change a file's mtime).
var _mtime_cache := {}
var _queue: Array = []  # BlockType, FIFO of pending bakes
var _queued := {}       # block_name -> true (queue membership, for dedup)
var _baking := false

# Parallel pool of off-screen viewports + their current mesh instance, so BATCH
# blocks render in the same frame and a single frame_post_draw captures them all.
var _viewports: Array[SubViewport] = []
var _meshes: Array[MeshInstance3D] = []

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
	for i in batch:
		_viewports.append(_make_viewport())
		_meshes.append(null)
	# Structural changes (import/reimport, delete, new block) can alter a block's
	# look while keeping its name; drop the in-memory cache and let the disk
	# signature decide what actually needs re-baking.
	VoxelWorld.workspace_changed.connect(invalidate_all)

# One off-screen viewport with its own world, ambient + key/fill rig, and a camera
# framed on the unit cell — mirrors BlockPreview3D so a baked icon matches the live
# preview. Renders only on demand (UPDATE_ONCE per bake), never every frame.
func _make_viewport() -> SubViewport:
	var vp := SubViewport.new()
	vp.size = Vector2i(RES, RES)
	vp.transparent_bg = true
	vp.own_world_3d = true
	vp.render_target_update_mode = SubViewport.UPDATE_DISABLED
	add_child(vp)

	# Shared lighting rig (see BlockLightRig) so a baked icon matches the live preview;
	# its key light is aimed from the camera direction so visible faces stay lit.
	BlockLightRig.apply(vp, _CAM_DIR)

	# Add to the tree BEFORE aiming it: look_at() no-ops on a node that isn't inside
	# the tree, which would leave the camera pointing straight down -Z (block off to
	# the side, head-on). Configure only once it's parented to the viewport.
	var camera := Camera3D.new()
	vp.add_child(camera)
	camera.fov = _CAM_FOV
	camera.position = _CAM_DIR.normalized() * _CAM_DIST
	camera.look_at(Vector3.ZERO, Vector3.UP)
	return vp

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
	var pending := {}   # names actually enqueued this run, for progress accounting
	for bt in block_types:
		if bt == null:
			continue
		# `force` re-bakes every block (the "Regenerate previews" path / perf timing),
		# overwriting both caches; otherwise skip anything already warm in memory or on disk.
		if not force and (_cache.has(bt.name) or FileAccess.file_exists(_disk_path(bt))):
			continue
		pending[bt.name] = true
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

# --- Internals --------------------------------------------------------------

func _enqueue(bt: BlockType) -> void:
	if _queued.has(bt.name):
		return
	_queued[bt.name] = true
	_queue.append(bt)
	if not _baking:
		_baking = true
		_bake_next.call_deferred()

# Bake up to BATCH queued blocks in one frame: assign each to a pool viewport, render
# them all at once, then capture every viewport after a single frame_post_draw. The
# block's live state is read at build time, so rapid edits coalesce to the latest look.
func _bake_next() -> void:
	if _queue.is_empty():
		_baking = false
		return
	var jobs: Array = []  # [BlockType, slot_index]
	var n: int = mini(batch, _queue.size())
	for i in n:
		var bt: BlockType = _queue.pop_front()
		_queued.erase(bt.name)
		# Fresh instance per bake so a previous block's per-surface overrides never
		# linger. Free synchronously (not queue_free): the old node must leave the tree
		# before we render, or it would draw on top of the new one in the capture.
		if _meshes[i] != null:
			_meshes[i].free()
		_meshes[i] = MeshInstance3D.new()
		_viewports[i].add_child(_meshes[i])
		BlockRender3D.build_into(_meshes[i], bt)
		_viewports[i].render_target_update_mode = SubViewport.UPDATE_ONCE
		jobs.append([bt, i])

	await RenderingServer.frame_post_draw

	for job in jobs:
		var bt: BlockType = job[0]
		var img := _viewports[job[1]].get_texture().get_image()
		if img != null and not img.is_empty():
			# Lazy path: keep the icon in memory + tell the cell to repaint now. Bulk path:
			# disk only — skip the GPU upload + retention, just bump the progress counter.
			if not _bulk:
				_cache[bt.name] = ImageTexture.create_from_image(img)
			else:
				_bulk_done += 1
			# create_from_image() (when used) has already copied the pixels it needs, so
			# `img` is now ours alone — hand the encode + write to a worker (see use_threads)
			# instead of blocking the bake loop on save_png. _disk_path/_safe are computed
			# here on the main thread (they read the workspace); the worker only touches the
			# Image + disk.
			if use_threads:
				_save_tasks.append(WorkerThreadPool.add_task(
					_save_image_worker.bind(img, _disk_path(bt), _safe(bt.name) + "__")))
			else:
				_save_to_disk(bt, img)
			if not _bulk:
				icon_ready.emit(bt.name)
	_bake_next.call_deferred()

# --- Disk cache -------------------------------------------------------------

# Persist the baked icon, pruning any older-signature file for the same block so the
# cache holds exactly one PNG per block (latest look only).
func _save_to_disk(bt: BlockType, img: Image) -> void:
	_write_icon(img, _disk_path(bt), _safe(bt.name) + "__")

# The threaded half of _save_to_disk: prune older-signature files for this block, then
# encode + write the PNG. Runs on a WorkerThreadPool thread when use_threads is on, so it
# must touch only the (exclusively-owned) Image + file I/O — never the workspace or the
# RenderingServer. The path + prefix are resolved by the caller on the main thread.
func _save_image_worker(img: Image, path: String, prefix: String) -> void:
	_write_icon(img, path, prefix)

# Shared prune-then-write used by both the sync and threaded paths.
func _write_icon(img: Image, path: String, prefix: String) -> void:
	var keep := path.get_file()
	var dir := DirAccess.open(cache_dir)
	if dir != null:
		for f in dir.get_files():
			if f.begins_with(prefix) and f != keep:
				dir.remove(f)
	img.save_png(path)

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
