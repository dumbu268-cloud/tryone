import type { GarmentAsset, GarmentDescriptor } from '@/core/types';

/**
 * Load a garment descriptor into a ready-to-render asset. The SVG texture is
 * rasterized to a crisp bitmap (supersampled) once at load time. Anchor
 * coordinates stay in the descriptor's texture space (independent of the raster
 * resolution), so UVs = anchor / textureSize regardless of `supersample`.
 */
export async function loadGarment(
  desc: GarmentDescriptor,
  supersample = 2,
): Promise<GarmentAsset> {
  const image = await rasterize(
    desc.textureUrl,
    Math.round(desc.textureWidth * supersample),
    Math.round(desc.textureHeight * supersample),
  );
  return {
    id: desc.id,
    name: desc.name,
    type: desc.type,
    textureWidth: desc.textureWidth,
    textureHeight: desc.textureHeight,
    image,
    anchors: desc.anchors,
    layout: desc.layout,
    zOrder: desc.zOrder,
    ...(desc.colorHints ? { colorHints: desc.colorHints } : {}),
  };
}

async function rasterize(
  url: string,
  width: number,
  height: number,
): Promise<TexImageSource> {
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2D context to rasterize the garment.');
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  // Prefer an ImageBitmap (cheaper to upload); fall back to the canvas itself.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(canvas);
    } catch {
      /* fall through */
    }
  }
  return canvas;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load garment texture: ${url}`));
    img.src = url;
  });
}
