extends Node

# The MCP server end to end, headless: a real HTTPClient talks JSON-RPC to McpServer on a
# test port (auth, origin, keep-alive, big responses), and a small pillar is built through
# the tools, asserting the resulting cells. Also covers the pieces underneath (slot names,
# orientation words, symmetry, the text codec). Runs sandboxed: projects and palettes go to
# a temp dir, never the real workspace.

const PORT := 47991
const TOKEN := "test-token-123"

var _pass := 0
var _fail := 0
var _http := HTTPClient.new()
var _sandbox := ""
var _rpc_id := 0

func _ready() -> void:
	print("\n=== voxyl mcp test ===\n")
	await _run()
	_cleanup()
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
	_sandbox = OS.get_temp_dir().path_join("voxyl_mcp_test_%d" % Time.get_ticks_usec()).replace("\\", "/")
	AppSettings.use_sandbox(_sandbox)
	VoxelWorld.reset_for_tests()
	_test_slot_names()
	_test_arch_orientation()
	_test_symmetry()
	_test_codec()
	_test_camera_framing()
	AppSettings.set_value(AppSettings.SECTION_AGENT, "enabled", true)
	AppSettings.set_value(AppSettings.SECTION_AGENT, "port", PORT)
	AppSettings.set_value(AppSettings.SECTION_AGENT, "require_token", true)
	AppSettings.set_value(AppSettings.SECTION_AGENT, "token", TOKEN)
	McpServer.restart()
	_check("server listens on the test port", McpServer.is_listening())
	await _test_http()
	await _test_build()
	await _test_prefabs()
	await _test_nei_roster_import_tool()
	McpServer.stop()

func _cleanup() -> void:
	_rm_rf(_sandbox)

# --- Pieces underneath ----------------------------------------------------------------

func _test_slot_names() -> void:
	print("-- slot names")
	var ok := true
	for id in ShapeCatalog.ORDER:
		for s in ShapeCatalog.slot_count(id):
			if ShapeCatalog.slot_from_name(id, ShapeCatalog.slot_name(id, s)) != s:
				ok = false
				print("    round trip failed: %s %d (%s)" % [id, s, ShapeCatalog.slot_name(id, s)])
	_check("every microblock slot name round-trips", ok)
	_check("face slot 2 is north", ShapeCatalog.slot_name("face4", 2) == "north")
	_check("vertical edge by words in any order", ShapeCatalog.slot_from_name("edge1", "east-south") == ShapeCatalog.slot_from_name("edge1", "south-east"))
	var e := ShapeCatalog.slot_from_name("edge1", "south-east")
	var b := ShapeCatalog.bounds("edge1", e)
	_check("south-east strip hugs +X,+Z and runs full height", b.position.x > 0.8 and b.position.z > 0.8 and is_equal_approx(b.size.y, 1.0))
	_check("corner name", ShapeCatalog.slot_name("corner1", 0) == "down-north-west")
	_check("centered post", ShapeCatalog.slot_from_name("edge2", "center-y") == ShapeCatalog.CENTER_SLOT)
	_check("axis alias -z = north", ShapeCatalog.slot_from_name("face1", "-z") == 2)
	_check("numbers still work", ShapeCatalog.slot_from_name("face1", 3) == 3)

func _test_arch_orientation() -> void:
	print("-- architecture orientation words")
	var ok := true
	for id in ["roof_tile", "stairs", "roof_outer_corner", "cylinder", "arch_d1", "banister_plain", "cornice_lh"]:
		for s in ShapeCatalog.slot_count(id):
			var back := ShapeCatalog.slot_from_name(id, ShapeCatalog.slot_name(id, s))
			if back != s and ArchShapes._placed_signature(id, back) != ArchShapes._placed_signature(id, s):
				ok = false
				print("    %s slot %d → '%s' → %d" % [id, s, ShapeCatalog.slot_name(id, s), back])
	_check("architecture slot names round-trip (to the same geometry)", ok)
	var r := ArchShapes.orient("roof_tile", {"up": "up", "facing": "south"})
	_check("one upright roof tile faces south", (r["slots"] as Array).size() == 1 and r["exact"])
	# Facing south = the slope looks south: its slope normal has +Z.
	_check("its slope normal points south and up", ArchShapes._has_normals("roof_tile", r["slots"][0], [[0, 1, 1]]))
	var st := ArchShapes.orient("stairs", {"up": "up", "facing": "north"})
	_check("stairs facing north has its riser faces toward north", ArchShapes._has_normals("stairs", st["slots"][0], [[0, 0, -1], [0, 1, 0]]))
	var corner := ArchShapes.orient("roof_outer_corner", {"up": "up", "facing": "south"})
	_check("a single word matches both diagonals of a corner", (corner["slots"] as Array).size() == 2 and not corner["exact"])
	var mirrored := ArchShapes.transform_part("cornice_lh", 0, Basis(Vector3(-1, 0, 0), Vector3(0, 1, 0), Vector3(0, 0, 1)))
	_check("mirroring a left-hand cornice gives the right-hand one", str(mirrored.get("shape", "")) == "cornice_rh")
	var turned := ArchShapes.transform_part("roof_tile", r["slots"][0], Basis(Vector3.UP, deg_to_rad(-90)))
	_check("a quarter turn clockwise turns south-facing to west-facing",
		ArchShapes.slot_info("roof_tile", int(turned["slot"]))["facing"] == "west")

