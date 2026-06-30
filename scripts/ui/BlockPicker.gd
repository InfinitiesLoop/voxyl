class_name BlockPicker
extends AcceptDialog

# A reusable "pick a block" popup: wraps a BlockGrid of items (searchable icon previews) and
# emits the picked item's key. Not bespoke to any one caller — hand it any collection of
# blocks (resolved block types today, palette entries or other block sets later) via
# set_items(). A single click on a cell picks it and closes; the dialog button just cancels.

signal picked(key: String)

var _grid: BlockGrid
var _pending_items: Array = []        # items handed in before _ready built the grid

func _ready() -> void:
	title = "Pick a block"
	ok_button_text = "Cancel"
	min_size = Vector2i(560, 540)

	var vbox := VBoxContainer.new()
	vbox.custom_minimum_size = Vector2(520, 480)
	add_child(vbox)

	_grid = BlockGrid.new()
	_grid.show_captions = true
	_grid.cell_size = Vector2(56, 56)
	_grid.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_grid.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_grid.item_selected.connect(func(key: String):
		picked.emit(key)
		queue_free())
	vbox.add_child(_grid)

	if not _pending_items.is_empty():
		_grid.populate_items(_pending_items)

	# Closing via the dialog button or the window X just dismisses — no pick.
	confirmed.connect(queue_free)
	canceled.connect(queue_free)

# Populate the picker. Safe to call before the dialog is added to the tree — items are
# stashed and applied once the grid exists.
func set_items(items: Array, title_text := "Pick a block") -> void:
	title = title_text
	_pending_items = items
	if _grid:
		_grid.populate_items(items)
