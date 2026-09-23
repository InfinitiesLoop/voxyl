extends RefCounted

# Views and renders: the user's own panes (list, aim, lens settings) and offscreen captures
# that never touch them (CaptureService). Every image is labeled — caption, axes gizmo, a
# legend in intent mode — because the model can't hover.

const _CAMERA_DESC := "CameraSpec: frame (a Region, default {all:true}, or a point [x,y,z]), from (n ne e se s sw w nw, or a bearing in degrees clockwise from north; default se), elevation (degrees above the horizon, or top/high/iso/mid/low/level/eye; eye = standing on the build's floor; default 30), fov (vertical degrees, default 50; the app uses 75), ortho (true = orthographic), distance / margin (fit, default 1.12), or explicit pos + look_at."
const _RENDER_DESC := "RenderSpec: mode textured|intent|clay|outline|xray|wire (intent = each semantic in its own flat color, with a legend — the clearest view of structure; outline = flat fill + dark feature edges; xray = faces at low opacity + every edge, see inside; wire = feature edges only, colored by semantic, drawn through everything), lighting app|studio|flat (studio lights undersides), background app|plain."

static func register(reg: McpRegistry) -> void:
	reg.add("view_list",
		"The user's open views: id, kind (3d / slice), whether it's focused and on screen, a 3D view's camera and render settings.",
		{}, func(_a: Dictionary) -> Dictionary: return {"views": view_list()})
	var cam_props := {
		"frame": {"description": "Region (default {all:true}) or a point [x,y,z] to look at"},
		"from": {"description": "Compass side (n ne e se s sw w nw) or bearing in degrees clockwise from north"},
		"elevation": {"description": "Degrees above the horizon, or top/high/iso/mid/low/level/eye"},
		"fov": {"type": "number"},
		"ortho": {"type": "boolean"},
		"distance": {"type": "number"},
		"margin": {"type": "number"},
		"pos": McpArgs.s_vec3("Explicit camera position (with look_at)"),
		"look_at": {"type": "array", "items": {"type": "number"}},
	}
	var capture_props := cam_props.duplicate()
	capture_props.merge({
		"render": {"type": "object", "description": _RENDER_DESC},
		"size": {"type": "array", "items": {"type": "integer"}, "description": "[w, h], default [1280, 720]"},
		"bbox": {"type": "boolean", "description": "Outline the framed region"},
		"format": {"type": "string", "enum": ["png", "jpeg"]},
	})
	reg.add("capture",
		"Render the build offscreen from any camera — the user's views don't move. Returns a labeled image (caption, compass gizmo, legend in intent mode), a capture_id and the camera used, and saves the PNG. Orthographic shots default to a plain background. " + _CAMERA_DESC + " " + _RENDER_DESC,
		{"properties": capture_props}, _capture)
	reg.add("capture_sheet",
		"Several labeled views in one image. preset: review (hero, eye-level, front and side elevations, top, back three-quarter), elevations (4 orthographic sides), turntable (8 bearings), compare (the same camera over each of `regions`, for variants). Or views: [CameraSpec + {label, render}]. frame/render apply to every tile unless a view overrides them; orthographic tiles default to studio lighting on a plain background.",
		{"properties": {
			"preset": {"type": "string", "enum": ["review", "elevations", "turntable", "compare"]},
			"views": {"type": "array", "items": {"type": "object"}},
			"frame": {"description": "Region for every tile (default {all:true})"},
			"regions": {"type": "array", "items": {"type": "object"}, "description": "compare: one Region per tile"},
			"labels": {"type": "array", "items": {"type": "string"}, "description": "compare: a caption per region"},
			"from": {"description": "compare: the shared camera side"},
			"elevation": {"description": "compare / turntable: the shared elevation"},
			"render": {"type": "object", "description": _RENDER_DESC},
			"tile": {"type": "array", "items": {"type": "integer"}, "description": "[w, h] per tile, default [560, 380]"},
			"cols": {"type": "integer"},
			"bbox": {"type": "boolean"},
			"format": {"type": "string", "enum": ["png", "jpeg"]},
		}}, _capture_sheet)
	reg.add("view_set",
		"Change one of the user's 3D views: move its camera (CameraSpec) and/or its lens settings (render: mode, lighting, projection, background). Its toolbar updates live. Use to hand the user a view of what you built — they see it move.",
		{"properties": {
			"view": {"type": "string", "description": "\"focused\" (default) or an id from view_list"},
			"camera": {"type": "object", "description": _CAMERA_DESC},
			"render": {"type": "object", "description": "mode / lighting / projection / background"},
		}}, _view_set, {"mutates": true})
	reg.add("screenshot",
		"Voxyl's window exactly as the user sees it right now (UI included), to check what they're looking at.",
		{"properties": {
			"scale": {"type": "number", "description": "Resize factor, default 0.6"},
			"format": {"type": "string", "enum": ["png", "jpeg"]},
		}}, _screenshot)
	reg.add("block_swatches",
		"An image of blocks as lit cubes with their names, to judge materials side by side before choosing (use names from block_search).",
		{"properties": {
			"blocks": {"type": "array", "description": "Block names, or {name, library}"},
			"format": {"type": "string", "enum": ["png", "jpeg"]},
		}, "required": ["blocks"]}, _block_swatches)
	reg.add("palette_render",
		"An image of a palette: every entry's block (cut to its shape, if it has one) with its semantic name.",
		{"properties": {"name": {"type": "string"}, "format": {"type": "string", "enum": ["png", "jpeg"]}},
		"required": ["name"]}, _palette_render)

