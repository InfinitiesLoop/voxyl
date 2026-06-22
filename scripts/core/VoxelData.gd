class_name VoxelData
extends Resource

# Sparse storage: only occupied cells are stored.
# Key: Vector3i position, Value: BlockCell (semantic id + orientation + tags).
# Coordinates are unbounded — negative values are valid.
#
# The value is always a BlockCell, never a bare color/material — the data layer
# stores intent. get_block() returns just the semantic id for the many callers
# that only care about "what kind of block is here"; get_cell() exposes the rest.
var cells: Dictionary = {}

# Set (or update) the block at pos. An empty type_id erases. Orientation/tags
# default to "plain" unless supplied — callers that care pass them explicitly.
func set_block(pos: Vector3i, type_id: String, orientation: int = 0, tags: Dictionary = {}) -> void:
	if type_id.is_empty():
		cells.erase(pos)
	else:
		cells[pos] = BlockCell.new(type_id, orientation, tags)

# Replace the whole cell object (used when moving/duplicating cells verbatim).
func set_cell(pos: Vector3i, cell: BlockCell) -> void:
	if cell == null or cell.type_id.is_empty():
		cells.erase(pos)
	else:
		cells[pos] = cell

func get_block(pos: Vector3i) -> String:
	var c: BlockCell = cells.get(pos, null)
	return c.type_id if c else ""

func get_cell(pos: Vector3i) -> BlockCell:
	return cells.get(pos, null)

func get_orientation(pos: Vector3i) -> int:
	var c: BlockCell = cells.get(pos, null)
	return c.orientation if c else 0

func clear_block(pos: Vector3i) -> void:
	cells.erase(pos)

# Returns [min: Vector3i, max: Vector3i] of all occupied cells, or [] if empty.
func get_used_aabb() -> Array:
	if cells.is_empty():
		return []
	var mn := Vector3i(cells.keys()[0])
	var mx := mn
	for pos: Vector3i in cells:
		mn.x = mini(mn.x, pos.x); mn.y = mini(mn.y, pos.y); mn.z = mini(mn.z, pos.z)
		mx.x = maxi(mx.x, pos.x); mx.y = maxi(mx.y, pos.y); mx.z = maxi(mx.z, pos.z)
	return [mn, mx]
