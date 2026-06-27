extends Node

var _pass := 0
var _fail := 0

func _ready() -> void:
	print("\n=== voxyl smoke test ===\n")
	_test_workspace_init()
	_test_block_ops()
	_test_palette_resolution()
	_test_last_wins()
	_test_orientation()
	_test_cell_orientation_tags()
	_test_hotbar()
	_test_shapes()
	_test_models()
	_test_reorient()
	_test_asset_library()
	_test_library_serialization()
	_test_mc_import()
	_test_statemap_multipart()
	_test_mc_import_multipart()
	_test_mc_import_tint()
	_test_tint_resolver()
	print("\n%d passed, %d failed" % [_pass, _fail])
	get_tree().quit(1 if _fail > 0 else 0)

func _check(label: String, condition: bool) -> void:
	if condition:
		print("  ok   %s" % label)
		_pass += 1
	else:
		print("  FAIL %s" % label)
		_fail += 1

func _test_workspace_init() -> void:
	print("-- workspace init")
	_check("workspace exists", VoxelWorld.workspace != null)
	_check("block types populated", VoxelWorld.workspace.block_types.size() > 0)
	_check("default palette exists", VoxelWorld.workspace.get_palette("Default") != null)
	var project := VoxelWorld.workspace.get_project("My First Build")
	_check("default project exists", project != null)
	_check("project has palette stack", project != null and not project.palette_names.is_empty())

func _test_block_ops() -> void:
	print("-- block ops")
	var project := VoxelWorld.workspace.get_project("My First Build")
	VoxelWorld.open(project)
	VoxelWorld.set_block(Vector3i(0, 0, 0), "Base")
	_check("set block", VoxelWorld.get_block(Vector3i(0, 0, 0)) == "Base")
	VoxelWorld.clear_block(Vector3i(0, 0, 0))
	_check("clear block", VoxelWorld.get_block(Vector3i(0, 0, 0)) == "")
	# Coordinates are unbounded by design: far-flung and negative positions are valid.
	VoxelWorld.set_block(Vector3i(100, 100, 100), "Base")
	_check("far-flung coords stored", VoxelWorld.get_block(Vector3i(100, 100, 100)) == "Base")
	VoxelWorld.set_block(Vector3i(-50, -50, -50), "Base")
	_check("negative coords stored", VoxelWorld.get_block(Vector3i(-50, -50, -50)) == "Base")
	VoxelWorld.clear_block(Vector3i(100, 100, 100))
	VoxelWorld.clear_block(Vector3i(-50, -50, -50))

func _test_palette_resolution() -> void:
	print("-- palette resolution")
	var project := VoxelWorld.workspace.get_project("My First Build")
	VoxelWorld.open(project)
	_check("merged semantic names non-empty", VoxelWorld.merged_semantic_names().size() > 0)
	var fallback := Color(0.35, 0.35, 0.35)
	_check("known semantic resolves color", VoxelWorld.get_color_for_semantic("Base") != fallback)
	_check("unknown semantic gets fallback", VoxelWorld.get_color_for_semantic("__nope__") == fallback)
	_check("block type resolved", not VoxelWorld.get_block_type_for_semantic("Base").is_empty())
	_check("unknown block type is empty", VoxelWorld.get_block_type_for_semantic("__nope__") == "")

func _test_last_wins() -> void:
	print("-- last-wins palette layering")
	var ws := VoxelWorld.workspace
	var project := ws.get_project("My First Build")
	var diamond := ws.add_block_type("Diamond Block")
	diamond.color = Color.CYAN
	var override := ws.add_palette("__test_override__")
	var e := PaletteEntry.new()
	e.semantic_name = "Base"
	e.block_type_name = "Diamond Block"
	override.entries.append(e)
	project.palette_names.append("__test_override__")
	VoxelWorld.open(project)
	_check("last-wins block type", VoxelWorld.get_block_type_for_semantic("Base") == "Diamond Block")
	_check("last-wins color", VoxelWorld.get_color_for_semantic("Base") == Color.CYAN)
	_check("non-overridden entry still resolves", not VoxelWorld.get_block_type_for_semantic("Accent").is_empty())
	project.palette_names.pop_back()
	ws.remove_palette("__test_override__")
	ws.remove_block_type("Diamond Block")

