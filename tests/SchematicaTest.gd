extends Node

# Schematica export: NBT container round-trip, SchematicaMeta's orientation-family bit rules,
# and the whole-block SchematicaWriter/SchematicaExporter/SchematicaProbe pipeline end to end.
# FMP/AC/GT part export isn't built yet (see .plans' build order) — this covers whole blocks
# only, same scope as SchematicaExporter itself today.

var _pass := 0
var _fail := 0

func _ready() -> void:
	print("\n=== voxyl schematica export test ===\n")
	VoxelWorld.reset_for_tests()
	_test_nbt_round_trip()
	_test_schematica_meta()
	_test_schematica_writer_add_blocks()
	_test_schematica_exporter_region()
	_test_schematica_exporter_prefab()
	print("\n%d passed, %d failed" % [_pass, _fail])
	get_tree().quit(1 if _fail > 0 else 0)

func _check(label: String, condition: bool) -> void:
	if condition:
		print("  ok   %s" % label)
		_pass += 1
	else:
		print("  FAIL %s" % label)
		_fail += 1

# --- NbtWriter / NbtReader ---------------------------------------------------

func _test_nbt_round_trip() -> void:
	print("-- NBT container round-trip (gzip, big-endian)")
	var list_items := [
		{"id": NbtWriter.tag_string("mcr_face")},
		{"id": NbtWriter.tag_string("mcr_edge")},
	]
	var root := {
		"AByte": NbtWriter.tag_byte(-12),
		"AShort": NbtWriter.tag_short(1234),
		"AnInt": NbtWriter.tag_int(-70000),
		"ALong": NbtWriter.tag_long(5000000000),
		"AFloat": NbtWriter.tag_float(1.5),
		"ADouble": NbtWriter.tag_double(2.5),
		"AString": NbtWriter.tag_string("hello nbt"),
		"AByteArray": NbtWriter.tag_byte_array(PackedByteArray([0, 1, 2, 255])),
		"AnIntArray": NbtWriter.tag_int_array(PackedInt32Array([1, -2, 300000])),
		"AList": NbtWriter.tag_list(NbtWriter.TYPE_COMPOUND, list_items),
		"ACompound": NbtWriter.tag_compound({"Inner": NbtWriter.tag_short(7)}),
	}
	var bytes := NbtWriter.write_file("Schematic", root)
	_check("write produces a gzip stream (magic bytes 1f 8b)", bytes.size() > 2 and bytes[0] == 0x1f and bytes[1] == 0x8b)

	var parsed: Variant = NbtReader.read_file(bytes)
	_check("read_file parses what write_file produced", parsed != null)
	if parsed == null:
		return
	_check("root name round-trips", parsed["name"] == "Schematic")
	var f: Dictionary = parsed["value"]
	_check("byte round-trips", int(f["AByte"]["value"]) == -12)
	_check("short round-trips", int(f["AShort"]["value"]) == 1234)
	_check("int round-trips", int(f["AnInt"]["value"]) == -70000)
	_check("long round-trips", int(f["ALong"]["value"]) == 5000000000)
	_check("float round-trips", is_equal_approx(float(f["AFloat"]["value"]), 1.5))
	_check("double round-trips", is_equal_approx(float(f["ADouble"]["value"]), 2.5))
	_check("string round-trips", str(f["AString"]["value"]) == "hello nbt")
	_check("byte array round-trips", (f["AByteArray"]["value"] as PackedByteArray) == PackedByteArray([0, 1, 2, 255]))
	_check("int array round-trips", (f["AnIntArray"]["value"] as PackedInt32Array) == PackedInt32Array([1, -2, 300000]))
	var lst: Array = f["AList"]["value"]
	_check("list of compounds round-trips (count + order)",
		lst.size() == 2
		and str((lst[0] as Dictionary)["id"]["value"]) == "mcr_face"
		and str((lst[1] as Dictionary)["id"]["value"]) == "mcr_edge")
	_check("nested compound round-trips", int((f["ACompound"]["value"] as Dictionary)["Inner"]["value"]) == 7)

	_check("garbage bytes fail gracefully instead of crashing",
		NbtReader.read_file(PackedByteArray([1, 2, 3, 4])) == null)

