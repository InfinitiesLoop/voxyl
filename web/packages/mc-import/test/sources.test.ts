import { describe, expect, it } from "vitest";
import { bytesSource, MultiSource, readText, ZipAssetSource, ZipReader } from "../src/index.ts";
import { zip } from "./helpers.ts";

describe("ranged zip reading", () => {
  it("reads only the ranges it needs", async () => {
    const bytes = await zip({ "assets/a/x.txt": "first", "assets/a/y.txt": "second" });
    const reads: number[] = [];
    const counted = {
      size: bytes.length,
      read: async (s: number, e: number) => {
        reads.push(e - s);
        return bytes.subarray(s, Math.min(e, bytes.length));
      },
    };
    const reader = await ZipReader.open(counted);
    expect(reads.length).toBe(2); // the end record, then the directory
    expect(reader.has("assets/a/y.txt")).toBe(true);
    reads.length = 0;
    await reader.read("assets/a/y.txt");
    expect(Math.max(...reads)).toBeLessThan(bytes.length);
  });
});

describe("asset sources", () => {
  it("lists a jar's assets without the assets/ prefix", async () => {
    const bytes = await zip({
      "assets/mod/textures/blocks/a.png": "1",
      "assets/mod/textures/blocks/sub/b.png": "2",
      "assets/mod/lang/en_US.lang": "k=v",
      "com/mod/Main.class": "ignored",
    });
    const source = await ZipAssetSource.open("mod.jar", bytesSource(bytes));
    expect(source.namespaces()).toEqual(["mod"]);
    expect(source.listFiles("mod/textures/blocks")).toEqual(["a.png"]);
    expect(source.listFilesRecursive("mod/textures/blocks").sort()).toEqual(["a.png", "sub/b.png"]);
    expect(source.has("mod/lang/en_US.lang")).toBe(true);
    expect(await readText(source, "mod/lang/en_US.lang")).toBe("k=v");
    expect(await source.bytes("mod/nothing")).toBeNull();
  });

  it("reads several sources of one namespace as their union, first source winning", async () => {
    const one = await ZipAssetSource.open(
      "one",
      bytesSource(await zip({ "assets/ns/f.txt": "one", "assets/ns/a.txt": "a" })),
    );
    const two = await ZipAssetSource.open(
      "two",
      bytesSource(await zip({ "assets/ns/f.txt": "two", "assets/ns/b.txt": "b" })),
    );
    const multi = new MultiSource([one, two]);
    expect(multi.listFiles("ns").sort()).toEqual(["a.txt", "b.txt", "f.txt"]);
    expect(await readText(multi, "ns/f.txt")).toBe("one");
    expect(await readText(multi, "ns/b.txt")).toBe("b");
  });
});
