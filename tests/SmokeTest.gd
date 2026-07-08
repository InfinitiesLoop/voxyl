extends Node

var _pass := 0
var _fail := 0

func _ready() -> void:
	print("\n=== voxyl smoke test ===\n")
	VoxelWorld.reset_for_tests()   # pristine defaults, ignore any persisted library
	_test_workspace_init()
	_test_block_ops()
	_test_palette_resolution()
	_test_last_wins()
	_test_named_libraries()
	_test_orientation()
	_test_cell_orientation_tags()
	_test_hotbar()
	_test_shapes()
	_test_full_facing_classification()
	_test_models()
	_test_model_revision()
	_test_element_rotation()
	_test_reorient()
	_test_undo_redo()
	_test_selection()
	_test_asset_library()
	_test_library_serialization()
	_test_project_persistence()
	_test_project_rename_and_timestamps()
	_test_mc_import()
	_test_mc_import_block_entities()
	_test_statemap_multipart()
	_test_mc_import_multipart()
	_test_mc_import_wall_tristate()
	_test_mc_import_nondirection_flatten()
	_test_mc_import_tint()
	_test_tint_resolver()
	_test_asset_sources()
	_test_import_service()
	_test_incremental_import()
	_test_import_split_by_namespace()
	_test_flat_import()
	_test_import_service_flat()
	_test_install_locations()
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
	_check("basic library populated", VoxelWorld.workspace.get_library("basic").block_types.size() > 0)
	_check("default palette exists", VoxelWorld.workspace.get_palette("Default") != null)
	_check("default palette subscribes to basic",
		VoxelWorld.workspace.get_palette("Default").library_names == ["basic"])
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
	_check("known semantic resolves color", VoxelWorld.get_color_for_semantic("Wall") != fallback)
	_check("unknown semantic gets fallback", VoxelWorld.get_color_for_semantic("__nope__") == fallback)
	_check("block type resolved", not VoxelWorld.get_block_type_for_semantic("Wall").is_empty())
	_check("unknown block type is empty", VoxelWorld.get_block_type_for_semantic("__nope__") == "")

func _test_last_wins() -> void:
	print("-- last-wins palette layering")
	var ws := VoxelWorld.workspace
	var project := ws.get_project("My First Build")
	var lib := ws.get_or_add_library("__test_lib__")
	var diamond := lib.add_block_type("Diamond Block")
	diamond.color = Color.CYAN
	var override := ws.add_palette("__test_override__")
	override.library_names = ["__test_lib__"]
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
	ws.remove_library("__test_lib__")

# Named libraries: the 3-tier resolution (palette stack → palette's library stack,
# first-hit, basic fallback), per-library order + stable sort, multi-library precedence,
# and the undeletable + re-seeded built-in floor.
func _test_named_libraries() -> void:
	print("-- named libraries (3-tier resolution + order + builtin floor)")
	VoxelWorld.reset_for_tests()
	var ws := VoxelWorld.workspace

	# Built-in floor: basic library + Default palette exist and resist deletion.
	_check("basic library is builtin",
		ws.get_library("basic") != null and ws.get_library("basic").builtin)
	ws.remove_library("basic")
	_check("basic library can't be removed", ws.get_library("basic") != null)
	ws.remove_palette("Default")
	_check("default palette can't be removed", ws.get_palette("Default") != null)

	# Per-library order + stable sort by (order, name).
	var lib := ws.get_or_add_library("ordered")
	var b1 := lib.add_block_type("zeta")     # order 0
	var b2 := lib.add_block_type("alpha")    # order 1
	_check("next_order increments per library", b1.order == 0 and b2.order == 1)
	var sorted := lib.sorted_block_types()
	_check("sorted by (order, name) not just name",
		sorted[0].name == "zeta" and sorted[1].name == "alpha")

	# Two libraries both defining "stone" → palette library-stack precedence (first hit).
	var lib_a := ws.get_or_add_library("A")
	var lib_b := ws.get_or_add_library("B")
	lib_a.add_block_type("stone").color = Color(1, 0, 0)
	lib_b.add_block_type("stone").color = Color(0, 1, 0)
	_check("first-hit wins in library stack [A,B]",
		ws.resolve_block_type("stone", ["A", "B"]).color == Color(1, 0, 0))
	_check("reordering the stack flips the winner [B,A]",
		ws.resolve_block_type("stone", ["B", "A"]).color == Color(0, 1, 0))

	# basic is the implicit final fallback so planning blocks always resolve.
	_check("basic is the implicit fallback for a name only in basic",
		ws.resolve_block_type("base", ["A"]) == ws.basic_library().get_block_type("base"))
	_check("a name in no library resolves to null",
		ws.resolve_block_type("__nope__", ["A"]) == null)

	# End-to-end: project palette stack → palette's library subscription.
	var project := ws.get_project("My First Build")
	var pal := ws.add_palette("named")
	pal.library_names = ["A"]
	var e := PaletteEntry.new()
	e.semantic_name = "Base"
	e.block_type_name = "stone"
	pal.entries.append(e)
	project.palette_names.append("named")
	VoxelWorld.open(project)
	_check("project resolves a semantic through the palette's library subscription",
		VoxelWorld.get_color_for_semantic("Base") == Color(1, 0, 0))

	VoxelWorld.reset_for_tests()

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

	# 6-way rotation (barrels, dispensers, …): rotating around a side axis reaches
	# UP/DOWN, and rotating back around Y always lands back on a horizontal facing.
	var north := Orientation.make(Orientation.Facing.NORTH)
	_check("rotate around X: north → up",
		Orientation.facing_of(Orientation.rotate_around_axis(north, 0, 1)) == Orientation.Facing.UP)
	_check("rotate around X reversed: north → down",
		Orientation.facing_of(Orientation.rotate_around_axis(north, 0, -1)) == Orientation.Facing.DOWN)
	var up := Orientation.make(Orientation.Facing.UP)
	_check("rotate around Y from up collapses to a horizontal facing",
		Orientation.is_horizontal(Orientation.facing_of(Orientation.rotate_around_axis(up, 1, 1))))
	_check("rotate_cw matches rotate_around_axis(.., 1, ..)",
		Orientation.rotate_cw(north) == Orientation.rotate_around_axis(north, 1, 1))
	_check("dominant_axis picks the largest component",
		Orientation.dominant_axis(Vector3i(0, 5, -1)) == 1
		and Orientation.dominant_axis(Vector3i(3, 0, -1)) == 0
		and Orientation.dominant_axis(Vector3i(0, 1, 4)) == 2)

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
	_check("hotbar has 12 slots", VoxelWorld.hotbar.size() == VoxelWorld.HOTBAR_SIZE)
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
		VoxelWorld.get_shape_for_semantic("Wall") == BlockType.Shape.FULL)

# has_full_facing_for_semantic() is the gate for interactive 6-way placement/rotation
# (View3D). A block with no state_map at all — a plain FULL cube (undecided, or a
# FLAT-mode MC import that only ever gets one baked model) — has nothing to protect,
# so it's still eligible: the generic whole-mesh transform (Orientation.basis_of)
# renders any of the 6 facings just fine, even though vanilla MC never poses a plain
# cube that way (see CLAUDE.md: MC-inspired, not MC-coupled). A shaped placeholder
# (stairs/slab) stays constrained even without a state_map, because tipping the
# built-in stair/slab mesh over would fight the "half" concept those shapes exist for.
func _test_full_facing_classification() -> void:
	print("-- full-facing classification (6-way placement/rotation gate)")
	VoxelWorld.open(VoxelWorld.workspace.get_project("My First Build"))
	_check("plain FULL semantic with no state_map is full-facing (undecided/FLAT case)",
		VoxelWorld.has_full_facing_for_semantic("Wall"))
	_check("STAIRS-shaped semantic with no state_map stays horizontal+half",
		not VoxelWorld.has_full_facing_for_semantic("Stairs"))
	_check("SLAB-shaped semantic with no state_map stays horizontal+half",
		not VoxelWorld.has_full_facing_for_semantic("Slab"))
	_check("a semantic no palette maps defaults to full-facing (FULL fallback)",
		VoxelWorld.has_full_facing_for_semantic("__nothing_maps_this__"))

	# A state_map that exists but only ever bakes horizontal facings (a real imported
	# stair) must stay constrained — resolve() has no vertical entry to fall back on.
	var ws := VoxelWorld.workspace
	var lib := ws.get_or_add_library("full_facing_diag")
	var horiz_bt := lib.add_block_type("diag_stairs_like")
	horiz_bt.state_map = BlockStateMap.new()
	horiz_bt.state_map.add_variant(Orientation.Facing.NORTH, false, "some:model")
	var pal := ws.add_palette("full_facing_diag_pal")
	pal.library_names = ["full_facing_diag"]
	var e1 := PaletteEntry.new()
	e1.semantic_name = "DiagStairsLike"
	e1.block_type_name = "diag_stairs_like"
	pal.entries.append(e1)
	# A state_map that bakes a vertical facing (a real imported barrel/log) is full-facing.
	var vert_bt := lib.add_block_type("diag_barrel_like")
	vert_bt.state_map = BlockStateMap.new()
	vert_bt.state_map.add_variant(Orientation.Facing.UP, false, "some:model")
	var e2 := PaletteEntry.new()
	e2.semantic_name = "DiagBarrelLike"
	e2.block_type_name = "diag_barrel_like"
	pal.entries.append(e2)
	var project := ws.get_project("My First Build")
	project.palette_names.append("full_facing_diag_pal")
	VoxelWorld.open(project)
	_check("state_map with only horizontal facings stays constrained",
		not VoxelWorld.has_full_facing_for_semantic("DiagStairsLike"))
	_check("state_map with a vertical facing is full-facing",
		VoxelWorld.has_full_facing_for_semantic("DiagBarrelLike"))
	project.palette_names.erase("full_facing_diag_pal")

