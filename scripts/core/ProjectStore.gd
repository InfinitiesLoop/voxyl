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
	return ResourceSaver.save(project, _path_for(project.name))

# Persist every project in the workspace.
static func save_all(workspace: VoxelWorkspace) -> Error:
	for project in workspace.projects:
		var err := save_project(project)
		if err != OK:
			return err
	return OK

# --- Delete -----------------------------------------------------------------

# Remove a project's on-disk file so it doesn't reload on the next launch. Missing
# file → OK (already gone).
static func delete_project(project_name: String) -> Error:
	var abs_path := _path_for(project_name)
	if not FileAccess.file_exists(abs_path):
		return OK
	return DirAccess.remove_absolute(abs_path)

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
