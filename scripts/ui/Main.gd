extends Control

@onready var _home: Control = $HomeScreen
@onready var _editor: Control = $Editor
@onready var _editor_bar_label: Label = $Editor/VBoxContainer/EditorBar/LayoutLabel
@onready var _palette_label: Label = $Editor/VBoxContainer/EditorBar/PaletteLabel

func _ready() -> void:
	($HomeScreen as HomeScreen).open_layout_requested.connect(_open_editor)
	($Editor/VBoxContainer/EditorBar/BackBtn as Button).pressed.connect(_go_home)
	_go_home()

func _go_home() -> void:
	_home.visible = true
	_editor.visible = false

func _open_editor(layout: VoxelLayout, palette: Palette) -> void:
	VoxelWorld.open(layout, palette)
	_editor_bar_label.text = layout.name
	_palette_label.text = palette.name
	_home.visible = false
	_editor.visible = true
