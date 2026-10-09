extends SceneTree

# Parity harness for the web port of the Minecraft importer: runs the real Godot NEI-roster
# import (ImportService, NEI mode, namespace split -- exactly the sequence ImportPanel drives)
# plus the GTNH heal extension over a whole modpack instance, headlessly, and writes two JSON
# manifests the TypeScript port is compared against:
#
#   nei-manifest.json    state right after the NEI roster import, BEFORE any heal extension
#                        { mods: { <item.csv mod label>: { ns, imported: [{registry, meta,
#                          display, name, faces}], dropped: [{registry, meta, display}] } } }
#   final-manifest.json  state after the heal extensions ran (per namespace library)
#                        { libraries: { <namespace>: [{name, registry, meta, legacy_id, mod,
#                          faces, pane, attachment, ...}] } }
#
# Read-only instrumentation: importer behaviour is untouched; this only drives it and reads the
# result back. Use the wrapper, which also sandboxes every write (libraries, projects, settings)
# under <out dir>/sandbox so the real Voxyl data is never touched:
#
#   bash tools/parity-manifest.sh <instance .minecraft dir> <vanilla client jar> <out dir> [--keep-sandbox]
#
# Raw form (the wrapper just adds the two sandbox flags and a safety check):
#   godot --headless --path . -s tools/parity-manifest.gd -- <mc dir> <jar> <out dir> \
#       --sandbox=<out>/sandbox --library=<out>/sandbox/library [--keep-sandbox]
#
# Without --sandbox/--library the script refuses to run (see _guard_sandbox).

const _DIR_NAMES := {
	BlockModel.Dir.DOWN: "down", BlockModel.Dir.UP: "up",
	BlockModel.Dir.NORTH: "north", BlockModel.Dir.SOUTH: "south",
	BlockModel.Dir.WEST: "west", BlockModel.Dir.EAST: "east",
}

var _ns_to_lib := {}    # raw namespace -> BlockLibrary (filled by the split resolver)

# Autoload _ready()s (VoxelWorld applies --sandbox/--library there) only run once the first
# frame starts, so defer the work to it.
func _initialize() -> void:
	process_frame.connect(func(): quit(_run()), CONNECT_ONE_SHOT)