func _test_models() -> void:
	print("-- model resolution (Phase 0 material layer)")
	var ws := VoxelWorld.workspace
	VoxelWorld.open(ws.get_project("My First Build"))
	_check("built-in models registered",
		ws.get_block_model(BlockModel.BUILTIN_FULL) != null
		and ws.get_block_model(BlockModel.BUILTIN_SLAB) != null
		and ws.get_block_model(BlockModel.BUILTIN_STAIRS) != null)
	# A semantic resolves to the built-in model matching its block type's shape.
	var base_model := VoxelWorld.get_model_for_semantic("Wall")
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
		VoxelWorld.get_texture_for_semantic("Wall") == null)
	# An explicit model_id overrides the shape fallback (the additive path).
	var custom := BlockModel.new()
	custom.id = "__test_pillar__"
	custom.elements = [BlockModel.box_element(Vector3(0.25, 0, 0.25), Vector3(0.75, 1, 0.75))]
	ws.basic_library().add_block_model(custom)
	var bt := ws.basic_library().get_block_type("base")  # "Wall" maps to base, shape FULL
	bt.model_id = "__test_pillar__"
	_check("explicit model_id overrides shape fallback",
		VoxelWorld.get_model_for_semantic("Wall").id == "__test_pillar__")
	bt.model_id = ""
	ws.basic_library().remove_block_model("__test_pillar__")

# View3D's per-model-id caches (mesh, resolved textures, surface materials — see
# View3D._model_key) key off this counter instead of re-hashing elements/textures on every
# lookup: a plain int is free to read, but only useful if it actually changes whenever the
# model's rendered look would. Covers both ways that happens — a full property
# reassignment (auto-bumped by the setters in BlockModel.gd) and an in-place edit that
# doesn't reassign the property, like model.textures[key] = ... (must call bump_revision()
# itself — see HomeScreen._on_replace_texture for the one real call site that does).
func _test_model_revision() -> void:
	print("-- BlockModel revision (View3D's per-model-id caches key off this)")
	var m := BlockModel.new()
	var r0 := m.revision
	m.elements = [BlockModel.box_element(Vector3.ZERO, Vector3.ONE)]
	_check("reassigning elements bumps revision", m.revision != r0)
	var r1 := m.revision
	m.textures = {"all": "some_tex"}
	_check("reassigning textures bumps revision", m.revision != r1)
	var r2 := m.revision
	m.ambient_occlusion = false
	_check("reassigning ambient_occlusion bumps revision", m.revision != r2)
	var r3 := m.revision
	m.textures["all"] = "some_other_tex"   # in-place dict edit — no property reassignment
	_check("an in-place dict edit alone does NOT bump revision (must call bump_revision())",
		m.revision == r3)
	m.bump_revision()
	_check("bump_revision() bumps it explicitly", m.revision != r3)

func _test_element_rotation() -> void:
	print("-- element rotation (coral fans / crossed plants stand up, not flat)")
	# A horizontal plane at y=0 with a 45° rotation about Z must tilt up off the y=0
	# plane (the coral-fan bug: dropped rotation left fans lying flat).
	var flat := {
		"from": Vector3(0, 0, 0), "to": Vector3(1, 0, 1),
		"faces": {4: BlockModel.make_face("all"), 5: BlockModel.make_face("all")},
	}
	_check("axis-aligned element → identity transform",
		BlockMesher.element_xform(flat).is_equal_approx(Transform3D()))
	var rotated := flat.duplicate()
	rotated["rotation"] = {
		"origin": Vector3(0.5, 0.5, 0.5), "axis": Vector3(0, 0, 1),
		"angle": deg_to_rad(45.0), "rescale": false,
	}
	var xform := BlockMesher.element_xform(rotated)
	_check("rotated element transform is non-identity",
		not xform.is_equal_approx(Transform3D()))
	# A corner that sits at y=0 (below the block center) lifts above y=0 once tilted.
	var lifted: Vector3 = xform * Vector3(1, 0, 0.5)
	_check("a y=0 corner lifts off the floor when the element is tilted", lifted.y > 0.01)
	# The mesh actually built from the rotated model spans a real vertical extent.
	var model := BlockModel.new()
	model.id = "__rot_fan__"
	model.elements = [rotated]
	var aabb := BlockMesher.color_mesh(model).get_aabb()
	_check("tilted element has vertical thickness in the built mesh", aabb.size.y > 0.1)

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

# Undo/redo: single edits auto-wrap into one step; begin/end groups many cell changes into
# ONE logical step; no-op edits don't pollute history or clear redo; a real new edit does
# clear the redo branch; reorients are recorded. Plus the low-level pieces: the ring-buffer
# limit, the delta serialization round-trip, and history surviving a full project save/load.
func _test_undo_redo() -> void:
	print("-- undo/redo history")
	# A scratch projects dir so a debounced autosave during the test can't write into the
	# repo. Restored at the end.
	var saved_root := ProjectStore.ROOT
	ProjectStore.ROOT = "user://__voxyl_undotest__"
	_rm_rf(ProjectStore.ROOT)

	# Fresh project so history starts empty (earlier tests dirtied "My First Build").
	var project := VoxelWorld.workspace.add_project("Undo Test")
	project.palette_names.append("Default")
	VoxelWorld.open(project)
	var a := Vector3i(0, 0, 0)
	var b := Vector3i(1, 0, 0)
	var c := Vector3i(2, 0, 0)

	# A single mutation with no open step auto-wraps into its own undoable entry.
	_check("fresh project has nothing to undo", not VoxelWorld.can_undo())
	VoxelWorld.set_block(a, "Base")
	_check("placing a block enables undo", VoxelWorld.can_undo())
	_check("nothing to redo yet", not VoxelWorld.can_redo())
	VoxelWorld.undo()
	_check("undo removes the placed block", VoxelWorld.get_block(a) == "")
	_check("undo enables redo", VoxelWorld.can_redo())
	VoxelWorld.redo()
	_check("redo restores the placed block", VoxelWorld.get_block(a) == "Base")

	# begin/end brackets many cell changes into ONE history entry (a bulk step).
	VoxelWorld.begin_operation("Bulk")
	VoxelWorld.set_block(b, "Accent")
	VoxelWorld.set_block(c, "Accent")
	VoxelWorld.end_operation()
	var e := VoxelWorld.history_entries()
	_check("multi-cell step is a single entry", (e["entries"] as Array).size() == 2)
	_check("newest entry keeps its name", e["entries"][1]["name"] == "Bulk")
	_check("entry reports its change count", e["entries"][1]["change_count"] == 2)
	_check("current index points at the newest step", e["current"] == 1)
	VoxelWorld.undo()
	_check("undo reverts every cell in the step at once",
		VoxelWorld.get_block(b) == "" and VoxelWorld.get_block(c) == "")
	VoxelWorld.redo()
	_check("redo re-applies the whole step at once",
		VoxelWorld.get_block(b) == "Accent" and VoxelWorld.get_block(c) == "Accent")

	# A no-op edit (painting the block that's already there) neither adds an entry nor
	# discards a pending redo.
	VoxelWorld.undo()  # undo Bulk → redo now holds it
	_check("redo available before the no-op", VoxelWorld.can_redo())
	var depth_before := (VoxelWorld.history_entries()["entries"] as Array).size()
	VoxelWorld.set_block(a, "Base")  # a is already Base → net no change
	_check("no-op edit adds no history entry",
		(VoxelWorld.history_entries()["entries"] as Array).size() == depth_before)
	_check("no-op edit does not clear the redo stack", VoxelWorld.can_redo())
	VoxelWorld.redo()
	_check("redo still works after the no-op", VoxelWorld.get_block(b) == "Accent")

	# A real new edit clears the redo branch (you can't redo into a diverged future).
	VoxelWorld.undo()
	_check("redo available before the diverging edit", VoxelWorld.can_redo())
	VoxelWorld.set_block(Vector3i(5, 5, 5), "Trim")
	_check("a new edit clears the redo stack", not VoxelWorld.can_redo())

	# Reorientation is recorded and undoable (restores the prior facing, keeps the type).
	VoxelWorld.set_block(a, "Stairs", Orientation.make(Orientation.Facing.NORTH, false))
	VoxelWorld.reorient_block(a, Orientation.make(Orientation.Facing.EAST, true))
	_check("reorient changed the facing",
		Orientation.facing_of(project.data.get_orientation(a)) == Orientation.Facing.EAST)
	VoxelWorld.undo()
	_check("undo restores the prior orientation",
		Orientation.facing_of(project.data.get_orientation(a)) == Orientation.Facing.NORTH)
	_check("undo of a reorient keeps the block type", project.data.get_block(a) == "Stairs")

	VoxelWorld.workspace.remove_project("Undo Test")
	VoxelWorld.active_project = null

	# --- low-level: ring-buffer limit ---
	var h := EditHistory.new()
	for i in EditHistory.LIMIT + 5:
		var op := EditOperation.new("Op%d" % i)
		op.record(Vector3i(i, 0, 0), null, ["Base", 0, {}])
		h.push(op)
	_check("undo stack is capped at LIMIT", (h.entries()["entries"] as Array).size() == EditHistory.LIMIT)

	# --- low-level: delta serialization round-trip (no BlockCell resources involved) ---
	var op2 := EditOperation.new("Round Trip")
	op2.record(Vector3i(2, 3, 4), null, ["Base", 5, {}])                # a place
	op2.record(Vector3i(0, 0, 0), ["Trim", 0, {"note": "hi"}], null)    # erase a tagged cell
	var back := EditOperation.from_data(op2.to_data())
	_check("op name survives serialization", back.name == "Round Trip")
	_check("op change count survives", back.change_count() == 2)
	var i1 := back.positions.find(Vector3i(2, 3, 4))
	_check("placed change: before is empty", i1 >= 0 and back.befores[i1] == null)
	_check("placed change: after keeps type + orientation",
		i1 >= 0 and back.afters[i1][0] == "Base" and back.afters[i1][1] == 5)
	var i2 := back.positions.find(Vector3i(0, 0, 0))
	_check("erased change: before keeps tags",
		i2 >= 0 and (back.befores[i2][2] as Dictionary).get("note", "") == "hi")
	_check("erased change: after is empty", i2 >= 0 and back.afters[i2] == null)

	# --- integration: history persists with the project across a save + reload ---
	var ws := VoxelWorkspace.new()
	var proj := ws.add_project("Hist RT")
	proj.palette_names = ["Default"]
	var op3 := EditOperation.new("Place")
	op3.record(Vector3i(1, 1, 1), null, ["Base", 0, {}])
	proj.history.push(op3)
	proj.data.set_block(Vector3i(1, 1, 1), "Base")
	_check("save project with history ok", ProjectStore.save_project(proj) == OK)
	var ws2 := VoxelWorkspace.new()
	ProjectStore.load_persisted(ws2)
	var q := ws2.get_project("Hist RT")
	_check("history reloaded from disk", q != null and q.history != null and q.history.can_undo())
	_check("reloaded entry keeps its name",
		q != null and q.history.entries()["entries"][0]["name"] == "Place")
	VoxelWorld.open(q)
	VoxelWorld.undo()
	_check("undo of a reloaded step reverts the cell", VoxelWorld.get_block(Vector3i(1, 1, 1)) == "")
	VoxelWorld.active_project = null

	_rm_rf(ProjectStore.ROOT)
	ProjectStore.ROOT = saved_root

