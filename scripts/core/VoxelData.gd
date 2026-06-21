class_name VoxelData
extends Resource

# Sparse storage: only occupied cells are stored.
# Key: Vector3i position, Value: block_type_id (String)
# Coordinates are unbounded — negative values are valid.
var cells: Dictionary = {}

func set_block(pos: Vector3i, type_id: String) -> void:
	if type_id.is_empty():
		cells.erase(pos)
	else:
		cells[pos] = type_id

func get_block(pos: Vector3i) -> String:
	return cells.get(pos, "")

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