func _test_orientation() -> void:
	print("-- orientation encoding")
	var o := Orientation.make(Orientation.Facing.EAST, true)
	_check("facing round-trips", Orientation.facing_of(o) == Orientation.Facing.EAST)
	_check("top flag round-trips", Orientation.is_top(o))
	_check("dir of east is +X", Orientation.dir_of(o) == Vector3i(1, 0, 0))
	_check("rotate cw N→E", Orientation.facing_of(
		Orientation.rotate_cw(Orientation.make(Orientation.Facing.NORTH))) == Orientation.Facing.EAST)
	_check("rotate keeps top flag", Orientation.is_top(Orientation.rotate_cw(o)))
	_check("from_dir picks dominant axis",
		Orientation.from_dir(Vector3(0.1, 0.0, -0.9)) == Orientation.Facing.NORTH)
	_check("toggle_top flips", not Orientation.is_top(Orientation.toggle_top(o)))

func _test_cell_orientation_tags() -> void:
	print("-- cell orientation + tags")
	var project := VoxelWorld.workspace.get_project("My First Build")
	VoxelWorld.open(project)
	var face := Orientation.make(Orientation.Facing.SOUTH, false)
	VoxelWorld.set_block(Vector3i(3, 3, 3), "Base", face)
	_check("orientation stored on cell", project.data.get_orientation(Vector3i(3, 3, 3)) == face)
	var cell := project.data.get_cell(Vector3i(3, 3, 3))
	_check("cell exposes type + orientation",
		cell != null and cell.type_id == "Base" and cell.orientation == face)
	cell.tags["note"] = "hello"
	_check("cell carries open-ended tags",
		project.data.get_cell(Vector3i(3, 3, 3)).tags.get("note", "") == "hello")
	VoxelWorld.clear_block(Vector3i(3, 3, 3))
	_check("cleared cell is gone", project.data.get_cell(Vector3i(3, 3, 3)) == null)

func _test_hotbar() -> void:
	print("-- hotbar")
	var project := VoxelWorld.workspace.get_project("My First Build")
	VoxelWorld.open(project)
	_check("hotbar has 9 slots", VoxelWorld.hotbar.size() == VoxelWorld.HOTBAR_SIZE)
	_check("hotbar seeded from palette", not VoxelWorld.hotbar[0].is_empty())
	VoxelWorld.set_hotbar_slot(2, "Trim")
	VoxelWorld.select_slot(2)
	_check("select_slot drives selection", VoxelWorld.selected_semantic == "Trim")
	_check("active slot tracked", VoxelWorld.active_slot == 2)
	# Pick an item already on the bar → jump to its slot, don't duplicate.
	VoxelWorld.set_hotbar_slot(5, "Roof")
	VoxelWorld.pick_block("Roof")
	_check("pick_block jumps to existing slot", VoxelWorld.active_slot == 5)
	# Pick a fresh item → lands in the active slot.
	VoxelWorld.select_slot(7)
	VoxelWorld.pick_block("Floor")
	_check("pick_block fills active slot", VoxelWorld.hotbar[7] == "Floor")

func _test_shapes() -> void:
	print("-- shape resolution")
	var project := VoxelWorld.workspace.get_project("My First Build")
	VoxelWorld.open(project)
	_check("stairs semantic resolves to STAIRS",
		VoxelWorld.get_shape_for_semantic("Stairs") == BlockType.Shape.STAIRS)
	_check("slab semantic resolves to SLAB",
		VoxelWorld.get_shape_for_semantic("Slab") == BlockType.Shape.SLAB)
	_check("plain semantic resolves to FULL",
		VoxelWorld.get_shape_for_semantic("Base") == BlockType.Shape.FULL)

func _test_models() -> void:
	print("-- model resolution (Phase 0 material layer)")
	var ws := VoxelWorld.workspace
	VoxelWorld.open(ws.get_project("My First Build"))
	_check("built-in models registered",
		ws.get_block_model(BlockModel.BUILTIN_FULL) != null
		and ws.get_block_model(BlockModel.BUILTIN_SLAB) != null
		and ws.get_block_model(BlockModel.BUILTIN_STAIRS) != null)
	# A semantic resolves to the built-in model matching its block type's shape.
	var base_model := VoxelWorld.get_model_for_semantic("Base")
	_check("plain semantic resolves to full model",
		base_model != null and base_model.id == BlockModel.BUILTIN_FULL)
	_check("slab semantic resolves to slab model",
		VoxelWorld.get_model_for_semantic("Slab").id == BlockModel.BUILTIN_SLAB)
	_check("stairs semantic resolves to stairs model",
		VoxelWorld.get_model_for_semantic("Stairs").id == BlockModel.BUILTIN_STAIRS)
	_check("full model is a single unit-cube element",
		base_model.elements.size() == 1
		and base_model.elements[0]["from"] == Vector3.ZERO
		and base_model.elements[0]["to"] == Vector3.ONE)
	# No textures imported yet → color path; texture resolver returns null.
	_check("no texture for semantic in the color path",
		VoxelWorld.get_texture_for_semantic("Base") == null)
	# An explicit model_id overrides the shape fallback (the additive path).
	var custom := BlockModel.new()
	custom.id = "__test_pillar__"
	custom.elements = [BlockModel.box_element(Vector3(0.25, 0, 0.25), Vector3(0.75, 1, 0.75))]
	ws.add_block_model(custom)
	var bt := ws.get_block_type("Stone")  # "Base" maps to Stone, shape FULL
	bt.model_id = "__test_pillar__"
	_check("explicit model_id overrides shape fallback",
		VoxelWorld.get_model_for_semantic("Base").id == "__test_pillar__")
	bt.model_id = ""
	ws.remove_block_model("__test_pillar__")