func _run() -> int:
	var t0 := Time.get_ticks_msec()
	var pos: Array[String] = []
	var keep_sandbox := false
	var sandbox_dir := ""
	for a in OS.get_cmdline_user_args():
		if a == "--keep-sandbox":
			keep_sandbox = true
		elif a.begins_with("--sandbox="):
			sandbox_dir = a.substr(10).replace("\\", "/")
		elif not a.begins_with("--"):
			pos.append(a.replace("\\", "/"))
	if pos.size() != 3:
		printerr("usage: -- <instance .minecraft dir> <vanilla client jar> <out dir> [--keep-sandbox]")
		return 2
	var mc_dir := pos[0]
	var jar := pos[1]
	var out_dir := pos[2]
	DirAccess.make_dir_recursive_absolute(out_dir)
	if not _guard_sandbox(out_dir, sandbox_dir):
		return 3

	# Sources: exactly what picking the instance folder in the UI yields, plus the vanilla jar
	# (a Prism instance keeps it in libraries/, which the forgiving scan deliberately skips).
	var sources := ImportService.detect_sources(mc_dir)
	var jar_sources := ImportService.detect_sources(jar)
	sources.append_array(jar_sources)
	print("sources: %d (%d from the instance, %d extra)" % [sources.size(), sources.size() - jar_sources.size(), jar_sources.size()])
	var dumps := ImportService.find_dumps_folder(mc_dir)
	if dumps.is_empty():
		printerr("no dumps/ folder found near %s" % mc_dir)
		return 4

	# Same objects the panel uses: a placeholder "imported" library for browsing, the workspace
	# resolver for per-namespace libraries (no prefix).
	var ws: VoxelWorkspace = _world().workspace
	var default_lib := ws.get_or_add_library("imported")
	var svc := ImportService.new(sources, default_lib, ImportService.Mode.NEI)
	var err := svc.load_nei_dumps(dumps)
	if not err.is_empty():
		printerr("load_nei_dumps: " + err)
		return 5
	svc.set_namespace_split(_resolve_library)
	var avail := svc.available_blocks()
	print("roster: %d entries" % avail.size())

	# ImportService.import_selected() == begin_import + import_step* + end_import; split open so
	# the pre-heal state can be read between the last step and end_import() (which heals).
	var nei := {}   # mod -> {ns, imported[], dropped[]}
	var total := svc.begin_import(avail)
	for i in total:
		var row: Dictionary = avail[i]["row"]
		var mod := str(row["mod"])
		if not nei.has(mod):
			nei[mod] = {"ns": str(row["ns"]), "imported": [], "dropped": []}
		var ok := svc.import_step(i)
		if ok:
			var bt := svc.last_imported
			var lib := svc.last_imported_library
			(nei[mod]["imported"] as Array).append({
				"registry": str(row["registry"]), "meta": int(row["meta"]),
				"display": str(row["display"]), "name": bt.name, "faces": _faces_of(lib, bt)})
		else:
			(nei[mod]["dropped"] as Array).append({
				"registry": str(row["registry"]), "meta": int(row["meta"]),
				"display": str(row["display"])})
	var t_nei := Time.get_ticks_msec()
	_write_nei(out_dir.path_join("nei-manifest.json"), nei)
	print("NEI import done in %.1fs" % ((t_nei - t0) / 1000.0))

	svc.end_import()   # flush texture writes, run the heal extensions, persist (sandboxed)
	var t_heal := Time.get_ticks_msec()
	print("heal + save done in %.1fs" % ((t_heal - t_nei) / 1000.0))
	_write_final(out_dir.path_join("final-manifest.json"))
	svc.close()

	_print_summary(nei)
	print("warnings (%d):" % svc.warnings.size())
	for w in svc.warnings:
		print("  " + w)
	print("total wall time: %.1fs" % ((Time.get_ticks_msec() - t0) / 1000.0))
	if not keep_sandbox:
		_rm_rf(sandbox_dir)
	return 0

# Refuse to run unless every store is pointed at a throwaway dir under the out dir -- an
# un-sandboxed import would write block libraries into the real workspace.
func _guard_sandbox(out_dir: String, sandbox_dir: String) -> bool:
	var want := out_dir.path_join("sandbox")
	var lib_ok: bool = AssetLibrary.ROOT == want.path_join("library")
	var proj_ok: bool = ProjectStore.ROOT == want.path_join("projects")
	if sandbox_dir != want or not lib_ok or not proj_ok:
		printerr("refusing to run un-sandboxed: expected --sandbox=%s --library=%s/library (got library root %s, projects root %s). Use tools/parity-manifest.sh."
			% [want, want, AssetLibrary.ROOT, ProjectStore.ROOT])
		return false
	return true

# Autoloads aren't compile-time identifiers in a -s main-loop script; fetch it at runtime.
func _world() -> Node:
	return root.get_node("VoxelWorld")

func _resolve_library(ns: String) -> BlockLibrary:
	var lib_name := ImportService.sanitize_library_name(ns)
	if lib_name == VoxelWorkspace.BASIC_LIBRARY:
		lib_name = "%s_imported" % ns
	var lib: BlockLibrary = _world().workspace.get_or_add_library(lib_name)
	_ns_to_lib[ns] = lib
	return lib

# Six-direction map of the texture asset ids the block's model binds (first element that has
# faces -- a pane's post model only binds up/down, mesh-only models bind none), or null.
func _faces_of(lib: BlockLibrary, bt: BlockType) -> Variant:
	if bt.model_id.is_empty():
		return null
	var model := lib.get_block_model(bt.model_id)
	if model == null:
		return null
	for el in model.elements:
		var faces: Dictionary = el.get("faces", {})
		if faces.is_empty():
			continue
		var out := {}
		for d in _DIR_NAMES:
			if faces.has(d):
				var key := str(faces[d].get("texture_key", ""))
				out[_DIR_NAMES[d]] = str(model.textures.get(key, key))
			else:
				out[_DIR_NAMES[d]] = null
		return out
	return null

