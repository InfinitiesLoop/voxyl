extends Node

# Headless structural test for MultiViewShell — exercises the tree surgery
# (split / collapse / presets / spawning) that can't be eyeballed, asserting
# pane and view counts. Run as a scene so the VoxelWorld autoload is present.

var _pass := 0
var _fail := 0

func _ready() -> void:
	print("\n=== voxyl shell test ===\n")
	await _run()
	print("\n%d passed, %d failed" % [_pass, _fail])
	get_tree().quit(1 if _fail > 0 else 0)

func _check(label: String, condition: bool) -> void:
	if condition:
		print("  ok   %s" % label)
		_pass += 1
	else:
		print("  FAIL %s" % label)
		_fail += 1

func _run() -> void:
	VoxelWorld.open(VoxelWorld.workspace.get_project("My First Build"))

	var shell := MultiViewShell.new()
	shell.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(shell)
	await get_tree().process_frame

	_check("starts with four panes (default 2×2)", _panes(shell).size() == 4)
	_check("starts with one (3D) view", _views(shell).size() == 1)

	# Oriented + shaped cells must rebuild in 3D without error (stairs/slab meshes).
	VoxelWorld.set_block(Vector3i(0, 0, 0), "Stairs",
		Orientation.make(Orientation.Facing.EAST, true))
	VoxelWorld.set_block(Vector3i(0, 1, 0), "Slab")
	var v3d: Node = _views(shell)[0]
	v3d._rebuild()
	_check("3D rebuild keeps a node for an oriented stairs cell",
		(v3d.get("_cell_nodes") as Dictionary).has(Vector3i(0, 0, 0)))
	VoxelWorld.clear_block(Vector3i(0, 0, 0))
	VoxelWorld.clear_block(Vector3i(0, 1, 0))

	_check_textured_render(v3d)
	_check_imported_render(v3d)

	var tb := (_panes(shell)[0] as ViewPane).get_tab_bar()
	_check("tab bar enables cross-pane drag",
		tb.drag_to_rearrange_enabled and tb.tabs_rearrange_group == ViewPane.REARRANGE_GROUP)

	shell.apply_preset(MultiViewShell.Preset.GRID)
	await get_tree().process_frame
	_check("2x2 preset → 4 panes", _panes(shell).size() == 4)
	_check("preset keeps the open view", _views(shell).size() == 1)

	VoxelWorld.request_slice_view(1, Vector3i(0, 0, 0))
	VoxelWorld.request_slice_view(0, Vector3i(2, 3, 4))
	await get_tree().process_frame
	_check("two slices spawned → 3 views", _views(shell).size() == 3)

	shell.split_focused(false)
	await get_tree().process_frame
	_check("split focused → 5 panes", _panes(shell).size() == 5)

	shell.close_focused_pane()
	await get_tree().process_frame
	await get_tree().process_frame
	_check("close empty pane collapses → 4 panes", _panes(shell).size() == 4)
	_check("views survive collapse", _views(shell).size() == 3)

	shell.apply_preset(MultiViewShell.Preset.SINGLE)
	await get_tree().process_frame
	_check("single preset → 1 pane", _panes(shell).size() == 1)
	_check("single retains all 3 views as tabs", _views(shell).size() == 3)

	# Focus gating: only the focused pane's current view is active.
	shell.apply_preset(MultiViewShell.Preset.COLUMNS)
	await get_tree().process_frame
	var panes := _panes(shell)
	_check("columns → 2 panes", panes.size() == 2)
	_check("exactly one active view across panes", _count_active(shell) == 1)
	shell._set_focus(panes[1])
	await get_tree().process_frame
	_check("refocus keeps exactly one active", _count_active(shell) == 1)
	_check("the focused pane's current view is the active one",
		panes[1].get_current_tab_control()._active)

	# The focused 2D slice projects a guide into every other view.
	_check("focused 2D slice projects a guide into the others",
		not (panes[0].get_tab_control(0).get("_guide") as Dictionary).is_empty())
	_check("the active view shows no guide of itself",
		(panes[1].get_current_tab_control().get("_guide") as Dictionary).is_empty())

	# Dropping a tab onto a pane body routes it to that pane; panes[1] has a
	# single view, so emptying it should collapse it back to one pane.
	shell.size = Vector2(900, 600)
	await get_tree().process_frame
	var src: ViewPane = panes[1]
	var dst: ViewPane = panes[0]
	var moved := src.get_tab_control(0)
	var drag := {
		"type": "tab_element",
		"from_path": src.get_tab_bar().get_path(),
		"tab_element": 0,
	}
	shell.drop_tab(drag, dst.global_position + dst.size * 0.5)
	await get_tree().process_frame
	await get_tree().process_frame
	_check("dropped tab joins the target pane", moved.get_parent() == dst)
	_check("emptied source pane collapses after drop", _panes(shell).size() == 1)
	_check("no views lost in the move", _views(shell).size() == 3)

	shell.queue_free()