# Region selection (the Select tool): the two-click state machine (anchor → cuboid →
# clear), min/max normalization from corners given in any order, a null click clearing
# but never starting a box, and the completed box persisting as 2 coords + a flag across
# a save + reload. This is shared editor state on VoxelWorld, visualized by every view.
func _test_selection() -> void:
	print("-- region selection (Select tool)")
	var saved_root := ProjectStore.ROOT
	ProjectStore.ROOT = "user://__voxyl_seltest__"
	_rm_rf(ProjectStore.ROOT)

	var project := VoxelWorld.workspace.add_project("Sel Test")
	project.palette_names.append("Default")
	VoxelWorld.open(project)
	_check("fresh project has no selection", not VoxelWorld.has_selection)
	_check("no box when nothing is selected", VoxelWorld.selection_box().is_empty())

	# First corner → a pending anchor: shown as a single-cell box, but not yet a selection.
	VoxelWorld.select_region_click(Vector3i(2, 1, 3))
	_check("first click sets a pending anchor, not a selection", not VoxelWorld.has_selection)
	var pending := VoxelWorld.selection_box()
	_check("pending anchor shows as a single-cell box",
		pending.size() == 2 and pending[0] == Vector3i(2, 1, 3) and pending[1] == Vector3i(2, 1, 3))

	# Second corner (given out of order) → completes + normalizes to component-wise min/max.
	VoxelWorld.select_region_click(Vector3i(0, 5, 1))
	_check("second click completes the selection", VoxelWorld.has_selection)
	_check("selection min is component-wise min", VoxelWorld.selection_min == Vector3i(0, 1, 1))
	_check("selection max is component-wise max", VoxelWorld.selection_max == Vector3i(2, 5, 3))

	# Third click clears — regardless of where the crosshair is (null is fine).
	VoxelWorld.select_region_click(null)
	_check("third click clears the selection", not VoxelWorld.has_selection)
	_check("cleared selection has no box", VoxelWorld.selection_box().is_empty())

	# A null click with no anchor is a harmless no-op (can't start a box off nothing).
	VoxelWorld.select_region_click(null)
	_check("null click with no anchor stays empty", not VoxelWorld.has_selection)

	# A completed selection persists (2 coords + a flag) across a save + reload.
	VoxelWorld.select_region_click(Vector3i(1, 1, 1))
	VoxelWorld.select_region_click(Vector3i(4, 3, 2))
	VoxelWorld.save_active_project()
	var ws2 := VoxelWorkspace.new()
	ProjectStore.load_persisted(ws2)
	var q := ws2.get_project("Sel Test")
	_check("selection persists across reload",
		q != null and q.has_selection
		and q.selection_min == Vector3i(1, 1, 1) and q.selection_max == Vector3i(4, 3, 2))

	# clear_selection() resets everything on demand.
	VoxelWorld.clear_selection()
	_check("clear_selection() empties the selection", not VoxelWorld.has_selection)

	VoxelWorld.workspace.remove_project("Sel Test")
	VoxelWorld.active_project = null
	_rm_rf(ProjectStore.ROOT)
	ProjectStore.ROOT = saved_root

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

	# Author a model + texture + block type by hand (the importer-agnostic path), in a
	# named library.
	var ws := VoxelWorkspace.new()
	var lib := ws.get_or_add_library("authored")
	var model := BlockModel.new()
	model.id = "test_pillar"
	model.elements = [BlockModel.box_element(Vector3(0.25, 0, 0.25), Vector3(0.75, 1, 0.75), "all")]
	model.textures = {"all": "test_tex"}
	lib.add_block_model(model)
	var tex := TextureAsset.new()
	tex.id = "test_tex"
	tex.image_path = "authored/pixels/test_tex.png"
	tex.frame_count = 4
	tex.frame_time = 0.25
	tex.transparency = TextureAsset.Transparency.CUTOUT
	tex.average_color = Color(0.3, 0.7, 0.2)
	lib.add_texture_asset(tex)
	var bt := lib.add_block_type("Test Block")
	bt.model_id = "test_pillar"
	# A nested multipart state map — the riskiest thing for the store_var index blob to
	# serialize (a Resource inside the block type), so round-trip it explicitly.
	var sm := BlockStateMap.new()
	sm.add_part([], "post")
	sm.add_part([{0: true}], "side", 0, 0)
	bt.state_map = sm

	_check("save_library succeeds", LibraryStore.save_library(lib) == OK)

	# Load into a fresh workspace and confirm every field survived the trip.
	var ws2 := VoxelWorkspace.new()
	LibraryStore.load_persisted(ws2)
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
	_check("block type multipart state_map survives the index round-trip",
		bt2 != null and bt2.state_map != null and bt2.state_map.is_multipart()
		and bt2.state_map.default_part_model_id() == "post")

	# delete_library removes the on-disk folder so a deleted library stays gone across a
	# reload (the "ghost library that won't delete" bug: a memory-only remove left the
	# folder, and load_persisted re-found it on the next launch).
	_check("authored folder exists before delete",
		DirAccess.dir_exists_absolute(AssetLibrary.path_for("authored")))
	_check("delete_library succeeds", LibraryStore.delete_library("authored") == OK)
	_check("authored folder is gone after delete",
		not DirAccess.dir_exists_absolute(AssetLibrary.path_for("authored")))
	# The fast delete stages the folder under .trash (an instant rename) rather than unlinking
	# it inline — but .trash must never surface as a library.
	_check("deleted library is staged under .trash",
		DirAccess.dir_exists_absolute(AssetLibrary.path_for(LibraryStore.TRASH_DIR)))
	_check(".trash is not listed as a library",
		not LibraryStore.list_libraries().has(LibraryStore.TRASH_DIR))
	var ws3 := VoxelWorkspace.new()
	LibraryStore.load_persisted(ws3)
	_check("deleted library does not resurrect on reload", ws3.get_library("authored") == null)
	# purge_worker (the off-thread body of purge_trash) does the real unlink of staged folders.
	LibraryStore._purge_worker(AssetLibrary.path_for(LibraryStore.TRASH_DIR))
	var trash_dir := DirAccess.open(AssetLibrary.path_for(LibraryStore.TRASH_DIR))
	_check("purge_trash unlinks the staged folder",
		trash_dir != null and trash_dir.get_directories().is_empty())
	_check("delete_library refuses to remove the basic floor",
		LibraryStore.delete_library(VoxelWorkspace.BASIC_LIBRARY) != OK)
	_check("delete_library on a missing folder is OK", LibraryStore.delete_library("never_existed") == OK)

	_rm_rf(AssetLibrary.ROOT)
	AssetLibrary.ROOT = saved_root

# Projects persist to disk: voxel data (positions/semantics/orientation/tags), the
# palette stack, the saved view layout, and the hotbar — all surviving a save + a
# reload into a fresh workspace. This is the whole point of ProjectStore.
func _test_project_persistence() -> void:
	print("-- project persistence round-trip")
	var saved_root := ProjectStore.ROOT
	ProjectStore.ROOT = "user://__voxyl_projtest__"
	_rm_rf(ProjectStore.ROOT)

	var ws := VoxelWorkspace.new()
	var p := ws.add_project("Round Trip")
	p.palette_names = ["Default", "Extra"]
	p.data.set_block(Vector3i(1, 2, 3), "Base", 5)
	p.data.set_block(Vector3i(-4, 0, 7), "Accent")            # negative coords are valid
	p.data.set_block(Vector3i(0, 0, 0), "Trim", 0, {"note": "hi"})  # a tagged cell
	p.hotbar = ["Base", "", "Accent"]
	p.active_slot = 2
	p.layout = {"tree": {"type": "pane", "current": 0, "focused": true,
		"views": [{"kind": "3d", "yaw": 12.5}]}}
	_check("save project ok", ProjectStore.save_project(p) == OK)

	# Reload into a pristine workspace (proves nothing rides in memory).
	var ws2 := VoxelWorkspace.new()
	ProjectStore.load_persisted(ws2)
	var q := ws2.get_project("Round Trip")
	_check("project reloaded from disk", q != null)
	if q != null:
		var expected_stack: Array[String] = ["Default", "Extra"]
		_check("palette stack round-trips", q.palette_names == expected_stack)
		_check("cell count round-trips", q.data.cells.size() == 3)
		_check("cell semantic round-trips", q.data.get_block(Vector3i(1, 2, 3)) == "Base")
		_check("cell orientation round-trips", q.data.get_orientation(Vector3i(1, 2, 3)) == 5)
		_check("negative-coord cell round-trips", q.data.get_block(Vector3i(-4, 0, 7)) == "Accent")
		var tagged := q.data.get_cell(Vector3i(0, 0, 0))
		_check("cell tags round-trip", tagged != null and tagged.tags.get("note", "") == "hi")
		_check("hotbar round-trips",
			q.hotbar.size() == 3 and q.hotbar[0] == "Base" and q.hotbar[2] == "Accent")
		_check("active slot round-trips", q.active_slot == 2)
		_check("layout round-trips",
			((q.layout.get("tree", {}) as Dictionary).get("type", "")) == "pane")

	_check("has_saved_projects sees the file", ProjectStore.has_saved_projects())
	_check("delete removes the file", ProjectStore.delete_project("Round Trip") == OK)
	_check("no saved projects after delete", not ProjectStore.has_saved_projects())

	_rm_rf(ProjectStore.ROOT)
	ProjectStore.ROOT = saved_root