func _test_symmetry() -> void:
	print("-- symmetry")
	var g := SpatialXform.group_from_spec({"rotate4": {"center": [0, 0]}})
	_check("rotate4 makes 4 maps", (g["maps"] as Array).size() == 4)
	var both := SpatialXform.group_from_spec({"rotate4": {"center": [0, 0]}, "mirror_x": 0})
	_check("rotate4 + mirror makes 8", (both["maps"] as Array).size() == 8)
	var edits := [{"pos": Vector3i(0, 0, 2), "op": "block", "semantic": "A", "orientation": 0}]
	var ex := SpatialXform.expand(edits, g["maps"], [])
	var got := {}
	for e in ex["edits"]:
		got[e["pos"]] = true
	_check("rotate4 puts copies on all four sides",
		got.has(Vector3i(0, 0, 2)) and got.has(Vector3i(-2, 0, 0)) and got.has(Vector3i(0, 0, -2)) and got.has(Vector3i(2, 0, 0)))
	var half := SpatialXform.group_from_spec({"rotate4": {"center": [0.5, 0.5]}})
	var ex2 := SpatialXform.expand([{"pos": Vector3i(0, 0, 0), "op": "clear"}], half["maps"], [])
	var cells := {}
	for e in ex2["edits"]:
		cells[e["pos"]] = true
	_check("a boundary pivot rotates a 2x2", cells.size() == 4 and cells.has(Vector3i(1, 0, 1)))
	var part := {"pos": Vector3i(0, 0, 2), "op": "part", "part": BlockCell.make_part("E", "edge1", ShapeCatalog.slot_from_name("edge1", "south-east"))}
	var ex3 := SpatialXform.expand([part], g["maps"], [])
	var names := {}
	for e in ex3["edits"]:
		names[ShapeCatalog.slot_name("edge1", int(e["part"]["slot"]))] = e["pos"]
	_check("parts turn with the structure", names.get("south-west") == Vector3i(-2, 0, 0) and names.get("north-east") == Vector3i(2, 0, 0))
	var rep := SpatialXform.repeat_offsets({"count": 3, "step": [0, 1, 0]})
	_check("repeat offsets", (rep["offsets"] as Array) == [Vector3i.ZERO, Vector3i(0, 1, 0), Vector3i(0, 2, 0)])

func _test_codec() -> void:
	print("-- text codec")
	var d := VoxelData.new()
	d.set_block(Vector3i(0, 0, 0), "Mass")
	d.set_block(Vector3i(1, 0, 0), "Core")
	d.set_block(Vector3i(0, 1, 1), "Mass")
	d.add_part(Vector3i(1, 1, 1), BlockCell.make_part("Glow", "face4", 3))
	var t := RegionCodec.dump(d, Vector3i(0, 0, 0), Vector3i(1, 1, 1))
	_check("dump origin", t["origin"] == [0, 0, 0])
	_check("two layers of two rows", (t["layers"] as Array).size() == 2 and (t["layers"][0] as PackedStringArray).size() == 2)
	_check("layer 0 row 0 is Mass then Core", str(t["layers"][0][0]) == "MC")
	_check("layer 1 row 1 has a part char", str(t["layers"][1][1]).substr(1, 1) == "g")
	_check("legend part slot by name", str(t["legend"]["g"][0]["slot"]) == "south")

