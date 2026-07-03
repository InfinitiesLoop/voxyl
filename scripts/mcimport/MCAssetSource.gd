class_name MCAssetSource
extends RefCounted

# Read-only I/O over a Minecraft assets tree, abstracting *where* the bytes live —
# a directory on disk, or inside a resource-pack `.zip` / mod `.jar` — away from
# MCImporter, which owns all the MC *layout* knowledge. Every path here is relative
# to the assets root: the directory that directly contains the namespace folders
# (`<ns>/blockstates`, `<ns>/models`, `<ns>/textures`). The importer reads each file
# it needs on demand, following the model parent chain, so a source never has to
# extract or pre-list more than it's asked for.
#
# Subclasses: MCDirSource (a folder), MCZipSource (an archive). The interface is
# pure byte/listing I/O — no MC concepts leak in here, which is why it can sit
# *below* the importer plugin without violating the "core stays MC-free" guardrail
# (this is plumbing, not a core type).

# Immediate subdirectory names of the assets root — the namespaces.
func list_namespaces() -> PackedStringArray:
	return PackedStringArray()

# File names directly inside `rel_dir` (no recursion); just the names, so callers
# re-join with the directory themselves.
func list_files(_rel_dir: String) -> PackedStringArray:
	return PackedStringArray()

# Like list_files but recursing into subdirectories, each result RELATIVE to `rel_dir`
# (e.g. "agon/0.png"). The flat importer uses this so mods that sort their block textures
# into subfolders under `textures/blocks/` aren't half-missed. Default: none.
func list_files_recursive(_rel_dir: String) -> PackedStringArray:
	return PackedStringArray()

func has_file(_rel: String) -> bool:
	return false

# UTF-8 text of a file, or "" when missing/unreadable.
func read_text(_rel: String) -> String:
	return ""

# Decoded image, or null when missing/unreadable.
func read_image(_rel: String) -> Image:
	return null

# Raw file bytes, or an empty PackedByteArray when missing/unreadable. Lets a caller
# copy a PNG verbatim (no decode/re-encode round trip) while still decoding it once for
# a pixel scan — see MCTexImport.ensure_texture.
func read_bytes(_rel: String) -> PackedByteArray:
	return PackedByteArray()

# Release any held handles (zip readers). Safe to call more than once.
func close() -> void:
	pass

# Human-readable label for diagnostics / the import UI.
func describe() -> String:
	return "<source>"