# save_project stamps modified_at; rename_project moves the .tres on disk, guards
# collisions, and its thumbnail sidecar follows the rename. Backs the home-screen
# details/rename/last-edited-sort feature.
func _test_project_rename_and_timestamps() -> void:
	print("-- project rename + timestamps")
	var saved_root := ProjectStore.ROOT
	ProjectStore.ROOT = "user://__voxyl_renametest__"
	_rm_rf(ProjectStore.ROOT)

	var ws := VoxelWorkspace.new()
	var p := ws.add_project("Alpha")
	_check("add_project stamps created_at", p.created_at > 0)
	p.modified_at = 0
	_check("save project ok", ProjectStore.save_project(p) == OK)
	_check("save_project stamps modified_at", p.modified_at > 0)

	# A stand-in thumbnail so we can prove the sidecar follows a rename.
	var img := Image.create(4, 4, false, Image.FORMAT_RGB8)
	img.fill(Color.RED)
	_check("save_thumbnail ok", ProjectStore.save_thumbnail("Alpha", img) == OK)
	_check("thumbnail exists", ProjectStore.has_thumbnail("Alpha"))

	# Collision guard: renaming onto an existing name fails and changes nothing.
	ws.add_project("Beta")
	_check("rename onto existing name refused",
		not ProjectStore.rename_project(ws, "Alpha", "Beta"))
	_check("refused rename kept old name", ws.get_project("Alpha") != null)

	_check("rename ok", ProjectStore.rename_project(ws, "Alpha", "Gamma"))
	_check("workspace sees new name", ws.get_project("Gamma") != null)
	_check("old name gone from workspace", ws.get_project("Alpha") == null)

	var ws2 := VoxelWorkspace.new()
	ProjectStore.load_persisted(ws2)
	_check("renamed project loads from disk", ws2.get_project("Gamma") != null)
	_check("old .tres removed", ws2.get_project("Alpha") == null)
	_check("thumbnail followed the rename", ProjectStore.has_thumbnail("Gamma"))
	_check("old thumbnail gone", not ProjectStore.has_thumbnail("Alpha"))

	_check("delete drops the thumbnail too",
		ProjectStore.delete_project("Gamma") == OK and not ProjectStore.has_thumbnail("Gamma"))

	_rm_rf(ProjectStore.ROOT)
	ProjectStore.ROOT = saved_root

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
	# A flat plane (faces up/down at y=0) carrying an MC element `rotation` — the coral-fan
	# shape: dropping the rotation left it lying flat instead of standing up.
	_write_file(assets + "/testmod/models/block/test_fan.json", """
{ "parent": "minecraft:block/cube_all", "textures": {"all":"testmod:block/test_tex"},
  "elements": [ { "from": [0,0,0], "to": [16,0,16],
	"rotation": {"origin":[8,8,8],"axis":"z","angle":45,"rescale":true},
	"faces": { "up": {"texture":"#all"}, "down": {"texture":"#all"} } } ] }
""")
	_write_file(assets + "/testmod/blockstates/test_fan.json",
		"""{ "variants": { "": { "model": "testmod:block/test_fan" } } }""")
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
	# A pillar (log-style) `axis=` blockstate — mirrors vanilla oak_log.json. Each axis is
	# a LINE through the block, so both its ends must resolve identically (regression test
	# for the bug where axis= wasn't parsed at all and every variant collapsed into one
	# untagged ANY_FACING entry — a log stuck on one fixed rotation no matter its placement).
	_write_file(assets + "/testmod/blockstates/test_log.json", """
{ "variants": {
	"axis=y": { "model": "testmod:block/test_block" },
	"axis=z": { "model": "testmod:block/test_block", "x": 90 },
	"axis=x": { "model": "testmod:block/test_block", "x": 90, "y": 90 } } }
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
	var lib := ws.get_or_add_library("mc")
	var imp := MCImporter.new(assets, lib)
	imp.import_namespace("testmod")

	_check("all six blocks imported",
		imp.imported_blocks.size() == 6 and imp.imported_blocks.has("test_block")
		and imp.imported_blocks.has("test_stairs") and imp.imported_blocks.has("test_fan")
		and imp.imported_blocks.has("test_log"))

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
		lib.texture_assets.size() == 2)
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

	# Element rotation: converted to BlockMesher's neutral form (origin 0–1, unit axis,
	# radians) and actually tilts the flat fan plane off the floor.
	var fan := ws.get_block_model("testmod:block/test_fan")
	var fan_rot = fan.elements[0].get("rotation", null) if fan != null else null
	_check("element rotation preserved on import",
		fan_rot != null and (fan_rot["origin"] as Vector3).is_equal_approx(Vector3(0.5, 0.5, 0.5))
		and (fan_rot["axis"] as Vector3).is_equal_approx(Vector3(0, 0, 1))
		and is_equal_approx(fan_rot["angle"], deg_to_rad(45.0)) and fan_rot["rescale"])
	_check("imported fan stands up (mesh has vertical extent)",
		fan != null and BlockMesher.color_mesh(fan).get_aabb().size.y > 0.1)

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
	_check("stairs (horizontal-only facing) aren't classified as 6-way",
		not stairs.state_map.has_vertical_facing())

	# axis= (pillar/log) variants: both ends of an axis must resolve to the SAME
	# model+rotation, and different axes must resolve to DIFFERENT rotations — otherwise
	# every axis collapses into one fixed orientation regardless of placement/rotation.
	var log_bt := ws.get_block_type("test_log")
	_check("axis variants captured in a state_map",
		log_bt != null and log_bt.state_map != null and not log_bt.state_map.is_empty())
	var up := log_bt.state_map.resolve(Orientation.make(Orientation.Facing.UP, false))
	var down := log_bt.state_map.resolve(Orientation.make(Orientation.Facing.DOWN, false))
	var e2 := log_bt.state_map.resolve(Orientation.make(Orientation.Facing.EAST, false))
	var w2 := log_bt.state_map.resolve(Orientation.make(Orientation.Facing.WEST, false))
	var n2 := log_bt.state_map.resolve(Orientation.make(Orientation.Facing.NORTH, false))
	var s2 := log_bt.state_map.resolve(Orientation.make(Orientation.Facing.SOUTH, false))
	_check("axis=y (up/down) is the unrotated variant",
		int(up.get("x_rot", -1)) == 0 and int(up.get("y_rot", -1)) == 0)
	_check("both ends of the y axis (up/down) resolve the same",
		up.get("x_rot") == down.get("x_rot") and up.get("y_rot") == down.get("y_rot"))
	_check("both ends of the x axis (east/west) resolve the same",
		e2.get("x_rot") == w2.get("x_rot") and e2.get("y_rot") == w2.get("y_rot"))
	_check("both ends of the z axis (north/south) resolve the same",
		n2.get("x_rot") == s2.get("x_rot") and n2.get("y_rot") == s2.get("y_rot"))
	_check("the x and z axes resolve to genuinely different rotations",
		int(e2.get("y_rot", -1)) != int(n2.get("y_rot", -1))
		or int(e2.get("x_rot", -1)) != int(n2.get("x_rot", -1)))
	_check("the x and y axes resolve to genuinely different rotations",
		e2.get("x_rot") != up.get("x_rot") or e2.get("y_rot") != up.get("y_rot"))
	_check("a log's axis facings (including up/down) classify it as 6-way",
		log_bt.state_map.has_vertical_facing())

	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	AssetLibrary.ROOT = saved_root

# Block entities (chests, signs, …) reference bodiless `builtin/entity` models — Java
# draws their shape, so the assets carry no geometry. Rather than drop them, the importer
# synthesizes a stand-in: a hand-authored chest template for the vanilla chests, and an
# approximate particle-skinned cube for everything else (a plain cube when even a particle
# texture is missing). Nothing MC-specific leaks past the importer.
func _test_mc_import_block_entities() -> void:
	print("-- mc importer block entities (chest template + approximate cube)")
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_beimport__"
	var src := "user://__voxyl_besrc__"
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	var assets := src + "/assets"

	# A vanilla-shaped chest: blockstate → a bodiless builtin/entity model, geometry
	# supplied only by the Java renderer + the 64×64 entity atlas.
	_write_file(assets + "/minecraft/blockstates/chest.json",
		'{ "variants": { "": { "model": "minecraft:block/chest" } } }')
	_write_file(assets + "/minecraft/models/block/chest.json",
		'{ "parent": "builtin/entity", "textures": { "particle": "minecraft:block/oak_planks" } }')
	var atlas_color := Color(0.55, 0.4, 0.2)
	var atlas := Image.create_empty(64, 64, false, Image.FORMAT_RGBA8)
	atlas.fill(atlas_color)
	_write_png(assets + "/minecraft/textures/entity/chest/normal.png", atlas)
	_write_solid(assets + "/minecraft/textures/block/oak_planks.png", Color(0.6, 0.45, 0.25))

	# A block entity we have NO template for, but whose model declares a particle texture.
	_write_file(assets + "/testmod/blockstates/test_sign.json",
		'{ "variants": { "": { "model": "testmod:block/test_sign" } } }')
	_write_file(assets + "/testmod/models/block/test_sign.json",
		'{ "parent": "builtin/entity", "textures": { "particle": "testmod:block/oak" } }')
	var sign_color := Color(0.7, 0.3, 0.2)
	_write_solid(assets + "/testmod/textures/block/oak.png", sign_color)

	# A bodiless block with no particle at all → a plain colored cube (undecided state).
	_write_file(assets + "/testmod/blockstates/test_void.json",
		'{ "variants": { "": { "model": "testmod:block/test_void" } } }')
	_write_file(assets + "/testmod/models/block/test_void.json",
		'{ "parent": "builtin/entity" }')

	var ws := VoxelWorkspace.new()
	var lib := ws.get_or_add_library("be")
	var imp := MCImporter.new(assets, lib)

	# --- Chest template: precise geometry mirroring ModelChest ---
	var chest_bt := imp.import_block("minecraft", "chest")
	var chest_m := ws.get_block_model("minecraft:block/chest")
	_check("chest imported (not dropped) with its template model",
		chest_bt != null and chest_bt.model_id == "minecraft:block/chest" and chest_m != null)
	_check("chest template has base + lid + latch boxes",
		chest_m != null and chest_m.elements.size() == 3)
	_check("chest faces bind the entity atlas texture",
		chest_m != null and chest_m.has_textures()
		and chest_m.textures.has("minecraft:entity/chest/normal"))
	var atlas_asset := ws.get_texture_asset("minecraft:entity/chest/normal")
	_check("chest entity atlas copied into the library + loadable",
		atlas_asset != null and AssetLibrary.load_image(atlas_asset.image_path) != null)
	# Base box (element 0) NORTH face unwraps to atlas px (14,33)..(28,43) of 64.
	var base_north: Rect2 = chest_m.elements[0]["faces"][BlockModel.Dir.NORTH]["uv"]
	_check("chest base front face UV-mapped into the atlas",
		base_north.is_equal_approx(Rect2(14.0 / 64.0, 33.0 / 64.0, 14.0 / 64.0, 10.0 / 64.0)))
	# The lid's UP face (element 1) is the chest's visible top. MC's entity-model space has
	# Y increasing DOWNWARD (opposite world space), so naively reading Mojang's own
	# addBox()/TexturedQuad unwrap formula assigns the WRONG atlas cell to world-up — the
	# lid's hidden underside (a bordered/recessed-panel design meant to be seen only with
	# the lid open) instead of the plain plank top vanilla actually shows. Regression test
	# for that swap: atlas px (28,0)..(42,14), not (14,0)..(28,14).
	var lid_up: Rect2 = chest_m.elements[1]["faces"][BlockModel.Dir.UP]["uv"]
	_check("chest lid's visible top samples the plank cell, not the lid-underside cell",
		lid_up.is_equal_approx(Rect2(28.0 / 64.0, 0.0 / 64.0, 14.0 / 64.0, 14.0 / 64.0)))
	_check("chest state_map stays null (view rotates the single model by facing)",
		chest_bt != null and chest_bt.state_map == null)
	# The base's top (element 0) and the lid's bottom (element 1) sit at the exact same
	# y=10/16 plane — always hidden, one behind the other. Emitting both used to z-fight,
	# which (combined with any transparent pixel elsewhere in the shared atlas making it
	# CUTOUT) showed as a hole cut into the chest's top. Neither should be emitted at all.
	_check("chest base's hidden top face is omitted",
		chest_m != null and not (chest_m.elements[0]["faces"] as Dictionary).has(BlockModel.Dir.UP))
	_check("chest lid's hidden bottom face is omitted",
		chest_m != null and not (chest_m.elements[1]["faces"] as Dictionary).has(BlockModel.Dir.DOWN))

	# --- Approximate cube: no template, but a particle texture to skin it ---
	var sign_bt := imp.import_block("testmod", "test_sign")
	var sign_m := ws.get_block_model("testmod:approx/test_sign")
	_check("untemplated block entity becomes an approximate cube",
		sign_bt != null and sign_bt.model_id == "testmod:approx/test_sign" and sign_m != null)
	_check("approximate cube is a full unit cube",
		sign_m != null and sign_m.elements.size() == 1
		and sign_m.elements[0]["from"] == Vector3.ZERO and sign_m.elements[0]["to"] == Vector3.ONE)
	_check("approximate cube skinned with the particle texture",
		sign_m != null and sign_m.has_textures() and sign_m.textures.has("testmod:block/oak"))
	_check("approximate cube planning color from the particle texture",
		sign_bt != null and _color_near(sign_bt.color, sign_color, 0.02))
	_check("approximate cube flagged in warnings", _warns_contain(imp, "approximate cube"))

	# --- No particle → plain colored cube, still a first-class (undecided) block ---
	var void_bt := imp.import_block("testmod", "test_void")
	var void_m := ws.get_block_model("testmod:approx/test_void")
	_check("particle-less block entity still emits a block type",
		void_bt != null and void_bt.model_id == "testmod:approx/test_void")
	_check("particle-less approximate cube carries no texture (color path)",
		void_m != null and not void_m.has_textures())

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
# neutral multipart map — boolean direction conditions become connection clauses; a
# genuinely unsupported shape (an AND combining two ORs — not a shape vanilla
# actually uses) is skipped, not fatal.
func _test_mc_import_multipart() -> void:
	print("-- mc importer multipart (fences/panes/bars)")
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_mpimport__"
	var src := "user://__voxyl_mpsrc__"
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	var assets := src + "/assets"

	# A fence: a post (always) + a side arm per connected horizontal neighbor, the
	# same model rotated by y. One stray part ANDs two ORs together — not a shape
	# vanilla actually uses, and still declined by design — to prove a genuinely
	# unsupported shape is skipped rather than aborting the import.
	_write_file(assets + "/testmod/blockstates/test_fence.json", """
{ "multipart": [
	{ "apply": { "model": "testmod:block/fence_post" } },
	{ "when": { "north": "true" }, "apply": { "model": "testmod:block/fence_side" } },
	{ "when": { "east":  "true" }, "apply": { "model": "testmod:block/fence_side", "y": 90 } },
	{ "when": { "south": "true" }, "apply": { "model": "testmod:block/fence_side", "y": 180 } },
	{ "when": { "west":  "true" }, "apply": { "model": "testmod:block/fence_side", "y": 270 } },
	{ "when": { "AND": [ { "OR": [ {"north":"true"}, {"east":"true"} ] },
	                     { "OR": [ {"south":"true"}, {"west":"true"} ] } ] },
	  "apply": { "model": "testmod:block/fence_side" } } ] }
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
	var lib := ws.get_or_add_library("mp")
	var imp := MCImporter.new(assets, lib)
	imp.import_block("testmod", "test_fence")

	var bt := ws.get_block_type("test_fence")
	_check("fence imported with a multipart state_map",
		bt != null and bt.state_map != null and bt.state_map.is_multipart())
	_check("fence model_id points at the always-on post",
		bt != null and bt.model_id == "testmod:block/fence_post")
	_check("post + 4 boolean sides translated; AND-of-two-ORs part skipped",
		bt != null and bt.state_map.parts.size() == 5)
	_check("the unsupported 'when' part was warned + skipped",
		_warns_contain(imp, "unhandled 'when'"))
	_check("post + side models imported",
		ws.get_block_model("testmod:block/fence_post") != null
		and ws.get_block_model("testmod:block/fence_side") != null)
	_check("shared texture imported once", lib.texture_assets.size() == 1)
	# Connection resolution end-to-end: isolated → post; east neighbor → +y=90 side.
	var sm := bt.state_map
	_check("isolated fence resolves to the post only", sm.resolve_parts({}).size() == 1)
	var east_parts := sm.resolve_parts({1: true})   # EAST connected (dir 1)
	_check("east connection adds the y=90 side",
		east_parts.size() == 2 and int(east_parts[1].get("y_rot", -1)) == 90)

	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	AssetLibrary.ROOT = saved_root

# Multipart tri-state connections (walls) + pipe-shorthand OR (redstone-style wiring):
# the importer now translates non-boolean direction values ("low"/"tall") and
# pipe-separated alternatives ("side|up", aliased to low/tall) instead of dropping
# them, and BlockStateMap.resolve_parts matches the resulting String/Array clauses
# against the neutral "none"/"low"/"tall" connection states View3D derives from
# neighbor geometry at render time.
func _test_mc_import_wall_tristate() -> void:
	print("-- mc importer tri-state + pipe-OR connections (walls/redstone-style)")
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_walllib__"
	var src := "user://__voxyl_wallsrc__"
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	var assets := src + "/assets"

	# A wall-like connector: always-on post, a "low" side and a "tall" side on north
	# (the actual wall vocabulary), plus an east side that fires on either of two
	# states via pipe-shorthand (redstone wire's "side|up" shape, generalized).
	_write_file(assets + "/testmod/blockstates/test_wall.json", """
{ "multipart": [
	{ "apply": { "model": "testmod:block/wall_post" } },
	{ "when": { "north": "low" },    "apply": { "model": "testmod:block/wall_low" } },
	{ "when": { "north": "tall" },   "apply": { "model": "testmod:block/wall_tall" } },
	{ "when": { "east": "side|up" }, "apply": { "model": "testmod:block/wall_pipe", "y": 90 } } ] }
""")
	for m in ["wall_post", "wall_low", "wall_tall", "wall_pipe"]:
		_write_file(assets + "/testmod/models/block/%s.json" % m, """
{ "textures": {"all":"testmod:block/wall_tex"}, "elements": [ { "from": [0,0,0], "to": [16,16,16], "faces": {
	"down": {"texture":"#all"}, "up": {"texture":"#all"},
	"north": {"texture":"#all"}, "south": {"texture":"#all"},
	"west": {"texture":"#all"}, "east": {"texture":"#all"} } } ] }
""")
	_write_solid(assets + "/testmod/textures/block/wall_tex.png", Color(0.5, 0.5, 0.5))

	var ws := VoxelWorkspace.new()
	var lib := ws.get_or_add_library("wall")
	var imp := MCImporter.new(assets, lib)
	imp.import_block("testmod", "test_wall")

	var bt := ws.get_block_type("test_wall")
	_check("wall imported with all 4 parts (post + low + tall + pipe)",
		bt != null and bt.state_map.parts.size() == 4)
	_check("no 'when' warnings — every shape here is now handled",
		not _warns_contain(imp, "unhandled 'when'"))

	# Raw parsed clause shapes: "low"/"tall" store as an exact String; the pipe value
	# stores as an Array covering both aliased states.
	var low_when := {}; var tall_when := {}; var pipe_when := {}
	for p in bt.state_map.parts:
		match str(p.get("model_id", "")):
			"testmod:block/wall_low": low_when = p["when"][0]
			"testmod:block/wall_tall": tall_when = p["when"][0]
			"testmod:block/wall_pipe": pipe_when = p["when"][0]
	_check("north-low clause stores the exact 'low' string", low_when.get(0) == "low")
	_check("north-tall clause stores the exact 'tall' string", tall_when.get(0) == "tall")
	_check("east pipe-OR clause aliases side/up into an array covering low+tall",
		(pipe_when.get(1) as Array) != null
		and (pipe_when[1] as Array).has("low") and (pipe_when[1] as Array).has("tall"))

	# Render-time matching: resolve_parts against the neutral tri-state connections.
	var sm := bt.state_map
	_check("a 'low' north neighbor selects the low side, not the tall one",
		_part_ids(sm.resolve_parts({0: "low"})) == ["testmod:block/wall_post", "testmod:block/wall_low"])
	_check("a 'tall' north neighbor selects the tall side, not the low one",
		_part_ids(sm.resolve_parts({0: "tall"})) == ["testmod:block/wall_post", "testmod:block/wall_tall"])
	_check("no north neighbor selects neither side",
		_part_ids(sm.resolve_parts({0: "none"})) == ["testmod:block/wall_post"])
	_check("the east pipe-OR matches a 'low' neighbor",
		_part_ids(sm.resolve_parts({1: "low"})).has("testmod:block/wall_pipe"))
	_check("the east pipe-OR matches a 'tall' neighbor",
		_part_ids(sm.resolve_parts({1: "tall"})).has("testmod:block/wall_pipe"))
	_check("the east pipe-OR does not match no neighbor",
		not _part_ids(sm.resolve_parts({1: "none"})).has("testmod:block/wall_pipe"))

	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	AssetLibrary.ROOT = saved_root

# Non-direction property flattening (age/flower_amount/slot_N_occupied-style state
# voxyl has no data for) + top-level AND: the importer picks the first-seen value per
# non-direction property as the chosen default (mirroring _parse_variants'
# shape=straight precedent) and drops only the rules that disagree with it, whether
# they're bare clauses or ANDed with a real direction condition.
func _test_mc_import_nondirection_flatten() -> void:
	print("-- mc importer non-direction property flattening + top-level AND")
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_flattenlib__"
	var src := "user://__voxyl_flattensrc__"
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	var assets := src + "/assets"

	# "age" first appears as "0" (in the AND rule below) — that becomes the chosen
	# default. The age=1 AND rule and the bare age=5 rule disagree with it and are
	# dropped; the age=0 AND rule and the bare age=0 rule survive.
	_write_file(assets + "/testmod/blockstates/test_flatten.json", """
{ "multipart": [
	{ "apply": { "model": "testmod:block/base_post" } },
	{ "when": { "AND": [ {"north":"true"}, {"age":"0"} ] }, "apply": { "model": "testmod:block/age0_side" } },
	{ "when": { "AND": [ {"north":"true"}, {"age":"1"} ] }, "apply": { "model": "testmod:block/age1_side" } },
	{ "when": { "age": "0" }, "apply": { "model": "testmod:block/age0_bare" } },
	{ "when": { "age": "5" }, "apply": { "model": "testmod:block/age5_bare" } } ] }
""")
	for m in ["base_post", "age0_side", "age1_side", "age0_bare", "age5_bare"]:
		_write_file(assets + "/testmod/models/block/%s.json" % m, """
{ "textures": {"all":"testmod:block/flatten_tex"}, "elements": [ { "from": [0,0,0], "to": [16,16,16], "faces": {
	"down": {"texture":"#all"}, "up": {"texture":"#all"},
	"north": {"texture":"#all"}, "south": {"texture":"#all"},
	"west": {"texture":"#all"}, "east": {"texture":"#all"} } } ] }
""")
	_write_solid(assets + "/testmod/textures/block/flatten_tex.png", Color(0.4, 0.4, 0.4))

	var ws := VoxelWorkspace.new()
	var lib := ws.get_or_add_library("flatten")
	var imp := MCImporter.new(assets, lib)
	imp.import_block("testmod", "test_flatten")

	var bt := ws.get_block_type("test_flatten")
	_check("only the default-matching rules survive (age1/age5 dropped)",
		bt != null and _part_ids(bt.state_map.parts) == [
			"testmod:block/base_post", "testmod:block/age0_side", "testmod:block/age0_bare"])
	_check("the disagreeing rules were warned + skipped",
		_warns_contain(imp, "unhandled 'when'"))

	var sm := bt.state_map
	_check("the AND-merged part still requires its real (north) connection",
		_part_ids(sm.resolve_parts({0: "tall"})).has("testmod:block/age0_side")
		and not _part_ids(sm.resolve_parts({0: "none"})).has("testmod:block/age0_side"))
	_check("the bare flattened-default part is unconditional",
		_part_ids(sm.resolve_parts({})).has("testmod:block/age0_bare"))

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
	var lib := ws.get_or_add_library("tint")
	var imp := MCImporter.new(assets, lib)
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
	var lib := ws.get_or_add_library("__tint_lib__")
	var bt := lib.add_block_type("__TintBlock__")
	bt.tint = Color(0.2, 0.6, 0.3)
	var pal := ws.add_palette("__tint_pal__")
	pal.library_names = ["__tint_lib__"]
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
	ws.remove_library("__tint_lib__")
	VoxelWorld.open(project)

# Phase 5: the asset-source abstraction. A directory tree and a .zip carrying the
# *same* synthetic assets must answer list/has/read identically, so MCImporter reads
# a resource pack the same way it reads an unzipped folder.
func _test_asset_sources() -> void:
	print("-- mc asset sources (dir + zip parity)")
	var base := "user://__voxyl_src__"
	_rm_rf(base)
	var assets := base + "/assets"
	var bs := '{"variants":{"":{"model":"minecraft:block/stone"}}}'
	var model := '{"textures":{"all":"minecraft:block/stone"},"elements":[{"from":[0,0,0],"to":[16,16,16],"faces":{"up":{"texture":"#all"}}}]}'
	_write_file(assets + "/minecraft/blockstates/stone.json", bs)
	_write_file(assets + "/minecraft/models/block/stone.json", model)
	_write_solid(assets + "/minecraft/textures/block/stone.png", Color(0.5, 0.5, 0.5))

	# Pack the identical tree under assets/ into a .zip (a resource pack layout).
	var zip := base + "/pack.zip"
	var packer := ZIPPacker.new()
	packer.open(zip)
	_zip_add(packer, "assets/minecraft/blockstates/stone.json", bs.to_utf8_buffer())
	_zip_add(packer, "assets/minecraft/models/block/stone.json", model.to_utf8_buffer())
	_zip_add(packer, "assets/minecraft/textures/block/stone.png",
		FileAccess.get_file_as_bytes(assets + "/minecraft/textures/block/stone.png"))
	packer.close()

	var dsrc := MCDirSource.new(assets)
	var zsrc := MCZipSource.new(zip)
	for pair in [["dir", dsrc], ["zip", zsrc]]:
		var tag: String = pair[0]
		var src: MCAssetSource = pair[1]
		_check("%s lists the namespace" % tag, src.list_namespaces().has("minecraft"))
		_check("%s lists blockstate files" % tag,
			src.list_files("minecraft/blockstates").has("stone.json"))
		_check("%s has_file sees a nested model" % tag,
			src.has_file("minecraft/models/block/stone.json"))
		_check("%s reads json text" % tag,
			src.read_text("minecraft/blockstates/stone.json").contains("variants"))
		_check("%s reads a png into an Image" % tag,
			src.read_image("minecraft/textures/block/stone.png") != null)
		_check("%s reports a missing file as empty/null" % tag,
			not src.has_file("minecraft/nope.json")
			and src.read_text("minecraft/nope.json") == ""
			and src.read_image("minecraft/nope.png") == null)

	# The importer reads a zip source end-to-end, exactly like a directory.
	var ws := VoxelWorkspace.new()
	MCImporter.new(zsrc, ws.get_or_add_library("zip")).import_namespace("minecraft")
	_check("importer translates a block straight out of a zip",
		ws.get_block_type("stone") != null
		and ws.get_block_model("minecraft:block/stone") != null)

	zsrc.close()
	_rm_rf(base)

# Phase 5: the import service — detect sources from a chosen path, browse the blocks
# they offer, import a selected subset, dedup/namespace colliding ids, and persist
# the library. No UI involved (the panel is a thin shell over this).
func _test_import_service() -> void:
	print("-- import service (browse + import + dedup + persist)")
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_impsvc_lib__"
	var src_root := "user://__voxyl_impsvc_src__"
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src_root)
	var assets := src_root + "/assets"

	# Two namespaces; "widget" exists in both (a cross-namespace collision), "stone"
	# only in minecraft. Each block is a self-contained full cube + one texture.
	for ref in [["minecraft", "stone"], ["minecraft", "widget"], ["othermod", "widget"]]:
		var ns: String = ref[0]
		var id: String = ref[1]
		_write_file("%s/%s/blockstates/%s.json" % [assets, ns, id],
			'{"variants":{"":{"model":"%s:block/%s"}}}' % [ns, id])
		_write_file("%s/%s/models/block/%s.json" % [assets, ns, id],
			'{"textures":{"all":"%s:block/%s"},"elements":[{"from":[0,0,0],"to":[16,16,16],"faces":{"up":{"texture":"#all"}}}]}' % [ns, id])
		_write_solid("%s/%s/textures/block/%s.png" % [assets, ns, id], Color(0.5, 0.4, 0.3))

	# detect_sources on a pack root (a folder with an assets/ child) → one dir source.
	var sources := ImportService.detect_sources(src_root)
	_check("detect finds one source for a pack root", sources.size() == 1)

	var ws := VoxelWorkspace.new()
	var target := ws.get_or_add_library("vanilla")
	# A shipped-style default that a vanilla import should overwrite in place.
	var placeholder := target.add_block_type("stone")
	placeholder.color = Color(0.99, 0.0, 0.99)   # sentinel: gets replaced by the import
	var svc := ImportService.new(sources, target)
	var avail := svc.available_blocks()
	_check("browse lists every block across namespaces", avail.size() == 3)
	_check("browse refs are namespaced and sorted",
		avail[0]["ref"] == "minecraft:stone" and avail[2]["ref"] == "othermod:widget")

	var n := svc.import_selected(avail)
	_check("all selected blocks import", n == 3)
	# The imported-block-types accessor (drives the import UI's preview pre-bake) reports
	# exactly the fresh block types, deduped.
	var fresh := svc.imported_block_types()
	_check("imported_block_types reports the fresh blocks",
		fresh.size() == 3 and fresh.has(ws.get_block_type("stone"))
		and fresh.has(ws.get_block_type("othermod:widget")))
	# minecraft == default namespace → vanilla blocks get clean, un-prefixed names.
	_check("vanilla blocks keep clean un-prefixed names",
		ws.get_block_type("stone") != null and ws.get_block_type("widget") != null)
	_check("modded blocks keep their namespace prefix",
		ws.get_block_type("othermod:widget") != null)
	_check("no minecraft-prefixed names are stored",
		ws.get_block_type("minecraft:stone") == null and ws.get_block_type("minecraft:widget") == null)
	# Overwrite: the import filled the existing "stone" in place (same instance), not a
	# duplicate — the sentinel color is gone and it now carries a model.
	_check("importing a vanilla block overwrites the like-named default in place",
		ws.get_block_type("stone") == placeholder
		and not placeholder.model_id.is_empty()
		and placeholder.color != Color(0.99, 0.0, 0.99))
	var stone_count := 0
	for bt in target.block_types:
		if bt.name == "stone":
			stone_count += 1
	_check("overwrite did not duplicate the block type", stone_count == 1)

	# Persisted to disk: a fresh workspace loads what was imported.
	var ws2 := VoxelWorkspace.new()
	LibraryStore.load_persisted(ws2)
	_check("imported library persisted via LibraryStore",
		ws2.get_block_type("stone") != null and ws2.get_block_type("othermod:widget") != null)

	svc.close()
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src_root)
	AssetLibrary.ROOT = saved_root

