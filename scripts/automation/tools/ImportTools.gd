extends RefCounted

# Importing block types from Minecraft/modpack assets — the NEI roster path
# (scripts/mcimport/NeiRosterImporter.gd). See .plans/prefabs.md for how the real dump
# format was confirmed, and ImportPanel.gd for the same flow as UI.

static func register(reg: McpRegistry) -> void:
	reg.add("nei_roster_import",
		"Import block types from NEI's own Data Dumps (in-game: Options -> Tools -> Data Dumps -> Items, then Item Panel in CSV mode) -- the confirmed, complete roster of everything placeable in a modpack (real registry name + meta + display name), general to any 1.7.10-1.12 modpack that ships NEI. `asset_paths` are one or more paths to the mod assets (an instance root, `.minecraft`, a mods folder, a resource pack) -- these supply textures, and the Data Dumps folder (item.csv + itempanel.csv) is located automatically nearby; pass `dumps_path` only if it isn't under any of asset_paths. A registry+meta with no matching texture (e.g. a GregTech single-block machine, or a block whose textures are procedurally composited rather than static files) is dropped, not imported -- an MC block the user could never tell apart from any other undecided block isn't a useful placeholder; see the `warnings` in the result for a per-mod count of what got dropped and why. A mod that resolves to nothing at all leaves no library behind. Without `mods` or `all:true` this only browses (returns per-mod counts, imports nothing) -- a modpack roster can be thousands of blocks, so an actual import is opt-in.",
		{"properties": {
			"dumps_path": {"type": "string", "description": "Only needed if it can't be found automatically near asset_paths"},
			"asset_paths": {"type": "array", "items": {"type": "string"}},
			"library": {"type": "string", "description": "Target library name (created if new)"},
			"mods": {"type": "array", "items": {"type": "string"}, "description": "Only import these mods (as shown by a browse call); omit + all:true to import everything"},
			"all": {"type": "boolean", "description": "Import every mod in the roster (ignored if mods is given)"},
			"split": {"type": "boolean", "description": "Route each block to a library named after its own registry namespace, prefixed by `library` (e.g. \"gtnh.ztones\") -- same as ImportPanel's namespace split"},
		}, "required": ["asset_paths", "library"]}, _nei_roster_import, {"mutates": true})

static func _nei_roster_import(args: Dictionary) -> Variant:
	var dumps_path := str(args.get("dumps_path", ""))
	var asset_paths: Array = args.get("asset_paths", [])
	var lib_name := str(args.get("library", ""))
	if asset_paths.is_empty() or lib_name.is_empty():
		return McpRegistry.fail("bad_argument", "asset_paths and library are both required")
	if lib_name == VoxelWorkspace.BASIC_LIBRARY:
		return McpRegistry.fail("bad_argument", "imports can't target the built-in '%s' library" % VoxelWorkspace.BASIC_LIBRARY)

	var sources: Array[MCAssetSource] = []
	var unreadable: Array = []
	for p in asset_paths:
		var found := ImportService.detect_sources(str(p))
		if found.is_empty():
			unreadable.append(str(p))
		sources.append_array(found)
		if dumps_path.is_empty():
			dumps_path = ImportService.find_dumps_folder(str(p))
	if sources.is_empty():
		return McpRegistry.fail("bad_argument", "none of asset_paths resolved to a readable Minecraft assets tree: %s" % ", ".join(unreadable))
	if dumps_path.is_empty():
		return McpRegistry.fail("no_dumps", "couldn't find a dumps/ folder near any of asset_paths -- run NEI's Data Dumps first (Options -> Tools -> Data Dumps -> Items, then Item Panel in CSV mode), or pass dumps_path directly")

	var lib_preexisted := VoxelWorld.workspace.get_library(lib_name) != null
	var lib := VoxelWorld.workspace.get_or_add_library(lib_name)
	var svc := ImportService.new(sources, lib, ImportService.Mode.NEI)
	var err := svc.load_nei_dumps(dumps_path)
	if not err.is_empty():
		svc.close()
		return McpRegistry.fail("bad_dumps", err)

	var avail := svc.available_blocks()
	var by_mod := {}
	for entry: Dictionary in avail:
		var mod: String = str(entry["row"]["mod"])
		by_mod[mod] = int(by_mod.get(mod, 0)) + 1
	var mod_counts: Array = []
	for mod in by_mod:
		mod_counts.append({"mod": mod, "count": by_mod[mod]})
	mod_counts.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return str(a["mod"]) < str(b["mod"]))

	var wanted_mods: Array = args.get("mods", [])
	var import_all := bool(args.get("all", false))
	if wanted_mods.is_empty() and not import_all:
		svc.close()
		return {"dry_run": true, "total": avail.size(), "mods": mod_counts, "dumps_path": dumps_path,
			"note": "nothing imported -- pass mods:[...] or all:true to actually import"}

	var selection: Array = avail
	if not wanted_mods.is_empty():
		var want := {}
		for m in wanted_mods:
			want[str(m)] = true
		selection = avail.filter(func(e: Dictionary) -> bool: return want.has(str(e["row"]["mod"])))
		if selection.is_empty():
			svc.close()
			return McpRegistry.fail("not_found", "none of the requested mods matched the roster; see the 'mods' list from a browse call")

	var split_created: Array[String] = []
	if bool(args.get("split", false)):
		svc.set_namespace_split(func(ns: String) -> BlockLibrary:
			var split_name := "%s.%s" % [lib_name, ns]
			if VoxelWorld.workspace.get_library(split_name) == null and split_name not in split_created:
				split_created.append(split_name)
			return VoxelWorld.workspace.get_or_add_library(split_name))

	var n := svc.import_selected(selection)
	var out := {"imported": n, "mods": mod_counts, "libraries_touched": svc.touched_library_names(),
		"warnings": svc.warnings}
	svc.close()
	if not unreadable.is_empty():
		out["asset_paths_unreadable"] = unreadable
	# A namespace/library every one of whose blocks failed to match a texture ends up empty
	# (import_entry drops rather than keeps an unmatched new block) — drop the library itself
	# too rather than leaving a pointless, empty entry behind. Mirrors ImportPanel._close()'s
	# same cleanup for the UI path.
	var to_check := split_created.duplicate()
	if not lib_preexisted:
		to_check.append(lib_name)
	for name in to_check:
		var check_lib := VoxelWorld.workspace.get_library(name)
		if check_lib != null and check_lib.block_types.is_empty() and check_lib.block_models.is_empty() \
				and check_lib.texture_assets.is_empty():
			VoxelWorld.workspace.remove_library(name)
	return out