func _test_reorient() -> void:
	print("-- reorient existing cells (R / Shift+R)")
	var project := VoxelWorld.workspace.get_project("My First Build")
	VoxelWorld.open(project)
	var p := Vector3i(4, 4, 4)
	VoxelWorld.set_block(p, "Stairs", Orientation.make(Orientation.Facing.NORTH, false))
	VoxelWorld.reorient_block(p, Orientation.make(Orientation.Facing.EAST, true))
	var cell := project.data.get_cell(p)
	_check("reorient updates facing", Orientation.facing_of(cell.orientation) == Orientation.Facing.EAST)
	_check("reorient updates top flag", Orientation.is_top(cell.orientation))
	_check("reorient keeps the same block type", cell.type_id == "Stairs")
	# Re-orienting an empty cell is a harmless no-op (never creates a block).
	VoxelWorld.reorient_block(Vector3i(40, 40, 40), Orientation.make(Orientation.Facing.WEST))
	_check("reorient of empty cell creates nothing", project.data.get_cell(Vector3i(40, 40, 40)) == null)
	VoxelWorld.clear_block(p)

func _test_asset_library() -> void:
	print("-- asset library (storage accessor)")
	# Point the single storage root at throwaway user:// scratch so the test never
	# writes into the repo, then restore it.
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_test_lib__"
	_rm_rf(AssetLibrary.ROOT)
	_check("path_for() is the root itself", AssetLibrary.path_for() == AssetLibrary.ROOT)
	_check("path_for joins the root", AssetLibrary.path_for("a/b") == AssetLibrary.ROOT.path_join("a/b"))
	AssetLibrary.ensure_dir(AssetLibrary.PIXELS_DIR)
	var img := Image.create_empty(16, 16, false, Image.FORMAT_RGBA8)
	img.fill(Color(0.2, 0.6, 0.9))
	_check("png writes under the library", img.save_png(AssetLibrary.path_for("pixels/test.png")) == OK)
	_check("file_exists sees the written file", AssetLibrary.file_exists("pixels/test.png"))
	var tex := AssetLibrary.load_texture("pixels/test.png")
	_check("load_texture returns a texture", tex != null)
	_check("loaded texture keeps the saved size",
		tex != null and tex.get_width() == 16 and tex.get_height() == 16)
	_check("missing image loads as null", AssetLibrary.load_image("pixels/nope.png") == null)
	_rm_rf(AssetLibrary.ROOT)
	AssetLibrary.ROOT = saved_root

