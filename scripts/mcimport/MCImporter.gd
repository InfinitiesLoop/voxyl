class_name MCImporter
extends RefCounted

# THE Minecraft → voxyl translator (Phase 2). This is the one place that knows MC's
# resource layout — `assets/<namespace>/{blockstates,models,textures}` — and turns
# it into voxyl's neutral material layer (BlockModel / TextureAsset / BlockStateMap /
# BlockType). It is a *plugin on top* of the core types (architectural guardrail):
# the core stays MC-free; every MC-ism (namespaces, `minecraft:` ids, ticks, the
# 0–16 coordinate space, blockstate property strings) is converted here and never
# leaks past this module. It is a reader, never a content source (decision 4) — it
# copies from assets the user already owns and bundles nothing.
#
# Modded MC is nearly free: mods ship the identical `assets/<namespace>/...` layout
# inside their jars (unzipped). `import_all()` walks every namespace under the root;
# each imports the same way.
#
# Usage:
#   var imp := MCImporter.new(source, VoxelWorld.workspace)
#   imp.import_namespace("minecraft")      # or imp.import_all()
#   # → workspace libraries are filled in memory + pixels copied to disk;
#   # the caller persists with LibraryStore.save_all(workspace).
#
# `source` is an MCAssetSource — the assets root that directly contains the
# namespace folders, whether that's a directory on disk or inside a resource-pack
# `.zip` / mod `.jar`. For convenience (and the existing tests) a plain String path
# is accepted and wrapped in an MCDirSource. Reads go through the source; writes
# (copied pixels) go through AssetLibrary so the storage root stays the one swap
# point (decision 3).

# MC face / direction names, in BlockModel.Dir order (NORTH,EAST,SOUTH,WEST,UP,DOWN).
# Orientation.Facing shares the same ordering, so this one table serves both the
# model face directions and blockstate `facing=` values.
const _DIR6 := {
	"north": 0, "east": 1, "south": 2, "west": 3, "up": 4, "down": 5,
}

# A pillar/log's `axis=` blockstate property names a line through the block (x/y/z),
# not a single direction — either end reads identically (the bark wraps the same way
# whichever way you look at it), unlike `facing=` which picks exactly one side. Binding
# BOTH facings along that axis to the same model+rotation (see _state_to_orientation)
# lets a placement land on either and rotation cycle through the pair, instead of every
# axis variant colliding into one untagged ANY_FACING entry (which resolve() then always
# picks the FIRST of, regardless of the placed orientation — a log stuck sideways with
# 'r' doing nothing).
const _AXIS_FACINGS := {
	"x": [1, 3],   # east, west
	"y": [4, 5],   # up, down
	"z": [0, 2],   # north, south
}

var _source: MCAssetSource
var _library: BlockLibrary

# Per-run caches. Resolved model JSON is cached by ref so the shared MC templates
# (block/block, block/cube, block/cube_all, …) are parsed once even though hundreds
# of blocks inherit them. Model/texture dedup into the workspace itself.
var _resolved_cache := {}   # model ref -> { textures, elements, ao }

# Diagnostics the caller (and tests) can inspect after a run.
var imported_blocks: Array[String] = []
var warnings: Array[String] = []

func _init(source, library: BlockLibrary) -> void:
	_source = source if source is MCAssetSource else MCDirSource.new(source)
	_library = library

# ---------------------------------------------------------------------------
# Browse (Phase 5) — list what's importable without importing anything.
# ---------------------------------------------------------------------------

# Namespaces the source offers (its top-level dirs), for the import browser.
func list_namespaces() -> PackedStringArray:
	return _source.list_namespaces()

# Block ids (blockstate basenames) under a namespace — the browsable, importable
# blocks, with nothing imported yet.
func list_blocks(ns: String) -> PackedStringArray:
	var out := PackedStringArray()
	for file_name in _source.list_files("%s/blockstates" % ns):
		if file_name.ends_with(".json"):
			out.append(file_name.get_basename())
	return out

# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

# Import every namespace found directly under the assets root (the modded case).
func import_all() -> void:
	for ns in _source.list_namespaces():
		import_namespace(ns)

# Import every block whose blockstate lives under `<ns>/blockstates/`.
func import_namespace(ns: String) -> void:
	var files := _source.list_files("%s/blockstates" % ns)
	if files.is_empty():
		_warn("no blockstates for namespace: %s" % ns)
		return
	for file_name in files:
		if file_name.ends_with(".json"):
			import_block(ns, file_name.get_basename())

