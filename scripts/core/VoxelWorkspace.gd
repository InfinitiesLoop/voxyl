class_name VoxelWorkspace
extends Resource

# The workspace holds the named block libraries (the material layer, split into
# swappable sets — see BlockLibrary), the palettes (semantic→block-type maps that each
# subscribe to an ordered stack of libraries), and the projects. Block types / models /
# textures no longer live in flat arrays here; they belong to a BlockLibrary, addressed
# by name through the catalog API below.

# The code-seeded built-in library: generic + a few naturals, the always-present
# "undecided"/planning floor (Principle 5). Undeletable and re-seeded on launch.
const BASIC_LIBRARY := "basic"

@export var libraries: Array[BlockLibrary] = []
@export var palettes: Array[Palette] = []
@export var projects: Array[VoxelProject] = []

# --- Library catalog --------------------------------------------------------

func get_library(library_name: String) -> BlockLibrary:
	for lib in libraries:
		if lib.name == library_name:
			return lib
	return null

# Get the named library, creating an empty one if it doesn't exist yet.
func get_or_add_library(library_name: String) -> BlockLibrary:
	var existing := get_library(library_name)
	if existing != null:
		return existing
	var lib := BlockLibrary.new()
	lib.name = library_name
	libraries.append(lib)
	return lib

# Remove a library by name. No-op for the built-in `basic` library (decision 3).
func remove_library(library_name: String) -> void:
	for i in libraries.size():
		if libraries[i].name == library_name:
			if libraries[i].builtin:
				return
			libraries.remove_at(i)
			return

func list_libraries() -> Array[String]:
	var out: Array[String] = []
	for lib in libraries:
		out.append(lib.name)
	return out

# The built-in `basic` library, seeding it (with its shape models) on first request so
# the fallback floor always exists.
func basic_library() -> BlockLibrary:
	var lib := get_library(BASIC_LIBRARY)
	if lib == null:
		lib = get_or_add_library(BASIC_LIBRARY)
		lib.builtin = true
	return lib

# Seed FULL/SLAB/STAIRS into the basic library so shape-only block types resolve.
func register_builtin_models() -> void:
	basic_library().register_builtin_models()

# --- Scoped resolution (a palette's library stack → first hit, basic fallback) ------

# The library scope for a resolution: the named libraries in order, then `basic` as the
# implicit final fallback so planning/"undecided" blocks always resolve (Principle 5).
func _scope(library_names: Array) -> Array[BlockLibrary]:
	var out: Array[BlockLibrary] = []
	for n in library_names:
		var lib := get_library(n)
		if lib != null and lib not in out:
			out.append(lib)
	var basic := get_library(BASIC_LIBRARY)
	if basic != null and basic not in out:
		out.append(basic)
	return out

# Resolve a block-type name within a palette's library stack (first hit wins), falling
# back to the basic library. null when no library in scope defines it.
func resolve_block_type(block_name: String, library_names: Array) -> BlockType:
	for lib in _scope(library_names):
		var bt := lib.get_block_type(block_name)
		if bt != null:
			return bt
	return null

# Resolve a model id within the same scope (models referenced by a resolved block type).
func resolve_block_model(model_id: String, library_names: Array) -> BlockModel:
	for lib in _scope(library_names):
		var m := lib.get_block_model(model_id)
		if m != null:
			return m
	return null

# Resolve a texture id within the same scope.
func resolve_texture_asset(texture_id: String, library_names: Array) -> TextureAsset:
	for lib in _scope(library_names):
		var t := lib.get_texture_asset(texture_id)
		if t != null:
			return t
	return null

# --- Catalog-wide convenience (context-free callers) ------------------------
#
# These search every library, first hit wins. Used where the caller has no palette /
# library context: the render path resolving an already-chosen (qualified, effectively
# unique) model_id / texture id, or a UI lookup of a block by bare name. Scoped
# resolution above is preferred wherever a palette's library stack is known.

func find_block_type(block_name: String) -> BlockType:
	for lib in libraries:
		var bt := lib.get_block_type(block_name)
		if bt != null:
			return bt
	return null

# Alias kept for the many context-free callers that look a block up by name.
func get_block_type(block_name: String) -> BlockType:
	return find_block_type(block_name)

func get_block_model(model_id: String) -> BlockModel:
	for lib in libraries:
		var m := lib.get_block_model(model_id)
		if m != null:
			return m
	return null

func get_texture_asset(texture_id: String) -> TextureAsset:
	for lib in libraries:
		var t := lib.get_texture_asset(texture_id)
		if t != null:
			return t
	return null

# --- Palettes ---------------------------------------------------------------

func add_palette(palette_name: String) -> Palette:
	var p := Palette.new()
	p.name = palette_name
	palettes.append(p)
	return p

func get_palette(palette_name: String) -> Palette:
	for p in palettes:
		if p.name == palette_name:
			return p
	return null

func remove_palette(palette_name: String) -> void:
	for i in palettes.size():
		if palettes[i].name == palette_name:
			if palettes[i].builtin:
				return
			palettes.remove_at(i)
			return

# --- Projects ---------------------------------------------------------------

func add_project(project_name: String) -> VoxelProject:
	var p := VoxelProject.new()
	p.name = project_name
	# Stamp both timestamps at creation so a brand-new project sorts correctly by
	# last-edited before its first real save (which re-stamps modified_at).
	var now := int(Time.get_unix_time_from_system())
	p.created_at = now
	p.modified_at = now
	projects.append(p)
	return p

func get_project(project_name: String) -> VoxelProject:
	for p in projects:
		if p.name == project_name:
			return p
	return null

func remove_project(project_name: String) -> void:
	for i in projects.size():
		if projects[i].name == project_name:
			projects.remove_at(i)
			return
