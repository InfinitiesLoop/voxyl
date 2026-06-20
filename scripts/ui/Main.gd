extends Control

@onready var _home: Control = $HomeScreen
@onready var _editor: Control = $Editor
@onready var _layout_label: Label = $Editor/VBoxContainer/EditorBar/LayoutLabel

func _ready() -> void:
	($HomeScreen as HomeScreen).open_layout_requested.connect(_open_editor)
	($Editor/VBoxContainer/EditorBar/BackBtn as Button).pressed.connect(_go_home)
	_go_home()

func _go_home() -> void:
	_home.visible = true
	_editor.visible = false

func _open_editor(layout: VoxelLayout) -> void:
	VoxelWorld.open(layout)
	_layout_label.text = layout.name
	_home.visible = false
	_editor.visible = true
