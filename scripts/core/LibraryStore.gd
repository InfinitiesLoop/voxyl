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

# Reserved root child folder holding libraries that have been deleted but not yet unlinked
# from disk (see delete_library / purge_trash). Excluded from list_libraries so a folder
# staged here is never seen as a live library.
const TRASH_DIR := ".trash"

# Consolidated per-library load cache: ROOT/<library>/index.dat. It holds the whole material
# layer as one FileAccess.store_var(full_objects) blob, NOT a .tres/.res of sub-resources —
# because the cost of opening a big library was never file I/O, it was materializing tens of
# thousands of Resource objects through ResourceLoader (UID lookups, cache, import checks). The
# raw variant (de)serializer skips all that: gtnh's ~65k objects load in ~0.8s this way vs ~37s
# via ResourceLoader, whether from 65k loose files or one .res. Bump INDEX_FORMAT to invalidate.
const INDEX_FILE := "index.dat"
const INDEX_FORMAT := 3

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
	# Refresh the load cache from the state we just persisted, so the next launch reads one
	# file instead of every loose .tres. Written here (not deleted for a rebuild-on-load)
	# because we already hold the whole library in memory and every save_library caller is
	# already doing bulk per-file writes — piggybacking one more keeps startup always fast.
	_write_index(library)
	return OK

# Persist every non-builtin palette (they carry library_names + builtin) under
# ROOT/palettes/. Builtin palettes (the code-seeded "Default") are never written: they're
# a code-owned floor, always rebuilt fresh on launch, so a code change to the seed always
# takes effect. Durable customization belongs in a separate named palette layered on top.
static func save_palettes(workspace: VoxelWorkspace) -> Error:
	var err := AssetLibrary.ensure_dir(PALETTES_DIR)
	if err != OK:
		return err
	for palette in workspace.palettes:
		if palette.builtin:
			continue
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

# Remove a library's on-disk folder (ROOT/<name>) so it doesn't resurrect on the next launch
# (load_persisted scans ROOT for folders and reloads whatever it finds — a memory-only
# remove_library left the folder behind, and an empty/partial folder, such as a stray import
# target, reappeared as a ghost library). The built-in `basic` floor is never deleted (it
# re-seeds anyway). Pairs with VoxelWorkspace.remove_library. Missing folder → OK.
#
# A big imported library is tens of thousands of files, and DirAccess has no delete-tree
# primitive — _rm_rf must unlink each one, slow enough to visibly hang the UI. So make delete
# *feel* instant: move the folder aside into the reserved .trash dir (an O(1) same-volume
# rename) and let purge_trash() do the real unlink off the UI thread. list_libraries skips
# .trash, so the library is already gone as far as the app is concerned. If the rename can't
# happen (e.g. a cross-volume ROOT), fall back to the synchronous recursive delete.
static func delete_library(library_name: String) -> Error:
	if library_name == VoxelWorkspace.BASIC_LIBRARY:
		return ERR_UNAUTHORIZED
	var dir := AssetLibrary.path_for(library_name)
	if not DirAccess.dir_exists_absolute(dir):
		return OK
	if AssetLibrary.ensure_dir(TRASH_DIR) == OK:
		var staged := AssetLibrary.path_for(TRASH_DIR).path_join(
			library_name.validate_filename() + "_" + str(Time.get_ticks_usec()))
		if DirAccess.rename_absolute(dir, staged) == OK:
			return OK
	return _rm_rf(dir)

# Reclaim disk from libraries deleted this session (or a prior one whose purge didn't finish):
# unlink everything staged under .trash on a WorkerThreadPool thread, so the slow per-file
# delete never blocks the UI. Fire-and-forget — an interrupted purge is just finished by the
# next call. The trash path is resolved here (main thread) and handed to the worker, so the
# worker never reads the shared AssetLibrary.ROOT (which tests mutate).
static func purge_trash() -> void:
	var trash := AssetLibrary.path_for(TRASH_DIR)
	if not DirAccess.dir_exists_absolute(trash):
		return
	WorkerThreadPool.add_task(_purge_worker.bind(trash))

static func _purge_worker(trash_abs: String) -> void:
	var d := DirAccess.open(trash_abs)
	if d == null:
		return
	for sub in d.get_directories():
		_rm_rf(trash_abs.path_join(sub))