# --- The user's views ------------------------------------------------------------------

# The editor's view shell (MultiViewShell), or null (headless / tests).
static func shell() -> Control:
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		return null
	return tree.get_first_node_in_group("view_shell") as Control

static func view_list() -> Array:
	var sh := shell()
	if sh == null:
		return []
	var focused: Control = sh.call("focused_view")
	var out: Array = []
	var i := 0
	for v: Control in sh.call("all_views"):
		var d := {"id": "v%d" % i, "kind": v.call("view_kind") if v.has_method("view_kind") else "?",
			"focused": v == focused, "shown": sh.call("is_view_shown", v)}
		if v is View3D:
			var st: Dictionary = (v as View3D).get_view_state()
			var info: Dictionary = (v as View3D).camera_info()
			d["camera"] = {"pos": st["camera_pos"], "looking": info["dir"]}
			d["render"] = st["render"]
		out.append(d)
		i += 1
	return out

static func _find_view(ref: String) -> Control:
	var sh := shell()
	if sh == null:
		return null
	if ref.is_empty() or ref == "focused":
		var f: Control = sh.call("focused_view")
		if f is View3D:
			return f
		for v in sh.call("all_views"):
			if v is View3D and sh.call("is_view_shown", v):
				return v
		return null
	var views: Array = sh.call("all_views")
	var i := ref.trim_prefix("v").to_int()
	return views[i] if ref.begins_with("v") and i >= 0 and i < views.size() else null

static func _view_set(args: Dictionary) -> Dictionary:
	var v := _find_view(str(args.get("view", "focused")))
	if not (v is View3D):
		return McpRegistry.fail("no_view", "no such 3D view (see view_list); the editor must be open")
	var view := v as View3D
	if args.get("render") is Dictionary:
		var why := ViewOptions.check(args["render"])
		if not why.is_empty():
			return McpRegistry.fail("bad_render", why)
		view.set_render_options(args["render"])
	if args.get("camera") is Dictionary:
		var aspect := view.size.x / maxf(1.0, view.size.y)
		var ortho := str(view.render_options["projection"]) == "orthographic"
		var cam: Dictionary = args["camera"].duplicate()
		if not cam.has("fov"):
			cam["fov"] = view.camera_info()["fov"]
		if ortho:
			cam["ortho"] = true
		var pose: Variant = resolve_camera(cam, aspect)
		if McpRegistry.is_error(pose):
			return pose
		view.set_camera_pose(pose["pos"], pose["target"], -1.0, float(pose["ortho_size"]) if ortho else -1.0)
	var st := view.get_view_state()
	return {"view": args.get("view", "focused"), "camera": {"pos": st["camera_pos"], "looking": view.camera_info()["dir"]},
		"render": st["render"]}

# --- Camera specs -------------------------------------------------------------------

