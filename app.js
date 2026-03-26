import { DocumentScanner } from "https://cdn.jsdelivr.net/npm/opencv-document-scanner/dist/opencv-document-scanner.js";

const video = document.getElementById("video");
const startCameraBtn = document.getElementById("startCameraBtn");
const captureBtn = document.getElementById("captureBtn");
const stopCameraBtn = document.getElementById("stopCameraBtn");
const finalRaw = document.getElementById("finalRaw");
const zoomSlider = document.getElementById("zoomSlider");
const refocusBtn = document.getElementById("refocusBtn");
const focusState = document.getElementById("focusState");

const SETTINGS = {
  windowMs: 4200,
  sampleMs: 180,
  maxFrames: 16,
  minFrameQuality: 0.2,
  minZoneQuality: 0.16,
  gridCols: 4,
  gridRows: 6,
  overlap: 0.3,
};

let stream = null;
let worker = null;
let track = null;
let capabilities = null;
let scanner = null;

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

function resizeCanvas(inputCanvas, targetW, targetH) {
  const out = document.createElement("canvas");
  out.width = targetW;
  out.height = targetH;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(inputCanvas, 0, 0, targetW, targetH);
  return out;
}

function preprocessCanvas(inputCanvas) {
  const scale = inputCanvas.width < 1000 ? 2 : 1;
  const out = document.createElement("canvas");
  out.width = Math.round(inputCanvas.width * scale);
  out.height = Math.round(inputCanvas.height * scale);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(inputCanvas, 0, 0, out.width, out.height);

  const img = ctx.getImageData(0, 0, out.width, out.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const g = Math.round((img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3);
    const c = clamp(128 + (g - 128) * 1.18, 0, 255);
    img.data[i] = c;
    img.data[i + 1] = c;
    img.data[i + 2] = c;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function quality(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  const gray = new Uint8Array(width * height);
  let mean = 0;

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const g = Math.round((data[i] + data[i + 1] + data[i + 2]) / 3);
    gray[p] = g;
    mean += g;
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
      grad += Math.abs(gray[idx + 1] - gray[idx - 1]) + Math.abs(gray[idx + width] - gray[idx - width]);
    }
  }

  const sharp = clamp(grad / Math.max(1, (width - 2) * (height - 2) * 22), 0, 1);
  const contrast = clamp(variance / 2400, 0, 1);
  return clamp(0.68 * sharp + 0.32 * contrast, 0, 1);
}

function buildZones(frameW, frameH) {
  const zones = [];
  const tileW = frameW / SETTINGS.gridCols;
  const tileH = frameH / SETTINGS.gridRows;
  const stepW = tileW * (1 - SETTINGS.overlap);
  const stepH = tileH * (1 - SETTINGS.overlap);

  for (let r = 0; r < SETTINGS.gridRows; r += 1) {
    for (let c = 0; c < SETTINGS.gridCols; c += 1) {
      let x = Math.round(c * stepW);
      let y = Math.round(r * stepH);
      const w = Math.round(tileW);
      const h = Math.round(tileH);
      if (x + w > frameW) x = frameW - w;
      if (y + h > frameH) y = frameH - h;
      zones.push({ id: `z_${r}_${c}`, x, y, w, h });
    }
  }

  return zones;
}

async function ensureScanner() {
  if (scanner) return scanner;
  await window.cvReady;
  scanner = new DocumentScanner();
  return scanner;
}

async function rectifyDocument(canvas) {
  try {
    const s = await ensureScanner();
    const points = s.detect(canvas, { useCanny: true });
    if (!points || points.length !== 4) return canvas;
    const cropped = s.crop(canvas);
    if (!cropped || !cropped.width || !cropped.height) return canvas;
    return cropped;
  } catch {
    return canvas;
  }
}

async function ensureWorker() {
  if (worker) return worker;
  worker = await Tesseract.createWorker("spa+eng", 1);
  await worker.setParameters({
    tessedit_pageseg_mode: "6",
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });
  return worker;
}

async function ocrCanvas(canvas) {
  const w = await ensureWorker();
  const direct = await w.recognize(canvas);
  const enhanced = await w.recognize(preprocessCanvas(canvas));

  const dText = normalizeText(direct.data?.text || "");
  const eText = normalizeText(enhanced.data?.text || "");
  const dConf = Number(direct.data?.confidence || 0);
  const eConf = Number(enhanced.data?.confidence || 0);

  return eConf > dConf ? { text: eText, confidence: eConf } : { text: dText, confidence: dConf };
}

function addWhiteBorder(inputCanvas, border = 10) {
  const out = document.createElement("canvas");
  out.width = inputCanvas.width + border * 2;
  out.height = inputCanvas.height + border * 2;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(inputCanvas, border, border);
  return out;
}

async function ocrZone(canvas) {
  const w = await ensureWorker();
  await w.setParameters({
    tessedit_pageseg_mode: "7",
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });
  const withBorder = addWhiteBorder(canvas, 10);
  const direct = await w.recognize(withBorder);
  const enhanced = await w.recognize(preprocessCanvas(withBorder));

  const dText = normalizeText(direct.data?.text || "");
  const eText = normalizeText(enhanced.data?.text || "");
  const dConf = Number(direct.data?.confidence || 0);
  const eConf = Number(enhanced.data?.confidence || 0);
  return eConf > dConf ? { text: eText, confidence: eConf } : { text: dText, confidence: dConf };
}

function bestOverlap(a, b, minLen = 3) {
  const left = normalizeText(a).toUpperCase();
  const right = normalizeText(b).toUpperCase();
  const maxLen = Math.min(left.length, right.length, 24);
  for (let len = maxLen; len >= minLen; len -= 1) {
    if (left.slice(-len) === right.slice(0, len)) return left.slice(-len);
  }
  return "";
}

function mergeByOverlap(left, right) {
  const l = normalizeText(left);
  const r = normalizeText(right);
  const ov = bestOverlap(l, r, 3);
  if (!ov) return normalizeText(`${l} ${r}`);
  const lNorm = l.toUpperCase();
  const rNorm = r.toUpperCase();
  const li = lNorm.lastIndexOf(ov);
  const ri = rNorm.indexOf(ov);
  if (li < 0 || ri < 0) return normalizeText(`${l} ${r}`);
  const partL = l.slice(0, li + ov.length);
  const partR = r.slice(ri + ov.length);
  return normalizeText(`${partL}${partR ? ` ${partR}` : ""}`);
}

async function captureFrames() {
  const frames = [];
  const start = performance.now();
  let nextShot = start;
  let idx = 0;

  while (performance.now() - start < SETTINGS.windowMs && frames.length < SETTINGS.maxFrames) {
    const now = performance.now();
    if (now >= nextShot) {
      const raw = frameToCanvas(video);
      const frameQ = quality(raw);
      if (frameQ >= SETTINGS.minFrameQuality) {
        const rectified = await rectifyDocument(raw);
        frames.push({ index: idx, canvas: rectified, quality: frameQ });
      }
      idx += 1;
      nextShot += SETTINGS.sampleMs;
    }
    await sleep(18);
  }

  return frames;
}

function buildMosaic(frames) {
  const widths = frames.map((f) => f.canvas.width).sort((a, b) => a - b);
  const heights = frames.map((f) => f.canvas.height).sort((a, b) => a - b);
  const targetW = widths[Math.floor(widths.length / 2)] || frames[0].canvas.width;
  const targetH = heights[Math.floor(heights.length / 2)] || frames[0].canvas.height;

  const normalized = frames.map((f) => ({ ...f, canvas: resizeCanvas(f.canvas, targetW, targetH) }));
  const zones = buildZones(targetW, targetH);

  const out = document.createElement("canvas");
  out.width = targetW;
  out.height = targetH;
  const ctx = out.getContext("2d", { willReadFrequently: true });

  for (const zone of zones) {
    let best = null;

    for (const frame of normalized) {
      const patch = cropCanvas(frame.canvas, zone);
      const q = quality(patch);
      if (!best || q > best.q) {
        best = { patch, q };
      }
    }

    if (!best || best.q < SETTINGS.minZoneQuality) continue;
    ctx.drawImage(best.patch, 0, 0, best.patch.width, best.patch.height, zone.x, zone.y, zone.w, zone.h);
  }

  return out;
}

function updateFocusIndicator() {
  if (!video.videoWidth || !video.videoHeight) return;
  const q = quality(frameToCanvas(video));
  focusState.textContent = `Foco: ${Math.round(q * 100)}%`;
}

async function applyTrackConstraints(constraints) {
  if (!track) return;
  try {
    await track.applyConstraints({ advanced: [constraints] });
  } catch {
    // ignore unsupported constraints
  }
}

async function setupCameraCapabilities() {
  if (!track) return;
  capabilities = track.getCapabilities ? track.getCapabilities() : null;

  if (capabilities?.zoom) {
    zoomSlider.disabled = false;
    zoomSlider.min = String(capabilities.zoom.min || 1);
    zoomSlider.max = String(capabilities.zoom.max || 1);
    zoomSlider.step = String(capabilities.zoom.step || 0.1);
    const settings = track.getSettings ? track.getSettings() : {};
    zoomSlider.value = String(settings.zoom || capabilities.zoom.min || 1);
  } else {
    zoomSlider.disabled = true;
  }

  refocusBtn.disabled = false;
  await applyTrackConstraints({ focusMode: "continuous" });
}

async function refocus() {
  focusState.textContent = "Foco: reenfocando...";
  await applyTrackConstraints({ focusMode: "single-shot" });
  await sleep(350);
  await applyTrackConstraints({ focusMode: "continuous" });
  updateFocusIndicator();
}

async function setZoom(value) {
  if (!capabilities?.zoom) return;
  const v = clamp(Number(value), capabilities.zoom.min || 1, capabilities.zoom.max || 1);
  await applyTrackConstraints({ zoom: v });
}

async function startCamera() {
  if (stream) return;

  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 60 },
    },
    audio: false,
  });

  video.srcObject = stream;
  await video.play();
  track = stream.getVideoTracks()[0] || null;
  await setupCameraCapabilities();

  captureBtn.disabled = false;
  stopCameraBtn.disabled = false;
  startCameraBtn.disabled = true;
  focusState.textContent = "Foco: listo";
}