# --- SchematicaMeta -----------------------------------------------------------

func _test_schematica_meta() -> void:
	print("-- SchematicaMeta orientation-family bit rules")
	var lib := VoxelWorld.workspace.get_or_add_library("__schem_meta__")

	var slab := lib.add_block_type("TestSlab")
	McId.set_registry_id(slab, "testmod:slab", 3, McId.ORIENT_HALF)
	_check("slab bottom half keeps the confirmed meta",
		SchematicaMeta.final_meta(slab, Orientation.make(Orientation.Facing.NORTH, false)) == 3)
	_check("slab top half sets bit 3",
		SchematicaMeta.final_meta(slab, Orientation.make(Orientation.Facing.NORTH, true)) == (3 | 8))

	var stairs := lib.add_block_type("TestStairs")
	McId.set_registry_id(stairs, "testmod:stairs", 0, McId.ORIENT_STAIRS)
	_check("stairs facing east -> mc facing 0",
		SchematicaMeta.final_meta(stairs, Orientation.make(Orientation.Facing.EAST, false)) == 0)
	_check("stairs facing west -> mc facing 1",
		SchematicaMeta.final_meta(stairs, Orientation.make(Orientation.Facing.WEST, false)) == 1)
	_check("stairs facing south -> mc facing 2",
		SchematicaMeta.final_meta(stairs, Orientation.make(Orientation.Facing.SOUTH, false)) == 2)
	_check("stairs facing north -> mc facing 3",
		SchematicaMeta.final_meta(stairs, Orientation.make(Orientation.Facing.NORTH, false)) == 3)
	_check("upside-down stairs sets bit 2",
		SchematicaMeta.final_meta(stairs, Orientation.make(Orientation.Facing.SOUTH, true)) == (2 | 4))

	var log_bt := lib.add_block_type("TestLog")
	McId.set_registry_id(log_bt, "testmod:log", 1, McId.ORIENT_LOG_AXIS)
	_check("log facing up keeps the confirmed (Y-axis) meta",
		SchematicaMeta.final_meta(log_bt, Orientation.make(Orientation.Facing.UP, false)) == 1)
	_check("log facing east sets the X-axis bits",
		SchematicaMeta.final_meta(log_bt, Orientation.make(Orientation.Facing.EAST, false)) == (1 | 4))
	_check("log facing south sets the Z-axis bits",
		SchematicaMeta.final_meta(log_bt, Orientation.make(Orientation.Facing.SOUTH, false)) == (1 | 8))

	var plain := lib.add_block_type("TestPlain")
	McId.set_registry_id(plain, "testmod:plain", 5)
	_check("mc.orient \"\" (default) passes the confirmed meta through unchanged",
		SchematicaMeta.final_meta(plain, Orientation.make(Orientation.Facing.EAST, true)) == 5)

	VoxelWorld.workspace.remove_library("__schem_meta__")

# --- SchematicaWriter (AddBlocks past id 255) --------------------------------

func _test_schematica_writer_add_blocks() -> void:
	print("-- SchematicaWriter AddBlocks (local ids past 255)")
	var size := Vector3i(2, 1, 1)
	var local_ids := PackedInt32Array([1, 300])   # second cell needs the high nibble
	var metas := PackedByteArray([0, 0])
	var mapping := {"testmod:normal": 1, "testmod:big": 300}
	var bytes := SchematicaWriter.write(size, local_ids, metas, mapping)
	var probed: Variant = SchematicaProbe.probe(bytes)
	_check("probe parses a written whole-block schematic", probed != null)
	if probed == null:
		return
	_check("dimensions round-trip", probed["dimensions"] == size)
	_check("a local id past 255 round-trips through AddBlocks",
		int(probed["histogram"].get("testmod:big", 0)) == 1)
	_check("a local id under 256 needs no AddBlocks help",
		int(probed["histogram"].get("testmod:normal", 0)) == 1)
	_check("mapping round-trips", probed["mapping"].get("testmod:big") == 300)

# --- SchematicaExporter (whole-block region export) --------------------------

