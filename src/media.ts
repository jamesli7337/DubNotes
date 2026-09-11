/** Longest edge, in pixels, an inserted photo is downscaled to before it is stored inline. */
export const IMAGE_MAX_EDGE = 1600;
/** Files at or under this size are stored as-is (keeps small GIFs/PNGs byte-exact). */
const KEEP_ORIGINAL_BYTES = 1_500_000;

export interface LoadedImage {
  /** data: URL ready to store on an ImageElement */
  src: string;
  /** natural size of `src` in pixels */
  w: number;
  h: number;
}

function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function decode(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file could not be read as an image.'));
    img.src = src;
  });
}

/**
 * Turns a picked photo / GIF into a data URL to store on the page. Small files
 * are kept byte-for-byte; anything larger than `IMAGE_MAX_EDGE` on its longest
 * side or over ~1.5 MB is downscaled and re-encoded (JPEG for photos, PNG when
 * the source was PNG) so backups and IndexedDB stay a sensible size.
 */
export async function loadImageFile(file: File): Promise<LoadedImage> {
  const original = await readAsDataURL(file);
  const img = await decode(original);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const tooBig = Math.max(w, h) > IMAGE_MAX_EDGE || file.size > KEEP_ORIGINAL_BYTES;
  if (!tooBig) return { src: original, w, h };

  const s = Math.min(1, IMAGE_MAX_EDGE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  const ctx = c.getContext('2d');
  if (!ctx) return { src: original, w, h };
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const png = file.type === 'image/png';
  const src = png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
  return { src, w: c.width, h: c.height };
}
