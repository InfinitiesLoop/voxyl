class_name MCMultiSource
extends MCAssetSource

# Several sources that all declare the SAME namespace, read as one. A modpack routinely has
# more than one jar touching a namespace — GTNH's gregtech-*.jar owns ~12k files under
# assets/gregtech/, but three small satellite mods (hydroenergy, Computronics,
# GTNewHorizonsCoreMod) each patch in a handful more under that same namespace. Before this,
# NeiRosterImporter's `_sources_by_ns` kept only the LAST source seen per namespace — whichever
# jar happened to sort last alphabetically silently won, discarding the other(s). When that
# was a small patch jar instead of the real mod, every texture lookup for the namespace missed
# everything the real jar actually has: no warning (a source WAS found), just an empty result
# for every single block. Wrapping every source for a namespace in this instead means every
# read tries each one in turn, so the union of what they all provide is visible regardless of
# which jar Godot's directory listing happens to return first or last.

var _sources: Array[MCAssetSource] = []

func _init(sources: Array[MCAssetSource]) -> void:
	_sources = sources

func list_namespaces() -> PackedStringArray:
	var seen := {}
	for s in _sources:
		for ns in s.list_namespaces():
			seen[ns] = true
	return PackedStringArray(seen.keys())

func list_files(rel_dir: String) -> PackedStringArray:
	var seen := {}
	for s in _sources:
		for f in s.list_files(rel_dir):
			seen[f] = true
	return PackedStringArray(seen.keys())

func list_files_recursive(rel_dir: String) -> PackedStringArray:
	var seen := {}
	for s in _sources:
		for f in s.list_files_recursive(rel_dir):
			seen[f] = true
	return PackedStringArray(seen.keys())

func has_file(rel: String) -> bool:
	for s in _sources:
		if s.has_file(rel):
			return true
	return false

func read_text(rel: String) -> String:
	for s in _sources:
		if s.has_file(rel):
			return s.read_text(rel)
	return ""

func read_image(rel: String) -> Image:
	for s in _sources:
		if s.has_file(rel):
			return s.read_image(rel)
	return null

func read_bytes(rel: String) -> PackedByteArray:
	for s in _sources:
		if s.has_file(rel):
			return s.read_bytes(rel)
	return PackedByteArray()

# The first source's archive path — used only as a "somewhere near here" anchor for sibling
# file lookups (see MCHealContext.read_sibling_text); which of several jars anchors that search
# doesn't matter since it walks upward to the shared mods/ folder either way.
func archive_path() -> String:
	return _sources[0].archive_path() if not _sources.is_empty() else ""

func close() -> void:
	for s in _sources:
		s.close()

func describe() -> String:
	var out := PackedStringArray()
	for s in _sources:
		out.append(s.describe())
	return ", ".join(out)
