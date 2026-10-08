import { describe, expect, it } from "vitest";
import { gunzip, gzip } from "../src/gzip.ts";
import { type Compound, nbt, readNbt, writeNbt } from "../src/nbt.ts";

describe("nbt", () => {
  it("writes a tiny compound exactly as the format says", () => {
    const bytes = writeNbt("root", { a: nbt.byte(1) });
    // TAG_Compound, name "root", TAG_Byte "a" = 1, TAG_End.
    expect([...bytes]).toEqual([
      0x0a, 0x00, 0x04, 0x72, 0x6f, 0x6f, 0x74, 0x01, 0x00, 0x01, 0x61, 0x01, 0x00,
    ]);
  });

  it("round-trips every tag type, nested", () => {
    const fields: Compound = {
      byte: nbt.byte(-5),
      short: nbt.short(-1234),
      int: nbt.int(-2_000_000_000),
      long: nbt.long(-9_000_000_000_000_000_000n),
      float: nbt.float(1.5),
      double: nbt.double(-2.25),
      string: nbt.string("Ztönes:tile.korpBlock"),
      bytes: nbt.byteArray(Uint8Array.from([0, 1, 254, 255])),
      ints: nbt.intArray(Int32Array.from([-1, 0, 7])),
      strings: nbt.list("string", ["a", "b"]),
      shorts: nbt.list("short", [1, -2]),
      none: nbt.list("compound", []),
      tiles: nbt.list("compound", [{ x: nbt.int(1), inner: nbt.compound({ y: nbt.byte(2) }) }, {}]),
    };
    const read = readNbt(writeNbt("Schematic", fields));
    expect(read.name).toBe("Schematic");
    expect(read.value).toEqual(fields);
  });

  it("keeps fields in the order they were written", () => {
    const read = readNbt(writeNbt("r", { z: nbt.byte(1), a: nbt.byte(2), m: nbt.byte(3) }));
    expect(Object.keys(read.value)).toEqual(["z", "a", "m"]);
  });

  it("refuses data that isn't a compound or is cut short", () => {
    expect(() => readNbt(Uint8Array.from([1, 0, 0]))).toThrow();
    const good = writeNbt("r", { a: nbt.string("hello") });
    expect(() => readNbt(good.subarray(0, good.length - 3))).toThrow();
  });

  it("gzips and gunzips", async () => {
    const data = writeNbt("r", { a: nbt.byteArray(new Uint8Array(5000)) });
    const packed = await gzip(data);
    expect(packed[0]).toBe(0x1f);
    expect(packed[1]).toBe(0x8b);
    expect(packed.length).toBeLessThan(data.length);
    expect(await gunzip(packed)).toEqual(data);
  });
});
