export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024
export const TARGET_BYTES = 280 * 1024
export const MAX_SIDE = 1600

export function fitDimensions(w: number, h: number, max = MAX_SIDE): { w: number; h: number } {
  const s = Math.min(1, max / Math.max(w, h))
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) }
}
export function validateUpload(file: { size: number; type: string }): string | null {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type)) return 'Please choose a JPG, PNG or WebP image.'
  if (file.size > MAX_UPLOAD_BYTES) return `Image is too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`
  return null
}

/**
 * Re-encode through a canvas: this (a) applies EXIF orientation, (b) DROPS ALL EXIF/GPS metadata,
 * (c) shrinks to ~200-300 KB by lowering size then quality.
 */
export async function compressReceipt(file: File): Promise<Blob> {
  const err = validateUpload(file)
  if (err) throw new Error(err)
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  let { w, h } = fitDimensions(bmp.width, bmp.height)
  let q = 0.82
  for (let i = 0; i < 8; i++) {
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h)
    ctx.drawImage(bmp, 0, 0, w, h)
    const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', q))
    if (blob.size <= TARGET_BYTES || i === 7) { bmp.close(); return blob }
    if (q > 0.5) q -= 0.12
    else { w = Math.round(w * 0.85); h = Math.round(h * 0.85) }
  }
  bmp.close()
  throw new Error('unreachable')
}