func _test_library_serialization() -> void:
	print("-- library serialization round-trip")
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_test_lib__"
	_rm_rf(AssetLibrary.ROOT)

	# Author a model + texture + block type by hand (the importer-agnostic path).
	var ws := VoxelWorkspace.new()
	var model := BlockModel.new()
	model.id = "test_pillar"
	model.elements = [BlockModel.box_element(Vector3(0.25, 0, 0.25), Vector3(0.75, 1, 0.75), "all")]
	model.textures = {"all": "test_tex"}
	ws.add_block_model(model)
	var tex := TextureAsset.new()
	tex.id = "test_tex"
	tex.image_path = "pixels/test_tex.png"
	tex.frame_count = 4
	tex.frame_time = 0.25
	tex.transparency = TextureAsset.Transparency.CUTOUT
	tex.average_color = Color(0.3, 0.7, 0.2)
	ws.add_texture_asset(tex)
	var bt := ws.add_block_type("Test Block")
	bt.model_id = "test_pillar"

	_check("save_all succeeds", LibraryStore.save_all(ws) == OK)

	# Load into a fresh workspace and confirm every field survived the trip.
	var ws2 := VoxelWorkspace.new()
	LibraryStore.load_into(ws2)
	var m2 := ws2.get_block_model("test_pillar")
	_check("model round-trips", m2 != null and m2.id == "test_pillar")
	_check("model elements (Vector3 geometry) survive",
		m2 != null and m2.elements.size() == 1
		and m2.elements[0]["from"] == Vector3(0.25, 0, 0.25)
		and m2.elements[0]["to"] == Vector3(0.75, 1, 0.75))
	_check("model texture bindings survive", m2 != null and m2.textures.get("all", "") == "test_tex")
	var t2 := ws2.get_texture_asset("test_tex")
	_check("texture animation fields survive",
		t2 != null and t2.frame_count == 4 and is_equal_approx(t2.frame_time, 0.25))
	_check("texture transparency + average color survive",
		t2 != null and t2.transparency == TextureAsset.Transparency.CUTOUT
		and t2.average_color.is_equal_approx(Color(0.3, 0.7, 0.2)))
	var bt2 := ws2.get_block_type("Test Block")
	_check("block type round-trips with its model_id", bt2 != null and bt2.model_id == "test_pillar")

	_rm_rf(AssetLibrary.ROOT)
	AssetLibrary.ROOT = saved_root

