class_name McpArgs
extends RefCounted

# Shared argument parsing for agent tools: positions, regions, orientations, part specs,
# symmetry / repeat, and the one commit path every edit tool uses. The shapes are described
# once in McpConventions and referenced from tool descriptions.
#
# Parsers return the parsed value, or an McpRegistry.fail(...) Dictionary — callers check
# with McpRegistry.is_error().

const UNDO_PREFIX := "Claude: "
const MAX_REJECTED_LISTED := 40

static func vec3i(v: Variant) -> Variant:
	if v is Array and (v as Array).size() >= 3:
		return Vector3i(int(v[0]), int(v[1]), int(v[2]))
	if v is Dictionary and v.has("x") and v.has("y") and v.has("z"):
		return Vector3i(int(v["x"]), int(v["y"]), int(v["z"]))
	return null

static func vec3i_or_fail(v: Variant, what: String) -> Variant:
	var p: Variant = vec3i(v)
	if p == null:
		return McpRegistry.fail("bad_argument", "%s must be [x, y, z]" % what)
	return p

# The open project, checked against the optional `project` guard argument.
static func project(args: Dictionary) -> Variant:
	var p := VoxelWorld.active_project
	if p == null:
		return McpRegistry.fail("no_project", "no project is open; use project_open (or project_create) first")
	var want := str(args.get("project", ""))
	if not want.is_empty() and want != p.name:
		return McpRegistry.fail("project_changed",
			"the open project is '%s', not '%s' (the user may have switched); re-check with status" % [p.name, want])
	return p

# A Region (see McpConventions): { min, max } | { selection: true } | { semantic } |
# { all: true }, with optional pad. Returns { min: Vector3i, max: Vector3i } or a failure.
static func region(spec: Variant, default_all := false) -> Variant:
	var data := VoxelWorld.active_project.data if VoxelWorld.active_project else null
	if spec == null:
		if not default_all:
			return McpRegistry.fail("bad_argument", "region is required")
		spec = {"all": true}
	if not (spec is Dictionary):
		return McpRegistry.fail("bad_argument", "region must be an object, e.g. {min:[x,y,z], max:[x,y,z]} or {all:true}")
	var mn: Vector3i
	var mx: Vector3i
	if spec.has("min") or spec.has("max"):
		var a: Variant = vec3i(spec.get("min"))
		var b: Variant = vec3i(spec.get("max", spec.get("min")))
		if a == null or b == null:
			return McpRegistry.fail("bad_argument", "region min/max must be [x, y, z]")
		mn = Vector3i(mini(a.x, b.x), mini(a.y, b.y), mini(a.z, b.z))
		mx = Vector3i(maxi(a.x, b.x), maxi(a.y, b.y), maxi(a.z, b.z))
	elif spec.get("selection", false):
		if not VoxelWorld.has_selection:
			return McpRegistry.fail("no_selection", "there's no region selection")
		mn = VoxelWorld.selection_min
		mx = VoxelWorld.selection_max
	elif spec.has("semantic"):
		var s := str(spec["semantic"])
		var found := false
		for p: Vector3i in data.cells:
			var cell: BlockCell = data.cells[p]
			var uses := cell.type_id == s
			if cell.is_shaped():
				uses = false
				for part in cell.parts:
					if str(part["semantic"]) == s:
						uses = true
			if uses:
				if not found:
					mn = p
					mx = p
					found = true
				mn = Vector3i(mini(mn.x, p.x), mini(mn.y, p.y), mini(mn.z, p.z))
				mx = Vector3i(maxi(mx.x, p.x), maxi(mx.y, p.y), maxi(mx.z, p.z))
		if not found:
			return McpRegistry.fail("empty_region", "'%s' isn't used in this project" % s)
	elif spec.get("all", false):
		var aabb := data.get_used_aabb() if data else []
		if aabb.is_empty():
			return McpRegistry.fail("empty_region", "the project is empty")
		mn = aabb[0]
		mx = aabb[1]
	elif spec.has("named"):
		return McpRegistry.fail("not_supported", "named regions aren't available yet; use {min,max}")
	else:
		return McpRegistry.fail("bad_argument", "region needs min/max, selection, semantic or all")
	var pad := int(spec.get("pad", 0))
	mn -= Vector3i.ONE * pad
	mx += Vector3i.ONE * pad
	var vol := (mx.x - mn.x + 1) * (mx.y - mn.y + 1) * (mx.z - mn.z + 1)
	if vol > 4_000_000:
		return McpRegistry.fail("too_large", "region has %d cells (max 4,000,000); split it" % vol)
	return {"min": mn, "max": mx}

