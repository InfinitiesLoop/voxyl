extends Control

@onready var _home: Control = $HomeScreen
@onready var _editor: Control = $Editor
@onready var _project_label: Label = $Editor/VBoxContainer/EditorBar/LayoutLabel
@onready var _bar: HBoxContainer = $Editor/VBoxContainer/EditorBar
@onready var _bottom: VBoxContainer = $Editor/VBoxContainer
@onready var _shell: MultiViewShell = $Editor/VBoxContainer/ContentArea/ViewShell

var _inventory: InventoryScreen

# EditorBar undo/redo buttons; enabled/disabled from VoxelWorld.history_changed.
var _undo_btn: Button
var _redo_btn: Button

func _ready() -> void:
	($HomeScreen as HomeScreen).open_project_requested.connect(_open_editor)
	($Editor/VBoxContainer/EditorBar/BackBtn as Button).pressed.connect(_go_home)
	_build_layout_controls()
	_build_inventory()
	_build_bottom_bar()
	# Reflect undo/redo availability in the toolbar buttons whenever the history moves or
	# a different project opens.
	VoxelWorld.history_changed.connect(_refresh_history_buttons)
	VoxelWorld.project_opened.connect(func(_p): _refresh_history_buttons())
	_refresh_history_buttons()
	# An agent opening a project shows the editor, as a double-click on the Home screen does.
	VoxelWorld.open_project_requested.connect(func(p: VoxelProject):
		if VoxelWorld.active_project != p:
			VoxelWorld.save_active_project()
		_open_editor(p))
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
		KEY_C:
			VoxelWorld.copy_selection()
			get_viewport().set_input_as_handled()
		KEY_X:
			VoxelWorld.cut_selection()
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
	_bar.add_child(VSeparator.new())
	_build_agent_controls()
	_add_bar_button("⚙", func(): SettingsDialog.open(self)).tooltip_text = "Settings"

# Agent presence in the editor bar: a badge while an agent is connected / building, and a
# Pause button that makes its edits fail until resumed. Hidden while connections are off.
var _agent_badge: Label
var _pause_btn: Button

func _build_agent_controls() -> void:
	_agent_badge = Label.new()
	_agent_badge.add_theme_color_override("font_color", Color(0.55, 0.85, 1.0))
	_agent_badge.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_bar.add_child(_agent_badge)
	_pause_btn = _add_bar_button("Pause agent", func(): McpServer.paused = not McpServer.paused)
	_pause_btn.toggle_mode = true
	_pause_btn.tooltip_text = "While paused, agent edits are refused (they can still look)"
	McpServer.status_changed.connect(_refresh_agent_controls)
	McpServer.call_started.connect(func(_t): _refresh_agent_controls())
	McpServer.call_finished.connect(func(_t): _refresh_agent_controls())
	_refresh_agent_controls()

func _refresh_agent_controls() -> void:
	var on := McpServer.is_listening()
	_agent_badge.visible = on
	_pause_btn.visible = on
	_pause_btn.set_pressed_no_signal(McpServer.paused)
	_pause_btn.text = "Resume agent" if McpServer.paused else "Pause agent"
	if McpServer.paused:
		_agent_badge.text = "● agent paused"
	elif McpServer.is_busy():
		_agent_badge.text = "● agent is building…"
	else:
		_agent_badge.text = "● agent connections on"

# The always-visible hotbar, with a read-only badge showing the active tool to its
# left (kept centered by Hotbar.centered_row — see there). The tool itself can only be
# changed from the Inventory screen's tool strip (_inventory.tool_strip()); that strip
# is view-aware, so we still feed it the shell's focus changes here — plus the current
# kind once, since the shell's initial focus fired during its own _ready, before this
# connection existed.
func _build_bottom_bar() -> void:
	var badge := ActiveToolBadge.new()
	var hotbar := Hotbar.new()
	_bottom.add_child(Hotbar.centered_row(badge, hotbar))
	_shell.focus_changed.connect(_inventory.tool_strip().set_view_kind)
	_inventory.tool_strip().set_view_kind(_shell.focused_view_kind())

func _add_bar_button(text: String, cb: Callable) -> Button:
	var b := Button.new()
	b.text = text
	b.focus_mode = Control.FOCUS_NONE
	b.pressed.connect(cb)
	_bar.add_child(b)
	return b