# The incremental import API the progress UI drives: begin_import → import_step per
# block → end_import. Each step reports success, counts accrue, and the result + the
# persisted library match a one-shot import.
func _test_incremental_import() -> void:
	print("-- incremental import (progress-driven)")
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_incr_lib__"
	var src_root := "user://__voxyl_incr_src__"
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src_root)
	var assets := src_root + "/assets"
	for id in ["alpha", "beta"]:
		_write_file("%s/minecraft/blockstates/%s.json" % [assets, id],
			'{"variants":{"":{"model":"minecraft:block/%s"}}}' % id)
		_write_file("%s/minecraft/models/block/%s.json" % [assets, id],
			'{"textures":{"all":"minecraft:block/%s"},"elements":[{"from":[0,0,0],"to":[16,16,16],"faces":{"up":{"texture":"#all"}}}]}' % id)
		_write_solid("%s/minecraft/textures/block/%s.png" % [assets, id], Color(0.3, 0.5, 0.7))

	var ws := VoxelWorkspace.new()
	var svc := ImportService.new(ImportService.detect_sources(src_root), ws.get_or_add_library("incr"))
	var avail := svc.available_blocks()

	var total := svc.begin_import(avail)
	_check("begin_import reports the total to step through", total == 2)
	var stepped_ok := 0
	for i in total:
		if svc.import_step(i):
			stepped_ok += 1
	_check("each step imports its block", stepped_ok == 2 and svc.imported_count == 2)
	# Nothing is written to disk until end_import.
	var mid := VoxelWorkspace.new()
	LibraryStore.load_persisted(mid)
	_check("library not persisted until end_import", mid.get_block_type("alpha") == null)
	svc.end_import()
	var after := VoxelWorkspace.new()
	LibraryStore.load_persisted(after)
	_check("end_import persists the imported blocks",
		after.get_block_type("alpha") != null and after.get_block_type("beta") != null)

	svc.close()
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src_root)
	AssetLibrary.ROOT = saved_root