# Translate one block (its blockstate + every model/texture it references) into a
# BlockType in the workspace. Returns the BlockType, or null if it couldn't be read
# or used a form not handled yet. Idempotent by name. `name_override` lets a caller
# (the import service deduping across namespaces) name the BlockType something other
# than the bare block id — e.g. the qualified "ns:id" — without the importer needing
# to know about collisions; "" keeps the bare block id.
func import_block(ns: String, block_id: String, name_override := "") -> BlockType:
	var bt_name := name_override if not name_override.is_empty() else block_id
	var bs = _read_json(_blockstate_rel(ns, block_id))
	if bs == null:
		_warn("unreadable blockstate: %s:%s" % [ns, block_id])
		return null
	if bs.has("multipart"):
		return _import_multipart(ns, block_id, bt_name, bs["multipart"])
	if not bs.has("variants"):
		_warn("blockstate has no variants: %s:%s" % [ns, block_id])
		return null

	var variants := _parse_variants(bs["variants"])
	if variants.is_empty():
		_warn("no usable variants: %s:%s" % [ns, block_id])
		return null

	# Import each referenced model and build the orientation → model map.
	var state_map := BlockStateMap.new()
	for v in variants:
		if _ensure_model(v["model_ref"]) == null:
			continue
		state_map.add_variant(v["facing"], v["top"], v["model_ref"], v["x"], v["y"], v["uvlock"])
	if state_map.is_empty():
		# Every variant model was bodiless (parent builtin/entity): this is a block
		# ENTITY (chest, sign, bed…) whose shape Java draws, not the assets. Synthesize a
		# stand-in rather than drop a legitimate semantic block type — see _emit_block_entity.
		var be_ref := ""
		for v in variants:
			if not str(v["model_ref"]).is_empty():
				be_ref = v["model_ref"]
				break
		if be_ref.is_empty():
			_warn("no model referenced: %s:%s" % [ns, block_id])
			return null
		return _emit_block_entity(ns, bt_name, be_ref)

	# The resting-orientation model is what BlockType.model_id and the current 3D
	# path resolve; sample its dominant texture for the planning color (decision 1).
	return _emit_block_type(ns, bt_name, state_map.default_model_id(), state_map)

# Translate an MC `when` connection value ("side"/"up"/etc.) into voxyl's neutral
# vocabulary. Only the importer (this file) ever sees MC's own words — core files
# (BlockStateMap, VoxelWorld, View3D) only ever deal in "none"/"low"/"tall". A key
# NOT in this table passes through unchanged (see _parse_direction_value) so a
# modded block's own vocabulary still round-trips instead of being dropped, even
# though it won't match anything _cell_connections produces yet.
const _CONNECT_ALIAS := {
	"true": true, "false": false,
	"none": "none", "low": "low", "tall": "tall",
	"side": "low", "up": "tall",   # redstone wire's flat-vs-climbing states
}

# Translate an MC `multipart` blockstate (fences, panes, bars, walls, redstone-style
# wiring) into a multipart BlockStateMap. Each rule is { when?, apply }: `apply`
# names the model (+ optional x/y rotation), `when` the connection condition.
# Handles boolean direction conditions (north/east/…=true/false), multi-value
# direction vocabularies (walls' low/tall, redstone's side/up, pipe-shorthand ORs
# like "side|up"), non-direction properties flattened to a chosen default (age,
# flower_amount, slot_N_occupied — see _collect_when_defaults), and top-level `AND`
# (see _parse_and). The one remaining unhandled shape is a nested OR *inside* an AND
# that itself combines with another OR (vanilla doesn't use this); such parts are
# still skipped (warned), so the block imports with whatever parts we can render.
func _import_multipart(ns: String, block_id: String, bt_name: String, multipart) -> BlockType:
	if not (multipart is Array):
		_warn("malformed multipart: %s:%s" % [ns, block_id])
		return null
	var defaults := _collect_when_defaults(multipart)
	var state_map := BlockStateMap.new()
	for rule in multipart:
		if not (rule is Dictionary):
			continue
		var apply = rule.get("apply")
		if apply is Array:
			apply = apply[0] if not apply.is_empty() else null   # weighted → first
		if not (apply is Dictionary):
			continue
		var model_ref := _canonical(str(apply.get("model", "")))
		if _ensure_model(model_ref) == null:
			continue
		var clauses = _parse_when(rule.get("when", null), defaults)
		if clauses == null:
			_warn("multipart part skipped (unhandled 'when'): %s:%s" % [ns, block_id])
			continue
		state_map.add_part(clauses, model_ref,
			int(apply.get("x", 0)), int(apply.get("y", 0)), bool(apply.get("uvlock", false)))
	if state_map.parts.is_empty():
		_warn("multipart had no usable parts: %s:%s" % [ns, block_id])
		return null
	return _emit_block_type(ns, bt_name, state_map.default_part_model_id(), state_map)

# First pass over a block's whole `multipart` array: pick the first-seen value for
# each non-direction property (age, flower_amount, slot_N_occupied, …) so the second
# pass (_parse_clause) can flatten every rule down to that one chosen default —
# mirrors `_parse_variants`' shape=straight precedent, just at the multipart-rule
# granularity instead of the variant-state-string granularity. Pure data collection;
# never rejects anything, so it can run ahead of any actual parsing/skipping.
func _collect_when_defaults(multipart: Array) -> Dictionary:
	var defaults := {}
	for rule in multipart:
		if rule is Dictionary:
			_collect_defaults_from_when(rule.get("when", null), defaults)
	return defaults

func _collect_defaults_from_when(when, defaults: Dictionary) -> void:
	if not (when is Dictionary):
		return
	if when.has("OR"):
		for sub in when["OR"]:
			_collect_defaults_from_when(sub, defaults)
		return
	if when.has("AND"):
		for sub in when["AND"]:
			_collect_defaults_from_when(sub, defaults)
		return
	for k in when.keys():
		if _DIR6.get(str(k), -1) < 0 and not defaults.has(str(k)):
			defaults[str(k)] = str(when[k]).to_lower()