# Phase 1: a textured/animated block must render through the new per-face texture
# path — a real PNG on disk, resolved via the workspace library into per-surface
# materials, with front-facing geometry. (The color path is covered above.)
func _check_textured_render(v3d: Node) -> void:
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_shelltest_lib__"
	_rm_rf(AssetLibrary.ROOT)
	AssetLibrary.ensure_dir(AssetLibrary.PIXELS_DIR)
	# A static 16×16 and an animated 2-frame 16×32 vertical strip.
	Image.create_empty(16, 16, false, Image.FORMAT_RGBA8).save_png(AssetLibrary.path_for("pixels/s.png"))
	Image.create_empty(16, 32, false, Image.FORMAT_RGBA8).save_png(AssetLibrary.path_for("pixels/a.png"))

	var ws := VoxelWorld.workspace
	var s_tex := TextureAsset.new()
	s_tex.id = "s_tex"; s_tex.image_path = "pixels/s.png"
	ws.add_texture_asset(s_tex)
	var a_tex := TextureAsset.new()
	a_tex.id = "a_tex"; a_tex.image_path = "pixels/a.png"
	a_tex.frame_count = 2; a_tex.frame_time = 0.5
	ws.add_texture_asset(a_tex)
	var s_model := BlockModel.builtin_full()
	s_model.id = "s_model"; s_model.textures = {"all": "s_tex"}
	var a_model := BlockModel.builtin_full()
	a_model.id = "a_model"; a_model.textures = {"all": "a_tex"}
	ws.add_block_model(s_model); ws.add_block_model(a_model)
	ws.add_block_type("TexStaticBlock").model_id = "s_model"
	ws.add_block_type("TexAnimBlock").model_id = "a_model"
	var pal := ws.add_palette("__tex_test__")
	for pair in [["TexStatic", "TexStaticBlock"], ["TexAnim", "TexAnimBlock"]]:
		var e := PaletteEntry.new()
		e.semantic_name = pair[0]; e.block_type_name = pair[1]
		pal.entries.append(e)
	var project := VoxelWorld.active_project
	project.palette_names.append("__tex_test__")

	VoxelWorld.set_block(Vector3i(0, 5, 0), "TexStatic")
	VoxelWorld.set_block(Vector3i(0, 6, 0), "TexAnim")
	v3d._rebuild()

	var nodes := v3d.get("_cell_nodes") as Dictionary
	var s_mi: MeshInstance3D = nodes.get(Vector3i(0, 5, 0))
	var a_mi: MeshInstance3D = nodes.get(Vector3i(0, 6, 0))
	_check("textured cell built + flagged", s_mi != null and s_mi.get_meta("textured", false))
	_check("full-cube textured mesh is one surface (shared 'all' key)",
		s_mi != null and s_mi.mesh.get_surface_count() == 1)
	_check("static texture → StandardMaterial3D with an albedo texture",
		s_mi != null and s_mi.get_surface_override_material(0) is StandardMaterial3D
		and (s_mi.get_surface_override_material(0) as StandardMaterial3D).albedo_texture != null)
	_check("animated texture → ShaderMaterial (frame-strip shader)",
		a_mi != null and a_mi.get_surface_override_material(0) is ShaderMaterial)
	_check("textured faces are front-facing (Godot winding)",
		s_mi != null and _mesh_winding_ok(s_mi.mesh))
	_check("textured cube emits all six faces",
		s_mi != null and _distinct_normals(s_mi.mesh) == 6)

	# Teardown — restore the workspace/project for the structural checks that follow.
	VoxelWorld.clear_block(Vector3i(0, 5, 0))
	VoxelWorld.clear_block(Vector3i(0, 6, 0))
	project.palette_names.erase("__tex_test__")
	ws.remove_palette("__tex_test__")
	ws.remove_block_type("TexStaticBlock"); ws.remove_block_type("TexAnimBlock")
	ws.remove_block_model("s_model"); ws.remove_block_model("a_model")
	ws.remove_texture_asset("s_tex"); ws.remove_texture_asset("a_tex")
	v3d._rebuild()
	_rm_rf(AssetLibrary.ROOT)
	AssetLibrary.ROOT = saved_root

