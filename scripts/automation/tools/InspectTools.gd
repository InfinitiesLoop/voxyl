extends RefCounted

# Inspecting the build as data: single cells, text layers, counts.

static func register(reg: McpRegistry) -> void:
	reg.add("cell_get",
		"What's in specific cells: the semantic (or parts, with slot names), its facing, and what block/shape the palette currently resolves it to.",
		{"properties": {
			"pos": McpArgs.s_vec3(),
			"positions": {"type": "array", "items": {"type": "array"}},
		}}, _cell_get)
	reg.add("region_text",
		"The build as text layers (the same format cells_place_layers takes, so it round-trips): axis y = plan layers going up (rows north→south, chars west→east); axis z / x = elevations. `at` picks one layer (a y level for axis y). Cheapest exact view of structure.",
		{"properties": {
			"region": McpArgs.s_region("Region (default: the whole build)"),
			"axis": {"type": "string", "enum": ["y", "z", "x"]},
			"at": {"type": "integer", "description": "Only this layer: a y for axis y, a z for axis z, an x for axis x"},
		}}, _region_text)
	reg.add("region_stats",
		"Counts inside a region (default: the whole build): whole blocks by semantic, parts by semantic and shape, bounds.",
		{"properties": {"region": McpArgs.s_region("Region (default: the whole build)")}}, _region_stats)

static func _cell_get(args: Dictionary) -> Dictionary:
	if VoxelWorld.active_project == null:
		return McpRegistry.fail("no_project", "no project is open")
	var positions: Array = args.get("positions", [])
	if args.has("pos"):
		positions = [args["pos"]] + positions
	if positions.is_empty():
		return McpRegistry.fail("bad_argument", "give pos or positions")
	var out: Array = []
	for p in positions.slice(0, 500):
		var pos: Variant = McpArgs.vec3i_or_fail(p, "pos")
		if McpRegistry.is_error(pos):
			return pos
		out.append(describe_cell(pos))
	return {"cells": out}

static func describe_cell(pos: Vector3i) -> Dictionary:
	var cell := VoxelWorld.active_project.data.get_cell(pos)
	var d := {"pos": pos}
	if cell == null:
		d["empty"] = true
		return d
	if cell.is_shaped():
		var parts: Array = []
		for part in cell.parts:
			var pj := McpArgs.part_json(part)
			pj["block"] = VoxelWorld.get_block_type_for_semantic(str(part["semantic"]))
			parts.append(pj)
		d["parts"] = parts
	else:
		d["semantic"] = cell.type_id
		d["block"] = VoxelWorld.get_block_type_for_semantic(cell.type_id)
		if cell.orientation != 0:
			d["facing"] = Orientation.NAMES[Orientation.facing_of(cell.orientation)].to_lower()
			if Orientation.is_top(cell.orientation):
				d["top"] = true
	return d

static func _region_text(args: Dictionary) -> Dictionary:
	if VoxelWorld.active_project == null:
		return McpRegistry.fail("no_project", "no project is open")
	var r: Variant = McpArgs.region(args.get("region"), true)
	if McpRegistry.is_error(r):
		return r
	var mn: Vector3i = r["min"]
	var mx: Vector3i = r["max"]
	var axis := str(args.get("axis", "y"))
	if args.has("at"):
		var at := int(args["at"])
		match axis:
			"z":
				mn.z = at
				mx.z = at
			"x":
				mn.x = at
				mx.x = at
			_:
				mn.y = at
				mx.y = at
	var cells := (mx.x - mn.x + 1) * (mx.y - mn.y + 1) * (mx.z - mn.z + 1)
	if cells > 40000:
		return McpRegistry.fail("too_large", "%d cells is too much text; narrow the region or use `at`" % cells)
	return RegionCodec.dump(VoxelWorld.active_project.data, mn, mx, axis,
		func(s: String) -> String: return VoxelWorld.get_shape_id_for_semantic(s))

static func _region_stats(args: Dictionary) -> Dictionary:
	if VoxelWorld.active_project == null:
		return McpRegistry.fail("no_project", "no project is open")
	var r: Variant = McpArgs.region(args.get("region"), true)
	if McpRegistry.is_error(r):
		return r
	return RegionOps.stats(VoxelWorld.active_project.data, r["min"], r["max"])