# A plain block's orientation from {facing: word, top: bool} or {orientation: int}.
static func orientation(spec: Dictionary) -> Variant:
	if spec.has("orientation") and typeof(spec["orientation"]) != TYPE_STRING:
		return int(spec["orientation"])
	var facing_word := str(spec.get("facing", spec.get("orientation", ""))).to_lower()
	var facing: int = Orientation.Facing.NORTH
	if not facing_word.is_empty():
		var i := Orientation.NAMES.map(func(n: String) -> String: return n.to_lower()).find(facing_word)
		if i < 0:
			var side := ShapeCatalog.side_from_name(facing_word)
			if side < 0:
				return McpRegistry.fail("bad_argument", "unknown facing '%s'" % facing_word)
			i = Orientation.from_dir(Vector3(ShapeCatalog.side_vec(side)))
		facing = i
	return Orientation.make(facing, bool(spec.get("top", false)))

# The part a semantic places, at the slot a spec names: { slot } (a name or number) or
# { orient: {up, facing, turn, shift, normals} } for architecture shapes. The shape always
# comes from the semantic's palette entry, exactly as in the UI.
static func part_for(semantic: String, spec: Dictionary) -> Variant:
	var shape := VoxelWorld.get_shape_id_for_semantic(semantic)
	if shape.is_empty():
		return McpRegistry.fail("not_shaped", "'%s' places whole blocks (its palette entry has no shape); use cells_set, or give the entry a shape with palette_update" % semantic)
	if spec.has("shape") and str(spec["shape"]) != shape:
		return McpRegistry.fail("shape_mismatch", "'%s' places %s, not %s; parts always take their entry's shape" % [semantic, shape, spec["shape"]])
	var slot := -1
	if spec.has("slot"):
		slot = ShapeCatalog.slot_from_name(shape, spec["slot"])
		if slot < 0:
			return McpRegistry.fail("bad_slot", "%s has no slot '%s'. Slots: %s" % [shape, spec["slot"], ", ".join(ShapeCatalog.slot_names(shape).slice(0, 48))])
	elif spec.has("orient"):
		if ShapeCatalog.family_of(shape) != ShapeCatalog.Family.ARCH:
			return McpRegistry.fail("bad_slot", "orient is for architecture shapes; %s takes a slot name" % shape)
		var o: Dictionary = spec["orient"] if spec["orient"] is Dictionary else {}
		var r := ArchShapes.orient(shape, o)
		var slots: Array = r["slots"]
		if slots.is_empty():
			return McpRegistry.fail("bad_slot", "no orientation of %s matches %s" % [shape, JSON.stringify(o)])
		if slots.size() > 1 and not r["exact"]:
			var names: PackedStringArray = []
			for s in slots:
				names.append(ShapeCatalog.slot_name(shape, s))
			return McpRegistry.fail("ambiguous_orient", "%s matches several slots: %s" % [JSON.stringify(o), "; ".join(names)])
		slot = int(slots[0])
	else:
		return McpRegistry.fail("bad_slot", "a part needs slot (e.g. \"north\", \"south-east\") or orient")
	return BlockCell.make_part(semantic, shape, slot)

# A part as JSON for results: semantic, shape, slot number and slot name.
static func part_json(part: Dictionary) -> Dictionary:
	var shape := str(part.get("shape", ""))
	return {"semantic": part.get("semantic", ""), "shape": shape, "slot": ShapeCatalog.slot_name(shape, int(part.get("slot", 0)))}

# Symmetry + repeat maps from a tool's args: { maps, offsets } or a failure.
static func symmetry(args: Dictionary) -> Variant:
	var maps: Array = [SpatialXform.new()]
	var offsets: Array = [Vector3i.ZERO]
	if args.get("symmetry") is Dictionary and not (args["symmetry"] as Dictionary).is_empty():
		var g := SpatialXform.group_from_spec(args["symmetry"])
		if g.has("error"):
			return McpRegistry.fail("bad_symmetry", str(g["error"]))
		maps = g["maps"]
	if args.get("repeat") is Dictionary:
		var r := SpatialXform.repeat_offsets(args["repeat"])
		if r.has("error"):
			return McpRegistry.fail("bad_repeat", str(r["error"]))
		offsets = r["offsets"]
	return {"maps": maps, "offsets": offsets}

