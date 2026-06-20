class_name VoxelProject
extends Resource

@export var project_name: String = "Untitled"
@export var data: VoxelData
@export var block_types: Array[BlockType] = []
@export var palette: Palette

func _init() -> void:
	data = VoxelData.new()
	palette = Palette.new()

func get_block_type(id: String) -> BlockType:
	for bt in block_types:
		if bt.id == id:
			return bt
	return null

func add_block_type(id: String, display_name: String, default_color: Color = Color.GRAY) -> BlockType:
	var bt := BlockType.new()
	bt.id = id
	bt.display_name = display_name
	bt.default_color = default_color
	block_types.append(bt)
	return bt
