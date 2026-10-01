class_name AgentSetup
extends RefCounted

# How to connect each supported AI agent to Voxyl's MCP server (see McpServer): one guide per
# tab under Settings → Agent connections. A guide is plain data, so supporting another agent is
# one more entry in guides() — SettingsDialog builds its tab from these fields:
#   title    the tab's name
#   intro    what this agent needs, shown at the top of the tab
#   label    what the snippet is, shown above it
#   snippet  the text to copy (a command or a config entry) with this run's port and token
#   copy     the copy button's text
#   after    what to do next, shown small under the button
# Port, token and whether one is required come from AppSettings, so the dialog calls guides()
# again whenever they change.

static func guides() -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	out.append(_claude_code())
	out.append(_codex())
	return out

# The MCP endpoint every agent is pointed at.
static func endpoint() -> String:
	return "http://127.0.0.1:%d/mcp" % AppSettings.agent_port()

# The command that registers Voxyl with Claude Code.
static func claude_command() -> String:
	var cmd := "claude mcp add --scope user --transport http voxyl %s" % endpoint()
	if AppSettings.agent_require_token():
		cmd += " --header \"Authorization: Bearer %s\"" % AppSettings.agent_token()
	return cmd

# The entry that registers Voxyl in Codex's config file. Codex reads the token from a static
# header here (its `bearer_token_env_var` option would also need an environment variable set
# before Codex starts).
static func codex_config() -> String:
	var toml := "[mcp_servers.voxyl]\nurl = \"%s\"" % endpoint()
	if AppSettings.agent_require_token():
		toml += "\nhttp_headers = { Authorization = \"Bearer %s\" }" % AppSettings.agent_token()
	return toml

# Where Codex's config file lives (the same on every OS, under the user's home folder).
static func codex_config_path() -> String:
	var windows := OS.get_name() == "Windows"
	var home := OS.get_environment("USERPROFILE" if windows else "HOME")
	if home.is_empty():
		return "~/.codex/config.toml"
	var path := home.path_join(".codex/config.toml")
	return path.replace("/", "\\") if windows else path

static func _claude_code() -> Dictionary:
	return {
		"title": "Claude Code",
		"intro": "Claude Code connects straight to this window. Register Voxyl with it once, then start a new Claude Code session.",
		"label": "Set up Claude Code (run once in a terminal):",
		"snippet": claude_command(),
		"copy": "Copy setup command",
		"after": "Start Voxyl before your agent session, or reconnect from the agent (in Claude Code: /mcp → reconnect) after Voxyl starts.",
	}

# Codex is OpenAI's coding agent, included with every ChatGPT plan; the ChatGPT desktop app's
# Codex mode, the terminal app and the editor extension all read one config file. (ChatGPT's
# chat window can't be used instead: it only reaches MCP servers on the public internet, and
# its connector form offers OAuth or no authentication, not a bearer token.)
static func _codex() -> Dictionary:
	return {
		"title": "Codex",
		"intro": "Codex is OpenAI's coding agent, included with your ChatGPT plan. The ChatGPT desktop app, Codex's terminal app and its editor extension all read the same config file, so Voxyl only needs adding once.",
		"label": "Add this to Codex's config file, %s (create it if it isn't there):" % codex_config_path(),
		"snippet": codex_config(),
		"copy": "Copy config entry",
		"after": "Restart Codex, then check that voxyl is listed: under Settings → MCP servers in the desktop app, or by typing /mcp in the terminal app. Start Voxyl before your Codex session.",
	}
