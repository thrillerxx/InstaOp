const HARD_MAX = 90000;
const SIZES = [1920, 1440, 1080, 720, 512, 384, 256];
const QUALITIES = [0.92, 0.84, 0.76, 0.68, 0.58, 0.48, 0.38];
const TYPES = ["image/webp", "image/jpeg"];

function utf8Bytes(text) {
  return new TextEncoder().encode(String(text || "")).length;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function loadBitmap(file) {
  if (typeof createImageBitmap === "function") return createImageBitmap(file);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that photograph."));
    };
    img.src = url;
  });
}

async function encode(bitmap, size, type, quality) {
  const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  return blob ? { blob, width, height, type, quality } : null;
}

async function optimizeImage(file, onProgress) {
  const originalBytes = file.size;
  const bitmap = await loadBitmap(file);
  const attempts = [];
  let best = null;
  for (const size of SIZES) {
    if (size > Math.max(bitmap.width, bitmap.height) && size !== SIZES[0]) continue;
    for (const type of TYPES) {
      for (const quality of QUALITIES) {
        const encoded = await encode(bitmap, size, type, quality);
        if (!encoded) continue;
        attempts.push(encoded);
        if (onProgress) {
          onProgress({
            originalBytes,
            currentBytes: encoded.blob.size,
            width: encoded.width,
            height: encoded.height,
            type: encoded.type,
          });
        }
        if (encoded.blob.size <= HARD_MAX) {
          if (!best || encoded.blob.size > best.blob.size) best = encoded;
          break;
        }
      }
      if (best && best.blob.size > HARD_MAX * 0.55) break;
    }
    if (best) break;
  }
  if (bitmap.close) bitmap.close();
  if (!best) {
    return {
      ok: false,
      originalBytes,
      error: `This photo could not be made smaller than ${HARD_MAX.toLocaleString()} bytes without destroying it. Crop it or pick another frame.`,
    };
  }
  return {
    ok: true,
    originalBytes,
    bytes: best.blob.size,
    width: best.width,
    height: best.height,
    mime: best.type,
    blob: best.blob,
    quality: best.quality,
  };
}

window.InstaOpOptimize = { HARD_MAX, utf8Bytes, formatBytes, optimizeImage };
