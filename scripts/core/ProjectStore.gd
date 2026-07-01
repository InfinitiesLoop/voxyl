class_name ProjectStore
extends RefCounted

# On-disk persistence for projects (the builds themselves). Each VoxelProject is a
# single loose .tres under ROOT/, carrying its voxel data (packed into arrays by
# VoxelData.pack — see there), its palette stack, its saved view layout, and its
# hotbar state. Parallel to LibraryStore/AssetLibrary: libraries + palettes are the
# swappable material layer under res://library/, projects are the builds under
# res://projects/. The two are decoupled — a project only references palettes by name.
#
# Like the library files these are loose .tres (no editor import sidecar) so a
# runtime-saved project loads straight back via ResourceLoader. The encoding is an
# implementation detail of this module; to move to JSON later, change it here.

# res://-relative root for saved projects. A static var (not const) so tests can
# repoint it to a scratch dir, mirroring AssetLibrary.ROOT.
static var ROOT := "res://projects"

# --- Save -------------------------------------------------------------------

# Persist one project. Flattens its voxel data into the packed on-disk mirror first
# (VoxelData keeps a live BlockCell dictionary at runtime), then writes ROOT/<name>.tres.
static func save_project(project: VoxelProject) -> Error:
	var err := _ensure_root()
	if err != OK:
		return err
	if project.data != null:
		project.data.pack()
	# Single choke point for every save path (autosave debounce, go-home, quit, the
	# immediate save on New Project) — so "last edited" is always current on disk.
	project.modified_at = int(Time.get_unix_time_from_system())
	return ResourceSaver.save(project, _path_for(project.name))

# Persist every project in the workspace.
static func save_all(workspace: VoxelWorkspace) -> Error:
	for project in workspace.projects:
		var err := save_project(project)
		if err != OK:
			return err
	return OK

# --- Delete -----------------------------------------------------------------

# Remove a project's on-disk file so it doesn't reload on the next launch. Also drops
# the sidecar thumbnail PNG. Missing file → OK (already gone).
static func delete_project(project_name: String) -> Error:
	_delete_thumbnail(project_name)
	var abs_path := _path_for(project_name)
	if not FileAccess.file_exists(abs_path):
		return OK
	return DirAccess.remove_absolute(abs_path)

# --- Rename -----------------------------------------------------------------

# Rename a project: move its .tres + sidecar thumbnail on disk and update the in-memory
# name. Mirrors LibraryStore.rename_library. Guards empty/unchanged/collision (returns
# false). Nothing references a project by name except its own files, so no repointing.
static func rename_project(workspace: VoxelWorkspace, old_name: String, new_name: String) -> bool:
	var n := new_name.strip_edges()
	if n.is_empty() or n == old_name:
		return false
	if workspace.get_project(n) != null:
		return false   # another project already owns this name
	var project := workspace.get_project(old_name)
	if project == null:
		return false

	var old_path := _path_for(old_name)
	var new_path := _path_for(n)
	project.name = n
	if save_project(project) != OK:
		project.name = old_name   # roll back the in-memory rename on write failure
		return false
	if old_path != new_path and FileAccess.file_exists(old_path):
		DirAccess.remove_absolute(old_path)

	# Move the thumbnail alongside so the card keeps its preview under the new name.
	var old_thumb := thumbnail_path_for(old_name)
	var new_thumb := thumbnail_path_for(n)
	if old_thumb != new_thumb and FileAccess.file_exists(old_thumb):
		DirAccess.rename_absolute(old_thumb, new_thumb)
	return true

# --- Thumbnails -------------------------------------------------------------
# A project's preview is a loose PNG sidecar next to its .tres, baked from the 3D view on
# save (see View3D). It's a pure visual convenience — the voxel data never references it.

static func thumbnail_path_for(project_name: String) -> String:
	return ROOT.path_join(project_name.validate_filename() + ".png")

static func has_thumbnail(project_name: String) -> bool:
	return FileAccess.file_exists(thumbnail_path_for(project_name))

# Write a freshly-rendered thumbnail image for a project. Skips empty images so a blank
# capture never clobbers a good existing preview.
static func save_thumbnail(project_name: String, img: Image) -> Error:
	if img == null or img.is_empty():
		return ERR_INVALID_DATA
	var err := _ensure_root()
	if err != OK:
		return err
	return img.save_png(thumbnail_path_for(project_name))

static func _delete_thumbnail(project_name: String) -> void:
	var thumb := thumbnail_path_for(project_name)
	if FileAccess.file_exists(thumb):
		DirAccess.remove_absolute(thumb)

# --- Load -------------------------------------------------------------------

# True when at least one project file exists on disk (so the caller can decide whether
# to seed the code-built default "first build" or load what the user saved).
static func has_saved_projects() -> bool:
	var dir := DirAccess.open(ROOT)
	if dir == null:
		return false
	for f in dir.get_files():
		if f.ends_with(".tres"):
			return true
	return false

# Load every saved project into `workspace`, replacing any same-named project. Each
# loaded project's voxel data is rehydrated from its packed mirror. Order-insensitive;
# projects are independent.
static func load_persisted(workspace: VoxelWorkspace) -> void:
	var dir := DirAccess.open(ROOT)
	if dir == null:
		return
	for f in dir.get_files():
		if not f.ends_with(".tres"):
			continue
		# CACHE_MODE_IGNORE so a reload returns the file's contents, not a stale instance
		# ResourceLoader may already hold from an earlier save/load.
		var res := ResourceLoader.load(ROOT.path_join(f), "", ResourceLoader.CACHE_MODE_IGNORE)
		var project := res as VoxelProject
		if project == null:
			continue
		if project.data != null:
			project.data.unpack()
		_replace_project(workspace, project)

# --- Internals --------------------------------------------------------------

static func _replace_project(workspace: VoxelWorkspace, project: VoxelProject) -> void:
	for i in workspace.projects.size():
		if workspace.projects[i].name == project.name:
			workspace.projects[i] = project
			return
	workspace.projects.append(project)

static func _ensure_root() -> Error:
	return DirAccess.make_dir_recursive_absolute(ROOT)

static func _path_for(project_name: String) -> String:
	# validate_filename() keeps human names ("My First Build") usable as files while
	# stripping anything the filesystem would choke on.
	return ROOT.path_join(project_name.validate_filename() + ".tres")
