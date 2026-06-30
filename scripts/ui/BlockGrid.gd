class_name BlockGrid
extends VBoxContainer

# JEI-style block browser: a scrollable flow of fixed-size icons with a live search box
# pinned at the bottom. A pure lens on a *collection of blocks* — each cell shows an icon
# baked by BlockIconBaker (the real 3D render of a block type) and emits the clicked item's
# key. It owns no data and never touches voxel data.
#
# It is item-based, not bespoke to block types: an Item carries a key (emitted on click), a
# search label, an optional caption drawn under the icon, and the BlockType used to bake the
# icon (or null → a planning-color placeholder). So the same grid shows raw block types
# (block_item) or palette entries (caller-built items mapping to a resolved block type).

signal item_selected(key: String)
# Back-compat: the Block Types tab listens to this; it fires alongside item_selected.
signal block_selected(block_name: String)

# A single grid cell's data. RefCounted so callers build them freely and the grid holds refs.
class Item extends RefCounted:
	var key: String                       # emitted on click; unique within the grid
	var label: String                     # tooltip + search text
	var caption: String = ""              # optional text drawn under the icon
	var block_type: BlockType = null      # baked for the icon; null → placeholder
	var placeholder_color := Color(0.5, 0.5, 0.5)

# Build an item that displays a block type directly (key/label = its name).
static func block_item(bt: BlockType) -> Item:
	var it := Item.new()
	it.key = bt.name
	it.label = bt.name
	it.block_type = bt
	it.placeholder_color = bt.color
	return it

# Per-grid look, set before populate_items: cell footprint + whether to draw captions
# (captioned cells get a taller box with a text strip beneath the icon).
var cell_size := Vector2(50, 50)
var show_captions := false

var _flow: HFlowContainer
var _search: LineEdit
var _baker: BlockIconBaker
var _items: Array = []               # Array[Item], as handed to populate_items()
var _selected: String = ""           # selected item key

const _CAPTION_H := 20.0

func _ready() -> void:
	# The off-screen icon baker lives under the grid (it needs to be in the tree to
	# render); icon_ready redraws just the cells whose bake landed.
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

	if not _items.is_empty():
		_rebuild_cells("")

# Replace the grid's contents with raw block types. Thin adapter over populate_items so the
# Block Types tab (and anything else handing in BlockTypes) is unchanged.
func populate(block_types: Array) -> void:
	var items: Array = []
	for bt in block_types:
		items.append(block_item(bt))
	populate_items(items)

# Replace the grid's contents with arbitrary items. Re-applies the current search text so a
# refresh keeps any active filter.
func populate_items(items: Array) -> void:
	_items = items
	if _flow:
		_rebuild_cells(_search.text)

# Re-bake icons after a block edit. With a name, only that block's icon is dropped and the
# cells showing it redraw; with none, the whole grid re-bakes (rarely needed — structural
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
		_redraw_cells_for_block(block_name)

# Highlight an item by key (no signal). Called by detail panels so external selection and
# in-grid clicks stay in sync.
func set_selected(key: String) -> void:
	if _selected == key:
		return
	_selected = key
	if _flow:
		for cell in _flow.get_children():
			cell.queue_redraw()

func _apply_filter(text: String) -> void:
	_rebuild_cells(text)

func _rebuild_cells(filter: String) -> void:
	for c in _flow.get_children():
		c.queue_free()
	var needle := filter.strip_edges().to_lower()
	for item in _items:
		if needle.is_empty() or item.label.to_lower().contains(needle) or item.caption.to_lower().contains(needle):
			_flow.add_child(_make_cell(item))

func _make_cell(item: Item) -> Control:
	var cell := Control.new()
	var h := cell_size.y + (_CAPTION_H if show_captions else 0.0)
	cell.custom_minimum_size = Vector2(cell_size.x, h)
	cell.tooltip_text = item.label
	# Pixel art stays crisp when the baked icon is drawn down into the cell.
	cell.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	cell.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	cell.set_meta("item", item)
	cell.draw.connect(func(): _draw_cell(cell, item))
	cell.gui_input.connect(func(ev: InputEvent): _on_cell_input(ev, item))
	return cell

func _draw_cell(cell: Control, item: Item) -> void:
	# Icon occupies a centered square in the top region; the caption strip (if any) sits below.
	var caption_h := _CAPTION_H if show_captions else 0.0
	var icon_area := Rect2(Vector2.ZERO, Vector2(cell.size.x, cell.size.y - caption_h))
	var side := minf(icon_area.size.x, icon_area.size.y)
	var off := (icon_area.size - Vector2(side, side)) * 0.5
	var icon_rect := Rect2(off, Vector2(side, side))

	var icon := _baker.icon_for(item.block_type) if item.block_type != null else null
	if icon != null:
		cell.draw_texture_rect(icon, icon_rect, false)
	else:
		_draw_placeholder(cell, item, icon_rect)

	if item.key == _selected:
		cell.draw_rect(icon_area, Color(0.40, 0.80, 1.0, 0.18))
		cell.draw_rect(icon_area, Color(0.40, 0.80, 1.0, 0.90), false, 2.0)

	if show_captions and not item.caption.is_empty():
		var font := get_theme_default_font()
		var baseline := cell.size.y - caption_h * 0.5 + 5.0
		cell.draw_string(font, Vector2(2, baseline), item.caption,
			HORIZONTAL_ALIGNMENT_CENTER, cell.size.x - 4, 11)

# Shown while a bake is pending (or for an unmapped item): a faint centered swatch of the
# item's planning color, so the cell hints at the block without flashing.
func _draw_placeholder(cell: Control, item: Item, area: Rect2) -> void:
	var inset := area.size * 0.22
	var rect := Rect2(area.position + inset, area.size - inset * 2.0)
	var c := item.placeholder_color
	cell.draw_rect(rect, Color(c.r, c.g, c.b, 0.35))

func _on_icon_ready(block_name: String) -> void:
	_redraw_cells_for_block(block_name)

func _redraw_cells_for_block(block_name: String) -> void:
	if not _flow:
		return
	for cell in _flow.get_children():
		var item: Item = cell.get_meta("item")
		if item.block_type != null and item.block_type.name == block_name:
			cell.queue_redraw()

func _on_cell_input(ev: InputEvent, item: Item) -> void:
	if ev is InputEventMouseButton and (ev as InputEventMouseButton).button_index == MOUSE_BUTTON_LEFT \
			and (ev as InputEventMouseButton).pressed:
		set_selected(item.key)
		item_selected.emit(item.key)
		block_selected.emit(item.key)