# A CameraSpec → pose { pos, target, fov, ortho_size, from (compass), elevation, region?, box? }.
static func resolve_camera(spec: Dictionary, aspect: float) -> Variant:
	var fov := float(spec.get("fov", 50.0))
	var ortho := bool(spec.get("ortho", false))
	if spec.has("pos") and spec.has("look_at"):
		var la: Variant = spec["look_at"]
		var pa: Variant = spec["pos"]
		if not (pa is Array and la is Array) or (pa as Array).size() < 3 or (la as Array).size() < 3:
			return McpRegistry.fail("bad_camera", "pos and look_at must be [x, y, z]")
		var pos := Vector3(float(pa[0]), float(pa[1]), float(pa[2]))
		var target := Vector3(float(la[0]), float(la[1]), float(la[2]))
		return {"pos": pos, "target": target, "fov": fov, "ortho_size": float(spec.get("ortho_size", 20.0)) if ortho else 0.0,
			"from": CameraFraming.compass_word(CameraFraming.bearing_of(pos, target)),
			"elevation": snappedf(rad_to_deg(atan2(pos.y - target.y, Vector2(pos.x - target.x, pos.z - target.z).length())), 0.1)}
	var box: AABB
	var frame: Variant = spec.get("frame", {"all": true})
	var floor_y := 0.0
	var region_json: Variant = null
	if frame is Array and (frame as Array).size() >= 3 and not (frame[0] is Array):
		var c := Vector3(float(frame[0]), float(frame[1]), float(frame[2]))
		box = AABB(c - Vector3.ONE * 2.0, Vector3.ONE * 4.0)
		floor_y = c.y
	else:
		var r: Variant = McpArgs.region(frame, true)
		if McpRegistry.is_error(r):
			return r
		box = AABB(Vector3(r["min"]), Vector3(r["max"] - r["min"] + Vector3i.ONE))
		floor_y = float((r["min"] as Vector3i).y)
		region_json = {"min": r["min"], "max": r["max"]}
	var b := CameraFraming.bearing(spec.get("from", "se"))
	if is_nan(b):
		return McpRegistry.fail("bad_camera", "from must be a compass side (n ne e se s sw w nw) or degrees")
	var elevation: Variant = spec.get("elevation", 30.0)
	var pose := CameraFraming.frame(box, b, elevation, fov, aspect, float(spec.get("margin", 1.12)), ortho,
		float(spec.get("distance", -1.0)), floor_y)
	pose["from"] = CameraFraming.compass_word(b)
	pose["elevation"] = snappedf(float(pose["elevation"]), 0.1)
	pose["region"] = region_json
	pose["box"] = box
	return pose

# --- Captures -------------------------------------------------------------------------

static func _capture(args: Dictionary) -> Variant:
	var cs: CaptureService = McpServer.capture_service()
	if VoxelWorld.active_project == null:
		return McpRegistry.fail("no_project", "no project is open")
	if not cs.is_rendering_available():
		return McpRegistry.fail("no_renderer", "this Voxyl runs without a display, so it can't render")
	var size := _size(args.get("size"), CaptureService.DEFAULT_SIZE)
	var render: Dictionary = (args["render"] as Dictionary).duplicate() if args.get("render") is Dictionary else {}
	if bool(args.get("ortho", false)) and not render.has("background"):
		render["background"] = "plain"
	var why := ViewOptions.check(render)
	if not why.is_empty():
		return McpRegistry.fail("bad_render", why)
	var pose: Variant = resolve_camera(args, CaptureService.aspect_of(size))
	if McpRegistry.is_error(pose):
		return pose
	var tile: Variant = await _render_tile(cs, pose, render, size, _caption(pose, render, size), bool(args.get("bbox", false)))
	if McpRegistry.is_error(tile):
		return tile
	var img: Image = await cs.compose([tile], 1, size)
	if img == null:
		return _not_drawing()
	var id := cs.remember_camera(_camera_json(pose))
	var path := cs.save(img, "capture-%d" % id)
	return {"capture_id": id, "camera": _camera_json(pose), "region": pose.get("region"), "saved": path,
		McpRegistry.IMAGES_KEY: [McpRegistry.image(img, str(args.get("format", "png")))]}