func _test_camera_framing() -> void:
	print("-- camera framing + view options")
	_check("compass words", CameraFraming.bearing("se") == 135.0 and CameraFraming.bearing(90) == 90.0 and is_nan(CameraFraming.bearing("up")))
	var box := AABB(Vector3(-2, 0, -2), Vector3(5, 18, 5))
	var pose := CameraFraming.frame(box, 135.0, 30, 50.0, 16.0 / 9.0)
	var p: Vector3 = pose["pos"]
	_check("a south-east camera stands south-east of the box", p.x > 0.5 and p.z > 0.5 and p.y > box.get_center().y)
	_check("at the asked elevation", absf(float(pose["elevation"]) - 30.0) < 0.5)
	var basis := Basis.looking_at((pose["target"] - p).normalized(), Vector3.UP)
	var tan_v := tan(deg_to_rad(25.0))
	var inside := true
	for i in 8:
		var c := box.position + box.size * Vector3(i & 1, (i >> 1) & 1, (i >> 2) & 1)
		var q := c - p
		var depth := -q.dot(basis.z)
		if absf(q.dot(basis.y)) > tan_v * depth + 0.01 or absf(q.dot(basis.x)) > tan_v * 16.0 / 9.0 * depth + 0.01:
			inside = false
	_check("the whole box is in frame", inside)
	var eye := CameraFraming.frame(box, 225.0, "eye", 70.0, 1.5, 1.1, false, -1.0, 0.0)
	_check("eye level stands at eye height", is_equal_approx((eye["pos"] as Vector3).y, CameraFraming.EYE_HEIGHT))
	var ortho := CameraFraming.frame(box, 180.0, 0, 50.0, 1.0, 1.0, true)
	_check("an orthographic front view is tall enough for the box", float(ortho["ortho_size"]) >= 18.0)
	_check("ViewOptions accepts known values", ViewOptions.check({"mode": "intent", "lighting": "studio"}).is_empty())
	_check("ViewOptions rejects unknown ones", not ViewOptions.check({"mode": "neon"}).is_empty() and not ViewOptions.check({"shiny": "yes"}).is_empty())

# --- HTTP transport -------------------------------------------------------------------

func _connect() -> bool:
	_http.close()
	_http.connect_to_host("127.0.0.1", PORT)
	for i in 300:
		_http.poll()
		var st := _http.get_status()
		if st == HTTPClient.STATUS_CONNECTED:
			return true
		if st != HTTPClient.STATUS_CONNECTING and st != HTTPClient.STATUS_RESOLVING:
			return false
		await get_tree().process_frame
	return false

# One HTTP request → { code, headers, body (String) }. Reuses the open connection.
func _request(method: int, body: String, headers: PackedStringArray) -> Dictionary:
	if _http.get_status() != HTTPClient.STATUS_CONNECTED:
		if not await _connect():
			return {"code": 0}
	_http.request(method, "/mcp", headers, body)
	for i in 600:
		_http.poll()
		if _http.get_status() != HTTPClient.STATUS_REQUESTING:
			break
		await get_tree().process_frame
	if not _http.has_response():
		return {"code": 0}
	var code := _http.get_response_code()
	var hdrs := _http.get_response_headers_as_dictionary()
	var out := PackedByteArray()
	for i in 6000:
		_http.poll()
		if _http.get_status() != HTTPClient.STATUS_BODY:
			break
		var chunk := _http.read_response_body_chunk()
		if chunk.is_empty():
			await get_tree().process_frame
		else:
			out.append_array(chunk)
	return {"code": code, "headers": hdrs, "body": out.get_string_from_utf8()}

func _auth_headers() -> PackedStringArray:
	return ["Content-Type: application/json", "Accept: application/json, text/event-stream",
		"Authorization: Bearer " + TOKEN, "MCP-Protocol-Version: 2025-06-18"]

func _rpc(method: String, params := {}) -> Dictionary:
	_rpc_id += 1
	var r := await _request(HTTPClient.METHOD_POST,
		JSON.stringify({"jsonrpc": "2.0", "id": _rpc_id, "method": method, "params": params}), _auth_headers())
	var parsed: Variant = JSON.parse_string(str(r.get("body", "")))
	return parsed if parsed is Dictionary else {"http": r.get("code", 0)}

# A tools/call → the parsed JSON text result (with "_is_error" set on failures).
func _tool(tool_name: String, args := {}) -> Dictionary:
	var r := await _rpc("tools/call", {"name": tool_name, "arguments": args})
	if not r.has("result"):
		return {"_is_error": true, "_raw": r}
	var content: Array = r["result"]["content"]
	var data: Variant = JSON.parse_string(str(content[0]["text"]))
	var out: Dictionary = data if data is Dictionary else {}
	out["_is_error"] = bool(r["result"].get("isError", false))
	out["_content"] = content
	return out

