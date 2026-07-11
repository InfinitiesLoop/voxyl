class_name ToolsPanel
extends HBoxContainer

# The tool strip: pencil / build-to-me / wand / select, plus the brush-size control. It
# lives inside the Inventory screen, to the left of that screen's hotbar — changing tool
# or brush always goes through opening the inventory now, so 3D fly mode never has to
# release the mouse cursor just to switch tools. The editor chrome still shows which
# tool is active (see ActiveToolBadge) next to the always-visible hotbar; it's read-only.
#
# The strip is view-aware: buttons for tools that don't apply to the currently focused
# view are greyed out (not hidden, so it never reflows as focus moves between panes).
# It owns none of the tool state — active tool and brush size live on VoxelWorld, and
# every view/UI reads from there (Principle 2). The strip only presents + edits it.

# [Tool, glyph, label, tooltip]. Order is presentation-only; view scoping and brush use
# are resolved from VoxelWorld so the strip can never disagree with what a view will do.
const TOOLS: Array = [
	[VoxelWorld.Tool.PAINT,       "✏", "Pencil", "Pencil — right-click place, left-click clear"],
	[VoxelWorld.Tool.BUILD_TO_ME, "⇧", "Build to me", "Build to me — extrude a column from the face toward the camera"],
	[VoxelWorld.Tool.WAND,        "✦", "Wand", "Wand — grow the clicked face's connected same-type blocks by one, using the selected block"],
	[VoxelWorld.Tool.SELECT,      "⬚", "Select", "Select — right-click two opposite corners to select a cuboid region; right-click again to clear"],
]

var _group := ButtonGroup.new()
var _buttons: Array[Button] = []

# View kind the strip is scoping to — the focused pane's view ("3d"/"slice"). Set by the
# shell via set_view_kind; the first editor view is 3D.
var _view_kind := "3d"

var _brush_label: Label
var _brush_spin: SpinBox
var _syncing := false  # guards the SpinBox<->VoxelWorld round-trip from recursing

func _ready() -> void:
	add_theme_constant_override("separation", 6)

	for def in TOOLS:
		var tool_id: VoxelWorld.Tool = def[0]
		var btn := Button.new()
		btn.text = "%s\n%s" % [def[1], def[2]]
		btn.tooltip_text = def[3]
		btn.toggle_mode = true
		btn.focus_mode = Control.FOCUS_NONE
		btn.button_group = _group
		btn.custom_minimum_size = Vector2(72, 52)
		btn.add_theme_font_size_override("font_size", 14)
		btn.pressed.connect(func(): VoxelWorld.set_active_tool(tool_id))
		add_child(btn)
		_buttons.append(btn)

	add_child(VSeparator.new())
	_build_brush_section()

	VoxelWorld.tool_changed.connect(_sync)
	VoxelWorld.brush_size_changed.connect(_on_brush_size_changed)
	_apply_view_kind()

# Brush-size control: always present (so selecting a brush tool never resizes the
# strip) and just disabled for tools that don't use one.
func _build_brush_section() -> void:
	var col := VBoxContainer.new()
	col.add_theme_constant_override("separation", 2)

	_brush_label = Label.new()
	_brush_label.text = "Brush size"
	_brush_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_brush_label.add_theme_font_size_override("font_size", 11)
	col.add_child(_brush_label)

	_brush_spin = SpinBox.new()
	_brush_spin.min_value = 1
	_brush_spin.max_value = VoxelWorld.BRUSH_SIZE_MAX
	_brush_spin.step = 1
	_brush_spin.value = VoxelWorld.brush_size
	_brush_spin.value_changed.connect(func(v: float):
		if not _syncing:
			VoxelWorld.set_brush_size(int(v)))
	col.add_child(_brush_spin)

	add_child(col)

# Focus moved to a view of this kind: switch off any tool it can't run, then grey the
# rest. Called by the shell on focus/tab changes.
func set_view_kind(kind: String) -> void:
	if kind.is_empty() or kind == _view_kind:
		return
	_view_kind = kind
	_apply_view_kind()

func _apply_view_kind() -> void:
	# If the active tool isn't valid here, fall back to this view's default so the strip
	# never shows an active-but-greyed tool (and no view is stuck with a no-op tool).
	if not VoxelWorld.tool_supports_view(VoxelWorld.active_tool, _view_kind):
		VoxelWorld.set_active_tool(_default_tool())
	for i in _buttons.size():
		_buttons[i].disabled = not VoxelWorld.tool_supports_view(TOOLS[i][0], _view_kind)
	_sync(VoxelWorld.active_tool)

func _default_tool() -> VoxelWorld.Tool:
	for def in TOOLS:
		if VoxelWorld.tool_supports_view(def[0], _view_kind):
			return def[0]
	return VoxelWorld.Tool.PAINT

func _sync(tool: VoxelWorld.Tool) -> void:
	for i in _buttons.size():
		_buttons[i].button_pressed = (TOOLS[i][0] == tool)
	# Brush controls stay put; they just enable/grey with whether the tool uses a brush.
	var uses_brush := VoxelWorld.tool_uses_brush(tool)
	_brush_spin.editable = uses_brush
	var dim := 1.0 if uses_brush else 0.4
	_brush_spin.modulate = Color(1, 1, 1, dim)
	_brush_label.modulate = Color(1, 1, 1, dim)

func _on_brush_size_changed(new_size: int) -> void:
	_syncing = true
	_brush_spin.value = new_size
	_syncing = false
