@tool
extends EditorPlugin

# Editor-only helper for working on Voxyl; nothing here ships with the app (an export should
# leave out res://addons/voxyl_dev). It lives in the editor process, which outlives every run of
# the game, so it can do what the game can't: stop it and start it again.
#
# The plugin itself is only the wiring. The messages are handled by restart_bridge.gd, an
# EditorDebuggerPlugin, which Godot hands every message the running game sends up its debugger
# connection.

const RestartBridge := preload("res://addons/voxyl_dev/restart_bridge.gd")

var _bridge: EditorDebuggerPlugin

func _enter_tree() -> void:
	_bridge = RestartBridge.new()
	add_debugger_plugin(_bridge)

func _exit_tree() -> void:
	remove_debugger_plugin(_bridge)
	_bridge = null