# Translate an MC `when` condition into the neutral OR-of-clauses form. Returns the
# clause Array ([] when the rule has no `when` → always applies), or null when the
# condition can't be expressed at all (caller skips the part). `defaults` is the
# non-direction property flattening table from _collect_when_defaults.
func _parse_when(when, defaults: Dictionary = {}):
	if when == null:
		return []                          # no condition → always
	if not (when is Dictionary):
		return null
	if when.has("OR"):
		var clauses: Array = []
		for sub in when["OR"]:
			var c = _parse_clause(sub, defaults)
			if c != null:                  # drop sub-clauses we can't translate
				clauses.append(c)
		if clauses.is_empty():
			return null
		return clauses
	if when.has("AND"):
		return _parse_and(when["AND"], defaults)
	var clause = _parse_clause(when, defaults)
	if clause == null:
		return null
	return [clause]

# Top-level {"AND": [...]} — vanilla combines a placement property with a content
# property (e.g. chiseled_bookshelf's facing + slot_N_occupied), occasionally with
# one member itself an `OR` (a slot-state alternative). Plain (non-OR) members merge
# into one clause (AND-of-plain-dicts is just their union, since keys never collide
# in real data); a single OR member distributes (AND distributes over OR: each OR
# branch becomes its own merged clause). Two OR members ANDed together, or a nested
# AND-of-AND, aren't a shape vanilla actually uses — declined (returns null) rather
# than guessed at.
func _parse_and(members, defaults: Dictionary):
	if not (members is Array) or members.is_empty():
		return null
	var plain: Array = []       # plain (non-OR/AND) member dicts
	var or_members: Array = []  # each OR member's own sub-clause array
	for m in members:
		if not (m is Dictionary):
			return null
		if m.has("OR"):
			or_members.append(m["OR"])
		elif m.has("AND"):
			return null
		else:
			plain.append(m)
	var base := {}
	for m in plain:
		base = _merge_dicts(base, m)
	if or_members.is_empty():
		var clause = _parse_clause(base, defaults)
		if clause == null:
			return null
		return [clause]
	if or_members.size() > 1:
		return null
	var clauses: Array = []
	for sub in or_members[0]:
		if sub is Dictionary:
			var c = _parse_clause(_merge_dicts(base, sub), defaults)
			if c != null:
				clauses.append(c)
	if clauses.is_empty():
		return null
	return clauses

func _merge_dicts(a: Dictionary, b: Dictionary) -> Dictionary:
	var out := a.duplicate()
	for k in b:
		if not out.has(k):
			out[k] = b[k]
	return out

# One MC `when` clause (a dict of property=value) → { dir:int -> required }, where
# `required` is a bool (plain true/false occupancy), a String ("none"/"low"/"tall"
# exact match), or an Array of Strings (pipe-shorthand OR) — see BlockStateMap's doc
# comment. Non-direction keys (age, flower_amount, slot_N_occupied, …) aren't real
# connections: a clause matching `defaults`' chosen value for that property just
# drops the key (it contributes no connection info); one that disagrees fails this
# clause only (the caller's OR loop drops just that sub-clause, not the whole rule).
func _parse_clause(d, defaults: Dictionary = {}):
	if not (d is Dictionary):
		return null
	var clause := {}
	for k in d.keys():
		var dir: int = _DIR6.get(str(k), -1)
		if dir >= 0:
			var value = _parse_direction_value(str(d[k]))
			if value == null:
				return null
			clause[dir] = value
		else:
			var actual := str(d[k]).to_lower()
			var default_v: String = defaults.get(str(k), actual)
			if actual != default_v:
				return null
	return clause

# One direction's raw MC value → voxyl's neutral clause requirement. Splits MC's
# pipe-shorthand ("side|up") into pieces, maps each through _CONNECT_ALIAS (an
# unrecognized piece passes through as its own lowercased String — inert until
# VoxelWorld.get_connect_height_for_semantic is taught that vocabulary, but at least
# the block still imports). One distinct mapped value → stored directly (bool or
# String); more than one → an Array (OR across states).
func _parse_direction_value(raw: String):
	var mapped: Array = []
	for piece in raw.split("|"):
		var key := piece.strip_edges().to_lower()
		if key.is_empty():
			continue
		var v = _CONNECT_ALIAS.get(key, key)
		if not mapped.has(v):
			mapped.append(v)
	if mapped.is_empty():
		return null
	if mapped.size() == 1:
		return mapped[0]
	var out: Array = []
	for v in mapped:
		out.append(("true" if v else "false") if v is bool else v)
	return out

# Create/update the BlockType for an imported block: bind its primary model, nest
# the state map, and mirror the dominant texture's average into the planning color.
# `bt_name` is the final, possibly-deduped name (bare block id or qualified "ns:id"); `ns`
# is the source namespace, kept on the BlockType even when `bt_name` doesn't carry it
# (namespace-split import names the type bare — see ImportService.name_for) so the
# provenance isn't lost.
func _emit_block_type(ns: String, bt_name: String, primary_ref: String, state_map: BlockStateMap) -> BlockType:
	var primary_model := _library.get_block_model(primary_ref)
	var bt := _library.get_block_type(bt_name)
	if bt == null:
		bt = _library.add_block_type(bt_name)
	bt.source_namespace = ns
	bt.model_id = primary_ref
	bt.state_map = state_map
	var avg = _model_average_color(primary_model)
	if avg != null:
		bt.color = avg
	_apply_tint(bt, primary_model)
	if not imported_blocks.has(bt_name):
		imported_blocks.append(bt_name)
	return bt

