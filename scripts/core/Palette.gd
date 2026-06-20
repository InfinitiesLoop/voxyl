class_name Palette
extends Resource

@export var name: String = "Default"
@export var entries: Array[PaletteEntry] = []

func get_entry(type_id: String) -> PaletteEntry:
	for e in entries:
		if e.block_type_id == type_id:
			return e
	return null

func get_color(type_id: String) -> Color:
	var e := get_entry(type_id)
	return e.color if e else Color.GRAY
