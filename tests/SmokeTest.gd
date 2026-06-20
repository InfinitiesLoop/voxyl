extends Node

var _pass := 0
var _fail := 0

func _ready() -> void:
	print("\n=== voxyl smoke test ===\n")
	_test_workspace_init()
	_test_block_ops()
	_test_palette_resolution()
	_test_last_wins()
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
	var layout := VoxelWorld.workspace.get_layout("My First Build")
	_check("default layout exists", layout != null)
	_check("layout has palette stack", layout != null and not layout.palette_names.is_empty())

func _test_block_ops() -> void:
	print("-- block ops")
	var layout := VoxelWorld.workspace.get_layout("My First Build")
	VoxelWorld.open(layout)
	VoxelWorld.set_block(Vector3i(0, 0, 0), "Base")
	_check("set block", VoxelWorld.get_block(Vector3i(0, 0, 0)) == "Base")
	VoxelWorld.clear_block(Vector3i(0, 0, 0))
	_check("clear block", VoxelWorld.get_block(Vector3i(0, 0, 0)) == "")
	VoxelWorld.set_block(Vector3i(100, 100, 100), "Base")
	_check("out-of-bounds rejected", VoxelWorld.get_block(Vector3i(100, 100, 100)) == "")

func _test_palette_resolution() -> void:
	print("-- palette resolution")
	var layout := VoxelWorld.workspace.get_layout("My First Build")
	VoxelWorld.open(layout)
	_check("merged semantic names non-empty", VoxelWorld.merged_semantic_names().size() > 0)
	var fallback := Color(0.35, 0.35, 0.35)
	_check("known semantic resolves color", VoxelWorld.get_color_for_semantic("Base") != fallback)
	_check("unknown semantic gets fallback", VoxelWorld.get_color_for_semantic("__nope__") == fallback)
	_check("block type resolved", not VoxelWorld.get_block_type_for_semantic("Base").is_empty())
	_check("unknown block type is empty", VoxelWorld.get_block_type_for_semantic("__nope__") == "")

func _test_last_wins() -> void:
	print("-- last-wins palette layering")
	var ws := VoxelWorld.workspace
	var layout := ws.get_layout("My First Build")
	var override := ws.add_palette("__test_override__")
	var e := PaletteEntry.new()
	e.semantic_name = "Base"
	e.block_type_name = "Diamond Block"
	e.color = Color.CYAN
	override.entries.append(e)
	layout.palette_names.append("__test_override__")
	VoxelWorld.open(layout)
	_check("last-wins block type", VoxelWorld.get_block_type_for_semantic("Base") == "Diamond Block")
	_check("last-wins color", VoxelWorld.get_color_for_semantic("Base") == Color.CYAN)
	_check("non-overridden entry still resolves", not VoxelWorld.get_block_type_for_semantic("Accent").is_empty())
	# cleanup
	layout.palette_names.pop_back()
	ws.remove_palette("__test_override__")
