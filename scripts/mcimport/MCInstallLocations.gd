class_name MCInstallLocations
extends RefCounted

# Where Minecraft installs commonly live, per launcher and platform — used to seed
# the import file pickers so a user doesn't have to remember that vanilla blocks hide
# in a version `.jar` while modded blocks sit in an instance's `mods/`. Pure path
# construction from the user's home / appdata environment; nothing is read or written.
#
# Each entry is { label, path, picker, exists } where `picker` is "file" (a `.jar` /
# `.zip` — a version jar or resource pack) or "dir" (a folder — an instance, its
# `mods/`, or an unzipped assets tree). Only the running platform's entries are built,
# but Windows, macOS and a Linux fallback are all encoded so the help travels.

# Candidate locations for the current OS, most useful first.
static func candidates() -> Array:
	match OS.get_name():
		"Windows": return _windows()
		"macOS": return _macos()
		_: return _linux()

static func _entry(label: String, path: String, picker: String) -> Dictionary:
	var norm := path.replace("\\", "/")
	return {"label": label, "path": norm, "picker": picker,
		"exists": DirAccess.dir_exists_absolute(norm)}

static func _windows() -> Array:
	var appdata := OS.get_environment("APPDATA").replace("\\", "/")          # …/AppData/Roaming
	var home := OS.get_environment("USERPROFILE").replace("\\", "/")         # C:/Users/<user>
	return [
		_entry("Vanilla — version jars (pick a .jar for vanilla blocks)",
			appdata.path_join(".minecraft/versions"), "file"),
		_entry("Vanilla — resource packs (pick a .zip)",
			appdata.path_join(".minecraft/resourcepacks"), "file"),
		_entry("CurseForge — instances (open an instance's mods folder)",
			home.path_join("curseforge/minecraft/Instances"), "dir"),
		_entry("CurseForge — vanilla version jars",
			home.path_join("curseforge/minecraft/Install/versions"), "file"),
		_entry("Prism — instances (open <instance>/.minecraft/mods)",
			appdata.path_join("PrismLauncher/instances"), "dir"),
	]

static func _macos() -> Array:
	var home := OS.get_environment("HOME")
	var support := home.path_join("Library/Application Support")
	return [
		_entry("Vanilla — version jars (pick a .jar for vanilla blocks)",
			support.path_join("minecraft/versions"), "file"),
		_entry("Vanilla — resource packs (pick a .zip)",
			support.path_join("minecraft/resourcepacks"), "file"),
		_entry("CurseForge — instances (open an instance's mods folder)",
			home.path_join("Documents/curseforge/minecraft/Instances"), "dir"),
		_entry("CurseForge — vanilla version jars",
			home.path_join("Documents/curseforge/minecraft/Install/versions"), "file"),
		_entry("Prism — instances (open <instance>/.minecraft/mods)",
			support.path_join("PrismLauncher/instances"), "dir"),
	]

static func _linux() -> Array:
	var home := OS.get_environment("HOME")
	return [
		_entry("Vanilla — version jars (pick a .jar for vanilla blocks)",
			home.path_join(".minecraft/versions"), "file"),
		_entry("Vanilla — resource packs (pick a .zip)",
			home.path_join(".minecraft/resourcepacks"), "file"),
		_entry("Prism — instances (open <instance>/.minecraft/mods)",
			home.path_join(".local/share/PrismLauncher/instances"), "dir"),
		_entry("CurseForge — instances (open an instance's mods folder)",
			home.path_join("curseforge/minecraft/Instances"), "dir"),
	]
