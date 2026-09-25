extends Node

# Schematica export: NBT container round-trip, SchematicaMeta's orientation-family bit rules,
# the whole-block SchematicaWriter/SchematicaExporter/SchematicaProbe pipeline, and shaped-part
# export (ForgeMultipart microblocks via FmpParts, ArchitectureCraft shapes via AcParts) end to
# end. GT machine export isn't built yet.

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
	_test_fmp_microblock_export()
	_test_ac_shape_export()
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

# --- SchematicaExporter (ForgeMultipart microblock parts) --------------------

func _tile_entities_of(bytes: PackedByteArray) -> Array:
	var parsed: Variant = NbtReader.read_file(bytes)
	if parsed == null:
		return []
	var fields: Dictionary = parsed["value"]
	return fields["TileEntities"]["value"] if fields.has("TileEntities") else []

func _tile_at(bytes: PackedByteArray, pos: Vector3i) -> Dictionary:
	for t: Dictionary in _tile_entities_of(bytes):
		if int(t["x"]["value"]) == pos.x and int(t["y"]["value"]) == pos.y and int(t["z"]["value"]) == pos.z:
			return t
	return {}

func _data_byte_at(bytes: PackedByteArray, pos: Vector3i, size: Vector3i) -> int:
	var parsed: Variant = NbtReader.read_file(bytes)
	var data: PackedByteArray = (parsed["value"] as Dictionary)["Data"]["value"]
	return data[(pos.y * size.z + pos.z) * size.x + pos.x]

