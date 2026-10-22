// A photo as picked from the camera or the gallery → the small JPEG the backend stores (FR-210,
// V46). Everything happens in the browser before the upload: decode, scale so the long side is at
// most 512 px, re-encode as JPEG, lowering the quality step by step until the file is ≤ 150 KB. The
// backends only store what they get (the SQL twin cannot resize); the mock keeps a data URL of
// exactly this blob. Plain browser APIs, no imports — the pure parts are unit-tested in jsdom
// (tests/unit/photo.test.ts), which has no canvas.

export const PHOTO_MAX_PX = 512;
export const PHOTO_MAX_BYTES = 150_000;
/** JPEG qualities tried in turn: the first one small enough wins. */
export const QUALITY_STEPS: readonly number[] = [0.85, 0.75, 0.65, 0.55, 0.5];
/** When even the lowest quality is too big, the long side shrinks by this and the steps run again … */
const SHRINK = 0.75;
/** … down to this long side; then the smallest result goes out as it is (never an endless loop). */
const MIN_PX = 128;

export interface Size {
  width: number;
  height: number;
}

/** The size of a w×h picture scaled to fit a maxPx square: never upscaled, whole pixels, ≥ 1. */
export function fitWithin(w: number, h: number, maxPx: number): Size {
  const long = Math.max(w, h);
  if (!Number.isFinite(long) || long <= 0 || !(w > 0) || !(h > 0)) return { width: 1, height: 1 };
  const scale = long > maxPx ? maxPx / long : 1;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

interface Decoded {
  src: CanvasImageSource;
  width: number;
  height: number;
  /** Frees the bitmap / the object URL once drawn. */
  close(): void;
}

const isImage = (file: Blob | null | undefined): file is Blob => !!file && /^image\//i.test(file.type);

/** Decodes through an <img> on an object URL (browsers without createImageBitmap). */
function decodeImg(file: Blob): Promise<Decoded> {
  const url = URL.createObjectURL(file);
  return new Promise<Decoded>((ok, fail) => {
    const img = new Image();
    img.onload = () => ok({ src: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      fail(new Error("not_image"));
    };
    img.src = url;
  });
}

/** Decodes the file; a bitmap when the browser has createImageBitmap, else an <img>. */
async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap !== "function") return decodeImg(file);
  let bmp: ImageBitmap;
  try {
    // Phones store portrait shots rotated plus an EXIF tag: ask for the upright picture where the
    // option is known (a browser that rejects it gets the plain call; its default is upright too).
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => createImageBitmap(file));
  } catch {
    throw new Error("not_image");
  }
  return { src: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
}

const toBlob = (canvas: HTMLCanvasElement, quality: number) => new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", quality));

/**
 * The picked file as a JPEG with the long side ≤ maxPx and at most maxBytes (FR-210). Rejects with
 * Error("not_image") for anything that is not a decodable image, Error("no_canvas") without a 2D
 * canvas.
 */
export async function resizeToJpeg(file: File | Blob, maxPx = PHOTO_MAX_PX, maxBytes = PHOTO_MAX_BYTES): Promise<Blob> {
  if (!isImage(file)) throw new Error("not_image");
  const img = await decode(file);
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no_canvas");
    let smallest: Blob | null = null;
    for (let px = maxPx; ; px = Math.round(px * SHRINK)) {
      const { width, height } = fitWithin(img.width, img.height, px);
      canvas.width = width;
      canvas.height = height;
      // JPEG has no alpha: a transparent PNG would otherwise come out black.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img.src, 0, 0, width, height);
      for (const q of QUALITY_STEPS) {
        const blob = await toBlob(canvas, q);
        // No blob: the canvas could not encode it (a zero-sized or tainted picture).
        if (!blob) throw new Error("not_image");
        if (blob.size <= maxBytes) return blob;
        if (!smallest || blob.size < smallest.size) smallest = blob;
      }
      if (px <= MIN_PX) return smallest!;
    }
  } finally {
    img.close();
  }
}
