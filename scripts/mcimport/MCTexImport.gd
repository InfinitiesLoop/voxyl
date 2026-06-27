class_name MCTexImport
extends RefCounted

# Shared texture ingestion for the MC importers. "How a referenced PNG becomes a
# TextureAsset" — copy the pixels into the asset library, scan them for the planning
# average-color + a transparency class, and parse any sibling `.mcmeta` animation —
# lives here in exactly one place, used by both MCImporter (1.8+ JSON models) and
# MCFlatImporter (pre-1.8 flat textures). It only knows the `<ns>/textures/<path>.png`
# (+ `.mcmeta`) convention, the one thing both formats share; all the format-specific
# layout knowledge stays in the two importers.

# Split "ns:path" → {ns, path}; a bare ref defaults to the "minecraft" namespace.
static func split_ref(ref: String) -> Dictionary:
	var colon := ref.find(":")
	if colon >= 0:
		return {"ns": ref.substr(0, colon), "path": ref.substr(colon + 1)}
	return {"ns": "minecraft", "path": ref}

# Ensure a TextureAsset exists for a texture ref, copying its PNG into the library
# and parsing any `.mcmeta` animation. Deduped by id (qualified ref). Appends to
# `warnings` and returns null when the source PNG is missing/unreadable.
static func ensure_texture(workspace: VoxelWorkspace, source: MCAssetSource,
		texture_ref: String, warnings: Array) -> TextureAsset:
	var sr := split_ref(texture_ref)
	var id: String = "%s:%s" % [sr["ns"], sr["path"]]
	var existing := workspace.get_texture_asset(id)
	if existing != null:
		return existing

	var src_rel := "%s/textures/%s.png" % [sr["ns"], sr["path"]]
	var img := source.read_image(src_rel)
	if img == null:
		warnings.append("texture image missing: %s" % texture_ref)
		return null

	# Copy pixels into the library (frame strips kept as-is). image_path is stored
	# library-relative so AssetLibrary resolves it under whatever ROOT is current.
	var rel := "%s/%s/%s.png" % [AssetLibrary.PIXELS_DIR, sr["ns"], sr["path"]]
	AssetLibrary.ensure_dir(rel.get_base_dir())
	img.save_png(AssetLibrary.path_for(rel))

	var asset := TextureAsset.new()
	asset.id = id
	asset.image_path = rel
	var scan := scan_image(img)
	asset.average_color = scan["average"]
	asset.transparency = scan["transparency"]
	_apply_mcmeta(asset, source, src_rel + ".mcmeta", img)
	workspace.add_texture_asset(asset)
	return asset

# One pass over the pixels for both the planning color and a transparency class.
# average ignores (near-)transparent pixels so a glass/leaf border doesn't wash the
# color toward black. Partial alpha anywhere → TRANSLUCENT; only hard 0/1 alpha with
# some fully-transparent pixels → CUTOUT; otherwise OPAQUE.
static func scan_image(img: Image) -> Dictionary:
	var w := img.get_width()
	var h := img.get_height()
	var r := 0.0; var g := 0.0; var b := 0.0; var n := 0
	var has_transparent := false
	var has_partial := false
	for y in h:
		for x in w:
			var c := img.get_pixel(x, y)
			if c.a < 0.05:
				has_transparent = true
				continue
			if c.a < 0.95:
				has_partial = true
			r += c.r; g += c.g; b += c.b; n += 1
	var average := Color(0.5, 0.5, 0.5)
	if n > 0:
		average = Color(r / n, g / n, b / n)
	var transparency := TextureAsset.Transparency.OPAQUE
	if has_partial:
		transparency = TextureAsset.Transparency.TRANSLUCENT
	elif has_transparent:
		transparency = TextureAsset.Transparency.CUTOUT
	return {"average": average, "transparency": transparency}

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
