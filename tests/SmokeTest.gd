extends Node

var _pass := 0
var _fail := 0

func _ready() -> void:
	print("\n=== voxyl smoke test ===\n")
	_test_workspace_init()
	_test_block_ops()
	_test_palette_resolution()
	_test_last_wins()
	_test_orientation()
	_test_cell_orientation_tags()
	_test_hotbar()
	_test_shapes()
	_test_reorient()
	print("\n%d passed, %d failed" % [_pass, _fail])
	get_tree().quit(1 if _fail > 0 else 0)

func _check(label: String, condition: bool) -> void:
	if condition:
		print("  ok   %s" % label)
		_pass += 1
	else:
		print("  FAIL %s" % label)
		_fail += 1

func _test_workspace_init() -> void:
	print("-- workspace init")
	_check("workspace exists", VoxelWorld.workspace != null)
	_check("block types populated", VoxelWorld.workspace.block_types.size() > 0)
	_check("default palette exists", VoxelWorld.workspace.get_palette("Default") != null)
	var project := VoxelWorld.workspace.get_project("My First Build")
	_check("default project exists", project != null)
	_check("project has palette stack", project != null and not project.palette_names.is_empty())

func _test_block_ops() -> void:
	print("-- block ops")
	var project := VoxelWorld.workspace.get_project("My First Build")
	VoxelWorld.open(project)
	VoxelWorld.set_block(Vector3i(0, 0, 0), "Base")
	_check("set block", VoxelWorld.get_block(Vector3i(0, 0, 0)) == "Base")
	VoxelWorld.clear_block(Vector3i(0, 0, 0))
	_check("clear block", VoxelWorld.get_block(Vector3i(0, 0, 0)) == "")
	# Coordinates are unbounded by design: far-flung and negative positions are valid.
	VoxelWorld.set_block(Vector3i(100, 100, 100), "Base")
	_check("far-flung coords stored", VoxelWorld.get_block(Vector3i(100, 100, 100)) == "Base")
	VoxelWorld.set_block(Vector3i(-50, -50, -50), "Base")
	_check("negative coords stored", VoxelWorld.get_block(Vector3i(-50, -50, -50)) == "Base")
	VoxelWorld.clear_block(Vector3i(100, 100, 100))
	VoxelWorld.clear_block(Vector3i(-50, -50, -50))

func _test_palette_resolution() -> void:
	print("-- palette resolution")
	var project := VoxelWorld.workspace.get_project("My First Build")
	VoxelWorld.open(project)
	_check("merged semantic names non-empty", VoxelWorld.merged_semantic_names().size() > 0)
	var fallback := Color(0.35, 0.35, 0.35)
	_check("known semantic resolves color", VoxelWorld.get_color_for_semantic("Base") != fallback)
	_check("unknown semantic gets fallback", VoxelWorld.get_color_for_semantic("__nope__") == fallback)
	_check("block type resolved", not VoxelWorld.get_block_type_for_semantic("Base").is_empty())
	_check("unknown block type is empty", VoxelWorld.get_block_type_for_semantic("__nope__") == "")

func _test_last_wins() -> void:
	print("-- last-wins palette layering")
	var ws := VoxelWorld.workspace
	var project := ws.get_project("My First Build")
	var diamond := ws.add_block_type("Diamond Block")
	diamond.color = Color.CYAN
	var override := ws.add_palette("__test_override__")
	var e := PaletteEntry.new()
	e.semantic_name = "Base"
	e.block_type_name = "Diamond Block"
	override.entries.append(e)
	project.palette_names.append("__test_override__")
	VoxelWorld.open(project)
	_check("last-wins block type", VoxelWorld.get_block_type_for_semantic("Base") == "Diamond Block")
	_check("last-wins color", VoxelWorld.get_color_for_semantic("Base") == Color.CYAN)
	_check("non-overridden entry still resolves", not VoxelWorld.get_block_type_for_semantic("Accent").is_empty())
	project.palette_names.pop_back()
	ws.remove_palette("__test_override__")
	ws.remove_block_type("Diamond Block")

