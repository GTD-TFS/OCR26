const video = document.getElementById("video");
const startCameraBtn = document.getElementById("startCameraBtn");
const captureBtn = document.getElementById("captureBtn");
const stopCameraBtn = document.getElementById("stopCameraBtn");
const finalRaw = document.getElementById("finalRaw");

const SETTINGS = {
  windowMs: 3200,
  sampleMs: 170,
  maxFrames: 16,
  minZoneQuality: 0.26,
  gridCols: 3,
  gridRows: 6,
  zoneMargin: 0.01,
};

let stream = null;
let worker = null;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function frameToCanvas(videoEl) {
  const canvas = document.createElement("canvas");
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function cropCanvas(sourceCanvas, rect) {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const w = Math.max(1, Math.round(rect.w));
  const h = Math.max(1, Math.round(rect.h));

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, x, y, w, h, 0, 0, w, h);
  return out;
}

function zoneQuality(zoneCanvas) {
  const ctx = zoneCanvas.getContext("2d", { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(0, 0, zoneCanvas.width, zoneCanvas.height);

  const gray = new Uint8Array(width * height);
  let mean = 0;
  let bright = 0;

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const g = Math.round((data[i] + data[i + 1] + data[i + 2]) / 3);
    gray[p] = g;
    mean += g;
    if (g > 245) bright += 1;
  }

  mean /= gray.length;

  let variance = 0;
  for (let i = 0; i < gray.length; i += 1) {
    const d = gray[i] - mean;
    variance += d * d;
  }
  variance /= gray.length;

  let grad = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      const gx = gray[idx + 1] - gray[idx - 1];
      const gy = gray[idx + width] - gray[idx - width];
      grad += Math.abs(gx) + Math.abs(gy);
    }
  }

  const sharp = clamp(grad / Math.max(1, (width - 2) * (height - 2) * 28), 0, 1);
  const contrast = clamp(variance / 2200, 0, 1);
  const exposure = 1 - clamp((bright / gray.length) * 1.7, 0, 1);

  return clamp(0.58 * sharp + 0.27 * contrast + 0.15 * exposure, 0, 1);
}

function buildGrid(frameW, frameH) {
  const zones = [];
  const cw = frameW / SETTINGS.gridCols;
  const ch = frameH / SETTINGS.gridRows;

  for (let r = 0; r < SETTINGS.gridRows; r += 1) {
    for (let c = 0; c < SETTINGS.gridCols; c += 1) {
      zones.push({
        id: `z_${r}_${c}`,
        row: r,
        col: c,
        x: c * cw + cw * SETTINGS.zoneMargin,
        y: r * ch + ch * SETTINGS.zoneMargin,
        w: cw * (1 - SETTINGS.zoneMargin * 2),
        h: ch * (1 - SETTINGS.zoneMargin * 2),
      });
    }
  }
  return zones;
}

function chooseBestZoneCandidates(frames, zones) {
  const best = new Map();

  for (const z of zones) {
    best.set(z.id, []);
  }

  for (const frame of frames) {
    for (const zone of zones) {
      const zoneCanvas = cropCanvas(frame.canvas, zone);
      const quality = zoneQuality(zoneCanvas);
      best.get(zone.id).push({
        zoneId: zone.id,
        row: zone.row,
        col: zone.col,
        frameIndex: frame.index,
        zoneCanvas,
        quality,
      });
    }
  }

  for (const [zoneId, list] of best.entries()) {
    list.sort((a, b) => b.quality - a.quality);
    best.set(zoneId, list.slice(0, 3));
  }

  return best;
}

function buildCompositeFromBest(zones, candidatesByZone, frameW, frameH) {
  const composite = document.createElement("canvas");
  composite.width = frameW;
  composite.height = frameH;
  const ctx = composite.getContext("2d", { willReadFrequently: true });

  for (const zone of zones) {
    const candidates = candidatesByZone.get(zone.id) || [];
    let selected = candidates.find((c) => c.quality >= SETTINGS.minZoneQuality);
    if (!selected) selected = candidates[0];
    if (!selected) continue;

    ctx.drawImage(
      selected.zoneCanvas,
      0,
      0,
      selected.zoneCanvas.width,
      selected.zoneCanvas.height,
      Math.round(zone.x),
      Math.round(zone.y),
      Math.round(zone.w),
      Math.round(zone.h)
    );
  }

  return composite;
}