func _test_http() -> void:
	print("-- http transport")
	_check("connects", await _connect())
	var no_auth := await _request(HTTPClient.METHOD_POST, "{}", ["Content-Type: application/json"])
	_check("no token → 401", no_auth["code"] == 401)
	var bad_origin := await _request(HTTPClient.METHOD_POST, "{}",
		_auth_headers() + PackedStringArray(["Origin: http://evil.example.com"]))
	_check("foreign Origin → 403", bad_origin["code"] == 403)
	var local_origin := await _request(HTTPClient.METHOD_POST,
		JSON.stringify({"jsonrpc": "2.0", "id": 99, "method": "ping"}),
		_auth_headers() + PackedStringArray(["Origin: http://localhost:3000"]))
	_check("local Origin is fine", local_origin["code"] == 200)
	var get_r := await _request(HTTPClient.METHOD_GET, "", _auth_headers())
	_check("GET → 405 (no event stream)", get_r["code"] == 405)
	_rpc_id += 1
	var init := await _request(HTTPClient.METHOD_POST, JSON.stringify({"jsonrpc": "2.0", "id": _rpc_id,
		"method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {},
		"clientInfo": {"name": "test", "version": "1"}}}), _auth_headers())
	var init_body: Dictionary = JSON.parse_string(init["body"])
	_check("initialize answers with the asked version", init_body["result"]["protocolVersion"] == "2025-06-18")
	_check("initialize issues a session id", (init["headers"] as Dictionary).has("Mcp-Session-Id"))
	_check("initialize carries instructions", str(init_body["result"].get("instructions", "")).contains("semantic"))
	var note := await _request(HTTPClient.METHOD_POST,
		JSON.stringify({"jsonrpc": "2.0", "method": "notifications/initialized"}), _auth_headers())
	_check("a notification → 202", note["code"] == 202)
	var list := await _rpc("tools/list")
	var names := {}
	for t in list["result"]["tools"]:
		names[t["name"]] = t
	_check("tools/list has the editing tools", names.has("cells_place_layers") and names.has("parts_add") and names.has("status"))
	_check("every tool has an object schema", names.values().all(func(t: Dictionary) -> bool: return t["inputSchema"]["type"] == "object"))
	var unknown := await _rpc("nope/nope")
	_check("unknown method → JSON-RPC error", unknown.has("error") and int(unknown["error"]["code"]) == -32601)
	var st := await _tool("status")
	_check("status over HTTP", not st["_is_error"] and st.has("paused"))
	var res := await _rpc("resources/read", {"uri": "voxyl://conventions"})
	_check("conventions resource", str(res["result"]["contents"][0]["text"]).contains("north = -Z"))

# --- A small build through the tools ---------------------------------------------------

