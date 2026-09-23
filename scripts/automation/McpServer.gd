extends Node

# Voxyl as an MCP server (autoload "McpServer"). Agents connect over MCP's Streamable HTTP
# transport — JSON-RPC 2.0 in HTTP POSTs to one endpoint, answered with plain JSON — straight
# to this running app, so an agent edits the same in-memory project the user is looking at
# and every change shows up live. Nothing to install: this file, a TCPServer and the JSON
# class are the whole server. See .plans/voxyl-mcp.md.
#
# The server is a client of VoxelWorld like any view: tool handlers (McpRegistry +
# scripts/automation/tools/) only translate requests into VoxelWorld calls, so the same
# signals, undo steps and rules apply as for the user's own clicks.
#
# Off by default. AppSettings holds enabled / port / token; the Settings dialog edits them
# and calls restart(). Binds 127.0.0.1 only, rejects non-local Origins (DNS rebinding), and
# requires the bearer token unless the user turned that off.

signal status_changed()
# A tool call started / finished (the editor bar's presence badge).
signal call_started(tool_name: String)
signal call_finished(tool_name: String)

const PROTOCOL_VERSIONS := ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
const MAX_BODY := 16 * 1024 * 1024
const MAX_HEADER := 64 * 1024
const IDLE_TIMEOUT_MS := 120000
const WRITE_CHUNK := 256 * 1024
# How long a mutating call waits for the user to finish what they're doing (a paint drag).
const WAIT_FOR_USER_MS := 15000

var registry: McpRegistry
var capture: Node   # CaptureService, created on first use (see capture_service())

var paused := false:
	set(v):
		paused = v
		status_changed.emit()

var _server: TCPServer
var _conns: Array[McpConnection] = []
var _port := 0
var _error := ""
var _last_call_ms := 0
var _calls_in_flight := 0
var _sessions := {}
var _log_lines: Array = []

func _ready() -> void:
	registry = McpRegistry.new()
	registry.register_all()
	_auto_start.call_deferred()

# Listen per the settings, but only when the app itself is running (the main scene): test
# scenes and tools that boot the project start the server themselves if they want it.
func _auto_start() -> void:
	var main := str(ProjectSettings.get_setting("application/run/main_scene", ""))
	var scene := get_tree().current_scene
	if scene != null and scene.scene_file_path == main:
		restart()

func _exit_tree() -> void:
	stop()

# (Re)start from the current settings: listen when enabled, stop otherwise.
func restart() -> void:
	stop()
	if not AppSettings.agent_enabled():
		status_changed.emit()
		return
	_port = AppSettings.agent_port()
	_server = TCPServer.new()
	var err := _server.listen(_port, "127.0.0.1")
	if err != OK:
		_server = null
		_error = "Port %d is in use — choose another" % _port if err == ERR_ALREADY_IN_USE \
			else "Can't listen on port %d (error %d)" % [_port, err]
	else:
		_error = ""
	status_changed.emit()

func stop() -> void:
	for c in _conns:
		c.peer.disconnect_from_host()
	_conns.clear()
	if _server != null:
		_server.stop()
		_server = null
	_error = ""

func is_listening() -> bool:
	return _server != null and _server.is_listening()

func port() -> int:
	return _port

# One line for the Settings dialog / editor bar.
func status_text() -> String:
	if not AppSettings.agent_enabled():
		return "Agent connections are off"
	if not _error.is_empty():
		return _error
	if not is_listening():
		return "Not listening"
	var s := "Listening on 127.0.0.1:%d · %d connection%s" % [_port, _conns.size(), "" if _conns.size() == 1 else "s"]
	if _last_call_ms > 0:
		s += " · last call %ds ago" % int((Time.get_ticks_msec() - _last_call_ms) / 1000.0)
	if paused:
		s += " · paused"
	return s

func is_busy() -> bool:
	return _calls_in_flight > 0

# The offscreen renderer for captures, created on first use.
func capture_service() -> Node:
	if capture == null:
		capture = CaptureService.new()
		add_child(capture)
	return capture

# ---------------------------------------------------------------------------
# Connection pump — everything is polled from _process, never blocking a frame.
# ---------------------------------------------------------------------------