# Phase 2: a block translated by MCImporter must render through the same textured
# path — closing the loop importer → workspace library → View3D. The importer keys
# surfaces by the texture's qualified ref (e.g. "testmod:block/imp_tex"), unlike the
# hand-authored "all" above, so this also proves path-style texture keys flow through.
func _check_imported_render(v3d: Node) -> void:
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_shelltest_implib__"
	var src := "user://__voxyl_shelltest_mcsrc__"
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	var assets := src + "/assets"
	# A self-contained block: one model (full cube, all faces #all) + one texture.
	_write_text(assets + "/testmod/blockstates/imp_block.json",
		'{ "variants": { "": { "model": "testmod:block/imp_block" } } }')
	_write_text(assets + "/testmod/models/block/imp_block.json",
		'{ "textures": {"all":"testmod:block/imp_tex"}, "elements": [ { "from":[0,0,0], "to":[16,16,16],'
		+ ' "faces": { "down":{"texture":"#all"},"up":{"texture":"#all"},"north":{"texture":"#all"},'
		+ '"south":{"texture":"#all"},"west":{"texture":"#all"},"east":{"texture":"#all"} } } ] }')
	var img := Image.create_empty(16, 16, false, Image.FORMAT_RGBA8)
	img.fill(Color(0.6, 0.3, 0.7))
	DirAccess.make_dir_recursive_absolute((assets + "/testmod/textures/block/imp_tex.png").get_base_dir())
	img.save_png(assets + "/testmod/textures/block/imp_tex.png")

	var ws := VoxelWorld.workspace
	var imp := MCImporter.new(assets, ws)
	imp.import_block("testmod", "imp_block")
	var pal := ws.add_palette("__imp_test__")
	var e := PaletteEntry.new()
	e.semantic_name = "ImpTest"; e.block_type_name = "imp_block"
	pal.entries.append(e)
	var project := VoxelWorld.active_project
	project.palette_names.append("__imp_test__")

	VoxelWorld.set_block(Vector3i(0, 7, 0), "ImpTest")
	v3d._rebuild()
	var mi: MeshInstance3D = (v3d.get("_cell_nodes") as Dictionary).get(Vector3i(0, 7, 0))
	_check("imported block renders through the textured path",
		mi != null and mi.get_meta("textured", false))
	_check("imported block's surface gets its copied texture",
		mi != null and mi.get_surface_override_material(0) is StandardMaterial3D
		and (mi.get_surface_override_material(0) as StandardMaterial3D).albedo_texture != null)

	# Teardown — restore the workspace/project for the structural checks that follow.
	VoxelWorld.clear_block(Vector3i(0, 7, 0))
	project.palette_names.erase("__imp_test__")
	ws.remove_palette("__imp_test__")
	ws.remove_block_type("imp_block")
	ws.remove_block_model("testmod:block/imp_block")
	ws.remove_texture_asset("testmod:block/imp_tex")
	v3d._rebuild()
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	AssetLibrary.ROOT = saved_root

func _write_text(path: String, text: String) -> void:
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f != null:
		f.store_string(text)

# Every triangle is front-facing per Godot's convention: the geometric cross
# product of its edges points *opposite* the stored normal (see the probe in
# View3D._add_face). Indexed (SurfaceTool dedups) so honor ARRAY_INDEX.
func _mesh_winding_ok(mesh: ArrayMesh) -> bool:
	for s in mesh.get_surface_count():
		var arr := mesh.surface_get_arrays(s)
		var verts: PackedVector3Array = arr[Mesh.ARRAY_VERTEX]
		var norms: PackedVector3Array = arr[Mesh.ARRAY_NORMAL]
		var idx = arr[Mesh.ARRAY_INDEX]
		var has_idx: bool = idx != null and idx.size() > 0
		var count: int = idx.size() if has_idx else verts.size()
		for t in range(0, count, 3):
			var a: int = idx[t] if has_idx else t
			var b: int = idx[t + 1] if has_idx else t + 1
			var c: int = idx[t + 2] if has_idx else t + 2
			if (verts[b] - verts[a]).cross(verts[c] - verts[a]).dot(norms[a]) >= 0.0:
				return false
	return true

func _distinct_normals(mesh: ArrayMesh) -> int:
	var seen := {}
	for s in mesh.get_surface_count():
		var arr := mesh.surface_get_arrays(s)
		for nrm in (arr[Mesh.ARRAY_NORMAL] as PackedVector3Array):
			seen[nrm.round()] = true
	return seen.size()

# Recursively delete a directory tree (test scratch cleanup). No-op if absent.
func _rm_rf(path: String) -> void:
	var dir := DirAccess.open(path)
	if dir == null:
		return
	for f in dir.get_files():
		DirAccess.remove_absolute(path.path_join(f))
	for d in dir.get_directories():
		_rm_rf(path.path_join(d))
	DirAccess.remove_absolute(path)

func _count_active(shell: MultiViewShell) -> int:
	var n := 0
	for v in _views(shell):
		if v._active:
			n += 1
	return n

func _panes(shell: MultiViewShell) -> Array:
	return shell._all_panes()

func _views(shell: MultiViewShell) -> Array:
	return shell._all_views()
