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
  sampleMs: 140,
  maxFrames: 24,
  minZoneQuality: 0.24,
  minFrameQuality: 0.32,
  gridCols: 2,
  gridRows: 4,
  zoneMargin: 0.02,
};

let stream = null;
let worker = null;
let track = null;
let capabilities = null;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function normalizeForConsensus(s) {
  return normalizeText(s).toUpperCase().replace(/[|]/g, "I");
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

function preprocessCanvas(inputCanvas) {
  const scale = inputCanvas.width < 900 ? 2 : 1;
  const out = document.createElement("canvas");
  out.width = Math.round(inputCanvas.width * scale);
  out.height = Math.round(inputCanvas.height * scale);

  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(inputCanvas, 0, 0, out.width, out.height);

  const img = ctx.getImageData(0, 0, out.width, out.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const g = Math.round((img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3);
    const centered = g - 128;
    const contrast = clamp(128 + centered * 1.28, 0, 255);
    img.data[i] = contrast;
    img.data[i + 1] = contrast;
    img.data[i + 2] = contrast;
  }

  ctx.putImageData(img, 0, 0);
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

  const sharp = clamp(grad / Math.max(1, (width - 2) * (height - 2) * 26), 0, 1);
  const contrast = clamp(variance / 2200, 0, 1);
  const exposure = 1 - clamp((bright / gray.length) * 1.7, 0, 1);

  return clamp(0.62 * sharp + 0.24 * contrast + 0.14 * exposure, 0, 1);
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

function collectZoneCandidates(frames, zones) {
  const byZone = new Map();
  for (const z of zones) byZone.set(z.id, []);

  for (const frame of frames) {
    for (const zone of zones) {
      const zoneCanvas = cropCanvas(frame.canvas, zone);
      const quality = zoneQuality(zoneCanvas);
      byZone.get(zone.id).push({
        frameIndex: frame.index,
        row: zone.row,
        col: zone.col,
        zoneCanvas,
        quality,
      });
    }
  }

  for (const [zoneId, list] of byZone.entries()) {
    list.sort((a, b) => b.quality - a.quality);
    byZone.set(zoneId, list.slice(0, 4));
  }

  return byZone;
}

function buildComposite(zones, candidatesByZone, frameW, frameH) {
  const composite = document.createElement("canvas");
  composite.width = frameW;
  composite.height = frameH;
  const ctx = composite.getContext("2d", { willReadFrequently: true });

  for (const zone of zones) {
    const list = candidatesByZone.get(zone.id) || [];
    const chosen = list.find((x) => x.quality >= SETTINGS.minZoneQuality) || list[0];
    if (!chosen) continue;

    ctx.drawImage(
      chosen.zoneCanvas,
      0,
      0,
      chosen.zoneCanvas.width,
      chosen.zoneCanvas.height,
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
    user_defined_dpi: "300",
  });

  const direct = await w.recognize(canvas);
  const pre = preprocessCanvas(canvas);
  const enhanced = await w.recognize(pre);

  const d = { text: normalizeText(direct.data.text), confidence: direct.data.confidence || 0 };
  const e = { text: normalizeText(enhanced.data.text), confidence: enhanced.data.confidence || 0 };
  return e.confidence > d.confidence ? e : d;
}

function pickConsensus(readings) {
  const groups = new Map();

  for (const r of readings) {
    const norm = normalizeForConsensus(r.text);
    if (!norm) continue;

    if (!groups.has(norm)) {
      groups.set(norm, {
        text: r.text,
        norm,
        count: 0,
        score: 0,
      });
    }

    const g = groups.get(norm);
    g.count += 1;
    g.score += 1.5 + (r.confidence / 100) + r.quality;
    if (r.confidence > (g.bestConfidence || 0)) {
      g.bestConfidence = r.confidence;
      g.text = r.text;
    }
  }

  if (!groups.size) return { text: "", support: 0, score: 0 };
  const winner = [...groups.values()].sort((a, b) => b.score - a.score || b.count - a.count)[0];
  return { text: normalizeText(winner.text), support: winner.count, score: winner.score };
}

function bestSuffixPrefixOverlap(left, right, minLen = 3) {
  const a = normalizeForConsensus(left);
  const b = normalizeForConsensus(right);
  const maxLen = Math.min(a.length, b.length, 28);

  for (let len = maxLen; len >= minLen; len -= 1) {
    const suffix = a.slice(-len);
    const prefix = b.slice(0, len);
    if (suffix === prefix) {
      return suffix;
    }
  }

  return "";
}

function isInformativeAnchor(anchor) {
  if (!anchor || anchor.length < 3) return false;
  const unique = new Set(anchor.split(""));
  const alnum = anchor.replace(/[^A-Z0-9]/g, "");
  if (alnum.length < 3) return false;
  if (unique.size < 2 && anchor.length < 6) return false;
  return true;
}

function getAnchorStats(leftReads, rightReads) {
  const stats = new Map();

  for (const l of leftReads) {
    for (const r of rightReads) {
      const anchor = bestSuffixPrefixOverlap(l.text, r.text, 3);
      if (!isInformativeAnchor(anchor)) continue;

      if (!stats.has(anchor)) {
        stats.set(anchor, { anchor, support: 0, score: 0 });
      }

      const item = stats.get(anchor);
      item.support += 1;
      item.score += (l.confidence / 100) + (r.confidence / 100) + l.quality + r.quality;
    }
  }

  if (!stats.size) return null;

  return [...stats.values()].sort((a, b) => {
    if (b.support !== a.support) return b.support - a.support;
    if (b.anchor.length !== a.anchor.length) return b.anchor.length - a.anchor.length;
    return b.score - a.score;
  })[0];
}

function mergeWithAnchor(left, right, anchor) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  const an = normalizeForConsensus(anchor);
  if (!an) return normalizeText(`${a} ${b}`);

  const aNorm = normalizeForConsensus(a);
  const bNorm = normalizeForConsensus(b);
  const idxA = aNorm.lastIndexOf(an);
  const idxB = bNorm.indexOf(an);

  if (idxA < 0 || idxB < 0) return normalizeText(`${a} ${b}`);

  const cutA = a.slice(0, idxA + an.length);
  const tailB = b.slice(idxB + an.length);
  return normalizeText(`${cutA}${tailB ? ` ${tailB}` : ""}`);
}

function assembleRowFromPieces(pieces) {
  if (!pieces.length) return "";
  pieces.sort((a, b) => a.col - b.col);

  let line = pieces[0].consensus;
  for (let i = 1; i < pieces.length; i += 1) {
    const left = pieces[i - 1];
    const right = pieces[i];
    const anchor = getAnchorStats(left.reads, right.reads);

    if (anchor && anchor.support >= 2 && anchor.anchor.length >= 3) {
      line = mergeWithAnchor(line, right.consensus, anchor.anchor);
    } else {
      line = normalizeText(`${line} ${right.consensus}`);
    }
  }

  return line;
}

async function buildZoneRawFallback(zones, candidatesByZone) {
  const rowPieces = new Map();

  for (const zone of zones) {
    const list = (candidatesByZone.get(zone.id) || []).filter((x) => x.quality >= SETTINGS.minZoneQuality || x === candidatesByZone.get(zone.id)?.[0]);
    if (!list.length) continue;

    const reads = [];
    for (const c of list) {
      const res = await ocrCanvas(c.zoneCanvas, 7);
      if (res.confidence < 15 || !res.text || res.text.length < 2) continue;
      reads.push({ text: res.text, confidence: res.confidence, quality: c.quality });
    }

    const consensus = pickConsensus(reads);
    if (!consensus.text || consensus.support < 2) continue;

    if (!rowPieces.has(zone.row)) rowPieces.set(zone.row, []);
    rowPieces.get(zone.row).push({ col: zone.col, consensus: consensus.text, reads });
  }

  const rows = [...rowPieces.entries()].sort((a, b) => a[0] - b[0]);
  const lines = [];

  for (const [, pieces] of rows) {
    const line = assembleRowFromPieces(pieces);
    if (line) lines.push(line);
  }

  return lines.join("\n");
}

function mergeRawTexts(primary, secondary) {
  const out = [];
  const lines = [...primary.split(/\n+/), ...secondary.split(/\n+/)].map((x) => normalizeText(x)).filter(Boolean);

  for (const line of lines) {
    const dup = out.some((x) => x === line || x.includes(line) || line.includes(x));
    if (!dup) out.push(line);
  }

  return out.join("\n");
}

async function captureFrames() {
  const frames = [];
  const start = performance.now();
  let nextShot = start;
  let idx = 0;

  while (performance.now() - start < SETTINGS.windowMs && frames.length < SETTINGS.maxFrames) {
    const now = performance.now();
    if (now >= nextShot) {
      const canvas = frameToCanvas(video);
      const quality = zoneQuality(canvas);
      if (quality >= SETTINGS.minFrameQuality) {
        frames.push({ index: idx, canvas, quality });
      }
      idx += 1;
      nextShot += SETTINGS.sampleMs;
    }
    await sleep(18);
  }

  return frames;
}

function updateFocusIndicator() {
  if (!video.videoWidth || !video.videoHeight) return;
  const frame = frameToCanvas(video);

  const w = frame.width * 0.45;
  const h = frame.height * 0.34;
  const x = (frame.width - w) / 2;
  const y = (frame.height - h) / 2;
  const center = cropCanvas(frame, { x, y, w, h });
  const q = zoneQuality(center);
  focusState.textContent = `Foco: ${Math.round(q * 100)}%`;
}

async function applyTrackConstraints(constraints) {
  if (!track) return;
  try {
    await track.applyConstraints({ advanced: [constraints] });
  } catch {
    // no-op en dispositivos sin soporte
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
  focusState.textContent = "Foco: listo (toca video para reenfocar)";
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
  finalRaw.textContent = "Procesando OCR bruto...";

  try {
    const frames = await captureFrames();
    if (!frames.length) throw new Error("No se capturaron frames legibles");

    const frameW = frames[0].canvas.width;
    const frameH = frames[0].canvas.height;
    const zones = buildGrid(frameW, frameH);
    const byZone = collectZoneCandidates(frames, zones);

    const composite = buildComposite(zones, byZone, frameW, frameH);
    const whole = await ocrCanvas(composite, 6);
    const zoneMerged = await buildZoneRawFallback(zones, byZone);

    const finalText =
      (whole.confidence >= 45 ? mergeRawTexts(whole.text, zoneMerged) : zoneMerged) ||
      (whole.confidence >= 55 ? whole.text : "");
    finalRaw.textContent = finalText || "No legible todavía. Acércate más, usa zoom y reenfoca.";
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
