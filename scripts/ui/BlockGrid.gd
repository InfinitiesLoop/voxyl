class_name BlockGrid
extends VBoxContainer

# JEI-style block browser: a scrollable flow of fixed-size block icons with a live
# search box pinned at the bottom. A pure lens on the block-type library — it shows
# icons baked by BlockIconBaker (the real 3D render of each block) and emits the
# clicked name; it owns no data and never touches voxel data.

signal block_selected(block_name: String)

const CELL_SIZE := Vector2(50, 50)

var _flow: HFlowContainer
var _search: LineEdit
var _baker: BlockIconBaker
var _block_types: Array = []        # Array[BlockType], as handed to populate()
var _cells_by_name := {}            # block name -> Control (visible cells only)
var _selected: String = ""

func _ready() -> void:
	# The off-screen icon baker lives under the grid (it needs to be in the tree to
	# render); icon_ready redraws just the cell whose bake landed.
	_baker = BlockIconBaker.new()
	add_child(_baker)
	_baker.icon_ready.connect(_on_icon_ready)

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

# Re-bake icons after a block edit. With a name, only that block's icon is dropped
# and redrawn; with none, the whole library re-bakes (rarely needed — structural
# changes already invalidate the baker via workspace_changed).
func refresh_icons(block_name := "") -> void:
	if not _baker:
		return
	if block_name.is_empty():
		_baker.invalidate_all()
		for cell in _flow.get_children():
			cell.queue_redraw()
	else:
		_baker.invalidate(block_name)
		if _cells_by_name.has(block_name):
			_cells_by_name[block_name].queue_redraw()

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
	_cells_by_name.clear()
	var needle := filter.strip_edges().to_lower()
	for bt in _block_types:
		if needle.is_empty() or bt.name.to_lower().contains(needle):
			var cell := _make_cell(bt)
			_cells_by_name[bt.name] = cell
			_flow.add_child(cell)

func _make_cell(bt: BlockType) -> Control:
	var cell := Control.new()
	cell.custom_minimum_size = CELL_SIZE
	cell.tooltip_text = bt.name
	# Pixel art stays crisp when the baked icon is drawn down into the cell.
	cell.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	cell.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	cell.draw.connect(func(): _draw_cell(cell, bt))
	cell.gui_input.connect(func(ev: InputEvent): _on_cell_input(ev, bt))
	return cell

func _draw_cell(cell: Control, bt: BlockType) -> void:
	# No cell-slot background — the icons read as a clean grid of blocks.
	var icon := _baker.icon_for(bt)
	if icon != null:
		cell.draw_texture_rect(icon, Rect2(Vector2.ZERO, cell.size), false)
	else:
		_draw_placeholder(cell, bt)
	if bt.name == _selected:
		var rect := Rect2(Vector2.ZERO, cell.size)
		cell.draw_rect(rect, Color(0.40, 0.80, 1.0, 0.18))
		cell.draw_rect(rect, Color(0.40, 0.80, 1.0, 0.90), false, 2.0)

# Shown while a bake is pending: a faint centered swatch of the block's planning
# color, so the cell hints at the block (and its undecided color) without flashing.
func _draw_placeholder(cell: Control, bt: BlockType) -> void:
	var inset := cell.size * 0.22
	var rect := Rect2(inset, cell.size - inset * 2.0)
	cell.draw_rect(rect, Color(bt.color.r, bt.color.g, bt.color.b, 0.35))

func _on_icon_ready(block_name: String) -> void:
	if _cells_by_name.has(block_name):
		_cells_by_name[block_name].queue_redraw()

func _on_cell_input(ev: InputEvent, bt: BlockType) -> void:
	if ev is InputEventMouseButton and (ev as InputEventMouseButton).button_index == MOUSE_BUTTON_LEFT \
			and (ev as InputEventMouseButton).pressed:
		set_selected(bt.name)
		block_selected.emit(bt.name)
