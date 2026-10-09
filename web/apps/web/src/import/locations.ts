// Where people keep Minecraft game folders, per platform, for the import dialog to show. A
// browser can't open those paths itself (the picker only takes well-known folders to start
// in), so the dialog shows the exact path with a copy button to paste into the picker.

export type Platform = "windows" | "mac" | "linux";

export interface Location {
  readonly label: string;
  /** The path as people write it, `<name>` standing for the instance's own folder. */
  readonly path: string;
  /** What to copy: the folder to open (an instance list, not one instance). */
  readonly copy: string;
}

interface NavigatorLike {
  readonly platform?: string;
  readonly userAgent?: string;
  readonly userAgentData?: { readonly platform?: string };
}

export function detectPlatform(nav: NavigatorLike): Platform {
  const text = `${nav.userAgentData?.platform ?? ""} ${nav.platform ?? ""} ${nav.userAgent ?? ""}`;
  if (/mac|iphone|ipad|darwin/i.test(text)) return "mac";
  if (/win/i.test(text)) return "windows";
  return "linux";
}

function instances(label: string, root: string, sep: string): Location {
  return { label, path: `${root}${sep}<name>`, copy: root };
}

export function launcherLocations(platform: Platform): Location[] {
  switch (platform) {
    case "windows":
      return [
        instances("Prism Launcher", "%APPDATA%\\PrismLauncher\\instances", "\\"),
        {
          label: "Minecraft launcher",
          path: "%APPDATA%\\.minecraft",
          copy: "%APPDATA%\\.minecraft",
        },
        instances("CurseForge", "%USERPROFILE%\\curseforge\\minecraft\\Instances", "\\"),
      ];
    case "mac":
      return [
        instances("Prism Launcher", "~/Library/Application Support/PrismLauncher/instances", "/"),
        {
          label: "Minecraft launcher",
          path: "~/Library/Application Support/minecraft",
          copy: "~/Library/Application Support/minecraft",
        },
        instances("CurseForge", "~/curseforge/minecraft/Instances", "/"),
      ];
    case "linux":
      return [
        instances("Prism Launcher", "~/.local/share/PrismLauncher/instances", "/"),
        { label: "Minecraft launcher", path: "~/.minecraft", copy: "~/.minecraft" },
        instances("CurseForge", "~/curseforge/minecraft/Instances", "/"),
      ];
  }
}

/** Where Prism and the vanilla launcher keep the 1.7.10 client jar, per platform. */
export function vanillaJarHint(platform: Platform): string {
  const prism =
    platform === "windows"
      ? "%APPDATA%\\PrismLauncher\\libraries\\com\\mojang\\minecraft\\1.7.10\\"
      : platform === "mac"
        ? "~/Library/Application Support/PrismLauncher/libraries/com/mojang/minecraft/1.7.10/"
        : "~/.local/share/PrismLauncher/libraries/com/mojang/minecraft/1.7.10/";
  return `Prism keeps it under ${prism} and the Minecraft launcher under versions/1.7.10/ in its game folder.`;
}