# One rendered tile: { image, caption, gizmo, legend }.
static func _render_tile(cs: CaptureService, pose: Dictionary, render: Dictionary, size: Vector2i, caption: String, bbox: bool) -> Variant:
	var marker: Array = []
	if bbox and pose.get("region") is Dictionary:
		marker = [pose["region"]["min"], pose["region"]["max"]]
	var img: Image = await cs.render(pose, render, size, marker)
	if img == null:
		return _not_drawing()
	var info := cs.camera_basis()
	var t := {"image": img, "caption": caption, "gizmo": {"right": info["right"], "up": info["up"]}}
	if str(render.get("mode", "textured")) == "intent":
		t["legend"] = _intent_legend(pose.get("region"))
	return t

static func _intent_legend(region: Variant) -> Array:
	var used := {}
	var data := VoxelWorld.active_project.data
	var cells: Array = data.cells.keys() if not (region is Dictionary) else RegionOps.cells_in(data, region["min"], region["max"])
	for p in cells:
		var cell: BlockCell = data.cells[p]
		if cell.is_shaped():
			for part in cell.parts:
				used[str(part["semantic"])] = true
		else:
			used[cell.type_id] = true
	var out: Array = []
	for s in VoxelWorld.merged_semantic_names():
		if used.has(s):
			out.append([s, View3D.intent_color(s)])
			used.erase(s)
	for s in used:
		out.append([s + " (not in palettes)", View3D.intent_color(s)])
	return out

# One line under a render. Narrow sheet tiles get the short form (label, camera, lens).
static func _caption(pose: Dictionary, render: Dictionary, size: Vector2i, label := "") -> String:
	var wide := size.x >= 700
	var parts: PackedStringArray = []
	if not label.is_empty():
		parts.append(label)
	if wide:
		parts.append(VoxelWorld.active_project.name)
	parts.append("from %s, %s°" % [str(pose.get("from", "")).to_upper(), str(pose.get("elevation", ""))])
	parts.append("ortho" if float(pose.get("ortho_size", 0.0)) > 0.0 else "fov %d" % int(pose.get("fov", 50)))
	if wide and pose.get("region") is Dictionary:
		var s: Vector3i = pose["region"]["max"] - pose["region"]["min"] + Vector3i.ONE
		parts.append("%d×%d×%d" % [s.x, s.y, s.z])
	var mode := str(render.get("mode", "textured"))
	if wide or mode != "textured":
		parts.append(mode)
	return " · ".join(parts)

static func _camera_json(pose: Dictionary) -> Dictionary:
	return {"pos": pose["pos"], "look_at": pose["target"], "from": pose.get("from", ""), "elevation": pose.get("elevation", 0),
		"fov": pose.get("fov", 50), "ortho": float(pose.get("ortho_size", 0.0)) > 0.0}

static func _not_drawing() -> Dictionary:
	return McpRegistry.fail("not_drawing", "Voxyl's window isn't drawing (minimized?); ask the user to restore it, then retry")

static func _size(v: Variant, default: Vector2i) -> Vector2i:
	if v is Array and (v as Array).size() >= 2:
		return Vector2i(clampi(int(v[0]), 64, 2400), clampi(int(v[1]), 64, 2400))
	return default

# The review preset's six shots.
const _REVIEW := [
	{"label": "Hero", "from": "se", "elevation": 28, "fov": 45},
	{"label": "Eye level", "from": "sw", "elevation": "eye", "fov": 70},
	{"label": "Front (south) elevation", "from": "s", "elevation": 0, "ortho": true},
	{"label": "Side (east) elevation", "from": "e", "elevation": 0, "ortho": true},
	{"label": "Top", "from": "s", "elevation": "top", "ortho": true},
	{"label": "Back three-quarter", "from": "nw", "elevation": 35, "fov": 45},
]