async function ensureWorker() {
  if (worker) return worker;
  worker = await Tesseract.createWorker("spa+eng", 1);
  return worker;
}

async function ocrCanvas(canvas, psm = 6) {
  const w = await ensureWorker();
  await w.setParameters({
    tessedit_pageseg_mode: String(psm),
    preserve_interword_spaces: "1",
  });
  const {
    data: { text, confidence },
  } = await w.recognize(canvas);

  return {
    text: normalizeText(text),
    confidence: confidence || 0,
  };
}

function mergeRawTexts(primary, secondary) {
  const aLines = primary.split(/\n+/).map((l) => normalizeText(l)).filter(Boolean);
  const bLines = secondary.split(/\n+/).map((l) => normalizeText(l)).filter(Boolean);
  const out = [];

  for (const line of [...aLines, ...bLines]) {
    const exists = out.some((x) => x === line || x.includes(line) || line.includes(x));
    if (!exists) out.push(line);
  }

  return out.join("\n");
}

async function buildZoneRawFallback(zones, candidatesByZone) {
  const rows = new Map();

  for (const zone of zones) {
    const candidates = candidatesByZone.get(zone.id) || [];
    const selected = candidates.find((c) => c.quality >= SETTINGS.minZoneQuality) || candidates[0];
    if (!selected) continue;

    const result = await ocrCanvas(selected.zoneCanvas, 7);
    if (result.confidence < 15 || !result.text) continue;

    if (!rows.has(zone.row)) rows.set(zone.row, []);
    rows.get(zone.row).push({ col: zone.col, text: result.text });
  }

  const orderedRows = [...rows.entries()].sort((a, b) => a[0] - b[0]);
  const lines = [];

  for (const [, parts] of orderedRows) {
    parts.sort((a, b) => a.col - b.col);
    const line = normalizeText(parts.map((p) => p.text).join(" "));
    if (line) lines.push(line);
  }

  return lines.join("\n");
}

async function startCamera() {
  if (stream) return;

  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
    },
    audio: false,
  });

  video.srcObject = stream;
  await video.play();
  captureBtn.disabled = false;
  stopCameraBtn.disabled = false;
  startCameraBtn.disabled = true;
}

function stopCamera() {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
  stream = null;
  captureBtn.disabled = true;
  stopCameraBtn.disabled = true;
  startCameraBtn.disabled = false;
}

async function captureFrames() {
  const frames = [];
  const start = performance.now();
  let nextShot = start;
  let idx = 0;

  while (performance.now() - start < SETTINGS.windowMs && frames.length < SETTINGS.maxFrames) {
    const now = performance.now();
    if (now >= nextShot) {
      frames.push({
        index: idx,
        canvas: frameToCanvas(video),
      });
      idx += 1;
      nextShot += SETTINGS.sampleMs;
    }
    await sleep(20);
  }

  return frames;
}

async function captureAndComposeRawOCR() {
  if (!stream) return;

  captureBtn.disabled = true;
  finalRaw.textContent = "Procesando OCR bruto por zonas...";

  try {
    const frames = await captureFrames();
    if (!frames.length) throw new Error("No se capturaron frames");

    const frameW = frames[0].canvas.width;
    const frameH = frames[0].canvas.height;
    const zones = buildGrid(frameW, frameH);
    const candidatesByZone = chooseBestZoneCandidates(frames, zones);

    const composite = buildCompositeFromBest(zones, candidatesByZone, frameW, frameH);
    const compositeOcr = await ocrCanvas(composite, 6);
    const zoneFallback = await buildZoneRawFallback(zones, candidatesByZone);

    const finalText = mergeRawTexts(compositeOcr.text, zoneFallback) || compositeOcr.text || zoneFallback || "";
    finalRaw.textContent = finalText || "No se obtuvo texto.";
  } catch (error) {
    finalRaw.textContent = `Error: ${error.message}`;
  } finally {
    captureBtn.disabled = false;
  }
}

startCameraBtn.addEventListener("click", async () => {
  try {
    await startCamera();
  } catch (error) {
    finalRaw.textContent = `No se pudo abrir la cámara: ${error.message}`;
  }
});

stopCameraBtn.addEventListener("click", stopCamera);
captureBtn.addEventListener("click", captureAndComposeRawOCR);