func _setup_export_project(lib_name: String) -> Dictionary:
	var ws := VoxelWorld.workspace
	var lib := ws.get_or_add_library(lib_name)
	var stone := lib.add_block_type("Stone")
	McId.set_registry_id(stone, "minecraft:stone", 0, "", true, "minecraft", "Stone")
	var slab := lib.add_block_type("Slab")
	McId.set_registry_id(slab, "minecraft:stone_slab", 0, McId.ORIENT_HALF, true, "minecraft", "Slab")

	var palette := ws.add_palette("__schem_export__")
	palette.library_names = [lib_name]
	var e1 := PaletteEntry.new()
	e1.semantic_name = "Base"
	e1.block_type_name = "Stone"
	palette.entries.append(e1)
	var e2 := PaletteEntry.new()
	e2.semantic_name = "Step"
	e2.block_type_name = "Slab"
	palette.entries.append(e2)
	var e3 := PaletteEntry.new()
	e3.semantic_name = "Undecided"
	e3.block_type_name = ""
	palette.entries.append(e3)

	return {"ws": ws, "lib": lib, "palette": palette}

func _test_schematica_exporter_region() -> void:
	print("-- SchematicaExporter (an open project's region)")
	var ctx := _setup_export_project("__schem_export_lib__")
	var ws: VoxelWorkspace = ctx["ws"]
	var project: VoxelProject = ws.add_project("__schem_export_project__")
	project.palette_names.append("__schem_export__")
	VoxelWorld.open(project)

	project.data.set_block(Vector3i(0, 0, 0), "Base")
	project.data.set_block(Vector3i(1, 0, 0), "Base")
	project.data.set_block(Vector3i(0, 0, 1), "Step", Orientation.make(Orientation.Facing.NORTH, true))
	project.data.set_block(Vector3i(1, 0, 1), "Undecided")   # no confirmed identity -> excluded

	var result := SchematicaExporter.export_region(project.data, Vector3i(0, 0, 0), Vector3i(1, 0, 1))
	var report: Dictionary = result["report"]
	_check("cells with a confirmed identity are counted", int(report["cells_written"]) == 3)
	_check("the undecided cell is bucketed as unmapped, not silently dropped",
		int(report["unmapped"].get("Undecided", 0)) == 1)
	_check("two distinct registries were used", int(report["distinct_blocks"]) == 2)

	var probed: Variant = SchematicaProbe.probe(result["bytes"])
	_check("the written file parses back", probed != null)
	if probed != null:
		_check("dimensions match the exported box", probed["dimensions"] == Vector3i(2, 1, 2))
		_check("stone cells show up in the histogram", int(probed["histogram"].get("minecraft:stone", 0)) == 2)
		_check("the slab cell shows up too (air fills the rest)", int(probed["histogram"].get("minecraft:stone_slab", 0)) == 1)
		var total_written: int = 0
		for v in probed["histogram"].values():
			total_written += int(v)
		_check("the undecided cell left its position as air, not a 4th block", total_written == 3)

	ws.remove_project(project.name)
	ws.remove_palette("__schem_export__")
	ws.remove_library("__schem_export_lib__")

func _test_schematica_exporter_prefab() -> void:
	print("-- SchematicaExporter (a whole prefab, via its own palette stack)")
	var ctx := _setup_export_project("__schem_export_prefab_lib__")
	var ws: VoxelWorkspace = ctx["ws"]
	var prefab: Prefab = ws.add_prefab("__schem_export_prefab__")
	prefab.size = Vector3i(1, 1, 2)
	prefab.palette_names = ["__schem_export__"]
	prefab.data.set_block(Vector3i(0, 0, 0), "Base")
	prefab.data.set_block(Vector3i(0, 0, 1), "Base")

	var result := SchematicaExporter.export_prefab(prefab)
	var probed: Variant = SchematicaProbe.probe(result["bytes"])
	_check("a prefab export resolves through its OWN palette stack, not the open project's",
		probed != null and int(probed["histogram"].get("minecraft:stone", 0)) == 2)

	ws.remove_prefab(prefab.name)
	ws.remove_palette("__schem_export__")
	ws.remove_library("__schem_export_prefab_lib__")