# Phase 2: the MC importer translates a synthetic `assets/<ns>/...` tree (we never
# bundle real MC assets — decision 4) into voxyl's neutral material layer. Exercises
# the parent chain, coordinate/UV conversion, texture copy + .mcmeta animation,
# average-color sampling, and blockstate variants → BlockStateMap.
func _test_mc_import() -> void:
	print("-- mc importer (Phase 2 translator)")
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_mclib__"
	var src := "user://__voxyl_mcsrc__"
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	var assets := src + "/assets"

	# Shared MC templates (minecraft ns): cube defines the geometry + per-face #vars;
	# cube_all binds every face to a single #all. Bare parent refs default to minecraft.
	_write_file(assets + "/minecraft/models/block/cube.json", """
{ "elements": [ { "from": [0,0,0], "to": [16,16,16], "faces": {
	"down": {"texture":"#down"}, "up": {"texture":"#up"},
	"north": {"texture":"#north"}, "south": {"texture":"#south"},
	"west": {"texture":"#west"}, "east": {"texture":"#east"} } } ] }
""")
	_write_file(assets + "/minecraft/models/block/cube_all.json", """
{ "parent": "block/cube", "textures": {
	"particle":"#all","down":"#all","up":"#all",
	"north":"#all","south":"#all","west":"#all","east":"#all" } }
""")
	# A mod namespace whose blocks inherit the vanilla templates by qualified ref.
	_write_file(assets + "/testmod/models/block/test_block.json", """
{ "parent": "minecraft:block/cube_all", "textures": {"all":"testmod:block/test_tex"} }
""")
	_write_file(assets + "/testmod/models/block/test_anim_model.json", """
{ "parent": "minecraft:block/cube_all", "textures": {"all":"testmod:block/test_anim"} }
""")
	# A half-height element overriding the inherited cube → coord conversion 16→1.
	_write_file(assets + "/testmod/models/block/test_slab.json", """
{ "parent": "minecraft:block/cube_all", "textures": {"all":"testmod:block/test_tex"},
  "elements": [ { "from": [0,0,0], "to": [16,8,16], "faces": {
	"down": {"texture":"#all"}, "up": {"texture":"#all"},
	"north": {"texture":"#all"}, "south": {"texture":"#all"},
	"west": {"texture":"#all"}, "east": {"texture":"#all"} } } ] }
""")
	_write_file(assets + "/testmod/blockstates/test_block.json",
		"""{ "variants": { "": { "model": "testmod:block/test_block" } } }""")
	_write_file(assets + "/testmod/blockstates/test_anim.json",
		"""{ "variants": { "": { "model": "testmod:block/test_anim_model" } } }""")
	_write_file(assets + "/testmod/blockstates/test_slab.json",
		"""{ "variants": { "": { "model": "testmod:block/test_slab" } } }""")
	# Orientation variants → BlockStateMap; y-rotation captured per facing.
	_write_file(assets + "/testmod/blockstates/test_stairs.json", """
{ "variants": {
	"facing=east":  { "model": "testmod:block/test_block" },
	"facing=south": { "model": "testmod:block/test_block", "y": 90 },
	"facing=west":  { "model": "testmod:block/test_block", "y": 180 },
	"facing=north": { "model": "testmod:block/test_block", "y": 270 } } }
""")
	# Pixels: a flat-colored static texture, and a 2-frame vertical strip + .mcmeta.
	var tex_color := Color(0.2, 0.5, 0.8)
	var tex := Image.create_empty(16, 16, false, Image.FORMAT_RGBA8)
	tex.fill(tex_color)
	_write_png(assets + "/testmod/textures/block/test_tex.png", tex)
	var anim := Image.create_empty(16, 32, false, Image.FORMAT_RGBA8)
	anim.fill(Color(0.4, 0.2, 0.1))
	_write_png(assets + "/testmod/textures/block/test_anim.png", anim)
	_write_file(assets + "/testmod/textures/block/test_anim.png.mcmeta",
		"""{ "animation": { "frametime": 4, "interpolate": true } }""")

	var ws := VoxelWorkspace.new()
	var imp := MCImporter.new(assets, ws)
	imp.import_namespace("testmod")

	_check("all four blocks imported",
		imp.imported_blocks.size() == 4 and imp.imported_blocks.has("test_block")
		and imp.imported_blocks.has("test_stairs"))

	# Block type + primary model.
	var bt := ws.get_block_type("test_block")
	_check("block type emitted with a model_id",
		bt != null and bt.model_id == "testmod:block/test_block")
	var model := ws.get_block_model("testmod:block/test_block")
	_check("leaf model imported (parent geometry merged in)",
		model != null and model.elements.size() == 1
		and model.elements[0]["from"] == Vector3.ZERO
		and model.elements[0]["to"] == Vector3.ONE)
	_check("template parents are flattened, not added as models",
		ws.get_block_model("minecraft:block/cube_all") == null
		and ws.get_block_model("minecraft:block/cube") == null)
	_check("model binds a texture key the view can resolve",
		model != null and model.has_textures()
		and model.textures.has("testmod:block/test_tex"))

	# Texture copied to the library + loadable end-to-end.
	var t := ws.get_texture_asset("testmod:block/test_tex")
	_check("texture asset created", t != null and t.id == "testmod:block/test_tex")
	_check("texture pixels copied into the library + loadable",
		t != null and AssetLibrary.load_image(t.image_path) != null)
	_check("texture imported once (dedup across blocks)",
		ws.texture_assets.size() == 2)
	_check("opaque texture classified opaque",
		t != null and t.transparency == TextureAsset.Transparency.OPAQUE)

	# Average color sampled at import, mirrored to BlockType.color (decision 1).
	_check("average color sampled from the texture",
		t != null and _color_near(t.average_color, tex_color, 0.02))
	_check("planning color mirrors the texture average",
		bt != null and _color_near(bt.color, tex_color, 0.02))

	# Partial element: 0–16 → 0–1, half height.
	var slab := ws.get_block_model("testmod:block/test_slab")
	_check("partial element converts 16→1 units",
		slab != null and slab.elements[0]["to"] == Vector3(1.0, 0.5, 1.0))

	# Animation: .mcmeta frames + ticks→seconds.
	var at := ws.get_texture_asset("testmod:block/test_anim")
	_check("animated texture frame_count from strip height",
		at != null and at.frame_count == 2)
	_check("frametime ticks converted to seconds (4/20)",
		at != null and is_equal_approx(at.frame_time, 0.2))
	_check("interpolate flag parsed", at != null and at.interpolate)

	# Blockstate variants → BlockStateMap (orientation → model + rotation).
	var stairs := ws.get_block_type("test_stairs")
	_check("orientation variants captured in a state_map",
		stairs != null and stairs.state_map != null and not stairs.state_map.is_empty())
	var east := stairs.state_map.resolve(Orientation.make(Orientation.Facing.EAST, false))
	var north := stairs.state_map.resolve(Orientation.make(Orientation.Facing.NORTH, false))
	_check("facing=east resolves to its model with no rotation",
		east.get("model_id", "") == "testmod:block/test_block" and int(east.get("y_rot", -1)) == 0)
	_check("facing=north carries its y rotation", int(north.get("y_rot", -1)) == 270)

	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	AssetLibrary.ROOT = saved_root

