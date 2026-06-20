class_name VoxelLayout
extends Resource

@export var name: String = ""
@export var data: VoxelData
# Ordered list of palette names. Resolution is last-wins: if two palettes
# both define the same semantic name, the one listed last takes priority.
@export var palette_names: Array[String] = []

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
