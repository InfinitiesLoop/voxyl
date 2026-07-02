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
	VoxelWorld.reset_for_tests()   # pristine defaults, ignore any persisted library
	VoxelWorld.open(VoxelWorld.workspace.get_project("My First Build"))

	var shell := MultiViewShell.new()
	shell.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(shell)
	await get_tree().process_frame

	_check("starts with one pane (default single)", _panes(shell).size() == 1)
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
	_check_multipart_render(v3d)
	_check_block_render3d_multipart()
	_check_tinted_render(v3d)
	_check_flat_render(v3d)
	await _check_import_progress()
	_check_library_rename()

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

	await _check_layout_roundtrip(shell)

	shell.queue_free()

# A serialized layout must rebuild the same structure — pane/view counts, split
# orientation + offset, and each slice view's axis/transform. This is what ties a
# project's arrangement to disk (MultiViewShell.serialize_layout ↔ apply_layout).
func _check_layout_roundtrip(shell: MultiViewShell) -> void:
	# Build a known structure: a horizontal split, its right pane split vertically,
	# with a couple of slices carrying distinct transforms.
	shell.apply_preset(MultiViewShell.Preset.COLUMNS)
	await get_tree().process_frame
	VoxelWorld.request_slice_view(2, Vector3i(1, 2, 3))
	await get_tree().process_frame
	# Give the fresh slice a non-default framing so we can prove it round-trips.
	var a_slice: Node = null
	for v in _views(shell):
		if v.has_method("view_kind") and v.view_kind() == "slice":
			a_slice = v
			break
	_check("a slice view exists to round-trip", a_slice != null)
	if a_slice != null:
		a_slice.apply_view_state({"axis": 2, "center": Vector3i(1, 2, 3),
			"slice_pos": 3, "rotation": 1, "cell_px": 48.0, "user_pan": Vector2(12, -7)})

	var before_panes := _panes(shell).size()
	var before_views := _views(shell).size()
	var layout := shell.serialize_layout()
	_check("serialize_layout produces a tree", layout.has("tree"))

	# Scramble the layout, then restore it from the descriptor.
	shell.apply_preset(MultiViewShell.Preset.SINGLE)
	await get_tree().process_frame
	_check("apply_layout accepts a real descriptor", shell.apply_layout(layout))
	await get_tree().process_frame

	_check("round-trip restores pane count", _panes(shell).size() == before_panes)
	_check("round-trip restores view count", _views(shell).size() == before_views)

	var restored_slice: Node = null
	for v in _views(shell):
		if v.has_method("view_kind") and v.view_kind() == "slice":
			restored_slice = v
			break
	_check("round-trip restores a slice view", restored_slice != null)
	if restored_slice != null:
		var st: Dictionary = restored_slice.get_view_state()
		_check("slice axis survives round-trip", int(st.get("axis", -1)) == 2)
		_check("slice zoom survives round-trip", is_equal_approx(st.get("cell_px", 0.0), 48.0))
		_check("slice rotation survives round-trip", int(st.get("rotation", -1)) == 1)

	# apply_layout rejects an empty/absent descriptor (caller falls back to a preset).
	_check("apply_layout rejects an empty descriptor", not shell.apply_layout({}))

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
	# Author into the basic library; the temp palette's empty library stack resolves
	# through the basic fallback.
	var lib := ws.basic_library()
	var s_tex := TextureAsset.new()
	s_tex.id = "s_tex"; s_tex.image_path = "pixels/s.png"
	lib.add_texture_asset(s_tex)
	var a_tex := TextureAsset.new()
	a_tex.id = "a_tex"; a_tex.image_path = "pixels/a.png"
	a_tex.frame_count = 2; a_tex.frame_time = 0.5
	lib.add_texture_asset(a_tex)
	var s_model := BlockModel.builtin_full()
	s_model.id = "s_model"; s_model.textures = {"all": "s_tex"}
	var a_model := BlockModel.builtin_full()
	a_model.id = "a_model"; a_model.textures = {"all": "a_tex"}
	lib.add_block_model(s_model); lib.add_block_model(a_model)
	lib.add_block_type("TexStaticBlock").model_id = "s_model"
	lib.add_block_type("TexAnimBlock").model_id = "a_model"
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
	lib.remove_block_type("TexStaticBlock"); lib.remove_block_type("TexAnimBlock")
	lib.remove_block_model("s_model"); lib.remove_block_model("a_model")
	lib.remove_texture_asset("s_tex"); lib.remove_texture_asset("a_tex")
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
	var lib := ws.basic_library()
	var imp := MCImporter.new(assets, lib)
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
	lib.remove_block_type("imp_block")
	lib.remove_block_model("testmod:block/imp_block")
	lib.remove_texture_asset("testmod:block/imp_tex")
	v3d._rebuild()
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	AssetLibrary.ROOT = saved_root

