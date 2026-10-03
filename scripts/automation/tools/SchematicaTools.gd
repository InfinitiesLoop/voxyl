extends RefCounted

# Schematica .schematic export/inspection, plus the manual mc.* identity correction NEI's
# roster can't always confirm on its own (see scripts/mcexport/McId.gd).

static func register(reg: McpRegistry) -> void:
	reg.add("schematic_export",
		"Export a region to a real Schematica .schematic file: whole blocks, ForgeMultipart microblock parts (covers/panels/slabs, hollow covers, strips/posts/pillars, nooks/corners/notches), and ArchitectureCraft shapes (roofs, stairs, cylinders, capitals, arches, balustrades/banisters — GT machines aren't wired up yet). Give EITHER `region` (within the open project; omit for the whole build) OR `prefab` (a saved prefab name, resolved through its own preferred palette stack, independent of whatever project is open; a prefab is turned by its own north, one of unknown north is written as saved). North is north: a project `region` is turned by the project's `north` setting (see project_settings), a prefab by the north it was saved with, so that north lands on the game's north (-Z) when the schematic is pasted. The report's `size` is the size as written, and `turned_degrees` (clockwise, seen from above) and `source_north` say how it was turned — absent when it already faced north. Facings and part slots turn with the blocks. A cell or part whose resolved block has no confirmed Minecraft identity (see block_set_mc_id, or reimport via nei_roster_import) is left out and counted in the report's `unmapped`, not guessed at; a part cell where nothing resolved is counted in `empty_part_cells`.",
		{"properties": {
			"region": McpArgs.s_region(),
			"prefab": {"type": "string", "description": "Export this saved prefab instead of a project region"},
			"project": {"type": "string"},
			"path": {"type": "string", "description": "Where to write the .schematic file on disk"},
		}, "required": ["path"]}, _schematic_export)
	reg.add("schematic_probe",
		"Read-only inspection of an existing .schematic file (this exporter's own output, or a reference file someone else made): dimensions, the SchematicaMapping table, and a per-block histogram. Does not import it as a prefab.",
		{"properties": {"path": {"type": "string"}}, "required": ["path"]}, _schematic_probe)
	reg.add("block_set_mc_id",
		"Manually set or correct a block type's confirmed Minecraft identity for export: registry name (\"modid:name\") + meta, and — only for a slab/stairs/log-shaped semantic — which orientation family (orient) governs its placed metadata (NEI's dumps don't expose this; it's never guessed). This same registry+meta identity also serves as a ForgeMultipart microblock material and an ArchitectureCraft base material — no separate identity needed. Pass registry:\"\" to clear an identity.",
		{"properties": {
			"library": {"type": "string"},
			"block": {"type": "string"},
			"registry": {"type": "string", "description": "\"modid:name\", e.g. \"minecraft:stone_slab\"; \"\" clears it"},
			"meta": {"type": "integer", "description": "Defaults to the block's current meta if omitted"},
			"orient": {"type": "string", "enum": ["", "half", "stairs", "log_axis"]},
		}, "required": ["library", "block"]}, _block_set_mc_id, {"mutates": true})
	reg.add("fmp_sawable_import",
		"Tag every block with a confirmed Minecraft identity, across all libraries, with whether Forge Multipart's saw can cut it into a microblock (cover/panel/slab/strip/post/pillar/corner/nook/notch) — read from the modpack's own config/microblocks.cfg. A block missing from that file usually can't be sawed and renders as missing-texture when cut with a microblock shape — but the cfg isn't the whole picture: a few FMP-sibling mods (confirmed for ProjectRed's Illumination Inverted Lamps) self-register materials in their own code, invisible to the cfg, so those known cases are left unchecked rather than marked false (see FmpParts.SELF_REGISTERING_PREFIXES). Once imported, palette_get/palette_update and schematic_export/prefab_save warn when a microblock shape is assigned to a material the cfg doesn't whitelist.",
		{"properties": {
			"path": {"type": "string", "description": "Path to the modpack's microblocks.cfg"},
		}, "required": ["path"]}, _fmp_sawable_import, {"mutates": true})

