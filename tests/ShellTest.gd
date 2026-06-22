extends Node

# Headless structural test for MultiViewShell — exercises the tree surgery
# (split / collapse / presets / spawning) that can't be eyeballed, asserting
# pane and view counts. Run as a scene so the VoxelWorld autoload is present.

var _pass := 0
var _fail := 0

func _ready() -> void:
	print("\n=== voxyl shell test ===\n")
	await _run()
	print("\n%d passed, %d failed" % [_pass, _fail])
	get_tree().quit(1 if _fail > 0 else 0)

func _check(label: String, condition: bool) -> void:
	if condition:
		print("  ok   %s" % label)
		_pass += 1
	else:
		print("  FAIL %s" % label)
		_fail += 1

func _run() -> void:
	VoxelWorld.open(VoxelWorld.workspace.get_project("My First Build"))

	var shell := MultiViewShell.new()
	shell.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(shell)
	await get_tree().process_frame

	_check("starts with four panes (default 2×2)", _panes(shell).size() == 4)
	_check("starts with one (3D) view", _views(shell).size() == 1)

	# Oriented + shaped cells must rebuild in 3D without error (stairs/slab meshes).
	VoxelWorld.set_block(Vector3i(0, 0, 0), "Stairs",
		Orientation.make(Orientation.Facing.EAST, true))
	VoxelWorld.set_block(Vector3i(0, 1, 0), "Slab")
	var v3d: Node = _views(shell)[0]
	v3d._rebuild()
	_check("3D rebuild keeps a node for an oriented stairs cell",
		(v3d.get("_cell_nodes") as Dictionary).has(Vector3i(0, 0, 0)))
	VoxelWorld.clear_block(Vector3i(0, 0, 0))
	VoxelWorld.clear_block(Vector3i(0, 1, 0))

	var tb := (_panes(shell)[0] as ViewPane).get_tab_bar()
	_check("tab bar enables cross-pane drag",
		tb.drag_to_rearrange_enabled and tb.tabs_rearrange_group == ViewPane.REARRANGE_GROUP)

	shell.apply_preset(MultiViewShell.Preset.GRID)
	await get_tree().process_frame
	_check("2x2 preset → 4 panes", _panes(shell).size() == 4)
	_check("preset keeps the open view", _views(shell).size() == 1)

	VoxelWorld.request_slice_view(1, Vector3i(0, 0, 0))
	VoxelWorld.request_slice_view(0, Vector3i(2, 3, 4))
	await get_tree().process_frame
	_check("two slices spawned → 3 views", _views(shell).size() == 3)

	shell.split_focused(false)
	await get_tree().process_frame
	_check("split focused → 5 panes", _panes(shell).size() == 5)

	shell.close_focused_pane()
	await get_tree().process_frame
	await get_tree().process_frame
	_check("close empty pane collapses → 4 panes", _panes(shell).size() == 4)
	_check("views survive collapse", _views(shell).size() == 3)

	shell.apply_preset(MultiViewShell.Preset.SINGLE)
	await get_tree().process_frame
	_check("single preset → 1 pane", _panes(shell).size() == 1)
	_check("single retains all 3 views as tabs", _views(shell).size() == 3)

	# Focus gating: only the focused pane's current view is active.
	shell.apply_preset(MultiViewShell.Preset.COLUMNS)
	await get_tree().process_frame
	var panes := _panes(shell)
	_check("columns → 2 panes", panes.size() == 2)
	_check("exactly one active view across panes", _count_active(shell) == 1)
	shell._set_focus(panes[1])
	await get_tree().process_frame
	_check("refocus keeps exactly one active", _count_active(shell) == 1)
	_check("the focused pane's current view is the active one",
		panes[1].get_current_tab_control()._active)

	# The focused 2D slice projects a guide into every other view.
	_check("focused 2D slice projects a guide into the others",
		not (panes[0].get_tab_control(0).get("_guide") as Dictionary).is_empty())
	_check("the active view shows no guide of itself",
		(panes[1].get_current_tab_control().get("_guide") as Dictionary).is_empty())

	# Dropping a tab onto a pane body routes it to that pane; panes[1] has a
	# single view, so emptying it should collapse it back to one pane.
	shell.size = Vector2(900, 600)
	await get_tree().process_frame
	var src: ViewPane = panes[1]
	var dst: ViewPane = panes[0]
	var moved := src.get_tab_control(0)
	var drag := {
		"type": "tab_element",
		"from_path": src.get_tab_bar().get_path(),
		"tab_element": 0,
	}
	shell.drop_tab(drag, dst.global_position + dst.size * 0.5)
	await get_tree().process_frame
	await get_tree().process_frame
	_check("dropped tab joins the target pane", moved.get_parent() == dst)
	_check("emptied source pane collapses after drop", _panes(shell).size() == 1)
	_check("no views lost in the move", _views(shell).size() == 3)

	shell.queue_free()

func _count_active(shell: MultiViewShell) -> int:
	var n := 0
	for v in _views(shell):
		if v._active:
			n += 1
	return n

func _panes(shell: MultiViewShell) -> Array:
	return shell._all_panes()

func _views(shell: MultiViewShell) -> Array:
	return shell._all_views()