# Phase 3: the neutral multipart map on its own — OR/AND clause matching and part
# selection from derived connection flags, with no importer or view involved.
func _test_statemap_multipart() -> void:
	print("-- multipart state map (connection parts)")
	var sm := BlockStateMap.new()
	sm.add_part([], "post")                      # always-on (the post)
	sm.add_part([{0: true}], "side", 0, 0)       # north (dir 0)
	sm.add_part([{1: true}], "side", 0, 90)      # east  (dir 1)
	sm.add_part([{0: true, 1: true}], "corner")  # north AND east (one clause)
	sm.add_part([{2: true}, {3: true}], "cap")   # south OR west (two clauses)
	_check("non-empty multipart map reads as multipart",
		sm.is_multipart() and not sm.is_empty())
	_check("default part is the always-on post", sm.default_part_model_id() == "post")
	# No connections → just the post.
	var none := sm.resolve_parts({})
	_check("no neighbors → post only", none.size() == 1 and none[0]["model_id"] == "post")
	# North connected → post + north side; the AND-corner and OR-cap stay off.
	_check("north connection → post + north side",
		_part_ids(sm.resolve_parts({0: true})) == ["post", "side"])
	# North+East → post + both sides + the AND corner.
	_check("north+east → post, two sides, the AND corner",
		_part_ids(sm.resolve_parts({0: true, 1: true})) == ["post", "side", "side", "corner"])
	# OR clause: matches south alone or west alone, but not an unrelated direction.
	_check("OR clause matches either branch (not an unrelated dir)",
		_part_ids(sm.resolve_parts({2: true})).has("cap")
		and _part_ids(sm.resolve_parts({3: true})).has("cap")
		and not _part_ids(sm.resolve_parts({0: true})).has("cap"))

# Phase 3: the importer translates an MC `multipart` blockstate (a fence) into the
# neutral multipart map — boolean direction conditions become connection clauses,
# multi-value conditions (wall/redstone style) are skipped, not fatal.
func _test_mc_import_multipart() -> void:
	print("-- mc importer multipart (fences/panes/bars)")
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_mpimport__"
	var src := "user://__voxyl_mpsrc__"
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	var assets := src + "/assets"

	# A fence: a post (always) + a side arm per connected horizontal neighbor, the
	# same model rotated by y. One stray part uses a non-boolean (wall-style) value
	# to prove unhandled conditions are skipped rather than aborting the import.
	_write_file(assets + "/testmod/blockstates/test_fence.json", """
{ "multipart": [
	{ "apply": { "model": "testmod:block/fence_post" } },
	{ "when": { "north": "true" }, "apply": { "model": "testmod:block/fence_side" } },
	{ "when": { "east":  "true" }, "apply": { "model": "testmod:block/fence_side", "y": 90 } },
	{ "when": { "south": "true" }, "apply": { "model": "testmod:block/fence_side", "y": 180 } },
	{ "when": { "west":  "true" }, "apply": { "model": "testmod:block/fence_side", "y": 270 } },
	{ "when": { "up": "tall" }, "apply": { "model": "testmod:block/fence_side" } } ] }
""")
	_write_file(assets + "/testmod/models/block/fence_post.json", """
{ "textures": {"all":"testmod:block/planks"}, "elements": [ { "from": [6,0,6], "to": [10,16,10], "faces": {
	"down": {"texture":"#all"}, "up": {"texture":"#all"},
	"north": {"texture":"#all"}, "south": {"texture":"#all"},
	"west": {"texture":"#all"}, "east": {"texture":"#all"} } } ] }
""")
	_write_file(assets + "/testmod/models/block/fence_side.json", """
{ "textures": {"all":"testmod:block/planks"}, "elements": [ { "from": [7,6,0], "to": [9,15,9], "faces": {
	"down": {"texture":"#all"}, "up": {"texture":"#all"},
	"north": {"texture":"#all"}, "south": {"texture":"#all"},
	"west": {"texture":"#all"}, "east": {"texture":"#all"} } } ] }
""")
	var planks := Image.create_empty(16, 16, false, Image.FORMAT_RGBA8)
	planks.fill(Color(0.6, 0.45, 0.25))
	_write_png(assets + "/testmod/textures/block/planks.png", planks)

	var ws := VoxelWorkspace.new()
	var imp := MCImporter.new(assets, ws)
	imp.import_block("testmod", "test_fence")

	var bt := ws.get_block_type("test_fence")
	_check("fence imported with a multipart state_map",
		bt != null and bt.state_map != null and bt.state_map.is_multipart())
	_check("fence model_id points at the always-on post",
		bt != null and bt.model_id == "testmod:block/fence_post")
	_check("post + 4 boolean sides translated; non-boolean part skipped",
		bt != null and bt.state_map.parts.size() == 5)
	_check("the non-boolean 'when' part was warned + skipped",
		_warns_contain(imp, "unhandled 'when'"))
	_check("post + side models imported",
		ws.get_block_model("testmod:block/fence_post") != null
		and ws.get_block_model("testmod:block/fence_side") != null)
	_check("shared texture imported once", ws.texture_assets.size() == 1)
	# Connection resolution end-to-end: isolated → post; east neighbor → +y=90 side.
	var sm := bt.state_map
	_check("isolated fence resolves to the post only", sm.resolve_parts({}).size() == 1)
	var east_parts := sm.resolve_parts({1: true})   # EAST connected (dir 1)
	_check("east connection adds the y=90 side",
		east_parts.size() == 2 and int(east_parts[1].get("y_rot", -1)) == 90)

	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	AssetLibrary.ROOT = saved_root

