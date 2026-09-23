class_name AppSettings
extends RefCounted

# App configuration (not project data, not the material layer): a ConfigFile at
# user://settings.cfg. Today it only holds the agent-connection settings; anything that's a
# preference of the app rather than of a build belongs here.
#
# Command-line overrides (after Godot's `--` separator), for scripted runs and tests:
#   --mcp-port=N        enable agent connections on port N for this run (not saved)
#   --mcp-token=T       use access token T for this run (not saved)
#   --sandbox=DIR       keep projects, palettes, captures and settings under DIR instead of
#                       the real workspace (libraries are still read from the shared folder)

const SECTION_AGENT := "agent"
const DEFAULT_PORT := 47823

static var path := "user://settings.cfg"
static var _cfg: ConfigFile
# Per-run overrides from the command line; never written to disk.
static var _overrides := {}
# Where agent captures are written (user://captures, or under the sandbox).
static var captures_dir := "user://captures"
static var _cli_applied := false

static func _config() -> ConfigFile:
	if _cfg == null:
		_cfg = ConfigFile.new()
		_cfg.load(path)   # a missing file just means defaults
	return _cfg

static func get_value(section: String, key: String, default: Variant = null) -> Variant:
	var k := "%s/%s" % [section, key]
	if _overrides.has(k):
		return _overrides[k]
	return _config().get_value(section, key, default)

static func set_value(section: String, key: String, value: Variant) -> void:
	_overrides.erase("%s/%s" % [section, key])
	_config().set_value(section, key, value)
	_config().save(path)

# Drop the cached file (tests repoint `path`).
static func reload() -> void:
	_cfg = null

# --- Agent connections -------------------------------------------------------------

static func agent_enabled() -> bool:
	return bool(get_value(SECTION_AGENT, "enabled", false))

static func agent_port() -> int:
	return int(get_value(SECTION_AGENT, "port", DEFAULT_PORT))

static func agent_require_token() -> bool:
	return bool(get_value(SECTION_AGENT, "require_token", true))

# The access token, generated on first use.
static func agent_token() -> String:
	var t := str(get_value(SECTION_AGENT, "token", ""))
	if t.is_empty():
		t = regenerate_token()
	return t

static func regenerate_token() -> String:
	var t := Crypto.new().generate_random_bytes(18).hex_encode()
	set_value(SECTION_AGENT, "token", t)
	return t

# The command that registers Voxyl with Claude Code.
static func setup_command() -> String:
	var cmd := "claude mcp add --transport http voxyl http://127.0.0.1:%d/mcp" % agent_port()
	if agent_require_token():
		cmd += " --header \"Authorization: Bearer %s\"" % agent_token()
	return cmd

# --- Command line ------------------------------------------------------------------

# Apply the command-line overrides above. Called first thing by VoxelWorld (before anything
# is loaded) so a sandbox takes effect for the whole run. Idempotent.
static func apply_command_line() -> void:
	if _cli_applied:
		return
	_cli_applied = true
	for arg in OS.get_cmdline_user_args():
		var kv := arg.split("=", true, 1)
		var val := kv[1] if kv.size() > 1 else ""
		match kv[0]:
			"--mcp-port":
				_overrides["%s/enabled" % SECTION_AGENT] = true
				_overrides["%s/port" % SECTION_AGENT] = int(val)
			"--mcp-token":
				_overrides["%s/token" % SECTION_AGENT] = val
				_overrides["%s/require_token" % SECTION_AGENT] = not val.is_empty()
			"--sandbox":
				use_sandbox(val)

# Keep everything this run writes under `dir` (see the header).
static func use_sandbox(dir: String) -> void:
	var d := dir.replace("\\", "/")
	DirAccess.make_dir_recursive_absolute(d)
	ProjectStore.ROOT = d.path_join("projects")
	LibraryStore.palettes_root = d.path_join("palettes")
	captures_dir = d.path_join("captures")
	path = d.path_join("settings.cfg")
	_cfg = null
