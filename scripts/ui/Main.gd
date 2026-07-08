extends Control

@onready var _home: Control = $HomeScreen
@onready var _editor: Control = $Editor
@onready var _project_label: Label = $Editor/VBoxContainer/EditorBar/LayoutLabel
@onready var _bar: HBoxContainer = $Editor/VBoxContainer/EditorBar
@onready var _content: HBoxContainer = $Editor/VBoxContainer/ContentArea
@onready var _shell: MultiViewShell = $Editor/VBoxContainer/ContentArea/ViewShell

var _inventory: InventoryScreen

# EditorBar undo/redo buttons; enabled/disabled from VoxelWorld.history_changed.
var _undo_btn: Button
var _redo_btn: Button

func _ready() -> void:
	($HomeScreen as HomeScreen).open_project_requested.connect(_open_editor)
	($Editor/VBoxContainer/EditorBar/BackBtn as Button).pressed.connect(_go_home)
	_build_layout_controls()
	_build_tool_rail()
	_build_inventory()
	# Reflect undo/redo availability in the toolbar buttons whenever the history moves or
	# a different project opens.
	VoxelWorld.history_changed.connect(_refresh_history_buttons)
	VoxelWorld.project_opened.connect(func(_p): _refresh_history_buttons())
	_refresh_history_buttons()
	_go_home()

# App-level edit shortcuts: Ctrl/Cmd+Z undo, Ctrl+Shift+Z or Ctrl+Y redo. Handled in
# _shortcut_input (before UI focus navigation, after a view could consume it — no view
# binds these), and only while the editor is up. Undo/redo route through VoxelWorld so the
# active project's history is the single source of truth (Principle 2).
func _shortcut_input(event: InputEvent) -> void:
	if not _editor.visible or not (event is InputEventKey):
		return
	var key := event as InputEventKey
	if not key.pressed or key.echo or not (key.ctrl_pressed or key.meta_pressed):
		return
	match key.keycode:
		KEY_Z:
			if key.shift_pressed:
				VoxelWorld.redo()
			else:
				VoxelWorld.undo()
			get_viewport().set_input_as_handled()
		KEY_Y:
			VoxelWorld.redo()
			get_viewport().set_input_as_handled()

func _refresh_history_buttons() -> void:
	if _undo_btn != null:
		_undo_btn.disabled = not VoxelWorld.can_undo()
	if _redo_btn != null:
		_redo_btn.disabled = not VoxelWorld.can_redo()

# The inventory overlay is editor chrome that sits above everything (incl. the
# hotbar). Opening it suspends the active view's input — and any 3D fly capture —
# restoring it on close so editing resumes in place.
func _build_inventory() -> void:
	_inventory = InventoryScreen.new()
	add_child(_inventory)
	_inventory.opened.connect(func(): _shell.set_views_suspended(true))
	_inventory.closed.connect(func(): _shell.set_views_suspended(false))

func _go_home() -> void:
	# Flush the build (voxels, layout, hotbar) before leaving the editor so nothing is
	# lost when returning to the home screen.
	VoxelWorld.save_active_project()
	if _inventory:
		_inventory.set_armed(false)  # also closes it if open
	_home.visible = true
	_editor.visible = false

# Persist the open project on app close (the debounce timer may not have fired yet).
func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		VoxelWorld.save_active_project()

func _open_editor(project: VoxelProject) -> void:
	VoxelWorld.open(project)
	_project_label.text = project.name
	_home.visible = false
	_editor.visible = true
	_inventory.set_armed(true)

# Pane + tiling commands live in the EditorBar and act on the focused pane.
func _build_layout_controls() -> void:
	_bar.add_child(VSeparator.new())
	_undo_btn = _add_bar_button("↶ Undo", func(): VoxelWorld.undo())
	_redo_btn = _add_bar_button("↷ Redo", func(): VoxelWorld.redo())
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

# The left tool rail lives in the content area, before the view shell (which keeps
# expand-filling the rest). It scopes its tools to whichever view has focus, so we feed
# it the shell's focus changes — plus the current kind once, since the shell's initial
# focus fired during its own _ready, before this connection existed.
func _build_tool_rail() -> void:
	var rail := ToolsPanel.new()
	_content.add_child(rail)
	_content.move_child(rail, 0)
	_shell.focus_changed.connect(rail.set_view_kind)
	rail.set_view_kind(_shell.focused_view_kind())

func _add_bar_button(text: String, cb: Callable) -> Button:
	var b := Button.new()
	b.text = text
	b.focus_mode = Control.FOCUS_NONE
	b.pressed.connect(cb)
	_bar.add_child(b)
	return b