# ---------------------------------------------------------------------------
# Block entities (chests, signs, beds, banners, shulker boxes…)
#
# A block whose every variant model is bodiless (parent `builtin/entity`) is a block
# ENTITY: Minecraft renders its shape in Java code (a BlockEntityRenderer), so nothing
# in the assets describes the geometry and _ensure_model finds none. Dropping it would
# lose a legitimate semantic block type (principle 1) and a block the user may well want
# to place (principle 5), so we synthesize a stand-in here instead. For the few we model
# precisely (chests) a hand-authored template mirrors what the Java renderer draws;
# everything else becomes an approximate unit cube skinned with the model's own particle
# texture. Either way it stays a reader of the user's assets (decision 4) and every
# MC-ism lives here in the plugin, never in core.
# ---------------------------------------------------------------------------

# Emit a BlockType for a block entity: a precise template when we have one for the
# block's (bodiless) primary model, otherwise an approximate particle-skinned cube. Only
# a model that *resolves but carries no geometry* is a block entity (a bodiless
# builtin/entity model); a model that couldn't be read at all is genuinely broken — skip
# it as before rather than invent a cube for an asset that isn't there.
func _emit_block_entity(ns: String, bt_name: String, primary_ref: String) -> BlockType:
	if _resolve_model_json(primary_ref, 0) == null:
		_warn("all variant models failed to import: %s" % bt_name)
		return null
	var tmpl := _build_entity_template(primary_ref)
	if tmpl != null:
		_library.add_block_model(tmpl)
		return _emit_block_type(ns, bt_name, tmpl.id, null)
	return _emit_approximate_cube(ns, bt_name, primary_ref)

# Known block-entity primary model → the entity atlas its Java renderer samples. Keyed
# by canonical model ref so only the precise vanilla blocks match; a modded chest with
# its own model falls through to the approximate cube.
const _CHEST_TEMPLATES := {
	"minecraft:block/chest": "minecraft:entity/chest/normal",
	"minecraft:block/trapped_chest": "minecraft:entity/chest/trapped",
	"minecraft:block/ender_chest": "minecraft:entity/chest/ender",
}

# The single-chest entity texture is a 64×64 atlas; UVs below are in its pixels.
const _CHEST_ATLAS := 64.0

# A hand-authored BlockModel mirroring the block, or null when we have no template for
# `primary_ref` (or its atlas is missing — the caller then approximates).
func _build_entity_template(primary_ref: String) -> BlockModel:
	if _CHEST_TEMPLATES.has(primary_ref):
		return _build_chest_model(primary_ref, _CHEST_TEMPLATES[primary_ref])
	return null

# Recreate Minecraft's ModelChest as neutral geometry: a base box, a lid box, and the
# front latch, each face UV-mapped into the chest entity atlas the same way the Java
# renderer unwraps them. Resting facing is NORTH (-Z), so the latch/front sits on -Z and
# the view rotates the whole model to the placed cell's orientation (state_map stays null).
func _build_chest_model(model_id: String, atlas_ref: String) -> BlockModel:
	var asset := _ensure_texture(atlas_ref)
	if asset == null:
		return null   # atlas not in the user's assets → fall back to approximate cube
	var tex := asset.id
	var model := BlockModel.new()
	model.id = model_id
	model.textures = {tex: tex}
	# from/to in voxyl units (MC 0–16 ÷ 16); atlas offset (u,v) + box dims (dx,dy,dz) per
	# Minecraft's box unwrap. Base occupies y 0–10, lid 10–14, latch protrudes at -Z.
	model.elements = [
		# Base and lid meet exactly at y=10/16: the base's top face and the lid's bottom
		# face are perfectly coincident, and both are always fully hidden (the lid sits
		# right on the base in this resting/closed pose — nothing ever exposes that seam).
		# Emitting both anyway used to z-fight, which — combined with the atlas being
		# classified CUTOUT because *some* pixel elsewhere in it is transparent — showed
		# as a flickery hole cut into the chest's top. Neither face is ever visible, so
		# just don't emit them.
		_entity_box(Vector3(1, 0, 1) / 16.0, Vector3(15, 10, 15) / 16.0, tex, 0, 19, 14, 10, 14, [BlockModel.Dir.UP]),
		_entity_box(Vector3(1, 10, 1) / 16.0, Vector3(15, 14, 15) / 16.0, tex, 0, 0, 14, 5, 14, [BlockModel.Dir.DOWN]),
		_entity_box(Vector3(7, 7, 0) / 16.0, Vector3(9, 11, 1) / 16.0, tex, 0, 0, 2, 4, 1),
	]
	return model

# One box element with all six faces UV-mapped into the atlas via Minecraft's standard
# box unwrap (top row: top|bottom; second row: left|front|right|back — offset by depth).
# `skip` omits faces that are geometrically hidden (see _build_chest_model) so they're
# never even emitted, rather than drawn and left to z-fight against a neighboring box.
#
# The (u+dz,v) slot and the (u+dz+dx,v) slot are swapped relative to a naive world-space
# reading of Mojang's own addBox()/TexturedQuad unwrap: MC's old entity-model coordinate
# space has Y increasing DOWNWARD (opposite world space), so the slot that formula alone
# suggests is "top" is actually the model's world-DOWN face, and vice versa. Confirmed by
# comparing a real render against an actual vanilla chest: without the swap the lid's top
# showed the OTHER slot's bordered/recessed-panel texture (that's the underside of the lid,
# only meant to be seen with it open) instead of the plain plank top vanilla actually shows.
func _entity_box(from: Vector3, to: Vector3, tex: String,
		u: float, v: float, dx: float, dy: float, dz: float, skip: Array = []) -> Dictionary:
	var uv := {
		BlockModel.Dir.UP:    _atlas_uv(u + dz + dx, v, dx, dz),
		BlockModel.Dir.DOWN:  _atlas_uv(u + dz, v, dx, dz),
		BlockModel.Dir.WEST:  _atlas_uv(u, v + dz, dz, dy),
		BlockModel.Dir.NORTH: _atlas_uv(u + dz, v + dz, dx, dy),
		BlockModel.Dir.EAST:  _atlas_uv(u + dz + dx, v + dz, dz, dy),
		BlockModel.Dir.SOUTH: _atlas_uv(u + dz + dx + dz, v + dz, dx, dy),
	}
	var faces := {}
	for d in uv:
		if d in skip:
			continue
		faces[d] = BlockModel.make_face(tex, uv[d])
	return {"from": from, "to": to, "faces": faces}