# Phase 3: a multipart/connecting block must render as a render-time set of parts —
# its post when isolated, and an extra side part per occupied neighbor — with the
# connection state derived from neighbors, never stored. Hand-built (color path) so
# the assertion is about the part/container structure the view builds, not textures.
func _check_multipart_render(v3d: Node) -> void:
	var ws := VoxelWorld.workspace
	var lib := ws.basic_library()
	var post := BlockModel.new()
	post.id = "mp_post"
	post.elements = [BlockModel.box_element(Vector3(0.375, 0, 0.375), Vector3(0.625, 1, 0.625))]
	var side := BlockModel.new()
	side.id = "mp_side"
	side.elements = [BlockModel.box_element(Vector3(0.4375, 0.375, 0), Vector3(0.5625, 0.9375, 0.5))]
	lib.add_block_model(post)
	lib.add_block_model(side)
	var sm := BlockStateMap.new()
	sm.add_part([], "mp_post")              # always
	sm.add_part([{0: true}], "mp_side", 0, 0)    # north
	sm.add_part([{1: true}], "mp_side", 0, 90)   # east
	sm.add_part([{2: true}], "mp_side", 0, 180)  # south
	sm.add_part([{3: true}], "mp_side", 0, 270)  # west
	var bt := lib.add_block_type("MPFenceBlock")
	bt.model_id = "mp_post"
	bt.state_map = sm
	var pal := ws.add_palette("__mp_test__")
	var e := PaletteEntry.new()
	e.semantic_name = "MPFence"; e.block_type_name = "MPFenceBlock"
	pal.entries.append(e)
	var project := VoxelWorld.active_project
	project.palette_names.append("__mp_test__")

	# Isolated: just the post → a single MeshInstance3D node (no container).
	VoxelWorld.set_block(Vector3i(0, 8, 0), "MPFence")
	v3d._rebuild()
	var iso = (v3d.get("_cell_nodes") as Dictionary).get(Vector3i(0, 8, 0))
	_check("isolated multipart cell → single node (post only)", iso is MeshInstance3D)

	# Add north (-Z) and east (+X) neighbors → post + 2 sides in a container.
	VoxelWorld.set_block(Vector3i(0, 8, -1), "Base")
	VoxelWorld.set_block(Vector3i(1, 8, 0), "Base")
	v3d._rebuild()
	var con = (v3d.get("_cell_nodes") as Dictionary).get(Vector3i(0, 8, 0))
	_check("connected multipart cell → container of parts",
		con is Node3D and not (con is MeshInstance3D))
	var part_meshes := 0
	if con is Node3D:
		for c in (con as Node3D).get_children():
			if c is MeshInstance3D:
				part_meshes += 1
	_check("post + 2 connected sides → 3 part meshes", part_meshes == 3)

	# Teardown — restore the workspace/project for the checks that follow.
	VoxelWorld.clear_block(Vector3i(0, 8, 0))
	VoxelWorld.clear_block(Vector3i(0, 8, -1))
	VoxelWorld.clear_block(Vector3i(1, 8, 0))
	project.palette_names.erase("__mp_test__")
	ws.remove_palette("__mp_test__")
	lib.remove_block_type("MPFenceBlock")
	lib.remove_block_model("mp_post")
	lib.remove_block_model("mp_side")
	v3d._rebuild()

