extends RefCounted

# Schematica .schematic export/inspection, plus the manual mc.* identity correction NEI's
# roster can't always confirm on its own (see scripts/mcexport/McId.gd).

static func register(reg: McpRegistry) -> void:
	reg.add("schematic_export",
		"Export a region to a real Schematica .schematic file: whole blocks, ForgeMultipart microblock parts (covers/panels/slabs, hollow covers, strips/posts/pillars, nooks/corners/notches), and ArchitectureCraft shapes (roofs, stairs, cylinders, capitals, arches, balustrades/banisters — GT machines aren't wired up yet). Give EITHER `region` (within the open project; omit for the whole build) OR `prefab` (a saved prefab name, resolved through its own preferred palette stack, independent of whatever project is open). A cell or part whose resolved block has no confirmed Minecraft identity (see block_set_mc_id, or reimport via nei_roster_import) is left out and counted in the report's `unmapped`, not guessed at; a part cell where nothing resolved is counted in `empty_part_cells`.",
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

static func _schematic_export(args: Dictionary) -> Dictionary:
	var path := str(args.get("path", ""))
	if path.is_empty():
		return McpRegistry.fail("bad_argument", "path is required")
	var prefab_name := str(args.get("prefab", ""))
	var result: Dictionary
	if not prefab_name.is_empty():
		var prefab := VoxelWorld.workspace.get_prefab(prefab_name)
		if prefab == null:
			return McpRegistry.fail("not_found", "no prefab named '%s'" % prefab_name)
		result = SchematicaExporter.export_prefab(prefab)
	else:
		var pv: Variant = McpArgs.project(args)
		if McpRegistry.is_error(pv):
			return pv
		var r: Variant = McpArgs.region(args.get("region"), true)
		if McpRegistry.is_error(r):
			return r
		result = SchematicaExporter.export_region((pv as VoxelProject).data, r["min"], r["max"])
	var bytes: PackedByteArray = result["bytes"]
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return McpRegistry.fail("write_failed", "couldn't open '%s' for writing" % path)
	f.store_buffer(bytes)
	f.close()
	var out: Dictionary = (result["report"] as Dictionary).duplicate()
	out["path"] = path
	out["bytes"] = bytes.size()
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