func _test_fmp_microblock_export() -> void:
	print("-- SchematicaExporter (ForgeMultipart microblock parts)")
	var ws := VoxelWorld.workspace
	var lib := ws.get_or_add_library("__schem_fmp_lib__")
	var stone := lib.add_block_type("Stone")
	McId.set_registry_id(stone, "minecraft:stone", 0, "", true)
	var planks := lib.add_block_type("Planks")
	McId.set_registry_id(planks, "minecraft:planks", 2, "", true)

	var palette := ws.add_palette("__schem_fmp_pal__")
	palette.library_names = ["__schem_fmp_lib__"]
	for pair in [["Cover", "Stone"], ["Strip", "Planks"], ["Post", "Stone"],
			["Corner", "Planks"], ["Hollow", "Stone"], ["Ghost", ""]]:
		var e := PaletteEntry.new()
		e.semantic_name = pair[0]
		e.block_type_name = pair[1]
		palette.entries.append(e)

	var project: VoxelProject = ws.add_project("__schem_fmp_project__")
	project.palette_names.append("__schem_fmp_pal__")
	VoxelWorld.open(project)
	var data := project.data

	var shared := Vector3i(0, 0, 0)
	data.add_part(shared, BlockCell.make_part("Strip", "edge1", 0))
	data.add_part(shared, BlockCell.make_part("Cover", "face1", 1))
	var post_pos := Vector3i(1, 0, 0)
	data.add_part(post_pos, BlockCell.make_part("Post", "edge2", ShapeCatalog.CENTER_SLOT))
	var corner_pos := Vector3i(0, 0, 1)
	data.add_part(corner_pos, BlockCell.make_part("Corner", "corner2", 5))
	var hollow_pos := Vector3i(1, 0, 1)
	data.add_part(hollow_pos, BlockCell.make_part("Hollow", "hollow1", 3))
	var ghost_pos := Vector3i(0, 1, 0)
	data.add_part(ghost_pos, BlockCell.make_part("Ghost", "face1", 0))

	var result := SchematicaExporter.export_region(data, Vector3i(0, 0, 0), Vector3i(1, 1, 1))
	var report: Dictionary = result["report"]
	_check("4 part cells resolved", int(report["cells_written"]) == 4)
	_check("1 empty part cell (Ghost, no confirmed identity)", int(report["empty_part_cells"]) == 1)
	_check("Ghost is bucketed as unmapped", int(report["unmapped"].get("Ghost", 0)) == 1)
	_check("4 tile entities written", int(report["tile_entities"]) == 4)
	_check("the placeholder block is mapped 4 times", int(report["mapped"].get(FmpParts.WORLD_REGISTRY, 0)) == 4)

	var bytes: PackedByteArray = result["bytes"]
	var probed: Variant = SchematicaProbe.probe(bytes)
	_check("the written file parses back", probed != null)
	if probed != null:
		_check("the placeholder block shows up 4 times in the histogram",
			int(probed["histogram"].get(FmpParts.WORLD_REGISTRY, 0)) == 4)

	var size := Vector3i(2, 2, 2)
	_check("a multipart position's Data byte is 0 (real state lives in the tile entity)",
		_data_byte_at(bytes, shared, size) == 0)

	var shared_tile := _tile_at(bytes, shared)
	_check("the shared cell got a savedMultipart tile entity", str(shared_tile.get("id", {}).get("value", "")) == "savedMultipart")
	var shared_parts: Array = shared_tile["parts"]["value"] if shared_tile.has("parts") else []
	_check("it holds both parts", shared_parts.size() == 2)
	var strip_tag: Dictionary = {}
	var cover_tag: Dictionary = {}
	for p: Dictionary in shared_parts:
		if str(p["id"]["value"]) == "mcr_edge":
			strip_tag = p
		elif str(p["id"]["value"]) == "mcr_face":
			cover_tag = p
	_check("the strip saved as mcr_edge with slot 0, size 1 (shape byte 0x10)",
		not strip_tag.is_empty() and int(strip_tag["shape"]["value"]) == 0x10)
	_check("the strip's material is Planks' registry + non-zero meta suffix",
		str(strip_tag.get("material", {}).get("value", "")) == "minecraft:planks_2")
	_check("the cover saved as mcr_face with slot 1, size 1 (shape byte 0x11)",
		not cover_tag.is_empty() and int(cover_tag["shape"]["value"]) == 0x11)
	_check("the cover's material is Stone's registry, no meta suffix (meta 0)",
		str(cover_tag.get("material", {}).get("value", "")) == "minecraft:stone")

	var post_tile := _tile_at(bytes, post_pos)
	var post_parts: Array = post_tile["parts"]["value"] if post_tile.has("parts") else []
	_check("a centered post saves as its own mcr_post type",
		post_parts.size() == 1 and str(post_parts[0]["id"]["value"]) == "mcr_post")
	_check("its shape byte is size 2, axis 0 (Y) -> 0x20",
		post_parts.size() == 1 and int(post_parts[0]["shape"]["value"]) == 0x20)

	var corner_tile := _tile_at(bytes, corner_pos)
	var corner_parts: Array = corner_tile["parts"]["value"] if corner_tile.has("parts") else []
	_check("a corner saves as mcr_cnr with its slot verbatim (size 2, slot 5 -> 0x25)",
		corner_parts.size() == 1 and str(corner_parts[0]["id"]["value"]) == "mcr_cnr"
		and int(corner_parts[0]["shape"]["value"]) == 0x25)

	var hollow_tile := _tile_at(bytes, hollow_pos)
	var hollow_parts: Array = hollow_tile["parts"]["value"] if hollow_tile.has("parts") else []
	_check("a hollow face saves as mcr_hllw (size 1, slot 3 -> 0x13)",
		hollow_parts.size() == 1 and str(hollow_parts[0]["id"]["value"]) == "mcr_hllw"
		and int(hollow_parts[0]["shape"]["value"]) == 0x13)

	_check("the ghost cell got no tile entity", _tile_at(bytes, ghost_pos).is_empty())

	ws.remove_project(project.name)
	ws.remove_palette("__schem_fmp_pal__")
	ws.remove_library("__schem_fmp_lib__")

# --- SchematicaExporter (ArchitectureCraft shapes) ---------------------------