static func _capture_sheet(args: Dictionary) -> Variant:
	var cs: CaptureService = McpServer.capture_service()
	if VoxelWorld.active_project == null:
		return McpRegistry.fail("no_project", "no project is open")
	if not cs.is_rendering_available():
		return McpRegistry.fail("no_renderer", "this Voxyl runs without a display, so it can't render")
	var tile_size := _size(args.get("tile"), Vector2i(560, 380))
	var base_render: Dictionary = args.get("render", {}) if args.get("render") is Dictionary else {}
	var why := ViewOptions.check(base_render)
	if not why.is_empty():
		return McpRegistry.fail("bad_render", why)
	var frame: Variant = args.get("frame", {"all": true})
	var specs: Array = []
	match str(args.get("preset", "")):
		"review":
			for v in _REVIEW:
				var s: Dictionary = v.duplicate()
				s["frame"] = frame
				specs.append(s)
		"elevations":
			for side in [["South", "s"], ["East", "e"], ["North", "n"], ["West", "w"]]:
				specs.append({"label": side[0] + " elevation", "from": side[1], "elevation": 0, "ortho": true, "frame": frame})
		"turntable":
			for b in 8:
				specs.append({"label": CameraFraming.compass_word(b * 45.0).to_upper(), "from": b * 45.0,
					"elevation": args.get("elevation", 25), "fov": 45, "frame": frame})
		"compare":
			var regions: Array = args.get("regions", [])
			if regions.is_empty():
				return McpRegistry.fail("bad_argument", "compare needs regions: [Region, ...]")
			var labels: Array = args.get("labels", [])
			for i in regions.size():
				specs.append({"label": str(labels[i]) if i < labels.size() else "#%d" % (i + 1), "frame": regions[i],
					"from": args.get("from", "se"), "elevation": args.get("elevation", 28), "fov": 45})
		"":
			for v in args.get("views", []):
				if v is Dictionary:
					var s: Dictionary = v.duplicate()
					if not s.has("frame") and not s.has("pos"):
						s["frame"] = frame
					specs.append(s)
		_:
			return McpRegistry.fail("bad_argument", "preset must be review, elevations, turntable or compare")
	if specs.is_empty():
		return McpRegistry.fail("bad_argument", "give a preset or views")
	if specs.size() > 16:
		return McpRegistry.fail("too_large", "at most 16 tiles per sheet")
	var tiles: Array = []
	var cams: Array = []
	for s: Dictionary in specs:
		var render := base_render.duplicate()
		if s.get("render") is Dictionary:
			render.merge(s["render"], true)
		if bool(s.get("ortho", false)) and not render.has("background"):
			render["background"] = "plain"   # elevations read better without the sky and grid
		if bool(s.get("ortho", false)) and not render.has("lighting"):
			render["lighting"] = "studio"    # …and with every side lit, not just the sunny ones
		var pose: Variant = resolve_camera(s, CaptureService.aspect_of(tile_size))
		if McpRegistry.is_error(pose):
			return pose
		var t: Variant = await _render_tile(cs, pose, render, tile_size, _caption(pose, render, tile_size, str(s.get("label", ""))), bool(args.get("bbox", false)))
		if McpRegistry.is_error(t):
			return t
		tiles.append(t)
		cams.append({"label": s.get("label", ""), "camera": _camera_json(pose)})
	var cols := int(args.get("cols", 3 if tiles.size() > 4 else 2 if tiles.size() > 1 else 1))
	var title := "%s — %s" % [VoxelWorld.active_project.name, str(args.get("preset", "views"))]
	var img: Image = await cs.compose(tiles, cols, tile_size, title)
	if img == null:
		return _not_drawing()
	var id := cs.remember_camera({"sheet": cams})
	var path := cs.save(img, "sheet-%d" % id)
	return {"capture_id": id, "tiles": cams, "saved": path,
		McpRegistry.IMAGES_KEY: [McpRegistry.image(img, str(args.get("format", "png")))]}

static func _screenshot(args: Dictionary) -> Variant:
	var cs: CaptureService = McpServer.capture_service()
	if not cs.is_rendering_available():
		return McpRegistry.fail("no_renderer", "this Voxyl runs without a display")
	var tree := Engine.get_main_loop() as SceneTree
	if not await cs.wait_draw():
		return _not_drawing()
	var img := tree.root.get_texture().get_image()
	if img == null or img.is_empty():
		return _not_drawing()
	var s := clampf(float(args.get("scale", 0.6)), 0.1, 1.0)
	if s < 1.0:
		img.resize(int(img.get_width() * s), int(img.get_height() * s), Image.INTERPOLATE_BILINEAR)
	var path := cs.save(img, "screenshot-%d" % Time.get_ticks_msec())
	return {"saved": path, "size": [img.get_width(), img.get_height()],
		McpRegistry.IMAGES_KEY: [McpRegistry.image(img, str(args.get("format", "jpeg")))]}