func _test_orientation() -> void:
	print("-- orientation encoding")
	var o := Orientation.make(Orientation.Facing.EAST, true)
	_check("facing round-trips", Orientation.facing_of(o) == Orientation.Facing.EAST)
	_check("top flag round-trips", Orientation.is_top(o))
	_check("dir of east is +X", Orientation.dir_of(o) == Vector3i(1, 0, 0))
	_check("rotate cw N→E", Orientation.facing_of(
		Orientation.rotate_cw(Orientation.make(Orientation.Facing.NORTH))) == Orientation.Facing.EAST)
	_check("rotate keeps top flag", Orientation.is_top(Orientation.rotate_cw(o)))
	_check("from_dir picks dominant axis",
		Orientation.from_dir(Vector3(0.1, 0.0, -0.9)) == Orientation.Facing.NORTH)
	_check("toggle_top flips", not Orientation.is_top(Orientation.toggle_top(o)))

func _test_cell_orientation_tags() -> void:
	print("-- cell orientation + tags")
	var project := VoxelWorld.workspace.get_project("My First Build")
	VoxelWorld.open(project)
	var face := Orientation.make(Orientation.Facing.SOUTH, false)
	VoxelWorld.set_block(Vector3i(3, 3, 3), "Base", face)
	_check("orientation stored on cell", project.data.get_orientation(Vector3i(3, 3, 3)) == face)
	var cell := project.data.get_cell(Vector3i(3, 3, 3))
	_check("cell exposes type + orientation",
		cell != null and cell.type_id == "Base" and cell.orientation == face)
	cell.tags["note"] = "hello"
	_check("cell carries open-ended tags",
		project.data.get_cell(Vector3i(3, 3, 3)).tags.get("note", "") == "hello")
	VoxelWorld.clear_block(Vector3i(3, 3, 3))
	_check("cleared cell is gone", project.data.get_cell(Vector3i(3, 3, 3)) == null)

func _test_hotbar() -> void:
	print("-- hotbar")
	var project := VoxelWorld.workspace.get_project("My First Build")
	VoxelWorld.open(project)
	_check("hotbar has 9 slots", VoxelWorld.hotbar.size() == VoxelWorld.HOTBAR_SIZE)
	_check("hotbar seeded from palette", not VoxelWorld.hotbar[0].is_empty())
	VoxelWorld.set_hotbar_slot(2, "Trim")
	VoxelWorld.select_slot(2)
	_check("select_slot drives selection", VoxelWorld.selected_semantic == "Trim")
	_check("active slot tracked", VoxelWorld.active_slot == 2)
	# Pick an item already on the bar → jump to its slot, don't duplicate.
	VoxelWorld.set_hotbar_slot(5, "Roof")
	VoxelWorld.pick_block("Roof")
	_check("pick_block jumps to existing slot", VoxelWorld.active_slot == 5)
	# Pick a fresh item → lands in the active slot.
	VoxelWorld.select_slot(7)
	VoxelWorld.pick_block("Floor")
	_check("pick_block fills active slot", VoxelWorld.hotbar[7] == "Floor")

func _test_shapes() -> void:
	print("-- shape resolution")
	var project := VoxelWorld.workspace.get_project("My First Build")
	VoxelWorld.open(project)
	_check("stairs semantic resolves to STAIRS",
		VoxelWorld.get_shape_for_semantic("Stairs") == BlockType.Shape.STAIRS)
	_check("slab semantic resolves to SLAB",
		VoxelWorld.get_shape_for_semantic("Slab") == BlockType.Shape.SLAB)
	_check("plain semantic resolves to FULL",
		VoxelWorld.get_shape_for_semantic("Base") == BlockType.Shape.FULL)

func _test_reorient() -> void:
	print("-- reorient existing cells (R / Shift+R)")
	var project := VoxelWorld.workspace.get_project("My First Build")
	VoxelWorld.open(project)
	var p := Vector3i(4, 4, 4)
	VoxelWorld.set_block(p, "Stairs", Orientation.make(Orientation.Facing.NORTH, false))
	VoxelWorld.reorient_block(p, Orientation.make(Orientation.Facing.EAST, true))
	var cell := project.data.get_cell(p)
	_check("reorient updates facing", Orientation.facing_of(cell.orientation) == Orientation.Facing.EAST)
	_check("reorient updates top flag", Orientation.is_top(cell.orientation))
	_check("reorient keeps the same block type", cell.type_id == "Stairs")
	# Re-orienting an empty cell is a harmless no-op (never creates a block).
	VoxelWorld.reorient_block(Vector3i(40, 40, 40), Orientation.make(Orientation.Facing.WEST))
	_check("reorient of empty cell creates nothing", project.data.get_cell(Vector3i(40, 40, 40)) == null)
	VoxelWorld.clear_block(p)
