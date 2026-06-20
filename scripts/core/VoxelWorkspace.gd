class_name VoxelWorkspace
extends Resource

@export var block_types: Array[BlockType] = []
@export var palettes: Array[Palette] = []
@export var projects: Array[VoxelProject] = []

func add_block_type(block_name: String) -> BlockType:
	var bt := BlockType.new()
	bt.name = block_name
	block_types.append(bt)
	return bt

func get_block_type(block_name: String) -> BlockType:
	for bt in block_types:
		if bt.name == block_name:
			return bt
	return null

func remove_block_type(block_name: String) -> void:
	for i in block_types.size():
		if block_types[i].name == block_name:
			block_types.remove_at(i)
			return

func add_palette(palette_name: String) -> Palette:
	var p := Palette.new()
	p.name = palette_name
	palettes.append(p)
	return p

func get_palette(palette_name: String) -> Palette:
	for p in palettes:
		if p.name == palette_name:
			return p
	return null

func remove_palette(palette_name: String) -> void:
	for i in palettes.size():
		if palettes[i].name == palette_name:
			palettes.remove_at(i)
			return

func add_project(project_name: String) -> VoxelProject:
	var p := VoxelProject.new()
	p.name = project_name
	projects.append(p)
	return p

func get_project(project_name: String) -> VoxelProject:
	for p in projects:
		if p.name == project_name:
			return p
	return null

func remove_project(project_name: String) -> void:
	for i in projects.size():
		if projects[i].name == project_name:
			projects.remove_at(i)
			return
