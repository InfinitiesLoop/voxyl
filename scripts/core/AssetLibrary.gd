class_name AssetLibrary
extends RefCounted

# THE single definition of where imported assets live (decision 3). Every read or
# write of an imported asset resolves its path through path_for(), so swapping the
# storage root — res:// today, possibly user:// or an OS app-support dir later —
# is a one-line change here with no call sites to touch. ROOT is a static var (not
# a const) precisely so that swap, and tests, can repoint it.
#
# Assets are LOOSE files imported at runtime, never run through Godot's editor
# import pipeline (no `.import` sidecars are generated). That means texture pixels
# can't be pulled in with load()/preload() — they're read by hand via
# load_image()/load_texture(), which go straight to the file on disk.

# res://-relative so imported assets sit next to the project install (decision 3).
static var ROOT := "res://library"

# Conventional sub-areas under ROOT (see the layout sketch in import-feature.md):
#   models/        serialized BlockModel resources (geometry + texture bindings)
#   textures/      serialized TextureAsset resources (the pixel metadata)
#   pixels/<ns>/   the raw image files TextureAsset.image_path points at
#   block_types/   serialized BlockType resources
const MODELS_DIR := "models"
const TEXTURES_DIR := "textures"
const PIXELS_DIR := "pixels"
const BLOCK_TYPES_DIR := "block_types"

# Absolute, engine-resolvable path for a ROOT-relative path ("" → the root).
static func path_for(relative := "") -> String:
	return ROOT if relative.is_empty() else ROOT.path_join(relative)

# Named libraries each live in their own folder under ROOT (decision: per-library
# persistence). The library segment is embedded in the ROOT-relative paths callers
# build — e.g. a texture's saved image_path is "<library>/pixels/<ns>/<path>.png" — so
# load_image/load_texture below stay ROOT-relative and unchanged. This helper just
# joins the segment for callers that want the library-relative prefix.
static func in_library(library_name: String, relative := "") -> String:
	return library_name if relative.is_empty() else library_name.path_join(relative)

# Create the directory at a library-relative path (recursively). Safe to re-call.
static func ensure_dir(relative := "") -> Error:
	return DirAccess.make_dir_recursive_absolute(path_for(relative))

static func file_exists(relative: String) -> bool:
	return FileAccess.file_exists(path_for(relative))

# Library-relative file names directly inside a sub-area directory (no recursion).
# Returns just the file names, so callers re-join with the directory themselves.
static func list_files(relative_dir: String) -> PackedStringArray:
	var dir := DirAccess.open(path_for(relative_dir))
	return dir.get_files() if dir != null else PackedStringArray()

# Load raw image pixels from a library-relative path, bypassing the editor import
# pipeline (these files were copied in at runtime, so load() can't see them).
# Image.load() reads the file directly off disk and detects the format by
# extension. Returns null if the file is missing or unreadable.
static func load_image(relative: String) -> Image:
	var abs_path := path_for(relative)
	if not FileAccess.file_exists(abs_path):
		return null
	var img := Image.new()
	if img.load(abs_path) != OK:
		return null
	return img

# Build a GPU texture from a library-relative image path, or null. Filtering /
# transparency are the material's concern, not the texture's, so they're applied
# where the material is built (View3D), not here.
static func load_texture(relative: String) -> ImageTexture:
	var img := load_image(relative)
	return ImageTexture.create_from_image(img) if img != null else null