# The library preview/icon (BlockRender3D.build_into, shared by BlockIconBaker and
# BlockPreview3D) renders a multipart block in its PREVIEW state — a straight
# EAST+WEST run (BlockRender3D.preview_parts) — as child MeshInstance3Ds, so a pane
# reads as a full face-on pane and a fence/wall as a straight section, not the lonely
# isolated post. A plain (non-multipart) block keeps the single-mesh-on-mi behavior.
func _check_block_render3d_multipart() -> void:
	var ws := VoxelWorld.workspace
	var lib := ws.basic_library()
	for id in ["rd_post", "rd_side", "rd_noside"]:
		var m := BlockModel.new()
		m.id = id
		m.elements = [BlockModel.box_element(Vector3(0.4375, 0, 0.4375), Vector3(0.5625, 1, 0.5625))]
		lib.add_block_model(m)
	var sm := BlockStateMap.new()
	sm.add_part([], "rd_post")                # always (the post)
	sm.add_part([{1: true}], "rd_side")       # side arm when EAST connects
	sm.add_part([{1: false}], "rd_noside")    # filler when EAST does NOT connect
	var bt := lib.add_block_type("RDPaneBlock")
	bt.model_id = "rd_post"
	bt.state_map = sm

	# Preview connects EAST+WEST: the east-side arm resolves and the "no east" filler
	# does not — a straight run, not the isolated form. Check the shared data helper
	# that both the icon baker and the live builder use.
	var preview_ids: Array = []
	for part in BlockRender3D.preview_parts(sm):
		preview_ids.append(str(part.get("model_id", "")))
	_check("multipart preview resolves the connected (east-side) run",
		preview_ids == ["rd_post", "rd_side"])
	_check("preview omits the isolated 'no east' filler part",
		not preview_ids.has("rd_noside"))

	# And build_into turns those parts into one child MeshInstance3D each (no mesh on mi).
	var mi := MeshInstance3D.new()
	add_child(mi)
	BlockRender3D.build_into(mi, bt)
	var child_meshes := 0
	for c in mi.get_children():
		if c is MeshInstance3D and (c as MeshInstance3D).mesh != null:
			child_meshes += 1
	_check("multipart preview builds one child mesh per resolved part",
		mi.mesh == null and child_meshes == 2)
	mi.queue_free()

	# A plain (non-multipart) block is unaffected: mesh set directly on mi, no children.
	var plain_mi := MeshInstance3D.new()
	add_child(plain_mi)
	var plain_bt := lib.get_block_type("base")
	BlockRender3D.build_into(plain_mi, plain_bt)
	_check("plain block still renders directly on mi (no children)",
		plain_mi.mesh != null and plain_mi.get_child_count() == 0)
	plain_mi.queue_free()

	lib.remove_block_type("RDPaneBlock")
	for id in ["rd_post", "rd_side", "rd_noside"]:
		lib.remove_block_model(id)

# Phase 4: an imported block whose model faces carry a tintindex renders with the
# block's biome tint multiplied into the surface — the importer bakes the plains
# default, the resolver hands the view the color, and the textured material modulates
# the texture by it (StandardMaterial3D.albedo_color). Closes importer → view for tint.
func _check_tinted_render(v3d: Node) -> void:
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_shelltest_tintlib__"
	var src := "user://__voxyl_shelltest_tintsrc__"
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	var assets := src + "/assets"
	# A leaves-style block: full cube, every face tintindex 0, one grayscale texture.
	_write_text(assets + "/testmod/blockstates/tint_leaves.json",
		'{ "variants": { "": { "model": "testmod:block/tint_leaves" } } }')
	_write_text(assets + "/testmod/models/block/tint_leaves.json",
		'{ "textures": {"all":"testmod:block/tint_leaves_tex"}, "elements": [ { "from":[0,0,0], "to":[16,16,16],'
		+ ' "faces": { "down":{"texture":"#all","tintindex":0},"up":{"texture":"#all","tintindex":0},'
		+ '"north":{"texture":"#all","tintindex":0},"south":{"texture":"#all","tintindex":0},'
		+ '"west":{"texture":"#all","tintindex":0},"east":{"texture":"#all","tintindex":0} } } ] }')
	var img := Image.create_empty(16, 16, false, Image.FORMAT_RGBA8)
	img.fill(Color(0.6, 0.6, 0.6))
	DirAccess.make_dir_recursive_absolute((assets + "/testmod/textures/block/tint_leaves_tex.png").get_base_dir())
	img.save_png(assets + "/testmod/textures/block/tint_leaves_tex.png")

	var ws := VoxelWorld.workspace
	var lib := ws.basic_library()
	var imp := MCImporter.new(assets, lib)
	imp.import_block("testmod", "tint_leaves")
	var bt := ws.get_block_type("tint_leaves")
	var pal := ws.add_palette("__tint_test__")
	var e := PaletteEntry.new()
	e.semantic_name = "TintTest"; e.block_type_name = "tint_leaves"
	pal.entries.append(e)
	var project := VoxelWorld.active_project
	project.palette_names.append("__tint_test__")

	VoxelWorld.set_block(Vector3i(0, 9, 0), "TintTest")
	v3d._rebuild()
	var mi: MeshInstance3D = (v3d.get("_cell_nodes") as Dictionary).get(Vector3i(0, 9, 0))
	var mat = mi.get_surface_override_material(0) if mi != null else null
	_check("tinted imported block bakes its tint into the surface albedo",
		mat is StandardMaterial3D and bt != null
		and _color_near((mat as StandardMaterial3D).albedo_color, bt.tint, 0.001))
	_check("the baked tint is the plains foliage default, not white",
		bt != null and _color_near(bt.tint, Color(0.4667, 0.6706, 0.1843), 0.01)
		and not _color_near(bt.tint, Color.WHITE, 0.1))

	# Teardown — restore the workspace/project for the checks that follow.
	VoxelWorld.clear_block(Vector3i(0, 9, 0))
	project.palette_names.erase("__tint_test__")
	ws.remove_palette("__tint_test__")
	lib.remove_block_type("tint_leaves")
	lib.remove_block_model("testmod:block/tint_leaves")
	lib.remove_texture_asset("testmod:block/tint_leaves_tex")
	v3d._rebuild()
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	AssetLibrary.ROOT = saved_root

