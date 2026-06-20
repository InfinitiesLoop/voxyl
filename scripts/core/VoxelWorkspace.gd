class_name VoxelWorkspace
extends Resource

@export var block_types: Array[BlockType] = []
@export var palettes: Array[Palette] = []
@export var layouts: Array[VoxelLayout] = []

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

func add_layout(layout_name: String) -> VoxelLayout:
	var l := VoxelLayout.new()
	l.name = layout_name
	layouts.append(l)
	return l

func get_layout(layout_name: String) -> VoxelLayout:
	for l in layouts:
		if l.name == layout_name:
			return l
	return null

func remove_layout(layout_name: String) -> void:
	for i in layouts.size():
		if layouts[i].name == layout_name:
			layouts.remove_at(i)
			return