func _test_build() -> void:
	print("-- building through tools")
	var pal := await _tool("palette_create", {"name": "Pillar Test", "libraries": [], "entries": [
		{"semantic": "Core", "block": "stone"},
		{"semantic": "Mass", "block": "base"},
		{"semantic": "Glow", "block": "glass", "shape": "face4"},
		{"semantic": "Edge", "block": "trim", "shape": "edge1"},
		{"semantic": "Chamfer", "block": "stone", "shape": "roof_tile"},
		{"semantic": "Nope", "block": "not_a_block"},
	]})
	_check("palette_create", not pal["_is_error"] and (pal["entries"] as Array).size() == 6)
	_check("an unknown block is a warning, not a failure", pal.has("warnings"))
	var saved_pal := LibraryStore.palettes_dir().path_join("Pillar Test.tres")
	_check("palette written to the sandbox only", FileAccess.file_exists(saved_pal))
	var proj := await _tool("project_create", {"name": "MCP Test", "palettes": ["Pillar Test"], "scratch": true})
	_check("scratch project created and open", not proj["_is_error"] and VoxelWorld.active_project != null and VoxelWorld.active_project.name == "MCP Test")
	_check("scratch isn't written", not FileAccess.file_exists(ProjectStore.ROOT.path_join("MCP Test.tres")))

	# One quarter of a 5x5 shaft layer, filled by rotate4; 3 layers tall.
	var r := await _tool("cells_place_layers", {"project": "MCP Test", "origin": [-2, 0, -2],
		"legend": {"M": "Mass", "C": "Core",
			"g": [{"semantic": "Glow", "slot": "north"}, {"semantic": "Edge", "slot": "south-west"}, {"semantic": "Edge", "slot": "south-east"}]},
		"layers": [[".....", ".....", "..C..", "..CC.", ".MgM."]],
		"symmetry": {"rotate4": {"center": [0, 0]}}, "repeat": {"count": 3, "step": [0, 1, 0]}})
	_check("cells_place_layers placed", not r["_is_error"] and int(r["placed"]) > 0 and not r.has("rejected"))
	_check("…as one undo step", str(r.get("undo_step", "")) == "Claude: cells_place_layers")
	var data := VoxelWorld.active_project.data
	_check("core center", data.get_block(Vector3i(0, 1, 0)) == "Core")
	_check("mass rotated to the west face", data.get_block(Vector3i(-2, 2, -1)) == "Mass")
	var east := data.get_cell(Vector3i(2, 0, 0))
	_check("glow cell rotated to the east face with 3 parts", east != null and east.parts.size() == 3)
	var glow_east := east != null and east.parts.any(func(p: Dictionary) -> bool:
		return p["semantic"] == "Glow" and ShapeCatalog.slot_name("face4", int(p["slot"])) == "west")
	_check("its glow panel sits at the back of the recess (west side of the east cell)", glow_east)

	var rej := await _tool("parts_add", {"items": [
		{"pos": [0, 0, 2], "semantic": "Glow", "slot": "north"},
		{"pos": [-1, 0, 2], "semantic": "Glow", "slot": "north"},
		{"pos": [0, 5, 0], "semantic": "Mass", "slot": "north"},
	]})
	var reasons := {}
	for x in rej.get("rejected", []):
		reasons[str(x["reason"])] = true
	_check("taken slot → slot_taken", reasons.has("slot_taken"))
	_check("part into a whole block → native_block", reasons.has("native_block"))
	_check("part of a plain semantic → not_shaped", reasons.has("not_shaped"))
	var shaped_block := await _tool("cells_set", {"cells": [{"pos": [0, 9, 0], "semantic": "Glow"}]})
	_check("whole block of a shaped semantic → shaped_semantic_needs_part",
		(shaped_block.get("rejected", []) as Array).any(func(x: Dictionary) -> bool: return x["reason"] == "shaped_semantic_needs_part"))

	var roof := await _tool("parts_add", {"items": [{"pos": [0, -1, 3], "semantic": "Chamfer", "orient": {"up": "up", "facing": "south"}}],
		"symmetry": {"rotate4": {"center": [0, 0]}}})
	_check("architecture parts by orientation words, rotated", int(roof.get("placed", 0)) == 4)
	var west := data.get_cell(Vector3i(-3, -1, 0))
	_check("the west copy faces west", west != null and ArchShapes.slot_info("roof_tile", int(west.parts[0]["slot"]))["facing"] == "west")

	var dry := await _tool("region_fill", {"region": {"min": [5, 0, 5], "max": [7, 2, 7]}, "semantic": "Mass", "style": "hollow", "dry_run": true})
	_check("dry run reports without changing", int(dry["placed"]) == 26 and data.get_block(Vector3i(5, 0, 5)).is_empty())

	var cells_before := data.cells.size()
	var text := await _tool("region_text", {"region": {"all": true}})
	_check("region_text dumps layers", (text["layers"] as Array).size() == 4)
	var cleared := await _tool("cells_clear", {"region": {"all": true}})
	_check("cleared everything", data.cells.is_empty() and int(cleared["cleared"]) == cells_before)
	var legend: Dictionary = text["legend"]
	var back := await _tool("cells_place_layers", {"origin": text["origin"], "legend": legend, "layers": text["layers"]})
	_check("the dump places back to the same cells", not back["_is_error"] and data.cells.size() == cells_before and not back.has("rejected"))

	var undo := await _tool("history", {"action": "undo", "count": 2})
	_check("undo two steps (re-place, clear) restores the build", int(undo["undo_done"]) == 2 and data.cells.size() == cells_before)

	var big := await _tool("region_fill", {"region": {"min": [10, 0, 10], "max": [49, 0, 49]}, "semantic": "Core"})
	_check("a 1600-cell fill", int(big["placed"]) == 1600)
	var big_text := await _tool("region_text", {"region": {"min": [10, 0, 10], "max": [49, 0, 49]}})
	_check("a big response arrives whole", (big_text["layers"][0] as Array).size() == 40)

	var paste_src := await _tool("region_copy", {"region": {"min": [-3, -1, -3], "max": [3, 2, 3]}})
	_check("region_copy", int(paste_src["copied_cells"]) == cells_before)
	var pasted := await _tool("clipboard_paste", {"at": [20, 5, 20], "rotate": 1})
	_check("clipboard_paste", int(pasted["placed"]) == cells_before)

	# A 4x3 region (one even side, one odd): a quarter turn must stay a solid 3x4, not a
	# gapped 3x5 from rounding half-cell offsets.
	await _tool("region_fill", {"region": {"min": [60, 0, 60], "max": [63, 0, 62]}, "semantic": "Mass"})
	await _tool("region_copy", {"region": {"min": [60, 0, 60], "max": [63, 0, 62]}})
	await _tool("clipboard_paste", {"at": [70, 0, 60], "rotate": 1})
	var pst := await _tool("region_stats", {"region": {"min": [69, 0, 59], "max": [74, 0, 65]}})
	var pb: Array = pst["bounds"]
	_check("rotated paste of a 4x3 box is a solid 3x4 at `at`", int(pst["cells"]) == 12
		and int(pb[0][0]) == 70 and int(pb[0][2]) == 60 and int(pb[1][0]) == 72 and int(pb[1][2]) == 63)
	var turned := await _tool("region_transform", {"region": {"min": [60, 0, 60], "max": [63, 0, 62]}, "rotate": 1})
	_check("region_transform turns a 4x3 region", not turned["_is_error"] and int(turned["placed"]) == 12)
	var tst := await _tool("region_stats", {"region": {"min": [58, 0, 58], "max": [65, 0, 64]}})
	var tb: Array = tst["bounds"]
	_check("…into a solid 3x4 (no gap, no stretch)", int(tst["cells"]) == 12
		and int(tb[1][0]) - int(tb[0][0]) == 2 and int(tb[1][2]) - int(tb[0][2]) == 3)
	var bad_pivot := await _tool("region_transform", {"region": {"min": [60, 0, 60], "max": [63, 0, 62]}, "rotate": 1, "pivot": [61.5, 61]})
	_check("an explicit pivot that lands between cells is refused",
		bad_pivot["_is_error"] and str(bad_pivot.get("code", "")) == "bad_argument")

	var cut := await _tool("cutaway", {"region": {"min": [0, 3, 0], "max": [9, 1, 9]}})
	_check("cutaway sets the user's cut box", not cut["_is_error"] and cut["cutaway"] is Dictionary
		and int(cut["cutaway"]["min"][1]) == 1 and bool(cut["cutaway"]["enabled"]))
	var cut_off := await _tool("cutaway", {"enabled": false})
	_check("…switches it off", not cut_off["_is_error"] and not bool(cut_off["cutaway"]["enabled"])
		and VoxelWorld.cutaway_box().is_empty())
	var st_cut := await _tool("status", {})
	_check("…and status reports it", st_cut.get("cutaway") is Dictionary)
	var cut_clear := await _tool("cutaway", {"clear": true})
	_check("…and clears it", not cut_clear["_is_error"] and cut_clear["cutaway"] == null)
	var cut_none := await _tool("cutaway", {"enabled": true})
	_check("switching a missing cutaway is refused", cut_none["_is_error"] and str(cut_none.get("code", "")) == "no_cutaway")

	McpServer.paused = true
	var paused := await _tool("cells_set", {"semantic": "Mass", "positions": [[0, 20, 0]]})
	_check("paused → paused_by_user", paused["_is_error"] and str(paused.get("code", "")) == "paused_by_user")
	var look := await _tool("region_stats", {})
	_check("…but reading still works", not look["_is_error"])
	McpServer.paused = false

	var guard := await _tool("cells_set", {"project": "Other", "semantic": "Mass", "positions": [[0, 20, 0]]})
	_check("project guard", guard["_is_error"] and str(guard.get("code", "")) == "project_changed")

	var cap := await _tool("capture", {})
	_check("capture without a display says so", cap["_is_error"] and str(cap.get("code", "")) == "no_renderer")

	var save := await _tool("project_save", {"as": "MCP Test Saved"})
	_check("save as promotes the scratch project", not save["_is_error"] and not VoxelWorld.active_project.scratch)
	_check("…and writes it", FileAccess.file_exists(ProjectStore.ROOT.path_join("MCP Test Saved.tres")))