# The commit path for every edit tool: symmetry/repeat expansion, one undo step named after
# the tool, rejection reasons, and a warning for semantics no palette in the stack defines.
static func commit(tool_name: String, edits: Array, args: Dictionary, extra_rejected: Array = []) -> Dictionary:
	var sym: Variant = symmetry(args)
	if McpRegistry.is_error(sym):
		return sym
	var ex := SpatialXform.expand(edits, sym["maps"], sym["offsets"])
	if (ex["edits"] as Array).size() > 500_000:
		return McpRegistry.fail("too_large", "that's %d edits (max 500,000); split it" % (ex["edits"] as Array).size())
	var opts := {
		"dry_run": bool(args.get("dry_run", false)),
		"only_air": bool(args.get("only_air", false)),
		"animate": bool(args.get("animate", true)),
	}
	var undo_name := UNDO_PREFIX + tool_name
	var before := VoxelWorld.history_entries()
	var report := VoxelWorld.apply_edits(ex["edits"], undo_name, opts)
	var rejected: Array = extra_rejected + ex["rejected"] + report["rejected"]
	var out := {
		"placed": report["placed"], "cleared": report["cleared"], "changed": report["changed"],
	}
	if int(report["skipped"]) > 0:
		out["skipped"] = report["skipped"]
	if opts["dry_run"]:
		out["dry_run"] = true
	elif VoxelWorld.history_entries().hash() != before.hash():
		out["undo_step"] = undo_name
	if not rejected.is_empty():
		var listed: Array = []
		for r in rejected.slice(0, MAX_REJECTED_LISTED):
			var rr: Dictionary = r.duplicate()
			if rr.has("part"):
				rr["part"] = part_json(rr["part"])
			listed.append(rr)
		out["rejected"] = listed
		out["rejected_count"] = rejected.size()
	var unknown := unknown_semantics(ex["edits"])
	if not unknown.is_empty():
		out["warnings"] = ["not in this project's palettes (they'll render as undecided): " + ", ".join(unknown)]
	return out

static func unknown_semantics(edits: Array) -> PackedStringArray:
	var known := {}
	for s in VoxelWorld.merged_semantic_names():
		known[s] = true
	var out := {}
	for e: Dictionary in edits:
		var s := ""
		match str(e.get("op", "")):
			"block": s = str(e.get("semantic", ""))
			"part": s = str((e["part"] as Dictionary).get("semantic", ""))
		if not s.is_empty() and not known.has(s):
			out[s] = true
	return PackedStringArray(out.keys())

# Common schema fragments.
static func s_vec3(desc := "[x, y, z]") -> Dictionary:
	return {"type": "array", "items": {"type": "integer"}, "minItems": 3, "maxItems": 3, "description": desc}

static func s_region(desc := "Region: {min:[x,y,z], max:[x,y,z]} | {selection:true} | {semantic:\"Name\"} | {all:true}; optional pad") -> Dictionary:
	return {"type": "object", "description": desc}

static func edit_props() -> Dictionary:
	return {
		"project": {"type": "string", "description": "Name of the project you expect to be open (fails with project_changed if the user switched)"},
		"symmetry": {"type": "object", "description": "Copy every edit through a symmetry group: {rotate4:{center:[x,z]}}, {rotate2:{center:[x,z]}}, {mirror_x:x0}, {mirror_z:z0}, {mirror_diag:true|{center:[x,z]}}; keys combine. Centers are cell coordinates (.5 = on a cell boundary). Parts' slots turn/mirror with the structure."},
		"repeat": {"type": "object", "description": "Array copies after symmetry: {count:n, step:[dx,dy,dz]} or {count:[nx,ny,nz], step:[sx,sy,sz]}"},
		"dry_run": {"type": "boolean", "description": "Validate and report (placed/rejected) without changing anything"},
		"only_air": {"type": "boolean", "description": "Skip cells that are already occupied"},
		"animate": {"type": "boolean", "description": "Play the placement reveal in the user's 3D views (default true)"},
	}
