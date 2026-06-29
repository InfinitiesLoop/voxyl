class_name LibraryStore
extends RefCounted

# On-disk persistence for the named block libraries and palettes. Each BlockLibrary is
# its own folder under the AssetLibrary root —
#   ROOT/<library>/{models,textures,block_types}/*.tres
#   ROOT/<library>/pixels/<ns>/...png        (the images, copied by the importers)
# — so libraries are self-contained, swappable sets that can be added/removed wholesale.
# Palettes (which now carry library_names) persist alongside, under a reserved
# ROOT/palettes/ folder.
#
# The files are loose .tres: plain text, hand-editable, and crucially carrying no Godot
# *import* sidecar, so a runtime-saved .tres loads directly via ResourceLoader (unlike a
# .png/.obj which would need the editor import pipeline). The encoding is an
# implementation detail of this module — to move to JSON later, change it here.

# Reserved root child folder for palettes (so list_libraries can exclude it).
const PALETTES_DIR := "palettes"

# --- Save -------------------------------------------------------------------

# Persist one library: its models, textures, and block types under ROOT/<library>/.
# Existing files for the same id/name are overwritten; stale files are not pruned.
static func save_library(library: BlockLibrary) -> Error:
	var err := _ensure_library_dirs(library.name)
	if err != OK:
		return err
	for model in library.block_models:
		err = _save(model, AssetLibrary.in_library(library.name, AssetLibrary.MODELS_DIR), model.id)
		if err != OK:
			return err
	for texture in library.texture_assets:
		err = _save(texture, AssetLibrary.in_library(library.name, AssetLibrary.TEXTURES_DIR), texture.id)
		if err != OK:
			return err
	for block_type in library.block_types:
		err = _save(block_type, AssetLibrary.in_library(library.name, AssetLibrary.BLOCK_TYPES_DIR), block_type.name)
		if err != OK:
			return err
	return OK

# Persist every palette (they carry library_names + builtin) under ROOT/palettes/.
static func save_palettes(workspace: VoxelWorkspace) -> Error:
	var err := AssetLibrary.ensure_dir(PALETTES_DIR)
	if err != OK:
		return err
	for palette in workspace.palettes:
		err = _save(palette, PALETTES_DIR, palette.name)
		if err != OK:
			return err
	return OK

# Persist the whole workspace material layer: every library + every palette. The
# convenient "save everything" used after edits/imports when the caller doesn't want to
# track exactly which library changed.
static func save_all(workspace: VoxelWorkspace) -> Error:
	for library in workspace.libraries:
		var err := save_library(library)
		if err != OK:
			return err
	return save_palettes(workspace)

# --- Rename -----------------------------------------------------------------

# Rename a library across both memory and disk: move its ROOT/<old> folder to
# ROOT/<new>, repoint every texture's image_path (which embeds the library segment),
# update any palette subscriptions naming it, then re-persist. No-op (returns false)
# for an empty/duplicate/basic name or a missing/builtin library. The library's block
# types/models/textures keep their ids, so palette entries and model refs stay intact;
# only the on-disk pixel paths and folder change.
static func rename_library(workspace: VoxelWorkspace, old_name: String, new_name: String) -> bool:
	new_name = new_name.strip_edges()
	if new_name.is_empty() or new_name == old_name or new_name == VoxelWorkspace.BASIC_LIBRARY:
		return false
	if workspace.get_library(new_name) != null:
		return false
	var lib := workspace.get_library(old_name)
	if lib == null or lib.builtin:
		return false

	var from_dir := AssetLibrary.path_for(old_name)
	var to_dir := AssetLibrary.path_for(new_name)
	if DirAccess.dir_exists_absolute(from_dir):
		var err := DirAccess.rename_absolute(from_dir, to_dir)
		if err != OK:
			return false

	# Repoint pixel paths: "<old>/pixels/..." → "<new>/pixels/...".
	var old_prefix := old_name + "/"
	for texture in lib.texture_assets:
		if texture.image_path.begins_with(old_prefix):
			texture.image_path = new_name + "/" + texture.image_path.substr(old_prefix.length())

	lib.name = new_name
	# Re-point any palette that subscribed to the old name.
	for palette in workspace.palettes:
		for i in palette.library_names.size():
			if palette.library_names[i] == old_name:
				palette.library_names[i] = new_name

	save_library(lib)
	save_palettes(workspace)
	return true

# --- Delete -----------------------------------------------------------------

# Remove a library's on-disk folder (ROOT/<name>) entirely, so it doesn't resurrect on
# the next launch (load_persisted scans ROOT for folders and reloads whatever it finds —
# a memory-only remove_library left the folder behind, and an empty/partial folder, such
# as a stray import target, reappeared as a ghost library). The built-in `basic` floor is
# never deleted (it re-seeds anyway). Pairs with VoxelWorkspace.remove_library. Missing
# folder → OK (already gone).
static func delete_library(library_name: String) -> Error:
	if library_name == VoxelWorkspace.BASIC_LIBRARY:
		return ERR_UNAUTHORIZED
	var dir := AssetLibrary.path_for(library_name)
	if not DirAccess.dir_exists_absolute(dir):
		return OK
	return _rm_rf(dir)