# --- Prefabs --------------------------------------------------------------------------

func _test_prefabs() -> void:
	print("-- prefabs through tools")
	await _tool("cells_clear", {"region": {"all": true}})
	await _tool("cells_set", {"cells": [
		{"pos": [0, 0, 0], "semantic": "Mass"}, {"pos": [1, 0, 0], "semantic": "Mass"},
		{"pos": [2, 0, 0], "semantic": "Mass"}, {"pos": [1, 1, 0], "semantic": "Core"}]})
	var saved := await _tool("prefab_save", {"name": "Bench", "region": {"min": [0, 0, 0], "max": [2, 1, 0]},
		"anchor": "bottom-center", "tags": ["furniture"]})
	_check("prefab_save", not saved["_is_error"] and int(saved["cells"]) == 4)
	_check("…bottom-center anchor", _ints(saved.get("anchor")) == [1, 0, 0])
	_check("…default palettes from the project's stack", saved.get("palettes") == ["Pillar Test"])
	_check("…written to the sandbox", PrefabStore.dir().begins_with(_sandbox) and FileAccess.file_exists(PrefabStore.path_for("Bench")))
	var dup := await _tool("prefab_save", {"name": "Bench", "region": {"min": [0, 0, 0], "max": [2, 1, 0]}})
	_check("saving over a name needs replace", dup["_is_error"] and str(dup.get("code", "")) == "name_taken")
	var top := await _tool("prefab_save", {"name": "Seat Only", "region": {"min": [0, 0, 0], "max": [2, 1, 0]},
		"exclude": ["Mass"], "trim": true, "anchor": "bottom-center"})
	_check("prefab_save exclude + trim", not top["_is_error"] and int(top["cells"]) == 1
		and _ints(top["size"]) == [1, 1, 1] and _ints(top["anchor"]) == [0, 0, 0])
	await _tool("prefab_delete", {"name": "Seat Only", "confirm": true})
	var listed := await _tool("prefab_list", {"query": "furn"})
	_check("prefab_list finds it by tag", (listed["prefabs"] as Array).size() == 1)

	# A quarter turn about the anchor, repeated three times along +X.
	var placed := await _tool("prefab_place", {"name": "Bench", "at": [10, 0, 0], "rotate": 1,
		"repeat": {"count": 3, "step": [5, 0, 0]}})
	_check("prefab_place with repeat", not placed["_is_error"] and int(placed["placed"]) == 12)
	_check("…as one undo step", str(placed.get("undo_step", "")) == "Claude: prefab_place")
	var data := VoxelWorld.active_project.data
	_check("the anchor lands on `at`", data.get_block(Vector3i(10, 1, 0)) == "Core" and data.get_block(Vector3i(20, 1, 0)) == "Core")
	_check("turned about the anchor (runs north-south now)",
		data.get_block(Vector3i(10, 0, -1)) == "Mass" and data.get_block(Vector3i(10, 0, 1)) == "Mass"
		and data.get_block(Vector3i(11, 0, 0)).is_empty())
	_check("nothing missing when the project maps it all", not placed.has("missing_semantics"))
	var kept := await _tool("prefab_place", {"name": "Bench", "at": [10, 0, 0], "rotate": 1})
	_check("keeps occupied cells unless overwrite", int(kept["placed"]) == 0 and int(kept.get("skipped", 0)) == 4)

	# A prefab whose semantic only its own palette defines.
	await _tool("palette_create", {"name": "Bench Pal", "entries": [{"semantic": "Seat", "block": "base"}]})
	await _tool("project_palettes_set", {"palettes": ["Pillar Test", "Bench Pal"]})
	await _tool("cells_set", {"cells": [{"pos": [0, 5, 0], "semantic": "Seat"}, {"pos": [1, 5, 0], "semantic": "Mass"}]})
	await _tool("prefab_save", {"name": "Seat Bench", "region": {"min": [0, 5, 0], "max": [1, 5, 0]}})
	await _tool("project_palettes_set", {"palettes": ["Pillar Test"]})
	var lacking := await _tool("prefab_place", {"name": "Seat Bench", "at": [30, 0, 0]})
	_check("placing still happens with a missing semantic", int(lacking.get("placed", 0)) == 2)
	_check("…and names it", lacking.get("missing_semantics") == ["Seat"] and lacking.get("palettes_available") == ["Bench Pal"])
	var filled := await _tool("prefab_place", {"name": "Seat Bench", "at": [30, 0, 3], "add_palettes": true})
	_check("add_palettes adds the palette to the bottom of the stack", filled.get("palettes_added") == ["Bench Pal"]
		and Array(VoxelWorld.active_project.palette_names) == ["Bench Pal", "Pillar Test"] and not filled.has("missing_semantics"))
	var remapped := await _tool("prefab_place", {"name": "Seat Bench", "at": [30, 0, 6], "remap": {"Seat": "Core"}})
	_check("remap renames on the way in", data.get_block(Vector3i(30, 0, 6)) == "Core" and not remapped.has("missing_semantics"))

	var got := await _tool("prefab_get", {"name": "Seat Bench"})
	_check("prefab_get lists semantics", (got["semantics"] as Dictionary).has("Seat") and (got["semantics"] as Dictionary).has("Mass"))
	var upd := await _tool("prefab_update", {"name": "Seat Bench", "rename": "Seat Bench 2", "anchor": [1, 0, 0], "notes": "two cells"})
	_check("prefab_update renames and re-anchors", not upd["_is_error"] and upd["name"] == "Seat Bench 2" and _ints(upd["anchor"]) == [1, 0, 0])
	var home := VoxelWorld.active_project
	var opened := await _tool("prefab_open", {"name": "Seat Bench 2"})
	_check("prefab_open opens it as the project", not opened["_is_error"] and VoxelWorld.active_project.editing_prefab != null)
	var st_pf := await _tool("status")
	_check("…and status says so", bool(st_pf["project"].get("editing_prefab", false)))
	await _tool("cells_set", {"cells": [{"pos": [0, 1, 0], "semantic": "Core"}]})
	var saved_back := await _tool("project_save", {})
	_check("project_save writes the edit back into the prefab", not saved_back["_is_error"]
		and VoxelWorld.workspace.get_prefab("Seat Bench 2").cell_count() == 3)
	VoxelWorld.open(home)
	var render := await _tool("prefab_render", {"name": "Bench"})
	_check("prefab_render without a display says so", render["_is_error"] and str(render.get("code", "")) == "no_renderer")
	var no_confirm := await _tool("prefab_delete", {"name": "Bench", "confirm": false})
	_check("delete needs confirm", no_confirm["_is_error"] and str(no_confirm.get("code", "")) == "needs_confirm")
	var deleted := await _tool("prefab_delete", {"name": "Bench", "confirm": true})
	_check("prefab_delete", not deleted["_is_error"] and VoxelWorld.workspace.get_prefab("Bench") == null
		and not FileAccess.file_exists(PrefabStore.path_for("Bench")))
	_check("placed copies stay", data.get_block(Vector3i(10, 1, 0)) == "Core")