# Phase 5 / pre-1.8: a block synthesized by MCFlatImporter from loose textures must
# render through the same per-face textured path. A multi-face block (distinct top vs
# side) yields more than one surface, proving the per-face bindings flow to the view —
# closing importer → view for the textures-only format with no model JSON in sight.
func _check_flat_render(v3d: Node) -> void:
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_shelltest_flatlib__"
	var src := "user://__voxyl_shelltest_flatsrc__"
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	var blocks := src + "/assets/testmod/textures/blocks"
	for face in [["pillar_top", Color(0.8, 0.2, 0.2)], ["pillar_side", Color(0.2, 0.6, 0.2)]]:
		var img := Image.create_empty(16, 16, false, Image.FORMAT_RGBA8)
		img.fill(face[1])
		DirAccess.make_dir_recursive_absolute((blocks + "/" + face[0] + ".png").get_base_dir())
		img.save_png(blocks + "/" + face[0] + ".png")

	var ws := VoxelWorld.workspace
	var lib := ws.basic_library()
	var imp := MCFlatImporter.new(src + "/assets", lib)
	imp.import_block("testmod", "pillar")          # top + side → multi-face cube
	var pal := ws.add_palette("__flat_test__")
	var e := PaletteEntry.new()
	e.semantic_name = "FlatTest"; e.block_type_name = "pillar"
	pal.entries.append(e)
	var project := VoxelWorld.active_project
	project.palette_names.append("__flat_test__")

	VoxelWorld.set_block(Vector3i(0, 10, 0), "FlatTest")
	v3d._rebuild()
	var mi: MeshInstance3D = (v3d.get("_cell_nodes") as Dictionary).get(Vector3i(0, 10, 0))
	_check("flat-imported block renders through the textured path",
		mi != null and mi.get_meta("textured", false))
	_check("flat multi-face block splits into per-texture surfaces (top ≠ side)",
		mi != null and mi.mesh.get_surface_count() == 2)
	_check("flat block's surfaces carry the copied textures",
		mi != null and mi.get_surface_override_material(0) is StandardMaterial3D
		and (mi.get_surface_override_material(0) as StandardMaterial3D).albedo_texture != null)

	# Teardown — restore the workspace/project for any checks that follow.
	VoxelWorld.clear_block(Vector3i(0, 10, 0))
	project.palette_names.erase("__flat_test__")
	ws.remove_palette("__flat_test__")
	lib.remove_block_type("pillar")
	lib.remove_block_model("testmod:flat/pillar")
	lib.remove_texture_asset("testmod:blocks/pillar_top")
	lib.remove_texture_asset("testmod:blocks/pillar_side")
	v3d._rebuild()
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	AssetLibrary.ROOT = saved_root

