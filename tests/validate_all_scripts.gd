extends SceneTree


func _get_files(path: String, suffix: String) -> Array[String]:
	var files: Array[String] = []
	var directories: Array[String] = []

	var dir := DirAccess.open(path)

	dir.list_dir_begin()

	var elem := dir.get_next()

	while elem != '':
		var elem_path := path.path_join(elem)

		if dir.file_exists(elem_path):
			if elem.ends_with(suffix):
				files.append(elem_path)
		elif dir.dir_exists(elem_path):
			directories.append(elem_path)

		elem = dir.get_next()

	dir.list_dir_end()

	for dir_path in directories:
		for file_path in _get_files(dir_path, suffix):
			files.append(file_path)

	files.sort()

	return files


func _resolve_to_res_path(p_path: String) -> String:
	if p_path.begins_with("res://"):
		return p_path
	if p_path.begins_with("/"):
		var project_root := ProjectSettings.globalize_path("res://")
		if p_path.begins_with(project_root):
			return "res://" + p_path.substr(project_root.length())
		return ""
	return "res://" + p_path


func _validate_user_args(p_args: PackedStringArray) -> bool:
	var all_paths_resolved := true
	for raw_path: String in p_args:
		var res_path := _resolve_to_res_path(raw_path)
		if res_path.is_empty() or not FileAccess.file_exists(res_path):
			printerr("ERROR: [validate_all_scripts] Cannot resolve script path: %s" % raw_path)
			all_paths_resolved = false
			continue
		print("Validating ", res_path)
		load(res_path)
	print("Validation of %s script(s) complete." % [p_args.size()])
	return all_paths_resolved


func _validate_all_scripts() -> void:
	var files := _get_files('res://', '.gd')
	for file_path in files:
		print("Validating ", file_path)
		load(file_path)
	print("Validation of %s script(s) complete." % [files.size()])


func _initialize() -> void:
	await process_frame
	var user_args := OS.get_cmdline_user_args()
	var success := true
	if user_args.size() > 0:
		success = _validate_user_args(user_args)
	else:
		_validate_all_scripts()
	quit(0 if success else 1)