func _test_nei_roster_import_tool() -> void:
	print("-- nei_roster_import over MCP")
	var saved_root := AssetLibrary.ROOT
	AssetLibrary.ROOT = "user://__voxyl_mcpnei_lib__"
	var src := "user://__voxyl_mcpnei_src__"
	var dumps := "user://__voxyl_mcpnei_dumps__"
	_rm_rf(AssetLibrary.ROOT)
	_rm_rf(src)
	_rm_rf(dumps)
	var blocks := src + "/assets/testmod/textures/blocks"
	DirAccess.make_dir_recursive_absolute(blocks)
	var img := Image.create_empty(16, 16, false, Image.FORMAT_RGBA8)
	img.fill(Color(0.3, 0.7, 0.4))
	img.save_png(blocks + "/widget.png")
	DirAccess.make_dir_recursive_absolute(dumps)
	var item_f := FileAccess.open(dumps + "/item.csv", FileAccess.WRITE)
	item_f.store_string("\n".join([
		"Name,ID,Has Block,Mod,Class,Display Name",
		"testmod:widget,400,true,TestMod,some.Class,Widget",
		"testmod:machine,401,true,TestMod,some.Class,Machine",
	]))
	item_f.close()
	var panel_f := FileAccess.open(dumps + "/itempanel.csv", FileAccess.WRITE)
	panel_f.store_string("\n".join([
		"Item Name,Item ID,Item meta,Has NBT,Display Name",
		"testmod:widget,400,0,false,Widget",
		"testmod:machine,401,0,false,Machine",
	]))
	panel_f.close()

	var browse := await _tool("nei_roster_import",
		{"dumps_path": dumps, "asset_paths": [src], "library": "mcpnei"})
	_check("no mods/all → browse only, nothing imported",
		not browse["_is_error"] and browse.get("dry_run", false) == true
		and int(browse.get("total", 0)) == 2)

	var bad_lib := await _tool("nei_roster_import",
		{"dumps_path": dumps, "asset_paths": [src], "library": VoxelWorkspace.BASIC_LIBRARY, "all": true})
	_check("refuses to target the built-in library", bad_lib["_is_error"])

	var imported := await _tool("nei_roster_import",
		{"dumps_path": dumps, "asset_paths": [src], "library": "mcpnei", "all": true})
	_check("all:true imports the whole roster",
		not imported["_is_error"] and int(imported.get("imported", 0)) == 2)
	_check("libraries_touched names the target library",
		Array(imported.get("libraries_touched", [])).has("mcpnei"))

	var got := await _tool("block_get", {"name": "Widget", "library": "mcpnei"})
	_check("block_get surfaces confirmed mc identity",
		not got["_is_error"] and got.get("mc_registry", "") == "testmod:widget"
		and got.get("mc_confirmed", false) == true)
	var machine := await _tool("block_get", {"name": "Machine", "library": "mcpnei"})
	_check("textureless entry still imported, correctly identified",
		not machine["_is_error"] and machine.get("mc_registry", "") == "testmod:machine"
		and str(machine.get("model", "")).is_empty())

	_rm_rf("user://__voxyl_mcpnei_lib__")
	_rm_rf(src)
	_rm_rf(dumps)
	AssetLibrary.ROOT = saved_root

func _rm_rf(path: String) -> void:
	var d := DirAccess.open(path)
	if d == null:
		return
	d.include_hidden = true
	for sub in d.get_directories():
		_rm_rf(path.path_join(sub))
	for f in d.get_files():
		d.remove(f)
	DirAccess.remove_absolute(path)

# JSON numbers come back as floats; compare vectors as ints.
func _ints(v: Variant) -> Array:
	return (v as Array).map(func(x: Variant) -> int: return int(x)) if v is Array else []
