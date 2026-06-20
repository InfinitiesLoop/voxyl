class_name VoxelProject
extends Resource

@export var name: String = ""
@export var data: VoxelData
# Ordered palette references. Resolution is last-wins across the stack.
@export var palette_names: Array[String] = []

func _init() -> void:
	data = VoxelData.new()

# Returns all semantic names currently placed in this project's voxel data.
func used_semantic_names() -> Array[String]:
	var seen := {}
	for v in data.cells.values():
		seen[v] = true
	var result: Array[String] = []
	result.assign(seen.keys())
	return result