# Namespace-split import: set_namespace_split routes each block to a per-namespace
# library (resolved by a caller-supplied callback, exactly as ImportPanel does), names
# the block types bare (the library scopes them), appends to a pre-existing matching
# library instead of clobbering it, and persists every touched library — while the
# scratch browse library that backed available_blocks() receives nothing.
func _test_import_split_by_namespace() -> void:
	print("-- import: split into a library per namespace")
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_split_lib__"
	var src_root := "user://__voxyl_split_src__"
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src_root)
	var assets := src_root + "/assets"
	for ref in [["minecraft", "stone"], ["othermod", "widget"], ["othermod", "gadget"]]:
		var ns: String = ref[0]
		var id: String = ref[1]
		_write_file("%s/%s/blockstates/%s.json" % [assets, ns, id],
			'{"variants":{"":{"model":"%s:block/%s"}}}' % [ns, id])
		_write_file("%s/%s/models/block/%s.json" % [assets, ns, id],
			'{"textures":{"all":"%s:block/%s"},"elements":[{"from":[0,0,0],"to":[16,16,16],"faces":{"up":{"texture":"#all"}}}]}' % [ns, id])
		_write_solid("%s/%s/textures/block/%s.png" % [assets, ns, id], Color(0.5, 0.4, 0.3))

	var ws := VoxelWorkspace.new()
	# A pre-existing per-namespace library the import must ADD to, not replace.
	var existing := ws.get_or_add_library("gtnh.othermod")
	existing.add_block_type("preexisting")

	# available_blocks() browses through this scratch library; splitting routes imports
	# elsewhere, so it must stay empty.
	var svc := ImportService.new(ImportService.detect_sources(src_root), ws.get_or_add_library("scratch"))
	# Resolver mirrors ImportPanel._split_library_for: "<prefix>.<ns>" (prefix "gtnh").
	svc.set_namespace_split(func(ns: String) -> BlockLibrary:
		return ws.get_or_add_library("gtnh.%s" % ns))
	var n := svc.import_selected(svc.available_blocks())
	_check("split import imports every block", n == 3)

	var mc_lib := ws.get_library("gtnh.minecraft")
	var om_lib := ws.get_library("gtnh.othermod")
	_check("minecraft block routed to gtnh.minecraft under a bare name",
		mc_lib != null and mc_lib.get_block_type("stone") != null)
	_check("modded blocks routed to gtnh.othermod under bare names",
		om_lib != null and om_lib.get_block_type("widget") != null and om_lib.get_block_type("gadget") != null)
	_check("splitting stores no qualified 'ns:id' names",
		mc_lib.get_block_type("minecraft:stone") == null and om_lib.get_block_type("othermod:widget") == null)
	_check("import appends to the existing library, keeping prior blocks",
		om_lib == existing and om_lib.get_block_type("preexisting") != null)
	_check("the scratch browse library received no imports",
		ws.get_library("scratch").block_types.is_empty())

	# Each touched library persisted (once, at end_import) — a fresh workspace reloads them.
	var ws2 := VoxelWorkspace.new()
	LibraryStore.load_persisted(ws2)
	_check("split libraries persisted per namespace",
		ws2.get_library("gtnh.minecraft") != null
		and ws2.get_library("gtnh.minecraft").get_block_type("stone") != null
		and ws2.get_library("gtnh.othermod").get_block_type("widget") != null)

	svc.close()
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src_root)
	AssetLibrary.ROOT = saved_root

