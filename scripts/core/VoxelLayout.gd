class_name VoxelLayout
extends Resource

@export var name: String = ""
@export var data: VoxelData

func _init() -> void:
	data = VoxelData.new()

# Returns all semantic names currently in use across this layout's cells.
func used_semantic_names() -> Array[String]:
	var seen := {}
	for v in data.cells.values():
		seen[v] = true
	var result: Array[String] = []
	result.assign(seen.keys())
	return result
