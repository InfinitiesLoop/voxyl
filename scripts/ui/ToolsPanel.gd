class_name ToolsPanel
extends VBoxContainer

const _TOOLS: Array = [
	[VoxelWorld.Tool.PAINT, "✏", "Paint"],
	[VoxelWorld.Tool.ERASE, "✕", "Erase"],
	[VoxelWorld.Tool.LINE,  "╱", "Line"],
	[VoxelWorld.Tool.RECT,  "▭", "Rectangle"],
	[VoxelWorld.Tool.FILL,  "◈", "Fill"],
]

var _group := ButtonGroup.new()
var _buttons: Array[Button] = []

func _ready() -> void:
	var label := Label.new()
	label.text = "Tools"
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.add_theme_font_size_override("font_size", 11)
	add_child(label)

	var sep := HSeparator.new()
	add_child(sep)

	for def in _TOOLS:
		var tool_id: VoxelWorld.Tool = def[0]
		var btn := Button.new()
		btn.text = def[1]
		btn.tooltip_text = def[2]
		btn.toggle_mode = true
		btn.button_group = _group
		btn.button_pressed = (tool_id == VoxelWorld.active_tool)
		btn.custom_minimum_size = Vector2(52, 40)
		btn.pressed.connect(func(): VoxelWorld.set_active_tool(tool_id))
		add_child(btn)
		_buttons.append(btn)

	VoxelWorld.tool_changed.connect(_sync)

func _sync(tool: VoxelWorld.Tool) -> void:
	for i in _buttons.size():
		_buttons[i].button_pressed = (_TOOLS[i][0] == tool)
