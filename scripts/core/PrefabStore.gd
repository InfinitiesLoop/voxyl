class_name PrefabStore
extends RefCounted

# On-disk persistence for prefabs: one loose .tres per prefab (its cells packed into arrays by
# VoxelData.pack, like a project) plus a sidecar thumbnail PNG, under the library root's
# reserved prefabs/ folder — beside palettes, since both are workspace-wide rather than part
# of any one build. A --sandbox run moves them (AppSettings.use_sandbox sets `root`).

const DIR := "prefabs"

# Where prefabs live: ROOT/prefabs, unless a sandboxed run moved them.
static var root := ""

static func dir() -> String:
	return root if not root.is_empty() else AssetLibrary.path_for(DIR)

static func path_for(prefab_name: String) -> String:
	return dir().path_join(prefab_name.validate_filename() + ".tres")

static func thumbnail_path_for(prefab_name: String) -> String:
	return dir().path_join(prefab_name.validate_filename() + ".png")

# --- Save / delete / rename -------------------------------------------------------

static func save_prefab(prefab: Prefab) -> Error:
	var err := DirAccess.make_dir_recursive_absolute(dir())
	if err != OK:
		return err
	if prefab.data != null:
		prefab.data.pack()
	return ResourceSaver.save(prefab, path_for(prefab.name))

static func delete_prefab(prefab_name: String) -> void:
	for p in [path_for(prefab_name), thumbnail_path_for(prefab_name)]:
		if FileAccess.file_exists(p):
			DirAccess.remove_absolute(p)

# Move a prefab's files to a new name (the caller has already checked the name is free and
# set prefab.name). The thumbnail follows so the card keeps its preview.
static func move_files(old_name: String, prefab: Prefab) -> Error:
	var err := save_prefab(prefab)
	if err != OK:
		return err
	var old_path := path_for(old_name)
	if old_path != path_for(prefab.name) and FileAccess.file_exists(old_path):
		DirAccess.remove_absolute(old_path)
	var old_thumb := thumbnail_path_for(old_name)
	var new_thumb := thumbnail_path_for(prefab.name)
	if old_thumb != new_thumb and FileAccess.file_exists(old_thumb):
		DirAccess.rename_absolute(old_thumb, new_thumb)
	return OK

# --- Thumbnails ---------------------------------------------------------------------

static func has_thumbnail(prefab_name: String) -> bool:
	return FileAccess.file_exists(thumbnail_path_for(prefab_name))

static func save_thumbnail(prefab_name: String, img: Image) -> Error:
	if img == null or img.is_empty():
		return ERR_INVALID_DATA
	var err := DirAccess.make_dir_recursive_absolute(dir())
	if err != OK:
		return err
	return img.save_png(thumbnail_path_for(prefab_name))

# --- Load ---------------------------------------------------------------------------

# Load every saved prefab into `workspace`, replacing same-named ones.
static func load_persisted(workspace: VoxelWorkspace) -> void:
	var d := DirAccess.open(dir())
	if d == null:
		return
	for f in d.get_files():
		if not f.ends_with(".tres"):
			continue
		var res := ResourceLoader.load(dir().path_join(f), "", ResourceLoader.CACHE_MODE_IGNORE)
		var prefab := res as Prefab
		if prefab == null:
			continue
		if prefab.data == null:
			prefab.data = VoxelData.new()
		prefab.data.unpack()
		var replaced := false
		for i in workspace.prefabs.size():
			if workspace.prefabs[i].name == prefab.name:
				workspace.prefabs[i] = prefab
				replaced = true
				break
		if not replaced:
			workspace.prefabs.append(prefab)