# Pre-1.8 import: a 1.7.10-style tree has NO blockstates/models, only loose
# textures under textures/blocks/. MCFlatImporter groups them by base name (across
# underscore / dot / camelCase / glued separators), strips state suffixes, and
# synthesizes a unit-cube BlockModel per block — multi-face when corroborated,
# uniform otherwise. The 1.8+ importer finds nothing in the same tree.
func _test_flat_import() -> void:
	print("-- flat importer (pre-1.8 textures-only)")
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_flatlib__"
	var src := "user://__voxyl_flatsrc__"
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	var assets := src + "/assets"
	var blocks := assets + "/testmod/textures/blocks"

	var c_stone := Color(0.5, 0.5, 0.5)
	var c_top := Color(0.8, 0.2, 0.2);  var c_side := Color(0.2, 0.8, 0.2)
	var c_front := Color(0.2, 0.2, 0.8); var c_front_on := Color(0.9, 0.9, 0.1)
	_write_solid(blocks + "/stone.png", c_stone)
	# Underscore-separated multi-face + an on/off state pair on the front.
	_write_solid(blocks + "/furnace_top.png", c_top)
	_write_solid(blocks + "/furnace_side.png", c_side)
	_write_solid(blocks + "/furnace_front_off.png", c_front)
	_write_solid(blocks + "/furnace_front_on.png", c_front_on)
	# Dot-separated (Railcraft style) and camelCase (EnderIO style) and glued.
	_write_solid(blocks + "/signal.lamp.top.png", c_top)
	_write_solid(blocks + "/signal.lamp.bottom.png", c_side)
	_write_solid(blocks + "/solarPanelSide.png", c_side)
	_write_solid(blocks + "/solarPanelTop.png", c_top)
	_write_solid(blocks + "/arcaneside.png", c_side)
	_write_solid(blocks + "/arcanetop.png", c_top)
	# A lone face texture with no siblings → stays standalone, not a fake block.
	_write_solid(blocks + "/treetop.png", Color(0.3, 0.5, 0.2))
	# Textures sorted into a subfolder (the Ztones pattern): must be found recursively,
	# each carrying its subpath so it imports as its own cube.
	_write_solid(blocks + "/agon/0.png", Color(0.4, 0.3, 0.6))
	_write_solid(blocks + "/agon/1.png", Color(0.5, 0.3, 0.6))
	# An animated texture (2-frame vertical strip + .mcmeta), as in 1.7.10.
	var anim := Image.create_empty(16, 32, false, Image.FORMAT_RGBA8)
	anim.fill(Color(0.7, 0.3, 0.1))
	_write_png(blocks + "/magma.png", anim)
	_write_file(blocks + "/magma.png.mcmeta", '{"animation":{"frametime":2}}')

	var ws := VoxelWorkspace.new()
	var lib := ws.get_or_add_library("flat")
	var imp := MCFlatImporter.new(assets, lib)

	# Browse: 9 blocks — the four faced groups collapse to one each; stone, magma,
	# treetop stand alone; the two nested agon variants each stand alone. (14 PNGs → 9.)
	var listed := imp.list_blocks("testmod")
	_check("flat browse groups faces into blocks",
		listed.size() == 9
		and Array(listed).has("furnace") and Array(listed).has("signal_lamp")
		and Array(listed).has("solar_panel") and Array(listed).has("arcane")
		and Array(listed).has("stone") and Array(listed).has("treetop"))
	_check("lone suffix texture stays standalone (no fake 'tree' block)",
		Array(listed).has("treetop") and not Array(listed).has("tree"))
	_check("subfolder textures found recursively (Ztones-style sets)",
		Array(listed).has("agon/0") and Array(listed).has("agon/1"))
	# A nested block imports end-to-end: its texture ref keeps the subpath.
	var agon_bt := imp.import_block("testmod", "agon/0")
	_check("nested block imports as its own cube with the right texture",
		agon_bt != null and ws.get_block_model("testmod:flat/agon/0") != null
		and ws.get_texture_asset("testmod:blocks/agon/0") != null)

	# Uniform block: a single texture on all six faces.
	var stone_bt := imp.import_block("testmod", "stone")
	var stone_m := ws.get_block_model("testmod:flat/stone")
	_check("uniform block → full cube, one texture on every face",
		stone_bt != null and stone_m != null and stone_m.textures.size() == 1
		and stone_m.elements[0]["faces"][BlockModel.Dir.UP]["texture_key"] == "testmod:blocks/stone"
		and stone_m.elements[0]["faces"][BlockModel.Dir.NORTH]["texture_key"] == "testmod:blocks/stone")
	_check("uniform planning color is the texture average",
		stone_bt != null and _color_near(stone_bt.color, c_stone, 0.02))

	# Multi-face block: top/side/front mapped; front uses the resting (off) state;
	# the unspecified bottom falls back to side.
	imp.import_block("testmod", "furnace")
	var fm := ws.get_block_model("testmod:flat/furnace")
	var ff: Dictionary = fm.elements[0]["faces"]
	_check("multi-face: top maps to the _top texture",
		ff[BlockModel.Dir.UP]["texture_key"] == "testmod:blocks/furnace_top")
	_check("multi-face: front maps to NORTH, resting (off) state chosen",
		ff[BlockModel.Dir.NORTH]["texture_key"] == "testmod:blocks/furnace_front_off")
	_check("multi-face: a side fills the other horizontals",
		ff[BlockModel.Dir.EAST]["texture_key"] == "testmod:blocks/furnace_side"
		and ff[BlockModel.Dir.WEST]["texture_key"] == "testmod:blocks/furnace_side")
	_check("multi-face: unspecified bottom falls back (to side here)",
		ff[BlockModel.Dir.DOWN]["texture_key"] == "testmod:blocks/furnace_side")
	_check("multi-face block binds its three distinct textures", fm.textures.size() == 3)

	# Separator coverage: dot + camelCase resolve the same way as underscore.
	imp.import_block("testmod", "signal_lamp")
	imp.import_block("testmod", "solar_panel")
	var sl: Dictionary = ws.get_block_model("testmod:flat/signal_lamp").elements[0]["faces"]
	var sp: Dictionary = ws.get_block_model("testmod:flat/solar_panel").elements[0]["faces"]
	_check("dot-separated faces resolve (signal.lamp.top → UP)",
		sl[BlockModel.Dir.UP]["texture_key"] == "testmod:blocks/signal.lamp.top"
		and sl[BlockModel.Dir.DOWN]["texture_key"] == "testmod:blocks/signal.lamp.bottom")
	_check("camelCase faces resolve (solarPanelTop → UP, Side → horizontals)",
		sp[BlockModel.Dir.UP]["texture_key"] == "testmod:blocks/solarPanelTop"
		and sp[BlockModel.Dir.NORTH]["texture_key"] == "testmod:blocks/solarPanelSide")

	# Animation survives the flat path (shared ingestion with the JSON importer).
	imp.import_block("testmod", "magma")
	var mt := ws.get_texture_asset("testmod:blocks/magma")
	_check("flat animated texture keeps its frames",
		mt != null and mt.frame_count == 2 and is_equal_approx(mt.frame_time, 0.1))

	# The 1.8+ importer finds nothing in a pre-1.8 tree (no blockstates).
	var ws2 := VoxelWorkspace.new()
	var jimp := MCImporter.new(assets, ws2.get_or_add_library("json"))
	jimp.import_namespace("testmod")
	_check("the 1.8+ importer imports nothing from a pre-1.8 tree",
		jimp.imported_blocks.is_empty() and _warns_contain(jimp, "no blockstates"))

	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	AssetLibrary.ROOT = saved_root