func _process(_delta: float) -> void:
	if _server == null:
		return
	while _server.is_connection_available():
		var c := McpConnection.new(_server.take_connection())
		_conns.append(c)
	var now := Time.get_ticks_msec()
	var live: Array[McpConnection] = []
	for c in _conns:
		c.peer.poll()
		var st := c.peer.get_status()
		if st == StreamPeerTCP.STATUS_ERROR or st == StreamPeerTCP.STATUS_NONE:
			continue
		if c.has_output():
			c.flush(WRITE_CHUNK)
			if not c.has_output() and c.close_after_write:
				c.peer.disconnect_from_host()
				continue
		elif not c.busy:
			if not c.read_available():
				continue
			var req := c.take_request(MAX_HEADER, MAX_BODY)
			if not req.is_empty():
				c.busy = true
				c.last_activity_ms = now
				_handle_http(c, req)
			elif now - c.last_activity_ms > IDLE_TIMEOUT_MS:
				c.peer.disconnect_from_host()
				continue
		live.append(c)
	_conns = live

# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------

func _handle_http(c: McpConnection, req: Dictionary) -> void:
	if req.has("error"):
		_respond(c, int(req["error"]), {"error": str(req.get("message", ""))}, {}, true)
		return
	var headers: Dictionary = req["headers"]
	var path := str(req["path"]).get_slice("?", 0)
	if path != "/mcp" and path != "/mcp/":
		_respond(c, 404, {"error": "not found; the MCP endpoint is /mcp"})
		return
	var origin := str(headers.get("origin", ""))
	if not origin.is_empty() and not _is_local_origin(origin):
		_respond(c, 403, {"error": "origin not allowed"})
		return
	if AppSettings.agent_require_token():
		var auth := str(headers.get("authorization", ""))
		if auth != "Bearer " + AppSettings.agent_token():
			_respond(c, 401, {"error": "missing or wrong access token (see Voxyl → Settings → Agent connections)"})
			return
	match str(req["method"]):
		"POST":
			pass
		"GET":
			_respond(c, 405, {"error": "this server has no event stream; POST JSON-RPC to /mcp"}, {"Allow": "POST, DELETE"})
			return
		"DELETE":
			_sessions.erase(str(headers.get("mcp-session-id", "")))
			_respond(c, 200, {})
			return
		_:
			_respond(c, 405, {"error": "method not allowed"}, {"Allow": "POST, DELETE"})
			return
	var parsed: Variant = JSON.parse_string((req["body"] as PackedByteArray).get_string_from_utf8())
	if parsed == null:
		_respond(c, 400, _rpc_error(null, -32700, "parse error"))
		return
	var extra := {}
	var batch: Array = parsed if parsed is Array else [parsed]
	var replies: Array = []
	for msg in batch:
		if not (msg is Dictionary):
			replies.append(_rpc_error(null, -32600, "invalid request"))
			continue
		if not msg.has("method"):
			continue   # a response from the client; we never ask it anything
		var reply: Variant = await _handle_rpc(msg, headers, extra)
		if msg.has("id") and reply != null:
			replies.append(reply)
	if replies.is_empty():
		_respond(c, 202, null, extra)
	elif parsed is Array:
		_respond(c, 200, replies, extra)
	else:
		_respond(c, 200, replies[0], extra)

func _is_local_origin(origin: String) -> bool:
	var host := origin.get_slice("://", 1).get_slice("/", 0)
	if host.begins_with("["):
		host = host.get_slice("]", 0).substr(1)
	else:
		host = host.get_slice(":", 0)
	return host in ["localhost", "127.0.0.1", "::1"]

func _respond(c: McpConnection, code: int, body: Variant, extra_headers := {}, close := false) -> void:
	var payload := PackedByteArray()
	var head := "HTTP/1.1 %d %s\r\n" % [code, _reason(code)]
	if body != null:
		payload = JSON.stringify(body).to_utf8_buffer()
		head += "Content-Type: application/json\r\n"
	head += "Content-Length: %d\r\n" % payload.size()
	for k in extra_headers:
		head += "%s: %s\r\n" % [k, extra_headers[k]]
	head += "Connection: %s\r\n\r\n" % ("close" if close else "keep-alive")
	var out := head.to_utf8_buffer()
	out.append_array(payload)
	c.queue_output(out)
	c.close_after_write = close
	c.busy = false
	c.last_activity_ms = Time.get_ticks_msec()

func _reason(code: int) -> String:
	return {200: "OK", 202: "Accepted", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
		404: "Not Found", 405: "Method Not Allowed", 411: "Length Required", 413: "Payload Too Large",
		431: "Request Header Fields Too Large", 501: "Not Implemented"}.get(code, "Status")

# ---------------------------------------------------------------------------
# JSON-RPC / MCP layer
# ---------------------------------------------------------------------------

