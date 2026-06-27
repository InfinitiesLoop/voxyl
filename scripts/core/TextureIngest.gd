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

# Bring an arbitrary on-disk PNG into the library as a TextureAsset under `id`.
# Loads the file, copies its pixels to library/pixels/custom/<id>.png, scans the
# planning color + transparency, then creates the asset — or updates the existing one
# with that id in place (so a "Replace…" call re-points the same id at new pixels).
# Returns the asset, or null if the image can't be loaded/saved. Static textures only;
# animation is an importer concern (.mcmeta), not a hand-picked file.
static func ingest_file(workspace: VoxelWorkspace, fs_path: String, id: String) -> TextureAsset:
	var img := Image.new()
	if img.load(fs_path) != OK:
		return null
	var rel := "%s/custom/%s.png" % [AssetLibrary.PIXELS_DIR, id.validate_filename()]
	AssetLibrary.ensure_dir(rel.get_base_dir())
	if img.save_png(AssetLibrary.path_for(rel)) != OK:
		return null
	var scan := scan_image(img)
	var asset := workspace.get_texture_asset(id)
	if asset == null:
		asset = TextureAsset.new()
		asset.id = id
		workspace.add_texture_asset(asset)
	asset.image_path = rel
	asset.average_color = scan["average"]
	asset.transparency = scan["transparency"]
	return asset
