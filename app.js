const video = document.getElementById("video");
const startCameraBtn = document.getElementById("startCameraBtn");
const captureBtn = document.getElementById("captureBtn");
const stopCameraBtn = document.getElementById("stopCameraBtn");
const finalRaw = document.getElementById("finalRaw");
const zoomSlider = document.getElementById("zoomSlider");
const refocusBtn = document.getElementById("refocusBtn");
const focusState = document.getElementById("focusState");

const SETTINGS = {
  windowMs: 4500,
  sampleMs: 180,
  maxFrames: 20,
  minFrameQuality: 0.28,
  minZoneQuality: 0.24,
  minTextConfidence: 30,
  minTextLength: 2,
  minSupport: 2,
  gridCols: 3,
  gridRows: 5,
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

function canonicalText(s) {
  return normalizeText(s)
    .toUpperCase()
    .replace(/[|]/g, "I")
    .replace(/[“”"'`´]/g, "")
    .replace(/\s+/g, " ");
}

function frameToCanvas(videoEl) {
  const canvas = document.createElement("canvas");
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  return canvas;
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
    const contrast = clamp(128 + centered * 1.35, 0, 255);
    img.data[i] = contrast;
    img.data[i + 1] = contrast;
    img.data[i + 2] = contrast;
  }
  ctx.putImageData(img, 0, 0);
  return out;
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

function frameQuality(canvas) {
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

  const sharp = clamp(grad / Math.max(1, (width - 2) * (height - 2) * 24), 0, 1);
  const contrast = clamp(variance / 2400, 0, 1);
  return clamp(0.68 * sharp + 0.32 * contrast, 0, 1);
}

function levenshtein(a, b) {
  const s = a || "";
  const t = b || "";
  const m = s.length;
  const n = t.length;
  if (!m) return n;
  if (!n) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  return dp[m][n];
}

function similarity(a, b) {
  const s = canonicalText(a);
  const t = canonicalText(b);
  if (!s || !t) return 0;
  const dist = levenshtein(s, t);
  return 1 - dist / Math.max(s.length, t.length);
}

function buildZones(frameW, frameH) {
  const zones = [];
  const cellW = frameW / SETTINGS.gridCols;
  const cellH = frameH / SETTINGS.gridRows;

  for (let r = 0; r < SETTINGS.gridRows; r += 1) {
    for (let c = 0; c < SETTINGS.gridCols; c += 1) {
      zones.push({
        id: `z_${r}_${c}`,
        row: r,
        col: c,
        x: c * cellW + cellW * SETTINGS.zoneMargin,
        y: r * cellH + cellH * SETTINGS.zoneMargin,
        w: cellW * (1 - SETTINGS.zoneMargin * 2),
        h: cellH * (1 - SETTINGS.zoneMargin * 2),
      });
    }
  }

  return zones;
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

async function ocrZone(canvas) {
  const w = await ensureWorker();

  const direct = await w.recognize(canvas);
  const enhancedCanvas = preprocessCanvas(canvas);
  const enhanced = await w.recognize(enhancedCanvas);

  const dText = normalizeText(direct.data?.text || "");
  const eText = normalizeText(enhanced.data?.text || "");
  const dConf = Number(direct.data?.confidence || 0);
  const eConf = Number(enhanced.data?.confidence || 0);

  if (eConf > dConf) return { text: eText, confidence: eConf };
  return { text: dText, confidence: dConf };
}

function bestSuffixPrefixOverlap(left, right, minLen = 3) {
  const a = canonicalText(left);
  const b = canonicalText(right);
  const maxLen = Math.min(a.length, b.length, 24);

  for (let len = maxLen; len >= minLen; len -= 1) {
    if (a.slice(-len) === b.slice(0, len)) return a.slice(-len);
  }

  return "";
}

function informativeOverlap(s) {
  if (!s || s.length < 3) return false;
  const uniq = new Set(s.split(""));
  return uniq.size >= 2;
}

function pickZoneConsensus(reads) {
  const groups = [];

  for (const r of reads) {
    const text = normalizeText(r.text);
    if (!text || text.length < SETTINGS.minTextLength) continue;
    if (r.confidence < SETTINGS.minTextConfidence) continue;

    let target = null;
    for (const g of groups) {
      if (similarity(text, g.text) >= 0.8) {
        target = g;
        break;
      }
    }

    if (!target) {
      groups.push({
        text,
        support: 1,
        score: (r.confidence / 100) + r.quality,
        bestConfidence: r.confidence,
      });
      continue;
    }

    target.support += 1;
    target.score += (r.confidence / 100) + r.quality;
    if (r.confidence > target.bestConfidence) {
      target.bestConfidence = r.confidence;
      target.text = text;
    }
  }

  if (!groups.length) return null;
  return groups.sort((a, b) => b.support - a.support || b.score - a.score)[0];
}

function anchorBetween(leftReads, rightReads) {
  const bag = new Map();
  for (const l of leftReads) {
    for (const r of rightReads) {
      const o = bestSuffixPrefixOverlap(l.text, r.text, 3);
      if (!informativeOverlap(o)) continue;
      const k = o;
      if (!bag.has(k)) bag.set(k, { overlap: o, support: 0, score: 0 });
      const item = bag.get(k);
      item.support += 1;
      item.score += (l.confidence / 100) + (r.confidence / 100);
    }
  }
  if (!bag.size) return null;
  return [...bag.values()].sort((a, b) => b.support - a.support || b.overlap.length - a.overlap.length || b.score - a.score)[0];
}

function mergeByOverlap(a, b, overlap) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  const ov = canonicalText(overlap);
  if (!ov) return normalizeText(`${left} ${right}`);

  const lNorm = canonicalText(left);
  const rNorm = canonicalText(right);
  const idxL = lNorm.lastIndexOf(ov);
  const idxR = rNorm.indexOf(ov);
  if (idxL < 0 || idxR < 0) return normalizeText(`${left} ${right}`);

  const leftPart = left.slice(0, idxL + ov.length);
  const rightTail = right.slice(idxR + ov.length);
  return normalizeText(`${leftPart}${rightTail ? ` ${rightTail}` : ""}`);
}

function assembleRow(pieces) {
  if (!pieces.length) return "";
  pieces.sort((a, b) => a.col - b.col);
  let out = pieces[0].consensus.text;

  for (let i = 1; i < pieces.length; i += 1) {
    const left = pieces[i - 1];
    const right = pieces[i];
    const anchor = anchorBetween(left.reads, right.reads);
    if (anchor && anchor.support >= SETTINGS.minSupport) {
      out = mergeByOverlap(out, right.consensus.text, anchor.overlap);
    } else {
      out = normalizeText(`${out} ${right.consensus.text}`);
    }
  }

  return out;
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
      const q = frameQuality(canvas);
      if (q >= SETTINGS.minFrameQuality) {
        frames.push({ index: idx, canvas, quality: q });
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
  const q = frameQuality(frame);
  focusState.textContent = `Foco: ${Math.round(q * 100)}%`;
}

async function applyTrackConstraints(constraints) {
  if (!track) return;
  try {
    await track.applyConstraints({ advanced: [constraints] });
  } catch {
    // dispositivo sin soporte
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
  finalRaw.textContent = "Procesando OCR...";

  try {
    const frames = await captureFrames();
    if (!frames.length) throw new Error("No se capturaron frames legibles");

    const zones = buildZones(frames[0].canvas.width, frames[0].canvas.height);
    const rowMap = new Map();

    for (const zone of zones) {
      const candidates = [];
      for (const frame of frames) {
        const zoneCanvas = cropCanvas(frame.canvas, zone);
        const q = frameQuality(zoneCanvas);
        if (q < SETTINGS.minZoneQuality) continue;
        candidates.push({ zoneCanvas, quality: q });
      }

      candidates.sort((a, b) => b.quality - a.quality);
      const top = candidates.slice(0, 5);
      if (!top.length) continue;

      const reads = [];
      for (const c of top) {
        const res = await ocrZone(c.zoneCanvas);
        if (!res.text) continue;
        reads.push({ text: res.text, confidence: res.confidence, quality: c.quality });
      }

      const consensus = pickZoneConsensus(reads);
      if (!consensus || consensus.support < SETTINGS.minSupport) continue;

      if (!rowMap.has(zone.row)) rowMap.set(zone.row, []);
      rowMap.get(zone.row).push({ col: zone.col, reads, consensus });
    }

    const rows = [...rowMap.entries()].sort((a, b) => a[0] - b[0]);
    const finalLines = [];
    for (const [, pieces] of rows) {
      const line = assembleRow(pieces);
      if (line) finalLines.push(line);
    }

    const finalText = finalLines.join("\n");
    finalRaw.textContent = finalText || "No legible todavía. Reenfoca y acerca más.";
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