# Pre-1.8 import through the service: FLAT mode browses + imports the synthesized
# blocks and persists them, exactly like the JSON path but via MCFlatImporter.
func _test_import_service_flat() -> void:
	print("-- import service (pre-1.8 FLAT mode)")
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_flatsvc_lib__"
	var src_root := "user://__voxyl_flatsvc_src__"
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src_root)
	var blocks := src_root + "/assets/testmod/textures/blocks"
	_write_solid(blocks + "/cobble.png", Color(0.4, 0.4, 0.4))
	_write_solid(blocks + "/machine_top.png", Color(0.7, 0.7, 0.2))
	_write_solid(blocks + "/machine_side.png", Color(0.2, 0.7, 0.7))

	var sources := ImportService.detect_sources(src_root)
	var ws := VoxelWorkspace.new()
	var svc := ImportService.new(sources, ws.get_or_add_library("flatsvc"), ImportService.Mode.FLAT)
	var avail := svc.available_blocks()
	_check("FLAT browse synthesizes blocks (cobble + grouped machine)",
		avail.size() == 2)
	var n := svc.import_selected(avail)
	# testmod is not the minecraft namespace, so names keep the prefix.
	_check("FLAT import creates the namespaced block types",
		n == 2 and ws.get_block_type("testmod:cobble") != null
		and ws.get_block_type("testmod:machine") != null)
	_check("FLAT import builds a cube model with textures",
		ws.get_block_model("testmod:flat/machine") != null
		and ws.get_block_model("testmod:flat/machine").has_textures())

	var ws2 := VoxelWorkspace.new()
	LibraryStore.load_persisted(ws2)
	_check("FLAT-imported library persisted to disk",
		ws2.get_block_type("testmod:machine") != null and ws2.get_block_type("testmod:cobble") != null)

	svc.close()
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src_root)
	AssetLibrary.ROOT = saved_root

# The import UI's "common locations" helper: well-formed, platform-appropriate
# entries covering the three launchers. Existence is machine-dependent so it's not
# asserted; structure + which launchers are offered is.
func _test_install_locations() -> void:
	print("-- install location hints (import UX)")
	var entries := MCInstallLocations.candidates()
	_check("candidates are offered for this platform", entries.size() >= 3)
	var all_well_formed := true
	var labels := ""
	for e in entries:
		labels += " " + str(e["label"])
		if str(e["label"]).is_empty() or str(e["path"]).is_empty():
			all_well_formed = false
		if not (e["picker"] == "file" or e["picker"] == "dir"):
			all_well_formed = false
		if not (e["exists"] is bool):
			all_well_formed = false
	_check("every entry has a label, path, file/dir picker, and exists flag", all_well_formed)
	_check("vanilla, CurseForge and Prism are all covered",
		labels.contains("Vanilla") and labels.contains("CurseForge") and labels.contains("Prism"))
	_check("a version-jar entry is a file pick (vanilla blocks live in a .jar)",
		entries.any(func(e): return e["picker"] == "file" and str(e["label"]).contains("version jar")))
	_check("an instance entry is a folder pick (mods live in a folder)",
		entries.any(func(e): return e["picker"] == "dir" and str(e["label"]).contains("instance")))

# Add one file to an open ZIPPacker (test fixture archives).
func _zip_add(packer: ZIPPacker, path: String, bytes: PackedByteArray) -> void:
	packer.start_file(path)
	packer.write_file(bytes)
	packer.close_file()

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