func _test_ac_shape_export() -> void:
	print("-- SchematicaExporter (ArchitectureCraft shapes)")
	var ws := VoxelWorld.workspace
	var lib := ws.get_or_add_library("__schem_ac_lib__")
	var planks := lib.add_block_type("Planks")
	McId.set_registry_id(planks, "minecraft:planks", 1, "", true)

	var palette := ws.add_palette("__schem_ac_pal__")
	palette.library_names = ["__schem_ac_lib__"]
	for pair in [["RoofMat", "Planks"], ["Undecided", ""]]:
		var e := PaletteEntry.new()
		e.semantic_name = pair[0]
		e.block_type_name = pair[1]
		palette.entries.append(e)

	var project: VoxelProject = ws.add_project("__schem_ac_project__")
	project.palette_names.append("__schem_ac_pal__")
	VoxelWorld.open(project)
	var data := project.data

	var stairs_pos := Vector3i(0, 0, 0)
	var stairs_slot := ArchShapes.make_slot(2, 1)
	data.add_part(stairs_pos, BlockCell.make_part("RoofMat", "stairs", stairs_slot))
	var ban_pos_neg := Vector3i(1, 0, 0)
	data.add_part(ban_pos_neg, BlockCell.make_part("RoofMat", "banister_plain", ArchShapes.make_slot(1, 2, true)))
	var ban_pos_pos := Vector3i(0, 0, 1)
	data.add_part(ban_pos_pos, BlockCell.make_part("RoofMat", "banister_plain", ArchShapes.make_slot(1, 2, false)))
	var undecided_pos := Vector3i(1, 0, 1)
	data.add_part(undecided_pos, BlockCell.make_part("Undecided", "roof_tile", ArchShapes.make_slot(0, 0)))

	var result := SchematicaExporter.export_region(data, Vector3i(0, 0, 0), Vector3i(1, 0, 1))
	var report: Dictionary = result["report"]
	_check("3 arch-shape cells resolved", int(report["cells_written"]) == 3)
	_check("1 empty part cell (Undecided material)", int(report["empty_part_cells"]) == 1)
	_check("the placeholder AC block is mapped 3 times", int(report["mapped"].get(AcParts.WORLD_REGISTRY, 0)) == 3)

	var bytes: PackedByteArray = result["bytes"]
	var size := Vector3i(2, 1, 2)
	_check("an AC shape position's Data byte is 0", _data_byte_at(bytes, stairs_pos, size) == 0)

	var stairs_tile := _tile_at(bytes, stairs_pos)
	_check("stairs saved as a gcewing.shape tile entity", str(stairs_tile.get("id", {}).get("value", "")) == "gcewing.shape")
	_check("Shape is stairs' real AC id (91), not ArchShapes' own table index",
		int(stairs_tile.get("Shape", {}).get("value", -1)) == AcParts.SHAPE_ID["stairs"])
	_check("side/turn match the placed slot", int(stairs_tile["side"]["value"]) == 2 and int(stairs_tile["turn"]["value"]) == 1)
	_check("BaseName/BaseData carry the resolved material",
		str(stairs_tile["BaseName"]["value"]) == "minecraft:planks" and int(stairs_tile["BaseData"]["value"]) == 1)
	_check("a non-offset shape writes no offsetX", not stairs_tile.has("offsetX"))

	var ban_neg := _tile_at(bytes, ban_pos_neg)
	_check("a banister shifted toward -X writes offsetX -6",
		ban_neg.has("offsetX") and int(ban_neg["offsetX"]["value"]) == -6)
	var ban_pos := _tile_at(bytes, ban_pos_pos)
	_check("a banister shifted toward +X writes offsetX +6",
		ban_pos.has("offsetX") and int(ban_pos["offsetX"]["value"]) == 6)

	_check("the undecided-material cell got no tile entity", _tile_at(bytes, undecided_pos).is_empty())

	ws.remove_project(project.name)
	ws.remove_palette("__schem_ac_pal__")
	ws.remove_library("__schem_ac_lib__")