# --- Blocks and palettes as images ------------------------------------------------------

static func _block_swatches(args: Dictionary) -> Variant:
	var cs: CaptureService = McpServer.capture_service()
	if not cs.is_rendering_available():
		return McpRegistry.fail("no_renderer", "this Voxyl runs without a display, so it can't render")
	var items: Array = []
	var missing: Array = []
	for b in args.get("blocks", []):
		var name := str(b.get("name", "")) if b is Dictionary else str(b)
		var lib_name := str(b.get("library", "")) if b is Dictionary else ""
		var found: BlockType = null
		var owner := ""
		for lib in VoxelWorld.workspace.libraries:
			if not lib_name.is_empty() and lib.name != lib_name:
				continue
			var bt := lib.get_block_type(name)
			if bt != null:
				found = bt
				owner = lib.name
				break
		if found == null:
			missing.append(name)
		else:
			items.append({"bt": found, "caption": "%s  (%s)" % [name, owner]})
	if items.is_empty():
		return McpRegistry.fail("not_found", "none of those blocks exist: %s" % ", ".join(missing))
	if items.size() > 36:
		return McpRegistry.fail("too_large", "at most 36 blocks per swatch sheet")
	return await _swatch_sheet(cs, items, "Block swatches", missing, str(args.get("format", "png")))

static func _palette_render(args: Dictionary) -> Variant:
	var cs: CaptureService = McpServer.capture_service()
	if not cs.is_rendering_available():
		return McpRegistry.fail("no_renderer", "this Voxyl runs without a display, so it can't render")
	var p := VoxelWorld.workspace.get_palette(str(args.get("name", "")))
	if p == null:
		return McpRegistry.fail("not_found", "no palette named '%s'" % args.get("name", ""))
	var items: Array = []
	for e in p.entries.slice(0, 36):
		var bt: BlockType
		if e.is_shaped():
			bt = VoxelWorld.icon_block_type_for_shape(e.shape_id, e.block_type_name, p)
		elif not e.block_type_name.is_empty():
			bt = VoxelWorld.workspace.resolve_block_type(e.block_type_name, p.library_names)
		if bt == null:
			bt = BlockType.new()
			bt.name = "undecided"
			bt.color = Color(0.35, 0.35, 0.35)
		var sub: String = e.block_type_name if not e.block_type_name.is_empty() else "undecided"
		if e.is_shaped():
			sub += " · " + ShapeCatalog.name_of(e.shape_id)
		items.append({"bt": bt, "caption": "%s — %s" % [e.semantic_name, sub]})
	if items.is_empty():
		return McpRegistry.fail("empty", "palette '%s' has no entries" % p.name)
	return await _swatch_sheet(cs, items, "Palette: " + p.name, [], str(args.get("format", "png")))

static func _swatch_sheet(cs: CaptureService, items: Array, title: String, missing: Array, format: String) -> Variant:
	var imgs: Array = await cs.swatch_images(items)
	if imgs.is_empty():
		return _not_drawing()
	var tiles: Array = []
	for i in items.size():
		tiles.append({"image": imgs[i], "caption": items[i]["caption"]})
	var cols := clampi(ceili(sqrt(float(tiles.size()) * 1.4)), 1, 6)
	var img: Image = await cs.compose(tiles, cols, Vector2i(260, CaptureService.SWATCH_RES), title)
	if img == null:
		return _not_drawing()
	var path := cs.save(img, "swatches-%d" % Time.get_ticks_msec())
	var out := {"saved": path, "shown": items.map(func(it: Dictionary) -> String: return str(it["caption"])),
		McpRegistry.IMAGES_KEY: [McpRegistry.image(img, format)]}
	if not missing.is_empty():
		out["missing"] = missing
	return out
