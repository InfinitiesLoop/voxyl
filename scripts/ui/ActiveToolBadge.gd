class_name ActiveToolBadge
extends PanelContainer

# A read-only glance at the active tool, shown next to the hotbar in the editor chrome.
# The tool itself can only be changed from the Inventory screen's tool strip (see
# ToolsPanel) — this badge exists so 3D fly mode still shows which tool is live without
# having to open the inventory. Purely a lens on VoxelWorld.active_tool (Principle 2).

var _glyph: Label
var _name: Label

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE

	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(1, 1, 1, 0.06)
	sb.set_corner_radius_all(6)
	sb.set_content_margin_all(8)
	add_theme_stylebox_override("panel", sb)

	var col := VBoxContainer.new()
	col.add_theme_constant_override("separation", 2)
	col.alignment = BoxContainer.ALIGNMENT_CENTER
	add_child(col)

	_glyph = Label.new()
	_glyph.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_glyph.add_theme_font_size_override("font_size", 18)
	col.add_child(_glyph)

	_name = Label.new()
	_name.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_name.add_theme_font_size_override("font_size", 11)
	_name.modulate = Color(1, 1, 1, 0.75)
	col.add_child(_name)

	VoxelWorld.tool_changed.connect(_on_tool_changed)
	_on_tool_changed(VoxelWorld.active_tool)

func _on_tool_changed(tool: VoxelWorld.Tool) -> void:
	for def in ToolsPanel.TOOLS:
		if def[0] == tool:
			_glyph.text = def[1]
			_name.text = def[2]
			return
