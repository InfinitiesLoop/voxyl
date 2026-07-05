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
var _importers := {}     # source -> { library_name -> MCImporter | MCFlatImporter } (lazy)
var _library: BlockLibrary
var _mode: Mode

# Namespace-split routing (opt-in via set_namespace_split). When on, import_step picks
# the target library per block from its namespace instead of using the single `_library`,
# and block types are named bare (the per-namespace library already scopes them). Off by
# default so the ordinary single-target import (and every existing caller/test) is
# unchanged.
var _split := false
var _library_resolver := Callable()   # func(ns: String) -> BlockLibrary
var _lib_by_ns := {}     # ns -> BlockLibrary (cached resolver results for this import)
var _touched := {}       # library name -> BlockLibrary that received a block this import
var _ns_source := {}     # ns -> MCAssetSource that fed it (for the post-import extension pass)

# Diagnostics from the last import_selected().
var imported_count := 0
var warnings: Array[String] = []

# `library` is the default import target (decision: import targets a library). Block types,
# models and textures land in it, `order` is assigned via its next_order(), and it's
# persisted at the end. Pass the Block Types tab's selected library (or a freshly created
# one) — never `basic`. It also backs browsing regardless of mode; under set_namespace_split
# the per-namespace libraries receive the imports instead, and each is persisted once.
func _init(sources: Array, library: BlockLibrary, mode := Mode.JSON) -> void:
	for s in sources:
		_sources.append(s)
	_library = library
	_mode = mode

# Route the next import by namespace: every block lands in the library `resolver`
# returns for its namespace (the caller creates/reuses it) rather than the single
# `_library`, and block types are named bare. `resolver` is func(ns: String) ->
# BlockLibrary; an invalid Callable turns splitting back off. Call before begin_import.
# `_library` is still used for browsing, so pass a valid one either way.
func set_namespace_split(resolver: Callable) -> void:
	_split = resolver.is_valid()
	_library_resolver = resolver

# Every library name that actually received a block during the last import (populated by
# import_step, cleared by begin_import). Lets a caller act only when the result is
# unambiguous — e.g. auto-selecting the target library when exactly one was touched.
func touched_library_names() -> Array:
	return _touched.keys()

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
		var imp = _importer_for(s, _library)
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
	_touched.clear()
	_lib_by_ns.clear()
	_ns_source.clear()
	# Overlap the per-texture pixel copies on worker threads for the duration of this
	# import; end_import() flushes them before returning (and before previews bake).
	MCTexImport.use_threads = true
	return selection.size()

# Import the i-th pending block. Returns true if it imported.
func import_step(i: int) -> bool:
	var entry = _pending[i]
	var lib := _target_library_for(entry["ns"])
	var imp = _importer_for(entry["source"], lib)
	# Remember which source fed each namespace so the post-import extension pass (which reads
	# more of the same source) can find it — even for a block that failed to import.
	_ns_source[entry["ns"]] = entry["source"]
	var ok := imp.import_block(entry["ns"], entry["id"], _pending_names[i]) != null
	if ok:
		imported_count += 1
		_touched[lib.name] = lib   # remember to persist it once, in end_import
	return ok

# Gather every importer's warnings and persist each library that received a block —
# exactly once, however many blocks (or namespaces) landed in it. That single write per
# touched library at the very end is the whole efficiency guarantee: a split import
# never re-saves a library mid-run.
func end_import() -> void:
	# Drain the threaded texture-copy writes and restore the default so any later
	# non-UI importer (e.g. a test) stays fully synchronous.
	MCTexImport.flush_writes()
	MCTexImport.use_threads = false
	# Post-import: let a mod-specific extension reshape each imported namespace (add healed
	# blocks, remove junk) before anything is persisted. Runs after the presumptive import so
	# it sees the whole result; runs before save so its changes land on disk.
	_run_extensions()
	for imp in _all_importers():
		warnings.append_array(imp.warnings)
	for lib in _touched.values():
		LibraryStore.save_library(lib)

# Run the registered extension (if any) for each namespace imported this run, on the library
# that received it. Idempotent per namespace (keyed dict), so a namespace fed by several
# sources still heals once — the extension re-reads whatever it needs from the source itself.
func _run_extensions() -> void:
	for ns in _ns_source:
		var ext := MCImportExtension.for_namespace(ns)
		if ext == null:
			continue
		var lib := _target_library_for(ns)
		var ctx := MCHealContext.new(lib, _ns_source[ns], ns)
		ext.heal(ctx)
		ctx.flush_composites()   # block until the threaded composite writes are all on disk
		warnings.append_array(ctx.warnings)
		_touched[lib.name] = lib   # a heal-only namespace still needs persisting

# The BlockTypes imported so far (deduped across sources), read back out of the target
# library by each importer's final names. Lets a caller act on the fresh blocks — the
# import UI uses it to pre-bake their previews so the grid has no lazy pop-in.
func imported_block_types() -> Array:
	var out: Array = []
	var seen := {}
	for imp in _all_importers():
		for bt_name in imp.imported_blocks:
			# Dedup per (library, name): a bare name like "stone" can legitimately exist
			# in more than one library once splitting spreads blocks across namespaces.
			var key := [imp._library.name, bt_name]
			if seen.has(key):
				continue
			seen[key] = true
			var bt: BlockType = imp._library.get_block_type(bt_name)
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
	# Splitting puts each namespace in its own library, so the library already scopes the
	# name — keep it bare (the block id) for every namespace, no "ns:" qualifier needed.
	if _split:
		return id
	return id if ns == "minecraft" else "%s:%s" % [ns, id]

func _resolve_names(selection: Array) -> PackedStringArray:
	var out := PackedStringArray()
	for entry in selection:
		out.append(name_for(entry["ns"], entry["id"]))
	return out

# The target library for a block's namespace: the single `_library` normally, or the
# split resolver's per-namespace library (cached for this import) when splitting.
func _target_library_for(ns: String) -> BlockLibrary:
	if not _split:
		return _library
	if not _lib_by_ns.has(ns):
		_lib_by_ns[ns] = _library_resolver.call(ns)
	return _lib_by_ns[ns]

# The translator for a (source, library) pair, matching the chosen mode. Keyed by both
# because splitting feeds one source's blocks into several libraries (and one library can
# be fed by several sources), and an importer is bound to a single library. MCImporter and
# MCFlatImporter share the methods this service uses (list_namespaces / list_blocks /
# import_block / warnings + imported_blocks), so callers treat them alike (duck-typed).
func _importer_for(source: MCAssetSource, library: BlockLibrary):
	var by_lib = _importers.get(source)
	if by_lib == null:
		by_lib = {}
		_importers[source] = by_lib
	var imp = by_lib.get(library.name)
	if imp == null:
		if _mode == Mode.FLAT:
			imp = MCFlatImporter.new(source, library)
		else:
			imp = MCImporter.new(source, library)
		by_lib[library.name] = imp
	return imp

# Every importer created so far, across all (source, library) pairs.
func _all_importers() -> Array:
	var out: Array = []
	for by_lib in _importers.values():
		out.append_array(by_lib.values())
	return out
