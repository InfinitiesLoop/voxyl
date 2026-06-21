extends Control

const SliceScene = preload("res://scenes/views/View2DGrid.tscn")

@onready var _home: Control = $HomeScreen
@onready var _editor: Control = $Editor
@onready var _project_label: Label = $Editor/VBoxContainer/EditorBar/LayoutLabel
@onready var _tabs: TabContainer = $Editor/VBoxContainer/ContentArea/TabContainer

func _ready() -> void:
	($HomeScreen as HomeScreen).open_project_requested.connect(_open_editor)
	($Editor/VBoxContainer/EditorBar/BackBtn as Button).pressed.connect(_go_home)
	_tabs.set_tab_title(0, "3D")
	# Enable close buttons on dynamically-added slice tabs
	var tab_bar := _tabs.get_tab_bar()
	tab_bar.tab_close_display_policy = TabBar.CLOSE_BUTTON_SHOW_ACTIVE_ONLY
	tab_bar.tab_close_pressed.connect(_on_tab_close_pressed)
	VoxelWorld.slice_view_requested.connect(_add_slice_view)
	_go_home()

func _go_home() -> void:
	_home.visible = true
	_editor.visible = false

func _open_editor(project: VoxelProject) -> void:
	VoxelWorld.open(project)
	_project_label.text = project.name
	_home.visible = false
	_editor.visible = true

func _add_slice_view(p_axis: int, p_center: Vector3i) -> void:
	var view := SliceScene.instantiate() as View2DGrid
	view.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	view.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_tabs.add_child(view)
	view.configure(p_axis, p_center)
	var tab_idx := _tabs.get_tab_count() - 1
	var axis_label: String = (["X", "Y", "Z"] as Array)[p_axis]
	# Title carries the in-plane center so duplicate slices stay distinguishable.
	var hv := _slice_title_hv(p_axis, p_center)
	_tabs.set_tab_title(tab_idx, "%s=%d (%d,%d)" % [axis_label, p_center[p_axis], hv.x, hv.y])
	_tabs.current_tab = tab_idx

func _slice_title_hv(p_axis: int, c: Vector3i) -> Vector2i:
	match p_axis:
		0: return Vector2i(c.z, c.y)
		2: return Vector2i(c.x, c.y)
		_: return Vector2i(c.x, c.z)

func _on_tab_close_pressed(tab_idx: int) -> void:
	var child := _tabs.get_tab_control(tab_idx)
	if child == null or child is View3D:
		return  # never close the 3D view
	# Switch to 3D tab before removing so the current tab stays valid
	for i in _tabs.get_tab_count():
		if _tabs.get_tab_control(i) is View3D:
			_tabs.current_tab = i
			break
	_tabs.remove_child(child)
	child.queue_free()