func _handle_rpc(msg: Dictionary, _headers: Dictionary, extra: Dictionary) -> Variant:
	var id: Variant = msg.get("id")
	var params: Dictionary = msg.get("params", {}) if msg.get("params") is Dictionary else {}
	match str(msg["method"]):
		"initialize":
			var asked := str(params.get("protocolVersion", ""))
			var version: String = asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
			var sid := Crypto.new().generate_random_bytes(16).hex_encode()
			_sessions[sid] = {"client": params.get("clientInfo", {}), "version": version}
			extra["Mcp-Session-Id"] = sid
			return _rpc_result(id, {
				"protocolVersion": version,
				"capabilities": {"tools": {"listChanged": false}, "resources": {"listChanged": false}},
				"serverInfo": {"name": "voxyl", "title": "Voxyl", "version": _app_version()},
				"instructions": McpConventions.INSTRUCTIONS,
			})
		"notifications/initialized", "notifications/cancelled":
			return null
		"ping":
			return _rpc_result(id, {})
		"tools/list":
			return _rpc_result(id, {"tools": registry.list_tools()})
		"tools/call":
			return _rpc_result(id, await _call_tool(str(params.get("name", "")), params.get("arguments", {})))
		"resources/list":
			return _rpc_result(id, {"resources": McpConventions.resources()})
		"resources/templates/list":
			return _rpc_result(id, {"resourceTemplates": []})
		"resources/read":
			var r := McpConventions.read(str(params.get("uri", "")))
			if r.is_empty():
				return _rpc_error(id, -32002, "resource not found")
			return _rpc_result(id, {"contents": [r]})
		"prompts/list":
			return _rpc_result(id, {"prompts": []})
	if msg.has("id"):
		return _rpc_error(id, -32601, "method not found: %s" % msg["method"])
	return null

func _rpc_result(id: Variant, result: Variant) -> Dictionary:
	return {"jsonrpc": "2.0", "id": id, "result": result}

func _rpc_error(id: Variant, code: int, message: String) -> Dictionary:
	return {"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}

func _app_version() -> String:
	return str(ProjectSettings.get_setting("application/config/version", "dev"))

# Run one tool: pause / busy-user checks for mutating tools, then the handler, then the
# result as MCP content (a JSON text block, plus any images).
func _call_tool(tool_name: String, args_v: Variant) -> Dictionary:
	var tool := registry.get_tool(tool_name)
	if tool.is_empty():
		return _tool_error({"code": "unknown_tool", "message": "no tool named '%s'" % tool_name})
	var args: Dictionary = args_v if args_v is Dictionary else {}
	_last_call_ms = Time.get_ticks_msec()
	if tool.get("mutates", false):
		if paused:
			return _tool_error({"code": "paused_by_user", "message": "the user paused agent edits in Voxyl; ask them to resume"})
		var waited := 0
		while VoxelWorld.is_mid_operation() and waited < WAIT_FOR_USER_MS:
			await get_tree().process_frame
			waited = Time.get_ticks_msec() - _last_call_ms
		if VoxelWorld.is_mid_operation():
			return _tool_error({"code": "user_busy", "message": "the user is in the middle of an edit; try again shortly"})
	_calls_in_flight += 1
	call_started.emit(tool_name)
	var result: Variant = await (tool["handler"] as Callable).call(args)
	_calls_in_flight -= 1
	call_finished.emit(tool_name)
	_log("%s %s" % [tool_name, "error" if (result is Dictionary and result.has(McpRegistry.ERROR_KEY)) else "ok"])
	if not (result is Dictionary):
		result = {"result": result}
	if result.has(McpRegistry.ERROR_KEY):
		return _tool_error(result[McpRegistry.ERROR_KEY])
	var content: Array = []
	var images: Array = result.get(McpRegistry.IMAGES_KEY, [])
	result.erase(McpRegistry.IMAGES_KEY)
	content.append({"type": "text", "text": JSON.stringify(McpRegistry.to_json(result))})
	for img in images:
		content.append(img)
	return {"content": content, "isError": false}

func _tool_error(err: Dictionary) -> Dictionary:
	return {"content": [{"type": "text", "text": JSON.stringify(McpRegistry.to_json(err))}], "isError": true}

func _log(line: String) -> void:
	_log_lines.append("%s %s" % [Time.get_time_string_from_system(), line])
	if _log_lines.size() > 200:
		_log_lines.pop_front()

func recent_calls() -> Array:
	return _log_lines.duplicate()
