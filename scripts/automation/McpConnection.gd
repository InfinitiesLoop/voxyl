class_name McpConnection
extends RefCounted

# One keep-alive HTTP/1.1 connection to the MCP server: buffers what's arrived, cuts out one
# request at a time (Content-Length bodies only), and drains responses a chunk per frame so
# a multi-megabyte image never blocks the app.

var peer: StreamPeerTCP
var busy := false               # a request from this connection is being handled
var close_after_write := false
var last_activity_ms := 0

var _in := PackedByteArray()
var _out := PackedByteArray()
var _out_pos := 0

func _init(p: StreamPeerTCP) -> void:
	peer = p
	peer.set_no_delay(true)
	last_activity_ms = Time.get_ticks_msec()

# Pull whatever bytes are waiting. False once the peer is gone.
func read_available() -> bool:
	var n := peer.get_available_bytes()
	if n > 0:
		var r := peer.get_partial_data(n)
		if int(r[0]) != OK:
			return false
		_in.append_array(r[1])
		last_activity_ms = Time.get_ticks_msec()
	return true

# One complete request from the buffer: { method, path, headers (lower-case keys), body },
# or { error: http_status, message } for one we won't serve, or {} if more bytes are needed.
func take_request(max_header: int, max_body: int) -> Dictionary:
	var end := _find_header_end()
	if end < 0:
		if _in.size() > max_header:
			_in = PackedByteArray()
			return {"error": 431, "message": "headers too large"}
		return {}
	var head := _in.slice(0, end).get_string_from_utf8()
	var lines := head.split("\r\n")
	var first := lines[0].split(" ")
	if first.size() < 2:
		_in = PackedByteArray()
		return {"error": 400, "message": "bad request line"}
	var headers := {}
	for i in range(1, lines.size()):
		var colon := lines[i].find(":")
		if colon > 0:
			headers[lines[i].substr(0, colon).strip_edges().to_lower()] = lines[i].substr(colon + 1).strip_edges()
	if str(headers.get("transfer-encoding", "")).to_lower().contains("chunked"):
		_in = PackedByteArray()
		return {"error": 501, "message": "chunked request bodies aren't supported; send Content-Length"}
	var length := int(headers.get("content-length", "0"))
	if length > max_body:
		_in = PackedByteArray()
		return {"error": 413, "message": "request body too large"}
	var body_start := end + 4
	if _in.size() < body_start + length:
		return {}
	var body := _in.slice(body_start, body_start + length)
	_in = _in.slice(body_start + length)
	return {"method": first[0].to_upper(), "path": first[1], "headers": headers, "body": body}

func _find_header_end() -> int:
	for i in range(0, _in.size() - 3):
		if _in[i] == 13 and _in[i + 1] == 10 and _in[i + 2] == 13 and _in[i + 3] == 10:
			return i
	return -1

func queue_output(bytes: PackedByteArray) -> void:
	_out.append_array(bytes)

func has_output() -> bool:
	return _out_pos < _out.size()

# Write up to `max_bytes` of pending output (whatever the socket takes right now).
func flush(max_bytes: int) -> void:
	if not has_output():
		return
	var chunk := _out.slice(_out_pos, mini(_out.size(), _out_pos + max_bytes))
	var r := peer.put_partial_data(chunk)
	if int(r[0]) == OK:
		_out_pos += int(r[1])
		last_activity_ms = Time.get_ticks_msec()
	if not has_output():
		_out = PackedByteArray()
		_out_pos = 0
