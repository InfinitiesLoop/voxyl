class_name TextureIngest
extends RefCounted

# The neutral "point at a PNG → TextureAsset" primitive. Voxel/MC-agnostic and in
# core/, so the block library can ingest a user's own texture without depending on
# the MC importer (mcimport/ depends on core/, never the reverse). MCTexImport.scan_image
# delegates here, so the one pixel-scan implementation is shared.

# One pass over the pixels for the planning average color + a transparency class.
# average ignores (near-)transparent pixels so a glass/leaf border doesn't wash the
# color toward black. Partial alpha anywhere → TRANSLUCENT; only hard 0/1 alpha with
# some fully-transparent pixels → CUTOUT; otherwise OPAQUE.
static func scan_image(img: Image) -> Dictionary:
	# Walk the raw byte buffer rather than get_pixel(x, y): per-pixel Color dispatch is
	# one of the slowest GDScript↔engine calls, and this runs once per imported texture
	# (animated ones are tall multi-frame strips). Convert a copy to RGBA8 so every pixel
	# is a fixed 4-byte stride; the C++ convert is far cheaper than the pixel loop it saves.
	var src := img
	if src.get_format() != Image.FORMAT_RGBA8:
		src = img.duplicate()
		src.convert(Image.FORMAT_RGBA8)
	var data := src.get_data()
	var count := data.size()
	# Byte thresholds equivalent to the old 0.05 / 0.95 alpha cutoffs: 0.05*255 = 12.75
	# (a < 13 ⇔ a ≤ 12) and 0.95*255 = 242.25 (a < 243 ⇔ a ≤ 242).
	var r := 0.0; var g := 0.0; var b := 0.0; var n := 0
	var has_transparent := false
	var has_partial := false
	var i := 0
	while i < count:
		var a := data[i + 3]
		if a < 13:
			has_transparent = true
		else:
			if a < 243:
				has_partial = true
			r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1
		i += 4
	var average := Color(0.5, 0.5, 0.5)
	if n > 0:
		average = Color(r / n / 255.0, g / n / 255.0, b / n / 255.0)
	var transparency := TextureAsset.Transparency.OPAQUE
	if has_partial:
		transparency = TextureAsset.Transparency.TRANSLUCENT
	elif has_transparent:
		transparency = TextureAsset.Transparency.CUTOUT
	return {"average": average, "transparency": transparency}

# Bring an arbitrary on-disk PNG into `library` as a TextureAsset under `id`. Loads the
# file, copies its pixels to <library>/pixels/custom/<id>.png, scans the planning color
# + transparency, then creates the asset — or updates the existing one with that id in
# place (so a "Replace…" call re-points the same id at new pixels). Returns the asset, or
# null if the image can't be loaded/saved. Static textures only; animation is an importer
# concern (.mcmeta), not a hand-picked file.
static func ingest_file(library: BlockLibrary, fs_path: String, id: String) -> TextureAsset:
	var img := Image.new()
	if img.load(fs_path) != OK:
		return null
	var rel := AssetLibrary.in_library(library.name,
		"%s/custom/%s.png" % [AssetLibrary.PIXELS_DIR, id.validate_filename()])
	AssetLibrary.ensure_dir(rel.get_base_dir())
	if img.save_png(AssetLibrary.path_for(rel)) != OK:
		return null
	var scan := scan_image(img)
	var asset := library.get_texture_asset(id)
	if asset == null:
		asset = TextureAsset.new()
		asset.id = id
		library.add_texture_asset(asset)
	asset.image_path = rel
	asset.average_color = scan["average"]
	asset.transparency = scan["transparency"]
	return asset
