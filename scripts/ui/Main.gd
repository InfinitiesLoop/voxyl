extends Control

@onready var _home: Control = $HomeScreen
@onready var _editor: Control = $Editor
@onready var _project_label: Label = $Editor/VBoxContainer/EditorBar/LayoutLabel
@onready var _tabs: TabContainer = $Editor/VBoxContainer/ContentArea/TabContainer

func _ready() -> void:
	($HomeScreen as HomeScreen).open_project_requested.connect(_open_editor)
	($Editor/VBoxContainer/EditorBar/BackBtn as Button).pressed.connect(_go_home)
	_tabs.set_tab_title(0, "2D Slice")
	_tabs.set_tab_title(1, "3D")
	_tabs.current_tab = 1  # default to 3D view
	_go_home()

func _go_home() -> void:
	_home.visible = true
	_editor.visible = false

func _open_editor(project: VoxelProject) -> void:
	VoxelWorld.open(project)
	_project_label.text = project.name
	_home.visible = false
	_editor.visible = true
