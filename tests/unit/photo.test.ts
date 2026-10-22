// Photos (FR-210, V46): the browser-side resize to a JPEG ≤ 512 px on the long side and ≤ 150 KB.
// jsdom has no canvas and no createImageBitmap, so the pure parts are tested as they are and the
// browser pieces are stubbed just enough to see what resizeToJpeg asks of them.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fitWithin, PHOTO_MAX_BYTES, PHOTO_MAX_PX, QUALITY_STEPS, resizeToJpeg } from "../../src/components/photo";

const file = (type = "image/jpeg", name = "a.jpg") => new File([new Uint8Array(1000)], name, { type });

/** A 2D canvas whose toBlob answers with a blob of the size the test dictates per (long side, quality). */
function stubCanvas(sizeOf: (px: number, q: number) => number) {
  const draws: { w: number; h: number }[] = [];
  const encodes: { px: number; q: number }[] = [];
  let cur = { w: 0, h: 0 };
  const ctx = {
    fillStyle: "",
    fillRect: vi.fn(),
    drawImage: vi.fn((_src: unknown, _x: number, _y: number, w: number, h: number) => {
      cur = { w, h };
      draws.push(cur);
    })
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb: BlobCallback, _type?: string, q?: unknown) => {
    const px = Math.max(cur.w, cur.h);
    encodes.push({ px, q: q as number });
    cb(new Blob([new Uint8Array(sizeOf(px, q as number))], { type: "image/jpeg" }));
  });
  return { ctx, draws, encodes };
}

/** createImageBitmap with a picture of the given size; `reject` makes every call fail, `plainOnly` the one with options. */
function stubBitmap(width: number, height: number, mode: "ok" | "reject" | "plainOnly" = "ok") {
  const close = vi.fn();
  const bitmap = { width, height, close } as unknown as ImageBitmap;
  const fn = vi.fn(async (_file: Blob, opts?: ImageBitmapOptions) => {
    if (mode === "reject" || (mode === "plainOnly" && opts)) throw new TypeError("decode failed");
    return bitmap;
  });
  vi.stubGlobal("createImageBitmap", fn);
  return { fn, bitmap, close };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fitWithin (FR-210: the long side ≤ 512 px)", () => {
  it("scales the long side down to the limit, keeps the ratio, never upscales", () => {
    expect(fitWithin(4000, 3000, 512)).toEqual({ width: 512, height: 384 });
    expect(fitWithin(3000, 4000, 512)).toEqual({ width: 384, height: 512 });
    expect(fitWithin(1000, 333, 512)).toEqual({ width: 512, height: 170 }); // 170.496 → 170
    expect(fitWithin(1000, 335, 512)).toEqual({ width: 512, height: 172 }); // 171.52 → 172
    expect(fitWithin(512, 512, 512)).toEqual({ width: 512, height: 512 });
    expect(fitWithin(300, 200, 512)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(513, 1, 512)).toEqual({ width: 512, height: 1 });
    expect(fitWithin(4000, 3000, 256)).toEqual({ width: 256, height: 192 });
  });

  it("answers 1×1 for a picture without a size (never 0 or NaN for the canvas)", () => {
    expect(fitWithin(0, 0, 512)).toEqual({ width: 1, height: 1 });
    expect(fitWithin(Number.NaN, 10, 512)).toEqual({ width: 1, height: 1 });
    expect(fitWithin(10, -5, 512)).toEqual({ width: 1, height: 1 });
    expect(fitWithin(Number.POSITIVE_INFINITY, 10, 512)).toEqual({ width: 1, height: 1 });
  });

  it("fixes the limits of FR-210 and the quality steps from 0.85 down to 0.5", () => {
    expect(PHOTO_MAX_PX).toBe(512);
    expect(PHOTO_MAX_BYTES).toBe(150_000);
    expect(QUALITY_STEPS[0]).toBe(0.85);
    expect(QUALITY_STEPS[QUALITY_STEPS.length - 1]).toBe(0.5);
    for (let i = 1; i < QUALITY_STEPS.length; i++) expect(QUALITY_STEPS[i]).toBeLessThan(QUALITY_STEPS[i - 1]);
  });
});

