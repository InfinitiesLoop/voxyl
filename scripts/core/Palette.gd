class_name Palette
extends Resource

@export var name: String = ""
@export var entries: Array[PaletteEntry] = []
# The ordered stack of libraries this palette draws its block types from (first-hit
# wins, with the built-in `basic` library as an implicit final fallback). Names a
# BlockLibrary by its `name`. Empty → only the `basic` fallback applies.
@export var library_names: Array[String] = []
# Marks the code-seeded "Default" palette — undeletable, but otherwise a normal palette.
@export var builtin := false

func get_entry(semantic_name: String) -> PaletteEntry:
	for e in entries:
		if e.semantic_name == semantic_name:
			return e
	return null

func get_block_type_name(semantic_name: String) -> String:
	var e := get_entry(semantic_name)
	return e.block_type_name if e else ""

func semantic_names() -> Array[String]:
	var names: Array[String] = []
	for e in entries:
		names.append(e.semantic_name)
	return names
