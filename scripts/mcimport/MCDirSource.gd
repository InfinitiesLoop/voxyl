class_name MCDirSource
extends MCAssetSource

# An assets root that is a real directory on disk (res://, user://, or an absolute
# OS path) — the original MCImporter behavior, now behind the source interface.

var _root: String

func _init(assets_root: String) -> void:
	_root = assets_root

func _abs(rel: String) -> String:
	return _root if rel.is_empty() else _root.path_join(rel)

func list_namespaces() -> PackedStringArray:
	var dir := DirAccess.open(_root)
	return dir.get_directories() if dir != null else PackedStringArray()

func list_files(rel_dir: String) -> PackedStringArray:
	var dir := DirAccess.open(_abs(rel_dir))
	return dir.get_files() if dir != null else PackedStringArray()

func has_file(rel: String) -> bool:
	return FileAccess.file_exists(_abs(rel))

func read_text(rel: String) -> String:
	var abs_path := _abs(rel)
	if not FileAccess.file_exists(abs_path):
		return ""
	var f := FileAccess.open(abs_path, FileAccess.READ)
	return f.get_as_text() if f != null else ""

func read_image(rel: String) -> Image:
	var abs_path := _abs(rel)
	if not FileAccess.file_exists(abs_path):
		return null
	var img := Image.new()
	return img if img.load(abs_path) == OK else null

func describe() -> String:
	return _root