# Phase 4: the importer bakes MC's plains-biome tint onto blocks whose model faces
# carry a tintindex. Leaves (every face tinted) fold the tint into the planning color;
# a grass block (only the top tinted) keeps its dominant side color and never mis-marks
# the pre-composited side texture; a plain block stays untinted (WHITE).
func _test_mc_import_tint() -> void:
	print("-- mc importer tint (biome colors, Phase 4)")
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_tintlib__"
	var src := "user://__voxyl_tintsrc__"
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	var assets := src + "/assets"

	var foliage := Color(0.4667, 0.6706, 0.1843)
	var grass := Color(0.5686, 0.7412, 0.3490)
	var leaf_gray := Color(0.6, 0.6, 0.6)
	var grass_top_gray := Color(0.55, 0.55, 0.55)
	var grass_side := Color(0.45, 0.32, 0.2)
	var dirt := Color(0.4, 0.3, 0.22)
	var plain := Color(0.5, 0.5, 0.55)

	# Leaves: full cube, every face tintindex 0, one grayscale texture.
	_write_file(assets + "/testmod/models/block/test_leaves.json", """
{ "textures": {"all":"testmod:block/test_leaves_tex"}, "elements": [ { "from":[0,0,0], "to":[16,16,16],
	"faces": { "down":{"texture":"#all","tintindex":0},"up":{"texture":"#all","tintindex":0},
	"north":{"texture":"#all","tintindex":0},"south":{"texture":"#all","tintindex":0},
	"west":{"texture":"#all","tintindex":0},"east":{"texture":"#all","tintindex":0} } } ] }
""")
	# Grass block: only the top is tinted; sides/bottom are pre-composited (untinted).
	_write_file(assets + "/testmod/models/block/test_grass.json", """
{ "textures": {"top":"testmod:block/test_grass_top","side":"testmod:block/test_grass_side","bottom":"testmod:block/test_dirt"},
	"elements": [ { "from":[0,0,0], "to":[16,16,16], "faces": {
	"up":{"texture":"#top","tintindex":0}, "down":{"texture":"#bottom"},
	"north":{"texture":"#side"},"south":{"texture":"#side"},"west":{"texture":"#side"},"east":{"texture":"#side"} } } ] }
""")
	# Plain: full cube, no tintindex anywhere.
	_write_file(assets + "/testmod/models/block/test_plain.json", """
{ "textures": {"all":"testmod:block/test_plain_tex"}, "elements": [ { "from":[0,0,0], "to":[16,16,16],
	"faces": { "down":{"texture":"#all"},"up":{"texture":"#all"},"north":{"texture":"#all"},
	"south":{"texture":"#all"},"west":{"texture":"#all"},"east":{"texture":"#all"} } } ] }
""")
	_write_file(assets + "/testmod/blockstates/test_leaves.json",
		'{ "variants": { "": { "model": "testmod:block/test_leaves" } } }')
	_write_file(assets + "/testmod/blockstates/test_grass.json",
		'{ "variants": { "": { "model": "testmod:block/test_grass" } } }')
	_write_file(assets + "/testmod/blockstates/test_plain.json",
		'{ "variants": { "": { "model": "testmod:block/test_plain" } } }')
	_write_solid(assets + "/testmod/textures/block/test_leaves_tex.png", leaf_gray)
	_write_solid(assets + "/testmod/textures/block/test_grass_top.png", grass_top_gray)
	_write_solid(assets + "/testmod/textures/block/test_grass_side.png", grass_side)
	_write_solid(assets + "/testmod/textures/block/test_dirt.png", dirt)
	_write_solid(assets + "/testmod/textures/block/test_plain_tex.png", plain)

	var ws := VoxelWorkspace.new()
	var imp := MCImporter.new(assets, ws)
	imp.import_namespace("testmod")

	# Leaves — fully tinted, color folded.
	var leaves := ws.get_block_type("test_leaves")
	var lm := ws.get_block_model("testmod:block/test_leaves")
	_check("tinted blocks imported",
		leaves != null and ws.get_block_type("test_grass") != null and ws.get_block_type("test_plain") != null)
	_check("leaves face keeps its tint_index",
		lm != null and int(lm.elements[0]["faces"][BlockModel.Dir.UP]["tint_index"]) == 0)
	_check("leaves tint is the plains foliage default",
		leaves != null and _color_near(leaves.tint, foliage, 0.01))
	var lt := ws.get_texture_asset("testmod:block/test_leaves_tex")
	_check("leaves texture marked as a foliage tint source",
		lt != null and lt.tint_source == TextureAsset.TintSource.FOLIAGE)
	_check("leaves planning color folds the tint in (grey source → green)",
		leaves != null and _color_near(leaves.color, leaf_gray * foliage, 0.02)
		and not _color_near(leaves.color, leaf_gray, 0.05))

	# Grass — only the top is tinted; dominant side color is preserved.
	var grass_bt := ws.get_block_type("test_grass")
	_check("grass block tint is the plains grass default",
		grass_bt != null and _color_near(grass_bt.tint, grass, 0.01))
	_check("grass top texture marked as a grass tint source",
		ws.get_texture_asset("testmod:block/test_grass_top") != null
		and ws.get_texture_asset("testmod:block/test_grass_top").tint_source == TextureAsset.TintSource.GRASS)
	_check("pre-composited grass side texture is never mis-marked",
		ws.get_texture_asset("testmod:block/test_grass_side") != null
		and ws.get_texture_asset("testmod:block/test_grass_side").tint_source == TextureAsset.TintSource.NONE)
	_check("grass planning color stays the untinted dominant side (no fold)",
		grass_bt != null and _color_near(grass_bt.color, grass_side, 0.02))

	# Plain — no tintindex → no tint at all.
	var plain_bt := ws.get_block_type("test_plain")
	_check("untinted block keeps a white tint",
		plain_bt != null and plain_bt.tint == Color.WHITE)

	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	AssetLibrary.ROOT = saved_root

