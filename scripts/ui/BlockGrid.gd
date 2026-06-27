class_name BlockGrid
extends VBoxContainer

# JEI-style block browser: a scrollable flow of fixed-size isometric icons with a
# live search box pinned at the bottom. A pure lens on the block-type library — it
# draws icons via BlockIconRender and emits the clicked name; it owns no data and
# never touches voxel data.

signal block_selected(block_name: String)

const CELL_SIZE := Vector2(50, 50)

var _flow: HFlowContainer
var _search: LineEdit
var _block_types: Array = []   # Array[BlockType], as handed to populate()
var _selected: String = ""

func _ready() -> void:
	var scroll := ScrollContainer.new()
	scroll.size_flags_horizontal = SIZE_EXPAND_FILL
	scroll.size_flags_vertical = SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	add_child(scroll)

	_flow = HFlowContainer.new()
	_flow.size_flags_horizontal = SIZE_EXPAND_FILL
	_flow.add_theme_constant_override("h_separation", 3)
	_flow.add_theme_constant_override("v_separation", 3)
	scroll.add_child(_flow)

	_search = LineEdit.new()
	_search.placeholder_text = "Search blocks…"
	_search.clear_button_enabled = true
	_search.text_changed.connect(_apply_filter)
	add_child(_search)

	if not _block_types.is_empty():
		_rebuild_cells("")

# Replace the grid's contents. Re-applies the current search text so a refresh
# (e.g. after an edit or import) keeps any active filter.
func populate(block_types: Array) -> void:
	_block_types = block_types
	if _flow:
		_rebuild_cells(_search.text)

# Highlight a block by name (no signal). Called by the detail panel so external
# selection and in-grid clicks stay in sync.
func set_selected(block_name: String) -> void:
	if _selected == block_name:
		return
	_selected = block_name
	if _flow:
		for cell in _flow.get_children():
			cell.queue_redraw()

func _apply_filter(text: String) -> void:
	_rebuild_cells(text)

func _rebuild_cells(filter: String) -> void:
	for c in _flow.get_children():
		c.queue_free()
	var needle := filter.strip_edges().to_lower()
	for bt in _block_types:
		if needle.is_empty() or bt.name.to_lower().contains(needle):
			_flow.add_child(_make_cell(bt))

func _make_cell(bt: BlockType) -> Control:
	var cell := Control.new()
	cell.custom_minimum_size = CELL_SIZE
	cell.tooltip_text = bt.name
	# Pixel art stays crisp; BlockIconRender draws texture quads onto this canvas item.
	cell.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	cell.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	cell.draw.connect(func(): _draw_cell(cell, bt))
	cell.gui_input.connect(func(ev: InputEvent): _on_cell_input(ev, bt))
	return cell

func _draw_cell(cell: Control, bt: BlockType) -> void:
	# No cell-slot background — the icons read as a clean grid of blocks. Only the
	# selected cell gets a highlight (subtle fill + border).
	var faces := BlockIconRender.resolve_faces(bt, VoxelWorld.workspace)
	BlockIconRender.draw_iso(cell, cell.size, faces, bt.shape)
	if bt.name == _selected:
		var rect := Rect2(Vector2.ZERO, cell.size)
		cell.draw_rect(rect, Color(0.40, 0.80, 1.0, 0.18))
		cell.draw_rect(rect, Color(0.40, 0.80, 1.0, 0.90), false, 2.0)

func _on_cell_input(ev: InputEvent, bt: BlockType) -> void:
	if ev is InputEventMouseButton and (ev as InputEventMouseButton).button_index == MOUSE_BUTTON_LEFT \
			and (ev as InputEventMouseButton).pressed:
		set_selected(bt.name)
		block_selected.emit(bt.name)
