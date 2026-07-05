class_name BlockTextureCache
extends RefCounted

# Shared decode cache for library texture PNGs. These assets bypass Godot's import
# pipeline (loose files under the workspace library), so every consumer that wants to
# draw one — the block detail swatches, the 3D block preview, the icon baker — pulls
# it through here and a PNG decodes exactly once.
#
# It's a pure material-layer helper: it loads and crops pixels, owns no block or voxel
# data. (Formerly the texture half of BlockIconRender; the 2D isometric icon painter
# that lived alongside it was retired in favor of real 3D-baked icons.)

# image_path -> ImageTexture (full decoded image). Main-thread only (GPU upload).
static var _tex_cache := {}
# image_path -> ImageTexture cropped to the top (frame-0) square of an animated strip.
static var _frame_cache := {}
# image_path -> Image, decoded but not yet uploaded to the GPU. Written by predecode's worker
# threads and read/emptied by the main-thread upload below, so it is guarded by _img_mutex.
# Transient: each entry is consumed (erased) the moment it's uploaded into a GPU texture — the
# upload copies the pixels, so keeping the raw Image would just double memory per texture.
static var _img_cache := {}
static var _img_mutex := Mutex.new()

# Perf counters (µs) for a throwaway bench: decode = Image.load (PNG→pixels, CPU-bound, now
# parallel — this is the SUM of work across worker threads, so it exceeds wall time); upload =
# ImageTexture.create_from_image (GPU texture creation, main-thread only). Accumulated only on
# a cache miss, so they measure the one-time cold cost.
static var prof_decode_us := 0
static var prof_upload_us := 0

# ImageTexture for a library-relative image path, cached. Null for an empty path or
# an unreadable file. AssetLibrary.load_texture reads the loose file off disk.
static func cached_texture(image_path: String) -> ImageTexture:
	if image_path.is_empty():
		return null
	if not _tex_cache.has(image_path):
		var img := _take_decoded(image_path)   # pre-decoded on a worker, or decoded here
		var t := Time.get_ticks_usec()
		_tex_cache[image_path] = ImageTexture.create_from_image(img) if img != null else null
		prof_upload_us += Time.get_ticks_usec() - t
	return _tex_cache[image_path]

# The drawable texture for a TextureAsset. Static textures return the full cached
# image; animated frame-strips return a real frame-0 ImageTexture cropped to the top
# square. (An AtlasTexture region is NOT honored by a 3D StandardMaterial3D — it would
# sample the whole strip, squished — so we crop a genuine sub-image instead.) Null for
# a missing/unreadable asset.
static func face_texture(asset: TextureAsset) -> Texture2D:
	if asset == null or asset.image_path.is_empty():
		return null
	if not asset.is_animated():
		return cached_texture(asset.image_path)
	if not _frame_cache.has(asset.image_path):
		var img := _take_decoded(asset.image_path)   # pre-decoded on a worker, or decoded here
		if img == null:
			_frame_cache[asset.image_path] = null
		else:
			var w := img.get_width()
			var h := mini(w, img.get_height())
			var t := Time.get_ticks_usec()
			_frame_cache[asset.image_path] = ImageTexture.create_from_image(img.get_region(Rect2i(0, 0, w, h)))
			prof_upload_us += Time.get_ticks_usec() - t
	return _frame_cache[asset.image_path]

# Decode PNGs for the given paths in parallel on WorkerThreadPool, into _img_cache, so the
# build that follows only has to UPLOAD them (create_from_image) on the main thread. Blocks
# until every decode finishes. Skips anything already uploaded (_tex/_frame cache) or already
# decoded (_img_cache). Image.load is the single biggest bake cost, is CPU-bound, and is
# thread-safe (it touches only its own Image + file), so this is the one place worth
# parallelizing. Callers dedupe paths (a Dictionary of keys) so there are no duplicate tasks.
static func predecode(image_paths: Array) -> void:
	var tasks: Array[int] = []
	for p in image_paths:
		if _tex_cache.has(p) or _frame_cache.has(p):
			continue
		_img_mutex.lock()
		var pending: bool = _img_cache.has(p)
		_img_mutex.unlock()
		if not pending:
			tasks.append(WorkerThreadPool.add_task(_decode_worker.bind(p)))
	for t in tasks:
		WorkerThreadPool.wait_for_task_completion(t)

static func _decode_worker(image_path: String) -> void:
	var t := Time.get_ticks_usec()
	var img := AssetLibrary.load_image(image_path)
	var dt := Time.get_ticks_usec() - t
	_img_mutex.lock()
	_img_cache[image_path] = img
	prof_decode_us += dt
	_img_mutex.unlock()

# The decoded Image for a path: a pre-decoded one from _img_cache (consumed — erased — since
# the caller uploads it immediately, and the upload copies the pixels), else decoded right
# here for the lazy/live path that never called predecode.
static func _take_decoded(image_path: String) -> Image:
	_img_mutex.lock()
	if _img_cache.has(image_path):
		var img: Image = _img_cache[image_path]
		_img_cache.erase(image_path)
		_img_mutex.unlock()
		return img
	_img_mutex.unlock()
	var t := Time.get_ticks_usec()
	var decoded := AssetLibrary.load_image(image_path)
	prof_decode_us += Time.get_ticks_usec() - t
	return decoded