# Phase 4: the per-semantic tint resolver walks the palette stack last-wins, exactly
# like the color resolver, and defaults to WHITE for untinted / unknown semantics.
func _test_tint_resolver() -> void:
	print("-- tint resolver (palette stack)")
	var ws := VoxelWorld.workspace
	var project := ws.get_project("My First Build")
	var bt := ws.add_block_type("__TintBlock__")
	bt.tint = Color(0.2, 0.6, 0.3)
	var pal := ws.add_palette("__tint_pal__")
	var e := PaletteEntry.new()
	e.semantic_name = "Base"
	e.block_type_name = "__TintBlock__"
	pal.entries.append(e)
	project.palette_names.append("__tint_pal__")
	VoxelWorld.open(project)
	_check("tint resolves through the palette stack",
		VoxelWorld.get_tint_for_semantic("Base") == Color(0.2, 0.6, 0.3))
	_check("untinted semantic defaults to white",
		VoxelWorld.get_tint_for_semantic("Accent") == Color.WHITE)
	_check("unknown semantic defaults to white",
		VoxelWorld.get_tint_for_semantic("__nope__") == Color.WHITE)
	project.palette_names.pop_back()
	ws.remove_palette("__tint_pal__")
	ws.remove_block_type("__TintBlock__")
	VoxelWorld.open(project)

# A solid-filled 16×16 RGBA PNG at `path` (test fixture pixels).
func _write_solid(path: String, color: Color) -> void:
	var img := Image.create_empty(16, 16, false, Image.FORMAT_RGBA8)
	img.fill(color)
	_write_png(path, img)

func _part_ids(parts: Array) -> Array:
	var out: Array = []
	for p in parts:
		out.append(p["model_id"])
	return out

func _warns_contain(imp: MCImporter, needle: String) -> bool:
	for w in imp.warnings:
		if w.find(needle) >= 0:
			return true
	return false

func _color_near(a: Color, b: Color, tol: float) -> bool:
	return absf(a.r - b.r) <= tol and absf(a.g - b.g) <= tol and absf(a.b - b.b) <= tol

# Write `text` to a user://-scratch absolute path, creating parent dirs as needed.
func _write_file(path: String, text: String) -> void:
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f != null:
		f.store_string(text)

func _write_png(path: String, image: Image) -> void:
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	image.save_png(path)

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