# Recursively delete an absolute directory and everything under it.
static func _rm_rf(abs_path: String) -> Error:
	var d := DirAccess.open(abs_path)
	if d == null:
		return ERR_CANT_OPEN
	d.include_hidden = true
	for sub in d.get_directories():
		var err := _rm_rf(abs_path.path_join(sub))
		if err != OK:
			return err
	for f in d.get_files():
		var err := d.remove(f)
		if err != OK:
			return err
	return DirAccess.remove_absolute(abs_path)

# --- Load -------------------------------------------------------------------

# The library folder names present under ROOT (every child dir except the reserved
# palettes folder).
static func list_libraries() -> PackedStringArray:
	var out := PackedStringArray()
	var dir := DirAccess.open(AssetLibrary.path_for())
	if dir == null:
		return out
	for d in dir.get_directories():
		if d != PALETTES_DIR:
			out.append(d)
	return out

# Read one library folder into a fresh BlockLibrary. `basic` is flagged builtin so it
# stays undeletable after a reload.
static func load_library(name: String) -> BlockLibrary:
	var lib := BlockLibrary.new()
	lib.name = name
	lib.builtin = name == VoxelWorkspace.BASIC_LIBRARY
	for model in _load_dir(AssetLibrary.in_library(name, AssetLibrary.MODELS_DIR)):
		lib.block_models.append(model)
	for texture in _load_dir(AssetLibrary.in_library(name, AssetLibrary.TEXTURES_DIR)):
		lib.texture_assets.append(texture)
	for block_type in _load_dir(AssetLibrary.in_library(name, AssetLibrary.BLOCK_TYPES_DIR)):
		lib.block_types.append(block_type)
	return lib

# Load every on-disk library + saved palette into `workspace`, over the code-seeded
# defaults. Libraries merge by id/name (disk wins for an edited block; a missing
# baseline block stays seeded — so `basic` is persisted-but-re-seeded and can't be
# emptied). Palettes replace by name (the saved Default carries the user's library
# subscriptions). Projects are not persisted — they stay code-seeded each launch.
static func load_persisted(workspace: VoxelWorkspace) -> void:
	for name in list_libraries():
		var target := workspace.get_or_add_library(name)
		if name == VoxelWorkspace.BASIC_LIBRARY:
			target.builtin = true
		_merge_library(target, load_library(name))
	# Keep the built-in shape models present even if an old on-disk basic lacked them.
	workspace.register_builtin_models()
	for palette in _load_dir(PALETTES_DIR):
		_replace_palette(workspace, palette)

# --- Internals --------------------------------------------------------------

# Merge `loaded` into `target` in place: disk entries win (replace same id/name), and
# baseline entries the disk doesn't carry are left untouched.
static func _merge_library(target: BlockLibrary, loaded: BlockLibrary) -> void:
	for model in loaded.block_models:
		target.remove_block_model(model.id)
		target.block_models.append(model)
	for texture in loaded.texture_assets:
		target.remove_texture_asset(texture.id)
		target.texture_assets.append(texture)
	for block_type in loaded.block_types:
		target.remove_block_type(block_type.name)
		target.block_types.append(block_type)
	# The loops above append straight to the arrays, bypassing the add helpers, so the
	# library's name/id indexes are now stale — rebuild on next access.
	target.invalidate_index()

# Replace a palette by name (or append). Bypasses remove_palette's builtin guard so a
# saved Default (carrying the user's edited library subscriptions) overrides the seeded one.
static func _replace_palette(workspace: VoxelWorkspace, palette: Palette) -> void:
	for i in workspace.palettes.size():
		if workspace.palettes[i].name == palette.name:
			workspace.palettes[i] = palette
			return
	workspace.palettes.append(palette)

static func _ensure_library_dirs(library_name: String) -> Error:
	for d in [AssetLibrary.MODELS_DIR, AssetLibrary.TEXTURES_DIR, AssetLibrary.BLOCK_TYPES_DIR]:
		var err := AssetLibrary.ensure_dir(AssetLibrary.in_library(library_name, d))
		if err != OK:
			return err
	return OK

static func _save(resource: Resource, dir: String, base: String) -> Error:
	# validate_filename() keeps human ids/names ("Oak Planks") usable as files while
	# stripping anything the filesystem would choke on.
	var rel := dir.path_join(base.validate_filename() + ".tres")
	return ResourceSaver.save(resource, AssetLibrary.path_for(rel))

static func _load_dir(dir: String) -> Array:
	var out: Array = []
	for file_name in AssetLibrary.list_files(dir):
		if not file_name.ends_with(".tres"):
			continue
		var rel := dir.path_join(file_name)
		# CACHE_MODE_IGNORE so a reload returns the file's contents, not a stale instance
		# ResourceLoader may already hold from an earlier save/load.
		var res := ResourceLoader.load(
			AssetLibrary.path_for(rel), "", ResourceLoader.CACHE_MODE_IGNORE)
		if res != null:
			out.append(res)
	return out
