import { describe, expect, it } from "vitest";
import { detectPlatform, launcherLocations, vanillaJarHint } from "./locations.ts";

describe("detectPlatform", () => {
  it("reads the platform from the navigator", () => {
    expect(detectPlatform({ platform: "Win32" })).toBe("windows");
    expect(detectPlatform({ userAgentData: { platform: "Windows" } })).toBe("windows");
    expect(detectPlatform({ platform: "MacIntel" })).toBe("mac");
    expect(detectPlatform({ userAgentData: { platform: "macOS" } })).toBe("mac");
    expect(detectPlatform({ platform: "Linux x86_64" })).toBe("linux");
  });

  it("does not take Darwin's user agent for Windows", () => {
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) Darwin" })).toBe(
      "mac",
    );
  });

  it("falls back to Linux", () => {
    expect(detectPlatform({})).toBe("linux");
  });
});

describe("launcherLocations", () => {
  it("lists Prism, the launcher and CurseForge on every platform", () => {
    for (const platform of ["windows", "mac", "linux"] as const) {
      expect(launcherLocations(platform).map((l) => l.label)).toEqual([
        "Prism Launcher",
        "Minecraft launcher",
        "CurseForge",
      ]);
    }
  });

  it("uses each platform's own folders", () => {
    const paths = (p: "windows" | "mac" | "linux") => launcherLocations(p).map((l) => l.path);
    expect(paths("windows")).toContain("%APPDATA%\\PrismLauncher\\instances\\<name>");
    expect(paths("windows")).toContain("%APPDATA%\\.minecraft");
    expect(paths("mac")).toContain("~/Library/Application Support/PrismLauncher/instances/<name>");
    expect(paths("mac")).toContain("~/Library/Application Support/minecraft");
    expect(paths("linux")).toContain("~/.local/share/PrismLauncher/instances/<name>");
    expect(paths("linux")).toContain("~/.minecraft");
    expect(paths("linux")).toContain("~/curseforge/minecraft/Instances/<name>");
  });

  it("copies a folder you can open, never the <name> placeholder", () => {
    for (const platform of ["windows", "mac", "linux"] as const) {
      for (const l of launcherLocations(platform)) expect(l.copy).not.toContain("<name>");
    }
    expect(launcherLocations("windows")[0]?.copy).toBe("%APPDATA%\\PrismLauncher\\instances");
  });
});

describe("vanillaJarHint", () => {
  it("names where the 1.7.10 jar lives", () => {
    expect(vanillaJarHint("windows")).toContain("libraries\\com\\mojang\\minecraft\\1.7.10\\");
    expect(vanillaJarHint("linux")).toContain("libraries/com/mojang/minecraft/1.7.10/");
    expect(vanillaJarHint("mac")).toContain("versions/1.7.10/");
  });
});