# Atlas pixel rect → normalized [0,1] Rect2 (V from the texture top, matching _face_uv).
func _atlas_uv(x: float, y: float, w: float, h: float) -> Rect2:
	return Rect2(x / _CHEST_ATLAS, y / _CHEST_ATLAS, w / _CHEST_ATLAS, h / _CHEST_ATLAS)

# Approximate a block entity we have no template for as a unit cube skinned with the
# model's own particle texture (oak planks for signs, obsidian for an unknown chest, …)
# — the best neutral stand-in the assets offer. No particle → a plain colored cube so the
# block still exists in the "undecided" state (principle 5). Flagged in warnings.
func _emit_approximate_cube(ns: String, bt_name: String, primary_ref: String) -> BlockType:
	var particle := _particle_texture(primary_ref)
	var model_id := _approx_model_id(primary_ref)
	var model := _library.get_block_model(model_id)
	if model == null:
		model = BlockModel.new()
		model.id = model_id
		_library.add_block_model(model)
	var asset: TextureAsset = null
	if not particle.is_empty():
		asset = _ensure_texture(particle)
	if asset != null:
		var faces := {}
		for d in BlockModel.ALL_DIRS:
			faces[d] = BlockModel.make_face(asset.id)
		model.elements = [{"from": Vector3.ZERO, "to": Vector3.ONE, "faces": faces}]
		model.textures = {asset.id: asset.id}
	else:
		model.elements = [BlockModel.box_element(Vector3.ZERO, Vector3.ONE)]
		model.textures = {}
	_warn("approximate cube (block entity, no asset geometry): %s" % bt_name)
	return _emit_block_type(ns, bt_name, model_id, null)

# The particle texture ref declared by a (bodiless) model, canonicalized, or "". This is
# the one visual hint a builtin/entity model carries, so it seeds the approximate cube.
func _particle_texture(primary_ref: String) -> String:
	var resolved = _resolve_model_json(primary_ref, 0)
	if resolved == null:
		return ""
	var textures_map: Dictionary = resolved["textures"]
	var raw := str(textures_map.get("particle", ""))
	if raw.is_empty():
		return ""
	var ref := _resolve_texture_var(textures_map, raw, 0) if raw.begins_with("#") else raw
	return _canonical(ref) if not ref.is_empty() else ""

# A distinct model id for an approximate cube, so it never collides with the real
# `block/…` model (which stays bodiless) it stands in for.
func _approx_model_id(primary_ref: String) -> String:
	var sr := _split_ref(primary_ref)
	return "%s:approx/%s" % [sr["ns"], str(sr["path"]).get_file()]

# ---------------------------------------------------------------------------
# Blockstate variants
# ---------------------------------------------------------------------------

# Flatten a `variants` dict into a list of {facing, top, model_ref, x, y, uvlock}.
# Properties voxyl doesn't model (shape=, waterlogged=, …) are dropped — the plan's
# "flatten unmodeled properties to a sensible default". A weighted-random variant
# (an array of models) takes the first.
#
# `shape` (stairs) is special: its inner_/outer_ values are *contextual corner forms*
# that depend on neighbors — the same thing voxyl declines to model for multipart
# connections. Flattening them onto the same (facing, half) as the straight form let a
# corner model win as the block's primary, so a stair read as already-connected on two
# sides. When a block offers a `shape=straight` resting form we keep only that; blocks
# whose shape vocabulary has no straight (rails) are untouched.
func _parse_variants(variants) -> Array:
	var out: Array = []
	if not (variants is Dictionary):
		return out
	var has_straight := false
	for state_str in variants.keys():
		if _variant_shape(state_str) == "straight":
			has_straight = true
			break
	for state_str in variants.keys():
		if has_straight:
			var shape := _variant_shape(state_str)
			if shape != "" and shape != "straight":
				continue
		var val = variants[state_str]
		if val is Array:
			val = val[0] if not val.is_empty() else null
		if not (val is Dictionary):
			continue
		var so := _state_to_orientation(state_str)
		var model_ref := _canonical(str(val.get("model", "")))
		var x := int(val.get("x", 0))
		var y := int(val.get("y", 0))
		var uvlock := bool(val.get("uvlock", false))
		# Usually one facing; an axis= variant binds the same model+rotation to both
		# ends of its axis (see _AXIS_FACINGS).
		for facing in so["facings"]:
			out.append({
				"facing": facing, "top": so["top"], "model_ref": model_ref,
				"x": x, "y": y, "uvlock": uvlock,
			})
	return out

# The value of the `shape` property in an MC state string ("…,shape=inner_left" →
# "inner_left"), or "" when absent. Used to keep only a stair's resting straight form.
func _variant_shape(state_str: String) -> String:
	for prop in state_str.split(","):
		var kv := prop.split("=")
		if kv.size() == 2 and kv[0] == "shape":
			return kv[1]
	return ""