static func _schematic_export(args: Dictionary) -> Dictionary:
	var path := str(args.get("path", ""))
	if path.is_empty():
		return McpRegistry.fail("bad_argument", "path is required")
	var prefab_name := str(args.get("prefab", ""))
	var result: Dictionary
	var north := ""   # the north of what was exported (the project's or the prefab's), reported when it turned
	if not prefab_name.is_empty():
		var prefab := VoxelWorld.workspace.get_prefab(prefab_name)
		if prefab == null:
			return McpRegistry.fail("not_found", "no prefab named '%s'" % prefab_name)
		result = SchematicaExporter.export_prefab(prefab)
		north = prefab.north_dir
	else:
		var pv: Variant = McpArgs.project(args)
		if McpRegistry.is_error(pv):
			return pv
		var r: Variant = McpArgs.region(args.get("region"), true)
		if McpRegistry.is_error(r):
			return r
		var project: VoxelProject = pv
		result = SchematicaExporter.export_region(project.data, r["min"], r["max"], project.export_turns(), r["filter"], r.get("positions"))
		north = project.north_dir
	var bytes: PackedByteArray = result["bytes"]
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return McpRegistry.fail("write_failed", "couldn't open '%s' for writing" % path)
	f.store_buffer(bytes)
	f.close()
	var out: Dictionary = (result["report"] as Dictionary).duplicate()
	out["path"] = path
	out["bytes"] = bytes.size()
	if out.has("turned_degrees"):
		out["source_north"] = north
	return out

static func _schematic_probe(args: Dictionary) -> Dictionary:
	var path := str(args.get("path", ""))
	if path.is_empty():
		return McpRegistry.fail("bad_argument", "path is required")
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return McpRegistry.fail("not_found", "couldn't open '%s'" % path)
	var bytes := f.get_buffer(f.get_length())
	f.close()
	var probed: Variant = SchematicaProbe.probe(bytes)
	if probed == null:
		return McpRegistry.fail("bad_file", "'%s' doesn't look like a valid .schematic file" % path)
	return probed

static func _block_set_mc_id(args: Dictionary) -> Dictionary:
	var lib_name := str(args.get("library", ""))
	var block_name := str(args.get("block", ""))
	var lib := VoxelWorld.workspace.get_library(lib_name)
	if lib == null:
		return McpRegistry.fail("not_found", "no library named '%s'" % lib_name)
	var bt := lib.get_block_type(block_name)
	if bt == null:
		return McpRegistry.fail("not_found", "no block '%s' in library '%s'" % [block_name, lib_name])

	var meta := int(args.get("meta", McId.get_mc_meta(bt)))
	if args.has("registry"):
		var orient := str(args.get("orient", McId.get_orient(bt)))
		McId.set_registry_id(bt, str(args["registry"]), meta, orient)
	elif args.has("orient") and McId.has_registry(bt):
		McId.set_registry_id(bt, McId.get_registry(bt), meta, str(args["orient"]),
			McId.is_confirmed(bt), McId.get_mod(bt), McId.get_display(bt))
	LibraryStore.save_library(lib)
	return {"library": lib_name, "block": block_name, "registry": McId.get_registry(bt),
		"meta": McId.get_mc_meta(bt), "orient": McId.get_orient(bt)}

static func _fmp_sawable_import(args: Dictionary) -> Dictionary:
	var path := str(args.get("path", ""))
	if not FileAccess.file_exists(path):
		return McpRegistry.fail("not_found", "no file at '%s'" % path)
	var whitelist := MicroblocksCfgImporter.parse(path)
	if whitelist.is_empty():
		return McpRegistry.fail("bad_file", "no entries parsed from '%s' — is this really microblocks.cfg?" % path)
	var checked := 0
	var sawable := 0
	var skipped_self_registering := 0
	var touched: Array = []
	for lib in VoxelWorld.workspace.libraries:
		var changed := false
		for bt in lib.block_types:
			if not McId.has_registry(bt):
				continue
			var registry := McId.get_registry(bt)
			var ok := MicroblocksCfgImporter.is_sawable(whitelist, registry, McId.get_mc_meta(bt))
			if not ok and FmpParts.is_self_registering(registry):
				skipped_self_registering += 1
				continue
			checked += 1
			if ok:
				sawable += 1
			FmpParts.mark_sawable(bt, ok)
			changed = true
		if changed:
			touched.append(lib.name)
			LibraryStore.save_library(lib)
	return {"path": path, "whitelist_entries": whitelist.size(), "checked": checked,
		"sawable": sawable, "not_sawable": checked - sawable,
		"skipped_self_registering": skipped_self_registering, "libraries": touched}