describe("resizeToJpeg", () => {
  it("rejects anything that is not an image before touching the decoder", async () => {
    const { fn } = stubBitmap(10, 10);
    await expect(resizeToJpeg(file("text/plain", "a.txt"))).rejects.toThrow("not_image");
    await expect(resizeToJpeg(file("application/pdf", "a.pdf"))).rejects.toThrow("not_image");
    await expect(resizeToJpeg(file("", "a"))).rejects.toThrow("not_image");
    await expect(resizeToJpeg(null as unknown as File)).rejects.toThrow("not_image");
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects an image the browser cannot decode (a corrupt file, HEIC on a desktop) with not_image", async () => {
    stubBitmap(10, 10, "reject");
    const { encodes } = stubCanvas(() => 1);
    await expect(resizeToJpeg(file("image/heic", "a.heic"))).rejects.toThrow("not_image");
    expect(encodes).toEqual([]);
  });

  it("decodes upright, scales to 512 on the long side and lowers the quality until the JPEG is ≤ 150 KB", async () => {
    const { fn, bitmap, close } = stubBitmap(4000, 3000);
    const bySize: Record<string, number> = { "0.85": 200_000, "0.75": 170_000, "0.65": 140_000, "0.55": 100_000, "0.5": 90_000 };
    const { ctx, draws, encodes } = stubCanvas((_px, q) => bySize[String(q)]);
    const out = await resizeToJpeg(file());
    expect(out.type).toBe("image/jpeg");
    expect(out.size).toBe(140_000);
    expect(fn).toHaveBeenCalledWith(expect.any(File), { imageOrientation: "from-image" });
    expect(draws).toEqual([{ w: 512, h: 384 }]);
    expect(ctx.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 512, 384);
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 512, 384); // white under a transparent PNG
    expect(encodes).toEqual([
      { px: 512, q: 0.85 },
      { px: 512, q: 0.75 },
      { px: 512, q: 0.65 }
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps the first quality when it already fits, and a small picture its own size", async () => {
    stubBitmap(300, 200);
    const { encodes } = stubCanvas(() => 20_000);
    const out = await resizeToJpeg(file("image/png", "a.png"));
    expect(out.size).toBe(20_000);
    expect(encodes).toEqual([{ px: 300, q: 0.85 }]);
  });

  it("takes custom limits", async () => {
    stubBitmap(4000, 3000);
    const { encodes, draws } = stubCanvas((_px, q) => (q >= 0.6 ? 60_000 : 40_000));
    const out = await resizeToJpeg(file(), 256, 50_000);
    expect(draws).toEqual([{ w: 256, h: 192 }]);
    expect(out.size).toBe(40_000);
    expect(encodes.map((e) => e.q)).toEqual([0.85, 0.75, 0.65, 0.55]);
  });

  it("shrinks the picture further when even quality 0.5 is too big, and gives up with the smallest at 128 px", async () => {
    stubBitmap(4000, 3000);
    // A picture that never compresses: the size follows the long side only (every quality the same).
    const { encodes, draws } = stubCanvas((px) => px * 10_000);
    const out = await resizeToJpeg(file());
    expect(draws.map((d) => d.w)).toEqual([512, 384, 288, 216, 162, 122]);
    expect(encodes).toHaveLength(6 * QUALITY_STEPS.length);
    expect(out.size).toBe(122 * 10_000); // the smallest tried, as it is
    // The same, but the third round fits: the loop stops there.
    stubBitmap(4000, 3000);
    const again = stubCanvas((px, q) => (px <= 288 && q <= 0.55 ? 100_000 : 900_000));
    expect((await resizeToJpeg(file())).size).toBe(100_000);
    expect(again.encodes.at(-1)).toEqual({ px: 288, q: 0.55 });
  });

  it("retries without the orientation option when the browser rejects it (older Safari)", async () => {
    const { fn, close } = stubBitmap(1000, 500, "plainOnly");
    const { draws } = stubCanvas(() => 1000);
    await resizeToJpeg(file());
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[0][1]).toEqual({ imageOrientation: "from-image" });
    expect(fn.mock.calls[1][1]).toBeUndefined();
    expect(draws).toEqual([{ w: 512, h: 256 }]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("falls back to an <img> on an object URL without createImageBitmap, and frees the URL", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    const create = vi.fn(() => "blob:siosia/1");
    const revoke = vi.fn();
    const urls = URL as unknown as Record<string, unknown>;
    urls.createObjectURL = create;
    urls.revokeObjectURL = revoke;
    let bad = false;
    class FakeImage {
      naturalWidth = 0;
      naturalHeight = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => {
          if (bad) return this.onerror?.();
          this.naturalWidth = 640;
          this.naturalHeight = 480;
          this.onload?.();
        });
      }
    }
    vi.stubGlobal("Image", FakeImage);
    try {
      const { ctx, draws } = stubCanvas(() => 1000);
      await resizeToJpeg(file());
      expect(create).toHaveBeenCalledTimes(1);
      expect(draws).toEqual([{ w: 512, h: 384 }]);
      expect(ctx.drawImage.mock.calls[0][0]).toBeInstanceOf(FakeImage);
      expect(revoke).toHaveBeenCalledWith("blob:siosia/1");
      // A file the <img> cannot show: not_image, and the URL is freed too.
      bad = true;
      await expect(resizeToJpeg(file("image/webp", "a.webp"))).rejects.toThrow("not_image");
      expect(revoke).toHaveBeenCalledTimes(2);
    } finally {
      delete urls.createObjectURL;
      delete urls.revokeObjectURL;
    }
  });

  it("reports a missing 2D canvas as no_canvas (and still frees the bitmap)", async () => {
    const { close } = stubBitmap(100, 100);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await expect(resizeToJpeg(file())).rejects.toThrow("no_canvas");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