# Parse an MC state string ("facing=east,half=top") into voxyl orientation parts.
# Only facing (or axis) + the top/bottom half are meaningful to voxyl; everything else
# is ignored. "" (the state-less variant) → the ANY_FACING default. Returns `facings`
# (plural — usually one value, two for an axis= pillar) rather than a single facing.
func _state_to_orientation(state_str: String) -> Dictionary:
	var facings: Array = [BlockStateMap.ANY_FACING]
	var top := false
	if state_str != "":
		for prop in state_str.split(","):
			var kv := prop.split("=")
			if kv.size() != 2:
				continue
			match kv[0]:
				"facing":
					facings = [_DIR6.get(kv[1], BlockStateMap.ANY_FACING)]
				"half":
					top = kv[1] == "top"     # stairs/doors/trapdoors
				"type":
					top = kv[1] == "top"     # slabs (type=top/bottom/double)
				"axis":
					facings = _AXIS_FACINGS.get(kv[1], [BlockStateMap.ANY_FACING])
	return {"facings": facings, "top": top}

# ---------------------------------------------------------------------------
# Models (parent chain → neutral BlockModel)
# ---------------------------------------------------------------------------

# Ensure a BlockModel exists in the workspace for `model_ref` (importing it, with
# its full parent chain merged and textures copied, on first sight). Deduped by id —
# the same MC model file referenced by many blocks is imported once. The id is the
# qualified ref ("minecraft:block/stone"), which uniquely names the resolved
# geometry+textures, so models are shared exactly when those match (Phase 1 note).
func _ensure_model(model_ref: String) -> BlockModel:
	if model_ref.is_empty():
		return null
	var existing := _library.get_block_model(model_ref)
	if existing != null:
		return existing
	var resolved = _resolve_model_json(model_ref, 0)
	if resolved == null:
		_warn("model not found: %s" % model_ref)
		return null
	var conv := _convert_elements(resolved["elements"], resolved["textures"])
	if conv["elements"].is_empty():
		# A bodiless model (e.g. a pure parent like block/block) can't render on its
		# own; skip it rather than create an empty BlockModel.
		_warn("model has no usable geometry: %s" % model_ref)
		return null
	var model := BlockModel.new()
	model.id = model_ref
	model.elements = conv["elements"]
	model.textures = conv["textures"]
	model.ambient_occlusion = resolved["ao"]
	_library.add_block_model(model)
	return model

# A model's `textures` entry is normally a bare "ns:path" (or "#var") string, but
# newer MC versions allow an object form ({ "sprite": "ns:path", "force_translucent":
# true, … }) to attach render hints alongside the ref. voxyl has no use for those
# hints (transparency is auto-detected from the PNG's own alpha), so unwrap to the
# sprite ref and drop the rest.
func _texture_ref_str(v) -> String:
	if v is Dictionary:
		return str(v.get("sprite", ""))
	return str(v)

# Resolve a model file and its parent chain into merged { textures, elements, ao }.
# MC merge rules: textures accumulate child-wins; elements are inherited wholesale
# unless the child defines its own (then they replace). Missing parents (builtin/*,
# absent files) stop the chain gracefully. Cached by ref.
func _resolve_model_json(model_ref: String, depth: int):
	if depth > 20:
		_warn("model parent chain too deep at %s" % model_ref)
		return null
	if _resolved_cache.has(model_ref):
		return _resolved_cache[model_ref]
	var j = _read_json(_model_rel(model_ref))
	if j == null:
		return null
	var base := {"textures": {}, "elements": [], "ao": true}
	if j.has("parent"):
		var p = _resolve_model_json(_canonical(str(j["parent"])), depth + 1)
		if p != null:
			base["textures"] = (p["textures"] as Dictionary).duplicate()
			base["elements"] = p["elements"]
			base["ao"] = p["ao"]
	if j.has("textures"):
		for k in j["textures"]:
			base["textures"][k] = _texture_ref_str(j["textures"][k])
	if j.has("elements"):
		base["elements"] = j["elements"]
	if j.has("ambientocclusion"):
		base["ao"] = bool(j["ambientocclusion"])
	_resolved_cache[model_ref] = base
	return base

# Convert merged MC elements → BlockModel elements, importing each referenced
# texture. Returns { elements, textures }. `textures` maps a texture_key to a
# TextureAsset id; here the key *is* the texture id (the qualified ref), so faces
# sharing a texture share one render surface (max sharing). Faces whose texture can't
# be resolved/loaded are dropped; an element with no surviving face is dropped.
func _convert_elements(mc_elements, textures_map: Dictionary) -> Dictionary:
	var out_elements: Array = []
	var used: Dictionary = {}   # texture id -> true
	for me in mc_elements:
		var from16 = me.get("from", [0, 0, 0])
		var to16 = me.get("to", [16, 16, 16])
		var from := Vector3(from16[0], from16[1], from16[2]) / 16.0
		var to := Vector3(to16[0], to16[1], to16[2]) / 16.0
		var faces := {}
		var mc_faces = me.get("faces", {})
		for fname in mc_faces:
			var dir: int = _DIR6.get(fname, -1)
			if dir < 0:
				continue
			var mface = mc_faces[fname]
			var tex_path := _resolve_texture_var(textures_map, str(mface.get("texture", "")), 0)
			if tex_path.is_empty():
				_warn("unresolved face texture '%s' on %s face" % [str(mface.get("texture", "")), fname])
				continue
			var asset := _ensure_texture(tex_path)
			if asset == null:
				continue
			used[asset.id] = true
			faces[dir] = {
				"texture_key": asset.id,
				"uv": _face_uv(mface, dir, from16, to16),
				"cullface": _DIR6.get(str(mface.get("cullface", "")), -1),
				"rotation": int(mface.get("rotation", 0)),
				"tint_index": int(mface.get("tintindex", -1)),
			}
		if not faces.is_empty():
			var el := {"from": from, "to": to, "faces": faces}
			var rotation := _convert_rotation(me.get("rotation", null))
			if not rotation.is_empty():
				el["rotation"] = rotation
			out_elements.append(el)
	var textures := {}
	for tid in used:
		textures[tid] = tid
	return {"elements": out_elements, "textures": textures}

