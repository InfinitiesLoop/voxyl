class_name PaneGeometry
extends RefCounted

# The multipart geometry every connecting "pane" block needs: a thin center post plus
# four side arms/caps that extend to meet an occupied neighbor, or cap off flush when
# isolated. This is Minecraft's own pane shape (post/side/side_alt/noside/noside_alt),
# textured with a "glass"-role side texture + a "glass_pane_top"-role edge texture.
# Vanilla panes get this for free through MCImporter's real blockstate/model JSON; this
# is the same shape synthesized by hand for a source with no blockstate JSON to import
# it from at all (Chisel, 1.7.10 — see GTNHExtension's chisel section), so a heal with
# only two flat textures can still produce real pane geometry instead of a full cube.
#
# Box coordinates and UV rects (voxyl's 0..1 cell space) are lifted verbatim from a real
# imported vanilla pane (minecraft:block/glass_pane_{post,side,side_alt,noside,
# noside_alt}) so a healed pane connects and caps exactly like the vanilla one does.

const MIN := 0.4375   # 7/16 — inner edge of the post/arm band
const MAX := 0.5625   # 9/16 — outer edge of the post/arm band
const W := 0.125      # 2/16 — the band's width (MAX - MIN)

# The five models one pane needs, id-prefixed with `base_id` ("<ns>:heal/<name>").
# `side_tex` is the texture id for the pane's flat visible faces (MC's "glass" role);
# `edge_tex` is the texture id for its thin top/bottom/end-cap rim (MC's
# "glass_pane_top" role) — pass the same id for both if the source has only one texture.
static func build_models(base_id: String, side_tex: String, edge_tex: String) -> Dictionary:
	var post := BlockModel.new()
	post.id = base_id + "/post"
	post.elements = [{
		"from": Vector3(MIN, 0, MIN), "to": Vector3(MAX, 1, MAX),
		"faces": {
			BlockModel.Dir.UP: _face(edge_tex, Rect2(MIN, MIN, W, W)),
			BlockModel.Dir.DOWN: _face(edge_tex, Rect2(MIN, MIN, W, W)),
		},
	}]
	post.textures = {edge_tex: edge_tex}

	# The north-pointing arm; rotated y=90/180/270 for east/south/west (see
	# build_state_map) — BlockMesher.rotation_basis's convention (verified against
	# fences/stairs) turns a north-pointing part east at y=90 and on from there.
	var side := BlockModel.new()
	side.id = base_id + "/side"
	side.elements = [{
		"from": Vector3(MIN, 0, 0), "to": Vector3(MAX, 1, MIN),
		"faces": {
			BlockModel.Dir.NORTH: _face(edge_tex, Rect2(MIN, 0, W, 1), BlockModel.Dir.NORTH),
			BlockModel.Dir.EAST: _face(side_tex, Rect2(MAX, 0, MIN, 1)),
			BlockModel.Dir.WEST: _face(side_tex, Rect2(1, 0, -MIN, 1)),
			BlockModel.Dir.UP: _face(edge_tex, Rect2(MIN, 0, W, MIN)),
			BlockModel.Dir.DOWN: _face(edge_tex, Rect2(MIN, 0, W, MIN)),
		},
	}]
	side.textures = {side_tex: side_tex, edge_tex: edge_tex}

	# The south-pointing arm — a mirror of `side`, not just `side` rotated 180: MC keeps
	# these as two separate models so the "glass" texture reads right-way-round on both
	# opposite arms instead of mirrored (see the EAST/WEST uv direction below).
	var side_alt := BlockModel.new()
	side_alt.id = base_id + "/side_alt"
	side_alt.elements = [{
		"from": Vector3(MIN, 0, MAX), "to": Vector3(MAX, 1, 1),
		"faces": {
			BlockModel.Dir.EAST: _face(side_tex, Rect2(0, 0, MIN, 1)),
			BlockModel.Dir.SOUTH: _face(edge_tex, Rect2(MIN, 0, W, 1), BlockModel.Dir.SOUTH),
			BlockModel.Dir.WEST: _face(side_tex, Rect2(MIN, 0, -MIN, 1)),
			BlockModel.Dir.UP: _face(edge_tex, Rect2(MIN, 0, W, MIN)),
			BlockModel.Dir.DOWN: _face(edge_tex, Rect2(MIN, 0, W, MIN)),
		},
	}]
	side_alt.textures = {side_tex: side_tex, edge_tex: edge_tex}

	# The north-facing end cap, shown instead of an arm when there's no neighbor to
	# reach for. noside_alt (below) is the same tiny box with its cap on the EAST face
	# instead — together, rotated per direction, they cap all four sides (see
	# build_state_map). Textured with `side_tex`, not `edge_tex`: MC caps a disconnected
	# side with the plain glass look, the rim texture is only for the post/arm tops.
	var noside := BlockModel.new()
	noside.id = base_id + "/noside"
	noside.elements = [{
		"from": Vector3(MIN, 0, MIN), "to": Vector3(MAX, 1, MAX),
		"faces": {BlockModel.Dir.NORTH: _face(side_tex, Rect2(MAX, 0, -W, 1))},
	}]
	noside.textures = {side_tex: side_tex}

	var noside_alt := BlockModel.new()
	noside_alt.id = base_id + "/noside_alt"
	noside_alt.elements = [{
		"from": Vector3(MIN, 0, MIN), "to": Vector3(MAX, 1, MAX),
		"faces": {BlockModel.Dir.EAST: _face(side_tex, Rect2(MIN, 0, W, 1))},
	}]
	noside_alt.textures = {side_tex: side_tex}

	return {"post": post, "side": side, "side_alt": side_alt, "noside": noside, "noside_alt": noside_alt}

static func _face(texture_key: String, uv: Rect2, cullface := -1) -> Dictionary:
	var f := BlockModel.make_face(texture_key, uv)
	f["cullface"] = cullface
	return f

# The multipart wiring shared by every pane, real or synthesized: post always shown;
# a side arm per connected direction; a noside cap per disconnected one. Identical in
# shape to what MCImporter parses out of a real pane blockstate (verified against
# minecraft:block/glass_pane's own imported state_map) — see BlockStateMap's class doc
# for the connection-condition vocabulary `add_part` takes.
static func build_state_map(models: Dictionary) -> BlockStateMap:
	var sm := BlockStateMap.new()
	sm.add_part([], models["post"].id)
	sm.add_part([{BlockModel.Dir.NORTH: true}], models["side"].id, 0, 0)
	sm.add_part([{BlockModel.Dir.EAST: true}], models["side"].id, 0, 90)
	sm.add_part([{BlockModel.Dir.SOUTH: true}], models["side_alt"].id, 0, 0)
	sm.add_part([{BlockModel.Dir.WEST: true}], models["side_alt"].id, 0, 90)
	sm.add_part([{BlockModel.Dir.NORTH: false}], models["noside"].id, 0, 0)
	sm.add_part([{BlockModel.Dir.EAST: false}], models["noside_alt"].id, 0, 0)
	sm.add_part([{BlockModel.Dir.SOUTH: false}], models["noside_alt"].id, 0, 90)
	sm.add_part([{BlockModel.Dir.WEST: false}], models["noside"].id, 0, 270)
	return sm
