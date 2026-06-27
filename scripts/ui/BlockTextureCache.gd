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

# image_path -> ImageTexture (full decoded image).
static var _tex_cache := {}
# image_path -> ImageTexture cropped to the top (frame-0) square of an animated strip.
static var _frame_cache := {}

# ImageTexture for a library-relative image path, cached. Null for an empty path or
# an unreadable file. AssetLibrary.load_texture reads the loose file off disk.
static func cached_texture(image_path: String) -> ImageTexture:
	if image_path.is_empty():
		return null
	if not _tex_cache.has(image_path):
		_tex_cache[image_path] = AssetLibrary.load_texture(image_path)
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
		var img := AssetLibrary.load_image(asset.image_path)
		if img == null:
			_frame_cache[asset.image_path] = null
		else:
			var w := img.get_width()
			var h := mini(w, img.get_height())
			_frame_cache[asset.image_path] = ImageTexture.create_from_image(img.get_region(Rect2i(0, 0, w, h)))
	return _frame_cache[asset.image_path]