# Convert an MC element `rotation` ({ origin:[0–16]×3, axis:"x"|"y"|"z", angle:deg,
# rescale:bool }) into BlockMesher's neutral form (origin in 0–1, axis as a unit vector,
# angle in radians). MC only ever rotates about one cardinal axis at ±22.5/±45°. Returns
# {} when the element has no usable rotation, so axis-aligned elements stay plain.
func _convert_rotation(rot) -> Dictionary:
	if not (rot is Dictionary) or not rot.has("axis"):
		return {}
	var axis: Vector3
	match str(rot["axis"]):
		"x": axis = Vector3(1, 0, 0)
		"y": axis = Vector3(0, 1, 0)
		"z": axis = Vector3(0, 0, 1)
		_: return {}
	var o = rot.get("origin", [8, 8, 8])
	return {
		"origin": Vector3(o[0], o[1], o[2]) / 16.0,
		"axis": axis,
		"angle": deg_to_rad(float(rot.get("angle", 0))),
		"rescale": bool(rot.get("rescale", false)),
	}

# Follow a face's "#var" through the textures map to a concrete texture ref. A value
# that doesn't start with "#" is already a ref (possibly bare, qualified later).
func _resolve_texture_var(textures_map: Dictionary, value: String, depth: int) -> String:
	if depth > 20 or value.is_empty():
		return ""
	if value.begins_with("#"):
		var key := value.substr(1)
		if not textures_map.has(key):
			return ""
		return _resolve_texture_var(textures_map, str(textures_map[key]), depth + 1)
	return value

# ---------------------------------------------------------------------------
# Textures (PNG + .mcmeta → TextureAsset)
# ---------------------------------------------------------------------------

# Ensure a TextureAsset exists for a texture ref — delegated to the shared ingestion
# helper so both MC importers copy/scan/animate pixels identically.
func _ensure_texture(texture_ref: String) -> TextureAsset:
	return MCTexImport.ensure_texture(_library, _source, texture_ref, warnings)

# ---------------------------------------------------------------------------
# UVs + sampling helpers
# ---------------------------------------------------------------------------

# A face's UV rect in [0,1], V measured from the texture top (matches View3D._add_face
# and how the animation shader walks the strip). Explicit MC uv is [x1,y1,x2,y2] in
# 0–16; when omitted MC derives it from the element's footprint (exact for full faces,
# a faithful sub-rect for partial ones — e.g. a bottom slab samples the lower half).
func _face_uv(mface, dir: int, from16, to16) -> Rect2:
	if mface.has("uv"):
		# Keep MC's [x1,y1,x2,y2] direction as-is (don't sort into a normalized rect):
		# a reversed pair (e.g. a glass pane's mirrored west/east faces) is how MC
		# encodes a horizontally/vertically flipped texture, and add_face maps
		# uv.position/uv.end straight onto the two opposite geometric corners, so a
		# negative-size Rect2 here faithfully reproduces that mirroring.
		var u = mface["uv"]
		return Rect2(u[0] / 16.0, u[1] / 16.0, (u[2] - u[0]) / 16.0, (u[3] - u[1]) / 16.0)
	var x1f := float(from16[0]); var y1f := float(from16[1]); var z1f := float(from16[2])
	var x2f := float(to16[0]); var y2f := float(to16[1]); var z2f := float(to16[2])
	match dir:
		4, 5:   # UP / DOWN — spans X,Z (top-down)
			return Rect2(x1f / 16.0, z1f / 16.0, (x2f - x1f) / 16.0, (z2f - z1f) / 16.0)
		1, 3:   # EAST / WEST — spans Z, and Y from the top
			return Rect2(z1f / 16.0, (16.0 - y2f) / 16.0, (z2f - z1f) / 16.0, (y2f - y1f) / 16.0)
		_:      # NORTH / SOUTH — spans X, and Y from the top
			return Rect2(x1f / 16.0, (16.0 - y2f) / 16.0, (x2f - x1f) / 16.0, (y2f - y1f) / 16.0)

# Average color of the model's dominant texture (the one bound to the most faces),
# already sampled at texture import. null when the model carries no loadable texture.
func _model_average_color(model: BlockModel):
	if model == null or model.textures.is_empty():
		return null
	var asset := _library.get_texture_asset(_dominant_texture_key(model))
	if asset != null:
		return asset.average_color
	return null

