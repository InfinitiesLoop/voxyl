extends RefCounted

# The game half of the `restart` tool: asking the Godot editor that launched Voxyl to restart it.
# The editor half is the addons/voxyl_dev plugin; its restart_bridge.gd explains the protocol.
#
# EngineDebugger is how a running game talks to the editor's debugger connection. It is only
# active when the editor (or --remote-debug) started us; an exported build has no one to talk to.

const PREFIX := "voxyl"
const PING_TIMEOUT_MS := 1500
# How long to let the tool's reply go out before asking the editor to kill us.
const REPLY_WAIT_MS := 2000

static var _ponged := false

# Did an editor start us?
static func attached() -> bool:
	return EngineDebugger.is_active()

# Is the dev plugin loaded in that editor? Ask, and wait a moment for the answer (a coroutine).
static func ping() -> bool:
	if not attached():
		return false
	# Messages coming back with our prefix are routed to _on_message — registered once.
	if not EngineDebugger.has_capture(PREFIX):
		EngineDebugger.register_message_capture(PREFIX, _on_message)
	_ponged = false
	EngineDebugger.send_message("%s:ping" % PREFIX, [])
	var tree := Engine.get_main_loop() as SceneTree
	var start := Time.get_ticks_msec()
	while not _ponged and Time.get_ticks_msec() - start < PING_TIMEOUT_MS:
		await tree.process_frame
	return _ponged

# Replies from the editor. Unlike on the editor side, `message` arrives without the prefix.
static func _on_message(message: String, _data: Array) -> bool:
	if message == "pong":
		_ponged = true
		return true
	return false

# Ask the editor to restart us — but only after the reply to the call that's asking has gone
# out, because the editor kills this process. Call it without awaiting: it returns at its first
# await and finishes on its own.
static func restart_soon() -> void:
	var tree := Engine.get_main_loop() as SceneTree
	await tree.process_frame   # the tool returns, and its reply is queued, meanwhile
	var start := Time.get_ticks_msec()
	while McpServer.has_unsent_replies() and Time.get_ticks_msec() - start < REPLY_WAIT_MS:
		await tree.process_frame
	await tree.create_timer(0.3).timeout   # the OS still has to put the bytes on the wire
	EngineDebugger.send_message("%s:restart" % PREFIX, [])