# The import progress window must drive the incremental import to completion across
# frames on the main thread (the fix for the "frozen window" of a big batch), end with
# its results, and surface warnings. Exercised in-tree so the awaiting actually ticks.
func _check_import_progress() -> void:
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_shelltest_proglib__"
	var src := "user://__voxyl_shelltest_progsrc__"
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	var assets := src + "/assets"
	# Two importable blocks + one that will warn (its model is missing) so the warnings
	# panel has something to show.
	for id in ["prog_a", "prog_b", "prog_broken"]:
		_write_text("%s/minecraft/blockstates/%s.json" % [assets, id],
			'{"variants":{"":{"model":"minecraft:block/%s"}}}' % id)
	for id in ["prog_a", "prog_b"]:
		_write_text("%s/minecraft/models/block/%s.json" % [assets, id],
			'{"textures":{"all":"minecraft:block/%s"},"elements":[{"from":[0,0,0],"to":[16,16,16],"faces":{"up":{"texture":"#all"}}}]}' % id)
		var img := Image.create_empty(16, 16, false, Image.FORMAT_RGBA8)
		img.fill(Color(0.4, 0.5, 0.6))
		DirAccess.make_dir_recursive_absolute(("%s/minecraft/textures/block/%s.png" % [assets, id]).get_base_dir())
		img.save_png("%s/minecraft/textures/block/%s.png" % [assets, id])

	var ws := VoxelWorld.workspace
	var svc := ImportService.new(ImportService.detect_sources(src), ws.get_or_add_library("__prog__"))
	var sel := svc.available_blocks()

	var dlg := ImportProgressDialog.new()
	add_child(dlg)
	await dlg.run(svc, sel)

	_check("progress dialog imports the good blocks (broken one skipped)",
		svc.imported_count == 2 and ws.get_block_type("prog_a") != null)
	_check("progress dialog collected warnings for the broken block",
		not svc.warnings.is_empty())
	_check("progress dialog enables Close when finished",
		not (dlg.get("_close_btn") as Button).disabled)
	_check("progress bar reaches full on completion",
		(dlg.get("_bar") as ProgressBar).value == (dlg.get("_bar") as ProgressBar).max_value)
	_check("warnings are surfaced in the dialog, not just counted",
		(dlg.get("_warn_box") as TextEdit).visible
		and not (dlg.get("_warn_box") as TextEdit).text.is_empty())

	dlg.queue_free()
	ws.remove_library("__prog__")
	svc.close()
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	AssetLibrary.ROOT = saved_root

# Renaming a library moves its folder on disk, repoints its textures' embedded library
# segment, and updates any palette that subscribed to it — while keeping the basic floor
# and builtin guards intact.
func _check_library_rename() -> void:
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_shelltest_renlib__"
	_rm_rf(AssetLibrary.ROOT)

	var ws := VoxelWorld.workspace
	var lib := ws.get_or_add_library("ren_old")
	var bt := lib.add_block_type("ren_block")
	var tex := TextureAsset.new()
	tex.id = "ren:tex"
	tex.image_path = AssetLibrary.in_library("ren_old", "pixels/ren/tex.png")
	lib.add_texture_asset(tex)
	var img := Image.create_empty(16, 16, false, Image.FORMAT_RGBA8)
	img.fill(Color(0.3, 0.4, 0.5))
	DirAccess.make_dir_recursive_absolute(AssetLibrary.path_for(tex.image_path).get_base_dir())
	img.save_png(AssetLibrary.path_for(tex.image_path))

	var pal := ws.add_palette("ren_pal")
	pal.library_names = ["ren_old"]
	LibraryStore.save_library(lib)
	LibraryStore.save_palettes(ws)

	var ok := LibraryStore.rename_library(ws, "ren_old", "ren_new")
	_check("rename_library reports success", ok)
	_check("renamed library replaces the old name in the catalog",
		ws.get_library("ren_old") == null and ws.get_library("ren_new") != null)
	_check("renamed library keeps its block types", bt.name == "ren_block"
		and ws.get_library("ren_new").get_block_type("ren_block") != null)
	_check("texture image_path is repointed to the new library segment",
		tex.image_path.begins_with("ren_new/"))
	_check("the new library folder exists on disk, the old one is gone",
		DirAccess.dir_exists_absolute(AssetLibrary.path_for("ren_new"))
		and not DirAccess.dir_exists_absolute(AssetLibrary.path_for("ren_old")))
	_check("subscribing palette is repointed to the new name",
		pal.library_names == ["ren_new"])
	_check("rename to the basic floor name is refused",
		not LibraryStore.rename_library(ws, "ren_new", VoxelWorkspace.BASIC_LIBRARY))
	_check("the builtin basic library can't be renamed",
		not LibraryStore.rename_library(ws, VoxelWorkspace.BASIC_LIBRARY, "whatever"))

	ws.remove_palette("ren_pal")
	ws.remove_library("ren_new")
	_rm_rf(AssetLibrary.ROOT)
	AssetLibrary.ROOT = saved_root

func _color_near(a: Color, b: Color, tol: float) -> bool:
	return absf(a.r - b.r) <= tol and absf(a.g - b.g) <= tol and absf(a.b - b.b) <= tol

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
