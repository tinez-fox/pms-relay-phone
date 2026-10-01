// Phone photos for a comment (docs/relay-design.md, "Images", up): at most 1600 px on the long
// side, JPEG q≈0.8, at most 4 MB after downsizing. Re-encoding through a canvas drops EXIF
// (location, camera), and the photo is turned upright first so dropping the orientation tag does
// not leave it sideways.
export const MAX_SIDE = 1600;
export const MAX_BYTES = 4 * 1024 * 1024;

export async function downsize(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {
    throw new Error(`${file.name || 'That file'} is not an image this phone can read`);
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // a transparent PNG would turn black as JPEG
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  let blob = null;
  for (const q of [0.8, 0.65, 0.5]) {
    blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/jpeg', quality: q }) : await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= MAX_BYTES) break;
  }
  if (!blob || blob.size > MAX_BYTES) throw new Error(`${file.name || 'That image'} is still over 4 MB after shrinking`);
  const name = (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
  return { blob, name, type: 'image/jpeg', w, h };
}
