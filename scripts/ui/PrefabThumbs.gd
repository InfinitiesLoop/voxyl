class_name PrefabThumbs
extends RefCounted

# Prefab thumbnails for the UI (the Home Prefabs tab, the inventory's Prefabs page): the baked
# PNG beside each prefab, loaded once per file version and scaled smoothly to the size asked
# for; a prefab without one gets it baked in the background (CaptureService renders it
# through its preferred palettes), and prefabs_changed tells the grids to pick it up.

static var _cache := {}      # "path|px" -> { mtime, tex }
static var _baking := {}     # prefab name -> true while a bake is queued / running

# The thumbnail texture at `px` square, or null (none baked yet — one is queued).
static func texture_for(prefab: Prefab, px := 128) -> Texture2D:
	var path := PrefabStore.thumbnail_path_for(prefab.name)
	if not FileAccess.file_exists(path):
		request_bake(prefab)
		return null
	var mtime := FileAccess.get_modified_time(path)
	if mtime < prefab.modified_at:
		request_bake(prefab)   # edited since: show the old one until the new one lands
	var key := "%s|%d" % [path, px]
	var hit: Dictionary = _cache.get(key, {})
	if hit.get("mtime", -1) == mtime:
		return hit["tex"]
	var img := Image.load_from_file(path)
	if img == null or img.is_empty():
		return null
	if img.get_width() != px:
		img.resize(px, px, Image.INTERPOLATE_LANCZOS)
	var tex := ImageTexture.create_from_image(img)
	_cache[key] = {"mtime": mtime, "tex": tex}
	return tex

# Bake (or re-bake) a prefab's thumbnail in the background, one prefab at a time.
static func request_bake(prefab: Prefab) -> void:
	if prefab == null or _baking.has(prefab.name):
		return
	var cs: CaptureService = McpServer.capture_service()
	if not cs.is_rendering_available():
		return
	_baking[prefab.name] = true
	_bake(cs, prefab)

static func _bake(cs: CaptureService, prefab: Prefab) -> void:
	var ok: bool = await cs.bake_prefab_thumbnail(prefab)
	_baking.erase(prefab.name)
	if ok:
		VoxelWorld.prefabs_changed.emit()
