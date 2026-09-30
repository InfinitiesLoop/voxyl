@tool
extends EditorDebuggerPlugin

# The editor half of Voxyl's `restart` tool (the game half is scripts/automation/EditorBridge.gd).
#
# How the two talk: when the editor runs the game it opens a debugger connection to it, and
# Godot lets both ends send named messages down it. A message is "prefix:name" plus an Array of
# data. The game sends with EngineDebugger.send_message(); this plugin receives it in _capture()
# and can answer with send_message() on the session it came from. Only messages whose prefix we
# claim in _has_capture() are routed here. Ours is "voxyl":
#
#   game -> editor   voxyl:ping      "is this plugin loaded?"    (answered with voxyl:pong)
#   game -> editor   voxyl:restart   "stop me and run me again"

const PREFIX := "voxyl"
# Give up waiting for the editor to finish a step after this long.
const STEP_TIMEOUT_MS := 20000

var _restarting := false

func _has_capture(prefix: String) -> bool:
	return prefix == PREFIX

# Here `message` still carries the prefix ("voxyl:ping"); on the game side it doesn't.
func _capture(message: String, _data: Array, session_id: int) -> bool:
	match message:
		"voxyl:ping":
			get_session(session_id).send_message("voxyl:pong", [])
			return true
		"voxyl:restart":
			if not _restarting:
				_restart()   # a coroutine: runs until its first await, then carries on by itself
			return true
	return false   # not ours after all

func _restart() -> void:
	_restarting = true
	# Remember what was running, so a restart re-runs the same scene (F5 or F6 alike).
	var scene := EditorInterface.get_playing_scene()

	# Pick up what changed on disk. The editor normally only looks when its window regains
	# focus, so without this a new script or class_name added while you were away would be
	# missing from the restarted game.
	var fs := EditorInterface.get_resource_filesystem()
	fs.scan()
	await _wait_until(func() -> bool: return not fs.is_scanning())

	EditorInterface.stop_playing_scene()
	await _wait_until(func() -> bool: return not EditorInterface.is_playing_scene())

	if scene.is_empty():
		EditorInterface.play_main_scene()
	else:
		EditorInterface.play_custom_scene(scene)
	_restarting = false

# Poll once a frame until `done` is true or a step times out.
func _wait_until(done: Callable) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var start := Time.get_ticks_msec()
	while not done.call() and Time.get_ticks_msec() - start < STEP_TIMEOUT_MS:
		await tree.process_frame
