extends Control

@onready var _home: Control = $HomeScreen
@onready var _editor: Control = $Editor
@onready var _project_label: Label = $Editor/VBoxContainer/EditorBar/LayoutLabel
@onready var _bar: HBoxContainer = $Editor/VBoxContainer/EditorBar
@onready var _shell: MultiViewShell = $Editor/VBoxContainer/ContentArea/ViewShell

var _inventory: InventoryScreen

func _ready() -> void:
	($HomeScreen as HomeScreen).open_project_requested.connect(_open_editor)
	($Editor/VBoxContainer/EditorBar/BackBtn as Button).pressed.connect(_go_home)
	_build_layout_controls()
	_build_inventory()
	_go_home()

# The inventory overlay is editor chrome that sits above everything (incl. the
# hotbar). Opening it suspends the active view's input — and any 3D fly capture —
# restoring it on close so editing resumes in place.
func _build_inventory() -> void:
	_inventory = InventoryScreen.new()
	add_child(_inventory)
	_inventory.opened.connect(func(): _shell.set_views_suspended(true))
	_inventory.closed.connect(func(): _shell.set_views_suspended(false))

func _go_home() -> void:
	if _inventory:
		_inventory.set_armed(false)  # also closes it if open
	_home.visible = true
	_editor.visible = false

func _open_editor(project: VoxelProject) -> void:
	VoxelWorld.open(project)
	_project_label.text = project.name
	_home.visible = false
	_editor.visible = true
	_inventory.set_armed(true)

# Pane + tiling commands live in the EditorBar and act on the focused pane.
func _build_layout_controls() -> void:
	_bar.add_child(VSeparator.new())
	_add_bar_button("Split ⬍", func(): _shell.split_focused(true))
	_add_bar_button("Split ⬌", func(): _shell.split_focused(false))
	_add_bar_button("Close Pane", func(): _shell.close_focused_pane())
	_add_bar_button("+ 3D", func(): _shell.add_3d_view_to_focused())
	_bar.add_child(VSeparator.new())
	_add_bar_button("Single", func(): _shell.apply_preset(MultiViewShell.Preset.SINGLE))
	_add_bar_button("Cols", func(): _shell.apply_preset(MultiViewShell.Preset.COLUMNS))
	_add_bar_button("Rows", func(): _shell.apply_preset(MultiViewShell.Preset.ROWS))
	_add_bar_button("2×2", func(): _shell.apply_preset(MultiViewShell.Preset.GRID))

func _add_bar_button(text: String, cb: Callable) -> void:
	var b := Button.new()
	b.text = text
	b.focus_mode = Control.FOCUS_NONE
	b.pressed.connect(cb)
	_bar.add_child(b)
