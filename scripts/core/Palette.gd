class_name Palette
extends Resource

@export var name: String = ""
# Auto-incremented at creation (see VoxelWorkspace.add_palette); higher = newer. Used to
# order the palette list newest-first. Palettes saved before this field existed default
# to 0 and simply sort to the bottom.
@export var id: int = 0
@export var entries: Array[PaletteEntry] = []
# The ordered stack of libraries this palette draws its block types from (first-hit
# wins, with the built-in `basic` library as an implicit final fallback). Names a
# BlockLibrary by its `name`. Empty → only the `basic` fallback applies.
@export var library_names: Array[String] = []
# Marks the code-seeded "Default" palette — undeletable, but otherwise a normal palette.
@export var builtin := false

# Fold the legacy "cut from another entry" link (PaletteEntry.base_name) into the entry's
# own block type, so a shaped entry saved that way keeps its look. Returns whether anything
# changed. Called on load.
func migrate_legacy_shapes() -> bool:
	var migrated := false
	for e in entries:
		if e.base_name.is_empty():
			continue
		if e.is_shaped() and e.block_type_name.is_empty():
			var base := get_entry(e.base_name)
			if base != null and not base.is_shaped():
				e.block_type_name = base.block_type_name
		e.base_name = ""
		migrated = true
	return migrated

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