func _write_nei(path: String, nei: Dictionary) -> void:
	var f := FileAccess.open(path, FileAccess.WRITE)
	f.store_string("{\"mods\":{\n")
	var mods := nei.keys()
	mods.sort()
	for mi in mods.size():
		var mod: String = mods[mi]
		var m: Dictionary = nei[mod]
		f.store_string("%s:{\"ns\":%s,\"imported\":[\n" % [JSON.stringify(mod), JSON.stringify(m["ns"])])
		_store_lines(f, m["imported"])
		f.store_string("],\"dropped\":[\n")
		_store_lines(f, m["dropped"])
		f.store_string("]}%s\n" % ("," if mi < mods.size() - 1 else ""))
	f.store_string("}}\n")
	f.close()

func _write_final(path: String) -> void:
	var nss := _ns_to_lib.keys()
	nss.sort()
	var f := FileAccess.open(path, FileAccess.WRITE)
	f.store_string("{\"libraries\":{\n")
	var lib_names := {}
	for ni in nss.size():
		var ns: String = nss[ni]
		var lib: BlockLibrary = _ns_to_lib[ns]
		lib_names[ns] = lib.name
		var rows: Array = []
		for bt in lib.block_types:
			rows.append({
				"name": bt.name,
				"registry": McId.get_registry(bt),
				"meta": McId.get_mc_meta(bt),
				"legacy_id": McId.get_legacy_id(bt),
				"mod": McId.get_mod(bt),
				"display": McId.get_display(bt),
				"faces": _faces_of(lib, bt),
				"pane": bt.state_map != null,
				"attachment": not bt.attachment.is_empty() and bt.attachment != Attachment.OPT_OUT,
				"attachment_kind": bt.attachment,
				"model_id": bt.model_id,
				"source_namespace": bt.source_namespace,
				"tags": Array(bt.tags),
			})
		f.store_string("%s:[\n" % JSON.stringify(ns))
		_store_lines(f, rows)
		f.store_string("]%s\n" % ("," if ni < nss.size() - 1 else ""))
	f.store_string("},\"library_names\":%s}\n" % JSON.stringify(lib_names, "", true))
	f.close()

# One JSON object per line, comma-separated -- diff-friendly and cheap to stream.
func _store_lines(f: FileAccess, items: Array) -> void:
	for i in items.size():
		f.store_string(JSON.stringify(items[i], "", true))
		f.store_string(",\n" if i < items.size() - 1 else "\n")

func _print_summary(nei: Dictionary) -> void:
	var mods := nei.keys()
	mods.sort()
	var ti := 0
	var td := 0
	print("per mod (imported / dropped):")
	for mod in mods:
		var im: int = (nei[mod]["imported"] as Array).size()
		var dr: int = (nei[mod]["dropped"] as Array).size()
		ti += im
		td += dr
		print("  %-40s ns=%-24s %6d / %6d" % [mod, nei[mod]["ns"], im, dr])
	print("TOTAL: %d mods, %d imported, %d dropped" % [mods.size(), ti, td])
	print("blocks per namespace library AFTER heal:")
	var nss := _ns_to_lib.keys()
	nss.sort()
	for ns in nss:
		print("  %-30s %6d" % [ns, (_ns_to_lib[ns] as BlockLibrary).block_types.size()])

func _rm_rf(path: String) -> void:
	if path.is_empty() or not DirAccess.dir_exists_absolute(path):
		return
	for d in DirAccess.get_directories_at(path):
		_rm_rf(path.path_join(d))
	for fl in DirAccess.get_files_at(path):
		DirAccess.remove_absolute(path.path_join(fl))
	DirAccess.remove_absolute(path)
