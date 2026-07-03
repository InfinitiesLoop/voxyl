class_name ImportService
extends RefCounted

# Phase 5 orchestration over MCImporter: turn a user-chosen path into one or more
# MCAssetSources, let the UI browse the blocks they offer, import a selected subset
# into the workspace (deduping + namespacing names so two packs can't silently
# collide), and persist the result. All the MC-awareness lives below this in
# MCImporter; this layer is about *which* blocks and *where from*, plus library
# bookkeeping.
#
# Reader, not a content source (decision 4): every source points at assets the user
# already owns (their game install, resource packs, or mods). The import UI says so.

# Which translator to run over the sources. JSON = the 1.8+ blockstate/model format
# (MCImporter); FLAT = the pre-1.8 textures-only synthesis (MCFlatImporter). Same
# sources either way — only the importer differs, chosen in the UI.
enum Mode { JSON, FLAT }

var _sources: Array[MCAssetSource] = []
var _importers := {}     # source -> MCImporter | MCFlatImporter (lazy; share the library)
var _library: BlockLibrary
var _mode: Mode

# Diagnostics from the last import_selected().
var imported_count := 0
var warnings: Array[String] = []

# `library` is the import target (decision: import targets a library). Block types,
# models and textures land in it, `order` is assigned via its next_order(), and only
# that library is persisted at the end. Pass the Block Types tab's selected library (or
# a freshly created one) — never `basic`.
func _init(sources: Array, library: BlockLibrary, mode := Mode.JSON) -> void:
	for s in sources:
		_sources.append(s)
	_library = library
	_mode = mode

# ---------------------------------------------------------------------------
# Source detection
# ---------------------------------------------------------------------------

# Build the right source(s) for a user-chosen path:
#   - a `.zip` / `.jar` archive      → one zip source (a resource pack or mod jar),
#   - a pack / install root          → the folder's `assets/` child,
#   - a mods folder                  → one zip source per `.jar`/`.zip` inside,
#   - otherwise the folder itself    → treated as the assets root.
# Returns [] when the path can't be opened, so the caller can report it.
static func detect_sources(path: String) -> Array[MCAssetSource]:
	var out: Array[MCAssetSource] = []
	var lower := path.to_lower()
	if lower.ends_with(".zip") or lower.ends_with(".jar"):
		out.append(MCZipSource.new(path))
		return out
	var dir := DirAccess.open(path)
	if dir == null:
		return out
	if dir.get_directories().has("assets"):
		out.append(MCDirSource.new(path.path_join("assets")))
		return out
	# A directory of archives → a mods folder.
	for f in dir.get_files():
		var fl := f.to_lower()
		if fl.ends_with(".jar") or fl.ends_with(".zip"):
			out.append(MCZipSource.new(path.path_join(f)))
	if not out.is_empty():
		return out
	# Best effort: assume the folder is itself an assets root.
	out.append(MCDirSource.new(path))
	return out

# ---------------------------------------------------------------------------
# Browse
# ---------------------------------------------------------------------------

# Every importable block across the sources, each as
# { ns, id, ref (= "ns:id"), source }, sorted by ref for a stable list. The UI
# searches/filters this and feeds a subset back to import_selected().
func available_blocks() -> Array:
	var out: Array = []
	for s in _sources:
		var imp = _importer_for(s)
		for ns in imp.list_namespaces():
			for id in imp.list_blocks(ns):
				out.append({"ns": ns, "id": id, "ref": "%s:%s" % [ns, id], "source": s})
	out.sort_custom(func(a, b): return a["ref"] < b["ref"])
	return out

# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

# Import the chosen blocks (each { ns, id, source } — typically a subset of
# available_blocks()) into the workspace and persist the library, synchronously.
# Returns the count imported; `warnings` collects every importer's warnings. The UI
# uses the incremental trio below instead so it can keep the main thread responsive,
# but this one-shot form stays for tests and non-UI callers.
func import_selected(selection: Array) -> int:
	begin_import(selection)
	for i in selection.size():
		import_step(i)
	end_import()
	return imported_count

# --- Incremental import (so a UI can pump the main thread between blocks) --------
#
# begin_import() resolves names and resets counters; import_step(i) imports one block
# (call for i in 0..total, awaiting a frame every so often to repaint a progress bar);
# end_import() gathers warnings and writes the library to disk. Splitting it lets the
# caller advance a progress bar and avoid the "frozen window" of a big batch import.

var _pending: Array = []
var _pending_names: PackedStringArray = PackedStringArray()

# Prepare to import `selection`; returns the total number of blocks to step through.
func begin_import(selection: Array) -> int:
	_pending = selection
	_pending_names = _resolve_names(selection)
	imported_count = 0
	warnings.clear()
	return selection.size()

# Import the i-th pending block. Returns true if it imported.
func import_step(i: int) -> bool:
	var entry = _pending[i]
	var imp = _importer_for(entry["source"])
	var ok := imp.import_block(entry["ns"], entry["id"], _pending_names[i]) != null
	if ok:
		imported_count += 1
	return ok

# Gather every importer's warnings and persist the target library (only if anything
# imported).
func end_import() -> void:
	for s in _sources:
		warnings.append_array(_importer_for(s).warnings)
	if imported_count > 0:
		LibraryStore.save_library(_library)

# The BlockTypes imported so far (deduped across sources), read back out of the target
# library by each importer's final names. Lets a caller act on the fresh blocks — the
# import UI uses it to pre-bake their previews so the grid has no lazy pop-in.
func imported_block_types() -> Array:
	var out: Array = []
	var seen := {}
	for imp in _importers.values():
		for bt_name in imp.imported_blocks:
			if seen.has(bt_name):
				continue
			seen[bt_name] = true
			var bt := _library.get_block_type(bt_name)
			if bt != null:
				out.append(bt)
	return out

# Release any held archive handles. Call when the panel closes.
func close() -> void:
	for s in _sources:
		s.close()

# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------

# Final block-type name per selected entry. The `minecraft` namespace is treated as
# equivalent to no namespace, so vanilla blocks get clean, un-prefixed names ("dirt",
# "oak_planks") — which means importing them OVERWRITES a like-named shipped default
# (the importer reuses an existing block type by name). Every other namespace keeps
# its prefix ("create:cogwheel"), so mods stay distinct and can't collide with vanilla
# or each other. This "minecraft == default namespace" rule is MC-specific, so it lives
# here in the importer plugin, never in the core workspace.
func name_for(ns: String, id: String) -> String:
	return id if ns == "minecraft" else "%s:%s" % [ns, id]

func _resolve_names(selection: Array) -> PackedStringArray:
	var out := PackedStringArray()
	for entry in selection:
		out.append(name_for(entry["ns"], entry["id"]))
	return out

# The translator for a source, matching the chosen mode. MCImporter and
# MCFlatImporter share the methods this service uses (list_namespaces / list_blocks /
# import_block / warnings), so callers treat them alike (duck-typed).
func _importer_for(source: MCAssetSource):
	if not _importers.has(source):
		if _mode == Mode.FLAT:
			_importers[source] = MCFlatImporter.new(source, _library)
		else:
			_importers[source] = MCImporter.new(source, _library)
	return _importers[source]
