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

const RES := 128                          # bake resolution (square); drawn down into the cell
const BATCH := 20                         # blocks baked per frame (one viewport each)
const _CAM_DIR := Vector3(0.9, 0.7, 1.2)  # 3/4 angle: shows top + two sides
# A narrow FOV pulled back reads almost isometric — the block fills the icon with
# minimal perspective distortion, rather than a small head-on cube.
const _CAM_FOV := 30.0
const _CAM_DIST := 3.2
const _CACHE_DIR := "user://icon_cache/"
# Bump when the render setup (camera/lights/RES) changes, to invalidate every disk
# icon — a block's signature embeds this, so stale-look icons can't survive an upgrade.
const _BAKE_VERSION := 1

var _cache := {}        # block_name -> ImageTexture (in-memory)
var _queue: Array = []  # BlockType, FIFO of pending bakes
var _queued := {}       # block_name -> true (queue membership, for dedup)
var _baking := false

# Parallel pool of off-screen viewports + their current mesh instance, so BATCH
# blocks render in the same frame and a single frame_post_draw captures them all.
var _viewports: Array[SubViewport] = []
var _meshes: Array[MeshInstance3D] = []

func _ready() -> void:
	DirAccess.make_dir_recursive_absolute(_CACHE_DIR)
	for i in BATCH:
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

	var world_env := WorldEnvironment.new()
	var env := Environment.new()
	env.background_mode = Environment.BG_CLEAR_COLOR
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color(0.72, 0.74, 0.80)
	env.ambient_light_energy = 1.0
	world_env.environment = env
	vp.add_child(world_env)

	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 45, 0)
	sun.light_energy = 1.3
	vp.add_child(sun)
	var fill := DirectionalLight3D.new()
	fill.rotation_degrees = Vector3(40, -135, 0)
	fill.light_energy = 0.5
	vp.add_child(fill)

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
	var n: int = mini(BATCH, _queue.size())
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
			_cache[bt.name] = ImageTexture.create_from_image(img)
			_save_to_disk(bt, img)
			icon_ready.emit(bt.name)
	_bake_next.call_deferred()

# --- Disk cache -------------------------------------------------------------

# Persist the baked icon, pruning any older-signature file for the same block so the
# cache holds exactly one PNG per block (latest look only).
func _save_to_disk(bt: BlockType, img: Image) -> void:
	var path := _disk_path(bt)
	var keep := path.get_file()
	var prefix := _safe(bt.name) + "__"
	var dir := DirAccess.open(_CACHE_DIR)
	if dir != null:
		for f in dir.get_files():
			if f.begins_with(prefix) and f != keep:
				dir.remove(f)
	img.save_png(path)

func _disk_path(bt: BlockType) -> String:
	return _CACHE_DIR + _safe(bt.name) + "__" + _signature(bt) + ".png"

# A short hash of everything that determines a block's rendered look: its model +
# shape + color + tint, plus each bound texture's id, path and file mtime (so a
# reimport that overwrites the same PNG still invalidates). Bump _BAKE_VERSION to
# invalidate every icon at once. Only computed on a cache miss, never per redraw.
func _signature(bt: BlockType) -> String:
	var parts := PackedStringArray()
	parts.append(str(_BAKE_VERSION))
	parts.append(bt.model_id)
	parts.append(str(bt.shape))
	parts.append(bt.color.to_html(true))
	parts.append(bt.tint.to_html(true))
	var model := BlockRender3D.model_for(bt)
	if model != null and model.has_textures():
		var keys: Array = model.textures.keys()
		keys.sort()
		for k in keys:
			var aid = model.textures[k]
			parts.append(str(k) + "=" + str(aid))
			var asset := VoxelWorld.workspace.get_texture_asset(aid)
			if asset != null and not asset.image_path.is_empty():
				parts.append(asset.image_path)
				parts.append(str(FileAccess.get_modified_time(AssetLibrary.path_for(asset.image_path))))
	return "|".join(parts).sha256_text().substr(0, 16)

func _safe(s: String) -> String:
	var out := ""
	for c in s:
		out += c if (c.is_valid_identifier() or c.is_valid_int() or c == "_" or c == "-") else "_"
	return out
