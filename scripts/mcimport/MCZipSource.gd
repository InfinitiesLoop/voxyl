class_name MCZipSource
extends MCAssetSource

# An assets root that lives inside a `.zip` resource pack or `.jar` mod. Both store
# the tree under a top-level `assets/` folder, so a path the importer asks for
# ("minecraft/models/block/stone.json") maps to "assets/<rel>" inside the archive.
# The reader stays open for the life of the source — resolving one block's parent
# chain is many small reads — and close() releases it.

const _BASE := "assets"

var _zip_path: String
var _reader: ZIPReader
var _ok := false
var _files := {}            # full in-zip path -> true (fast membership tests)

func _init(zip_path: String) -> void:
	_zip_path = zip_path
	_reader = ZIPReader.new()
	if _reader.open(zip_path) != OK:
		_reader = null
		return
	_ok = true
	for f in _reader.get_files():
		_files[f] = true

func _full(rel: String) -> String:
	return _BASE if rel.is_empty() else "%s/%s" % [_BASE, rel]

func list_namespaces() -> PackedStringArray:
	return _immediate(_BASE + "/", true)

func list_files(rel_dir: String) -> PackedStringArray:
	return _immediate(_full(rel_dir) + "/", false)

# Every file at or below rel_dir, each relative to it ("agon/0.png"). Zip entries are a
# flat path list, so this is just a prefix scan; directory entries (trailing "/") skipped.
func list_files_recursive(rel_dir: String) -> PackedStringArray:
	var prefix := _full(rel_dir) + "/"
	var out := PackedStringArray()
	for full in _files.keys():
		if not full.begins_with(prefix):
			continue
		var rest: String = full.substr(prefix.length())
		if not rest.is_empty() and not rest.ends_with("/"):
			out.append(rest)
	return out

# Immediate children (dirs or files) under a full in-zip prefix. Zip entries are a
# flat list, so a directory is inferred from any deeper path that shares the prefix.
func _immediate(prefix: String, want_dirs: bool) -> PackedStringArray:
	var seen := {}
	for full in _files.keys():
		if not full.begins_with(prefix):
			continue
		var rest: String = full.substr(prefix.length())
		var slash := rest.find("/")
		if want_dirs:
			if slash > 0:
				seen[rest.substr(0, slash)] = true
		elif slash < 0 and not rest.is_empty():
			seen[rest] = true
	var out := PackedStringArray()
	for k in seen:
		out.append(k)
	return out

func has_file(rel: String) -> bool:
	return _ok and _files.has(_full(rel))

func read_text(rel: String) -> String:
	if not has_file(rel):
		return ""
	return _reader.read_file(_full(rel)).get_string_from_utf8()

func read_image(rel: String) -> Image:
	if not has_file(rel):
		return null
	var img := Image.new()
	return img if img.load_png_from_buffer(_reader.read_file(_full(rel))) == OK else null

func read_bytes(rel: String) -> PackedByteArray:
	if not has_file(rel):
		return PackedByteArray()
	return _reader.read_file(_full(rel))

func close() -> void:
	if _reader != null:
		_reader.close()
		_reader = null
		_ok = false

# Safety net for callers that forget close(). Inlined rather than calling close() —
# during PREDELETE the script instance is mid-teardown and dispatching a user method
# off it errors, so we release the reader directly.
func _notification(what: int) -> void:
	if what == NOTIFICATION_PREDELETE and _reader != null:
		_reader.close()
		_reader = null

func describe() -> String:
	return _zip_path