# The texture_key bound to the most faces — the block's "main" texture, used both
# for the planning color and for deciding whether to fold a tint into it. Falls
# back to the first declared binding when the face scan is inconclusive.
func _dominant_texture_key(model: BlockModel) -> String:
	var counts := {}
	for element in model.elements:
		for dir in element["faces"]:
			var key: String = element["faces"][dir]["texture_key"]
			counts[key] = int(counts.get(key, 0)) + 1
	var best_key := ""
	var best := -1
	for key in counts:
		if counts[key] > best:
			best = counts[key]; best_key = key
	if best_key.is_empty() and not model.textures.is_empty():
		best_key = model.textures.keys()[0]
	return model.textures.get(best_key, best_key)

# ---------------------------------------------------------------------------
# Tint (Phase 4) — bake MC's biome colors into the neutral material layer.
#
# MC tints grayscale "tintindex" textures (grass, leaves, water) from per-biome
# colormaps decided in Java code, NOT in the assets — the model JSON only carries a
# `tintindex` flag per face. voxyl has no biomes, so we resolve the tint to a single
# plains/default-biome color here (the one MC-specific bit, living in the importer
# plugin) and stash it on BlockType.tint; the 3D view multiplies it into the tinted
# faces. Which faces are tinted stays neutral data (the face's tint_index, already
# converted in _convert_elements).
# ---------------------------------------------------------------------------

# MC's plains/default-biome tint colors (the swatches the colormaps yield at the
# plains climate point). Users can re-tint per block afterwards — this is just the
# import-time default the plan calls for.
const _PLAINS_GRASS := Color(0.5686, 0.7412, 0.3490)    # #91BD59
const _PLAINS_FOLIAGE := Color(0.4667, 0.6706, 0.1843)  # #77AB2F
const _WATER_TINT := Color(0.2471, 0.4627, 0.8941)      # #3F76E4

# Set BlockType.tint from the model's tinted faces (those with tint_index >= 0). No
# tinted faces → leave it WHITE (no tint). Also marks each genuinely-tinted texture's
# tint_source (only textures actually used on a tintindex face, so grass_block_side —
# pre-composited, untinted — is never mis-marked). When the planning color itself
# comes from a tinted texture, the tint is folded into BlockType.color so the
# grey-source 2D/planning views still read as green/blue.
func _apply_tint(bt: BlockType, model: BlockModel) -> void:
	if model == null:
		return
	var tinted_counts := {}   # texture_key -> count of tinted faces using it
	for element in model.elements:
		var faces: Dictionary = element["faces"]
		for dir in faces:
			var face: Dictionary = faces[dir]
			if int(face.get("tint_index", -1)) >= 0:
				var key := str(face["texture_key"])
				tinted_counts[key] = int(tinted_counts.get(key, 0)) + 1
	if tinted_counts.is_empty():
		return
	# The biome color to apply: classify the most-used tinted texture's path.
	var main_key := ""
	var best := -1
	for key in tinted_counts:
		if tinted_counts[key] > best:
			best = tinted_counts[key]; main_key = key
	bt.tint = _classify_tint(main_key)["color"]
	for key in tinted_counts:
		var asset := _library.get_texture_asset(key)
		if asset != null and asset.tint_source == TextureAsset.TintSource.NONE:
			var cls := _classify_tint(key)
			asset.tint_source = cls["source"]
			asset.fixed_tint = cls["color"]
	if tinted_counts.has(_dominant_texture_key(model)):
		bt.color = bt.color * bt.tint

# Guess a tint category (+ plains color) from a texture ref's path. MC decides this
# in Java per block, so this path heuristic is the importer's best neutral stand-in;
# the result is only a default the user can override. Unknown tintindex content
# defaults to grass green (the most common case).
func _classify_tint(texture_ref: String) -> Dictionary:
	var path := str(_split_ref(texture_ref)["path"]).to_lower()
	if path.contains("water"):
		return {"source": TextureAsset.TintSource.FIXED, "color": _WATER_TINT}
	if path.contains("leaves") or path.contains("foliage") or path.contains("vine") or path.contains("lily"):
		return {"source": TextureAsset.TintSource.FOLIAGE, "color": _PLAINS_FOLIAGE}
	return {"source": TextureAsset.TintSource.GRASS, "color": _PLAINS_GRASS}

# ---------------------------------------------------------------------------
# Ref + path helpers
# ---------------------------------------------------------------------------

# Split "ns:path" → {ns, path}; a bare ref defaults to the "minecraft" namespace
# (MC's rule, applied identically for any mod's refs). Shared with the flat importer.
func _split_ref(ref: String) -> Dictionary:
	return MCTexImport.split_ref(ref)

# Canonical "ns:path" form of a ref, so the same model/texture deduplicates to one
# library id whether a pack wrote it bare or fully qualified. A bare ref defaults to
# "minecraft" — MC's rule, applied identically to every namespace (mods qualify their
# own refs, so a bare ref genuinely means vanilla). "" stays "".
func _canonical(ref: String) -> String:
	if ref.is_empty():
		return ""
	var sr := _split_ref(ref)
	return "%s:%s" % [sr["ns"], sr["path"]]

# Paths are relative to the assets root; the source resolves them to disk / zip.
func _blockstate_rel(ns: String, block_id: String) -> String:
	return "%s/blockstates/%s.json" % [ns, block_id]

func _model_rel(model_ref: String) -> String:
	var sr := _split_ref(model_ref)
	return "%s/models/%s.json" % [sr["ns"], sr["path"]]

func _read_json(rel: String):
	var text := _source.read_text(rel)
	if text.is_empty():
		return null
	return JSON.parse_string(text)

func _warn(msg: String) -> void:
	warnings.append(msg)