function stopCamera() {
  if (!stream) return;
  for (const t of stream.getTracks()) t.stop();
  stream = null;
  track = null;
  capabilities = null;

  captureBtn.disabled = true;
  stopCameraBtn.disabled = true;
  startCameraBtn.disabled = false;
  zoomSlider.disabled = true;
  refocusBtn.disabled = true;
  focusState.textContent = "Foco: detenido";
}

async function captureAndComposeRawOCR() {
  if (!stream) return;

  captureBtn.disabled = true;
  finalRaw.textContent = "Procesando OCR por zonas...";

  try {
    const frames = await captureFrames();
    if (!frames.length) throw new Error("No se capturaron frames legibles");

    const mosaic = buildMosaic(frames);
    const zones = buildZones(mosaic.width, mosaic.height);
    const byRow = new Map();

    for (const zone of zones) {
      const patch = cropCanvas(mosaic, zone);
      const q = quality(patch);
      if (q < SETTINGS.minZoneQuality) continue;
      const o = await ocrZone(patch);
      if (!o.text || o.confidence < 28) continue;
      if (!byRow.has(zone.id.split("_")[1])) byRow.set(zone.id.split("_")[1], []);
      byRow.get(zone.id.split("_")[1]).push({ col: Number(zone.id.split("_")[2]), text: o.text, confidence: o.confidence });
    }

    const rows = [...byRow.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
    const lines = [];
    for (const [, items] of rows) {
      items.sort((a, b) => a.col - b.col);
      let line = items[0]?.text || "";
      for (let i = 1; i < items.length; i += 1) {
        line = mergeByOverlap(line, items[i].text);
      }
      if (line && line.length >= 2) lines.push(line);
    }

    const finalText = lines.join("\n").trim();
    finalRaw.textContent = finalText || "No legible todavía. Acércate, usa zoom y mueve más lento.";
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
refocusBtn.addEventListener("click", refocus);
zoomSlider.addEventListener("input", (e) => {
  setZoom(e.target.value);
});
video.addEventListener("click", () => {
  refocus();
});

setInterval(() => {
  if (stream && !captureBtn.disabled) updateFocusIndicator();
}, 700);