# Remove a palette's on-disk .tres file (ROOT/palettes/<name>.tres), so it doesn't
# resurrect on the next launch — save_palettes() only re-saves whatever is currently in
# workspace.palettes, it never prunes a file whose in-memory palette is gone. Pairs with
# VoxelWorkspace.remove_palette. The built-in Default is never saved in the first place
# (see save_palettes), so this is a no-op for it either way. Missing file → OK.
static func delete_palette(palette_name: String) -> Error:
	var rel := PALETTES_DIR.path_join(palette_name.validate_filename() + ".tres")
	var abs_path := AssetLibrary.path_for(rel)
	if not FileAccess.file_exists(abs_path):
		return OK
	return DirAccess.remove_absolute(abs_path)

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
		if d != PALETTES_DIR and d != TRASH_DIR:
			out.append(d)
	return out

# Read one library folder into a fresh BlockLibrary. `basic` is flagged builtin so it
# stays undeletable after a reload. Prefers the consolidated index.res (one read); on a
# miss/stale/corrupt index, falls back to the loose .tres files and rebuilds the index.
static func load_library(name: String) -> BlockLibrary:
	var lib := _load_from_index(name)
	if lib != null:
		return lib
	lib = BlockLibrary.new()
	lib.name = name
	lib.builtin = name == VoxelWorkspace.BASIC_LIBRARY
	for model in _load_dir(AssetLibrary.in_library(name, AssetLibrary.MODELS_DIR)):
		lib.block_models.append(model)
	for texture in _load_dir(AssetLibrary.in_library(name, AssetLibrary.TEXTURES_DIR)):
		lib.texture_assets.append(texture)
	for block_type in _load_dir(AssetLibrary.in_library(name, AssetLibrary.BLOCK_TYPES_DIR)):
		lib.block_types.append(block_type)
	lib.invalidate_index()
	# Warm the cache for next time (the slow path we just took is exactly what it avoids).
	_write_index(lib)
	return lib

# Absolute path of a library's consolidated index file (ROOT/<name>/index.res).
static func _index_path(library_name: String) -> String:
	return AssetLibrary.path_for(library_name).path_join(INDEX_FILE)

# Build a BlockLibrary from the consolidated index, or null if there's no usable index (so
# the caller falls back to the loose files). Any failure — missing file, unreadable blob,
# older format — returns null rather than raising, keeping the loose .tres the safety net.
static func _load_from_index(name: String) -> BlockLibrary:
	var path := _index_path(name)
	if not FileAccess.file_exists(path):
		return null
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return null
	var data = f.get_var(true)   # allow_objects: reconstruct the BlockType/Model/Texture objects
	f.close()
	if typeof(data) != TYPE_DICTIONARY or data.get("format") != INDEX_FORMAT:
		return null
	var lib := BlockLibrary.new()
	lib.name = name
	lib.builtin = name == VoxelWorkspace.BASIC_LIBRARY
	# Type-check each element: a corrupt blob shouldn't smuggle wrong objects into the library.
	for model in data.get("block_models", []):
		if model is BlockModel:
			lib.block_models.append(model)
	for texture in data.get("texture_assets", []):
		if texture is TextureAsset:
			lib.texture_assets.append(texture)
	for block_type in data.get("block_types", []):
		if block_type is BlockType:
			lib.block_types.append(block_type)
	lib.invalidate_index()
	return lib

# Persist the library's consolidated index as one store_var blob. Best-effort: a failure just
# means the next load takes the slow loose-file path (and tries to write it again). Assumes the
# library folder already exists (save_library / load_library have both ensured or read it).
static func _write_index(library: BlockLibrary) -> void:
	var f := FileAccess.open(_index_path(library.name), FileAccess.WRITE)
	if f == null:
		return
	f.store_var({
		"format": INDEX_FORMAT,
		"name": library.name,
		"block_models": library.block_models,
		"texture_assets": library.texture_assets,
		"block_types": library.block_types,
	}, true)   # full_objects: serialize the resources by value, not by path
	f.close()

# Load every on-disk library + saved palette into `workspace`, over the code-seeded
# defaults. Libraries merge by id/name (disk wins for an edited block; a missing
# baseline block stays seeded — so `basic` is persisted-but-re-seeded and can't be
# emptied). Palettes replace by name, except any flagged builtin (the code-seeded
# Default): those are skipped even if a stale copy exists on disk from before this
# palette was excluded from save_palettes, so Default always matches the running code.
# Projects are not persisted — they stay code-seeded each launch.
static func load_persisted(workspace: VoxelWorkspace) -> void:
	for name in list_libraries():
		var target := workspace.get_or_add_library(name)
		if name == VoxelWorkspace.BASIC_LIBRARY:
			target.builtin = true
		_merge_library(target, load_library(name))
	# Keep the built-in shape models present even if an old on-disk basic lacked them.
	workspace.register_builtin_models()
	for palette in _load_dir(PALETTES_DIR):
		if palette.builtin:
			continue
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
