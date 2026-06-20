class_name VoxelData
extends Resource

# Sparse storage: only occupied cells are stored.
# Key: Vector3i position, Value: block_type_id (String)
var cells: Dictionary = {}
@export var size: Vector3i = Vector3i(16, 16, 16)

func set_block(pos: Vector3i, type_id: String) -> void:
	if type_id.is_empty():
		cells.erase(pos)
	else:
		cells[pos] = type_id

func get_block(pos: Vector3i) -> String:
	return cells.get(pos, "")

func clear_block(pos: Vector3i) -> void:
	cells.erase(pos)

func is_in_bounds(pos: Vector3i) -> bool:
	return pos.x >= 0 and pos.y >= 0 and pos.z >= 0 \
		and pos.x < size.x and pos.y < size.y and pos.z < size.z
