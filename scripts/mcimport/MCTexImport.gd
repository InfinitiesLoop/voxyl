class_name MCTexImport
extends RefCounted

# Shared texture ingestion for the MC importers. "How a referenced PNG becomes a
# TextureAsset" — copy the pixels into the asset library, scan them for the planning
# average-color + a transparency class, and parse any sibling `.mcmeta` animation —
# lives here in exactly one place, used by both MCImporter (1.8+ JSON models) and
# MCFlatImporter (pre-1.8 flat textures). It only knows the `<ns>/textures/<path>.png`
# (+ `.mcmeta`) convention, the one thing both formats share; all the format-specific
# layout knowledge stays in the two importers.

# EXPERIMENTAL: when on, the verbatim pixel copy is written on a WorkerThreadPool thread
# instead of inline. Off by default so direct-importer callers (the tests) stay fully
# synchronous and can never read a copied file before it exists; ImportService flips it on
# for the duration of a UI import and calls flush_writes() before the files are read (the
# preview prebake reads them). The decode + scan always run on the calling thread.
static var use_threads := false
static var _write_tasks: Array[int] = []   # outstanding write task ids

# Write `bytes` to `path`, returning success. Runs on a worker thread when use_threads is
# on; touches only the (unshared) destination file, so it's safe off the main thread.
static func _write_file(bytes: PackedByteArray, path: String) -> bool:
	var out := FileAccess.open(path, FileAccess.WRITE)
	if out == null:
		return false
	out.store_buffer(bytes)
	out.close()
	return true

# Block until every dispatched texture-copy write has finished. ImportService calls this
# at the end of an import so the copied PNGs are all on disk before the previews bake.
static func flush_writes() -> void:
	for tid in _write_tasks:
		WorkerThreadPool.wait_for_task_completion(tid)
	_write_tasks.clear()

# Split "ns:path" → {ns, path}; a bare ref defaults to the "minecraft" namespace.
static func split_ref(ref: String) -> Dictionary:
	var colon := ref.find(":")
	if colon >= 0:
		return {"ns": ref.substr(0, colon), "path": ref.substr(colon + 1)}
	return {"ns": "minecraft", "path": ref}

# Ensure a TextureAsset exists in `library` for a texture ref, copying its PNG into the
# library's pixel folder and parsing any `.mcmeta` animation. Deduped by id (qualified
# ref). Appends to `warnings` and returns null when the source PNG is missing/unreadable.
static func ensure_texture(library: BlockLibrary, source: MCAssetSource,
		texture_ref: String, warnings: Array) -> TextureAsset:
	var sr := split_ref(texture_ref)
	var id: String = "%s:%s" % [sr["ns"], sr["path"]]
	var existing := library.get_texture_asset(id)
	if existing != null:
		return existing

	var src_rel := "%s/textures/%s.png" % [sr["ns"], sr["path"]]
	# Read the source PNG's raw bytes once: we copy them verbatim to the library (below)
	# AND decode them here for the pixel scan. This avoids the decode→re-encode round trip
	# a save_png() would cost per texture — the single biggest import expense, redundant
	# since the pixels are copied unchanged.
	var bytes := source.read_bytes(src_rel)
	if bytes.is_empty():
		warnings.append("texture image missing: %s" % texture_ref)
		return null
	var img := Image.new()
	if img.load_png_from_buffer(bytes) != OK:
		warnings.append("texture image unreadable: %s" % texture_ref)
		return null

	# Copy pixels under the target library's pixel folder (frame strips kept as-is) by
	# writing the source PNG bytes verbatim — no re-encode. image_path keeps the library
	# segment so AssetLibrary resolves it ROOT-relative.
	var rel := AssetLibrary.in_library(library.name,
		"%s/%s/%s.png" % [AssetLibrary.PIXELS_DIR, sr["ns"], sr["path"]])
	AssetLibrary.ensure_dir(rel.get_base_dir())
	var dest := AssetLibrary.path_for(rel)
	# The write is pure I/O on a fresh, unshared file — offload it to a worker (when
	# enabled) so many texture copies overlap instead of serializing on the main thread.
	# The decode + scan above stay on the main thread (they feed the asset's planning color
	# synchronously). flush_writes() must run before anything reads these files.
	if use_threads:
		_write_tasks.append(WorkerThreadPool.add_task(_write_file.bind(bytes, dest)))
	elif not _write_file(bytes, dest):
		warnings.append("texture copy failed: %s" % texture_ref)
		return null

	var asset := TextureAsset.new()
	asset.id = id
	asset.image_path = rel
	var scan := scan_image(img)
	asset.average_color = scan["average"]
	asset.transparency = scan["transparency"]
	_apply_mcmeta(asset, source, src_rel + ".mcmeta", img)
	library.add_texture_asset(asset)
	return asset

# The neutral pixel scan now lives in TextureIngest (core/), shared with the block
# library's own texture ingest. Kept here as a thin wrapper so the MC importers and
# their tests call the same name; core/ never depends on mcimport/.
static func scan_image(img: Image) -> Dictionary:
	return TextureIngest.scan_image(img)

# Parse an MC `.mcmeta` animation block onto the asset. MC stacks frames vertically
# as square tiles, so frame_count = height / width. frametime is in ticks → seconds
# (÷20; the render shader consumes seconds/frame directly). 1.7.10 uses the same
# `.png.mcmeta` animation format, so this serves both importers unchanged.
static func _apply_mcmeta(asset: TextureAsset, source: MCAssetSource, mcmeta_rel: String, img: Image) -> void:
	var j = _read_json(source, mcmeta_rel)
	if j == null or not j.has("animation"):
		return
	var anim = j["animation"]
	var w := maxi(img.get_width(), 1)
	asset.frame_count = maxi(1, floori(img.get_height() / float(w)))
	asset.frame_time = float(int(anim.get("frametime", 1))) / 20.0
	asset.interpolate = bool(anim.get("interpolate", false))
	if anim.has("frames"):
		var order: Array[int] = []
		for fr in anim["frames"]:
			if fr is Dictionary:
				order.append(int(fr.get("index", 0)))   # per-frame time ignored
			else:
				order.append(int(fr))
		asset.frame_order = order

static func _read_json(source: MCAssetSource, rel: String):
	var text := source.read_text(rel)
	if text.is_empty():
		return null
	return JSON.parse_string(text)
