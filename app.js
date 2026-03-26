const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const startCameraBtn = document.getElementById("startCameraBtn");
const captureBtn = document.getElementById("captureBtn");
const stopCameraBtn = document.getElementById("stopCameraBtn");
const modeSelect = document.getElementById("modeSelect");
const windowMsInput = document.getElementById("windowMs");
const sampleMsInput = document.getElementById("sampleMs");
const maxFramesInput = document.getElementById("maxFrames");
const minZoneQualityInput = document.getElementById("minZoneQuality");
const templateEditor = document.getElementById("templateEditor");
const applyTemplateBtn = document.getElementById("applyTemplateBtn");
const statusEl = document.getElementById("status");
const finalResultEl = document.getElementById("finalResult");
const zoneReadingsEl = document.getElementById("zoneReadings");

const DEFAULT_TEMPLATE = {
  id: "id-card-es-generic",
  documentRoi: { x: 0.08, y: 0.12, w: 0.84, h: 0.72 },
  zones: [
    { id: "nombre", x: 0.08, y: 0.18, w: 0.42, h: 0.1, psm: 7, kind: "name" },
    { id: "apellidos", x: 0.08, y: 0.29, w: 0.52, h: 0.12, psm: 7, kind: "name" },
    { id: "numero_documento", x: 0.56, y: 0.18, w: 0.36, h: 0.1, psm: 7, kind: "docNumber" },
    { id: "fecha_nacimiento", x: 0.56, y: 0.3, w: 0.3, h: 0.09, psm: 7, kind: "date" },
    { id: "sexo", x: 0.86, y: 0.3, w: 0.06, h: 0.09, psm: 10, kind: "sex" },
    { id: "nacionalidad", x: 0.56, y: 0.4, w: 0.3, h: 0.09, psm: 7, kind: "nationality" },
    { id: "mrz", x: 0.08, y: 0.77, w: 0.84, h: 0.18, psm: 6, kind: "mrz" },
  ],
};

const FIELD_RULES = {
  docNumber: {
    regex: /^[A-Z0-9]{6,12}$/,
    allowed: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  },
  date: {
    regex: /^(0[1-9]|[12][0-9]|3[01])[\\/-](0[1-9]|1[0-2])[\\/-](19|20)\\d{2}$/,
  },
  sex: {
    allowedSet: ["M", "F", "X"],
  },
  mrz: {
    regex: /^[A-Z0-9<\\n]{10,}$/,
    allowed: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<\\n",
  },
  name: {
    regex: /^[A-ZÁÉÍÓÚÜÑ' -]{2,}$/,
  },
  nationality: {
    regex: /^[A-Z]{2,3}$/,
  },
};

let stream = null;
let template = structuredClone(DEFAULT_TEMPLATE);
let busy = false;
let tesseractWorker = null;

function updateVideoLayout() {
  if (!video.videoWidth || !video.videoHeight) return;
  document.documentElement.style.setProperty("--video-ratio", `${video.videoWidth} / ${video.videoHeight}`);
}

function logStatus(message, data) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  statusEl.textContent = `${line}\n${statusEl.textContent}`.slice(0, 10000);
  if (data) {
    console.debug(message, data);
  }
}

function renderTemplateInEditor() {
  templateEditor.value = JSON.stringify(template, null, 2);
}

function applyTemplateFromEditor() {
  try {
    const parsed = JSON.parse(templateEditor.value);
    if (!Array.isArray(parsed.zones) || !parsed.documentRoi) {
      throw new Error("La plantilla debe incluir documentRoi y zones[]");
    }
    template = parsed;
    drawOverlay();
    logStatus("Plantilla aplicada");
  } catch (error) {
    logStatus(`Error en plantilla: ${error.message}`);
  }
}

async function startCamera() {
  if (stream) return;
  const isPortraitScreen = window.matchMedia("(orientation: portrait)").matches;

  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: isPortraitScreen ? { ideal: 1080 } : { ideal: 1920 },
      height: isPortraitScreen ? { ideal: 1920 } : { ideal: 1080 },
    },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute("playsinline", "true");
  await video.play();
  updateVideoLayout();
  drawOverlay();
  captureBtn.disabled = false;
  stopCameraBtn.disabled = false;
  startCameraBtn.disabled = true;
  logStatus("Cámara abierta");
}

function stopCamera() {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
  stream = null;
  captureBtn.disabled = true;
  stopCameraBtn.disabled = true;
  startCameraBtn.disabled = false;
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  logStatus("Cámara detenida");
}

function drawOverlay() {
  if (!video.videoWidth || !video.videoHeight) return;

  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;

  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  const roi = getDocumentRoi(modeSelect.value);
  const px = roi.x * overlay.width;
  const py = roi.y * overlay.height;
  const pw = roi.w * overlay.width;
  const ph = roi.h * overlay.height;

  ctx.strokeStyle = "#2ed48a";
  ctx.lineWidth = 4;
  ctx.strokeRect(px, py, pw, ph);

  ctx.font = "20px IBM Plex Sans";
  ctx.fillStyle = "#2ed48a";
  ctx.fillText(modeSelect.value === "guide" ? "GUÍA" : "BARRIDO", px + 8, py + 24);

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(46, 212, 138, 0.7)";

  for (const zone of template.zones) {
    const zx = px + zone.x * pw;
    const zy = py + zone.y * ph;
    const zw = zone.w * pw;
    const zh = zone.h * ph;

    ctx.strokeRect(zx, zy, zw, zh);
    ctx.fillText(zone.id, zx + 4, zy + 18);
  }
}

function getDocumentRoi(mode) {
  if (mode === "sweep") {
    return { x: 0.03, y: 0.05, w: 0.94, h: 0.9 };
  }
  return template.documentRoi;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function frameToCanvasFrame(videoEl) {
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

function toPixelsRect(normRect, baseRect) {
  return {
    x: baseRect.x + normRect.x * baseRect.w,
    y: baseRect.y + normRect.y * baseRect.h,
    w: normRect.w * baseRect.w,
    h: normRect.h * baseRect.h,
  };
}

function qualityMetrics(zoneCanvas) {
  const ctx = zoneCanvas.getContext("2d", { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(0, 0, zoneCanvas.width, zoneCanvas.height);

  let mean = 0;
  let brightPixels = 0;
  let darkPixels = 0;
  const gray = new Uint8Array(width * height);

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const g = Math.round((data[i] + data[i + 1] + data[i + 2]) / 3);
    gray[p] = g;
    mean += g;
    if (g > 245) brightPixels += 1;
    if (g < 20) darkPixels += 1;
  }

  mean /= gray.length;

  let variance = 0;
  for (let i = 0; i < gray.length; i += 1) {
    const d = gray[i] - mean;
    variance += d * d;
  }
  variance /= gray.length;

  // Aproximación de nitidez por gradiente horizontal/vertical
  let sharpnessSum = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      const gx = gray[idx + 1] - gray[idx - 1];
      const gy = gray[idx + width] - gray[idx - width];
      sharpnessSum += Math.abs(gx) + Math.abs(gy);
    }
  }

  const normSharpness = sharpnessSum / Math.max(1, (width - 2) * (height - 2));
  const brightRatio = brightPixels / gray.length;
  const darkRatio = darkPixels / gray.length;

  const exposurePenalty = clamp(brightRatio * 1.8 + darkRatio * 1.2, 0, 1);
  const contrastScore = clamp(variance / 2200, 0, 1);
  const sharpnessScore = clamp(normSharpness / 28, 0, 1);
  const exposureScore = 1 - exposurePenalty;

  const quality = clamp(0.55 * sharpnessScore + 0.3 * contrastScore + 0.15 * exposureScore, 0, 1);

  return {
    quality,
    sharpnessScore,
    contrastScore,
    exposureScore,
    meanLuma: mean,
    brightRatio,
    darkRatio,
  };
}

function normalizeRawText(text) {
  return text.replace(/\s+/g, " ").trim().toUpperCase();
}

function normalizeByKind(text, kind) {
  let s = normalizeRawText(text);

  if (!s) return s;

  // Ajustes OCR comunes para comparación, sin inventar valores arbitrarios.
  if (kind === "docNumber" || kind === "mrz" || kind === "date") {
    s = s.replace(/[|]/g, "1");
    s = s.replace(/[“”"`´]/g, "");
  }

  if (kind === "docNumber") {
    s = s.replace(/\s/g, "");
    s = s.replace(/O/g, "0");
    s = s.replace(/[IL]/g, "1");
    s = s.replace(/S/g, "5");
    s = s.replace(/B/g, "8");
    s = s.replace(/Z/g, "2");
  }

  if (kind === "date") {
    s = s.replace(/\./g, "/").replace(/-/g, "/");
    s = s.replace(/O/g, "0");
    s = s.replace(/[IL]/g, "1");
    s = s.replace(/\s+/g, "");

    const m = s.match(/^(\d{2})[\/](\d{2})[\/](\d{4})$/);
    if (m) s = `${m[1]}/${m[2]}/${m[3]}`;
  }

  if (kind === "sex") {
    s = s.replace(/[^A-Z]/g, "");
    if (s.startsWith("H")) s = "M";
    if (s.startsWith("V")) s = "M";
    if (s.startsWith("W")) s = "F";
    s = s.slice(0, 1);
  }

  if (kind === "mrz") {
    s = s.replace(/\s/g, "");
    s = s.replace(/0(?=[A-Z<])/g, "O");
    s = s.replace(/[^A-Z0-9<\n]/g, "");
  }

  if (kind === "name") {
    s = s.replace(/\d/g, "");
    s = s.replace(/[!|]/g, "I");
    s = s.replace(/0/g, "O");
    s = s.replace(/[^A-ZÁÉÍÓÚÜÑ' -]/g, "");
  }

  return s.trim();
}

function validateField(value, kind) {
  if (!value) return { ok: false, reason: "vacío" };
  const rule = FIELD_RULES[kind];
  if (!rule) return { ok: true, reason: "sin-regla" };

  if (rule.allowedSet && !rule.allowedSet.includes(value)) {
    return { ok: false, reason: "fuera-conjunto" };
  }

  if (rule.allowed) {
    for (const ch of value) {
      if (!rule.allowed.includes(ch)) {
        return { ok: false, reason: `char-inválido:${ch}` };
      }
    }
  }

  if (rule.regex && !rule.regex.test(value)) {
    return { ok: false, reason: "regex" };
  }

  return { ok: true, reason: "ok" };
}

function isLikelyOcrError(normalized, kind, ocrConfidence) {
  if (!normalized) return true;
  if (ocrConfidence < 18) return true;

  if (kind === "docNumber" && normalized.length < 6) return true;
  if (kind === "date" && normalized.length < 8) return true;
  if (kind === "mrz" && normalized.length < 10) return true;
  if (kind === "name" && normalized.length < 2) return true;

  return false;
}

async function ensureWorker() {
  if (tesseractWorker) return tesseractWorker;
  tesseractWorker = await Tesseract.createWorker("spa+eng", 1, {
    logger: (msg) => {
      if (msg.status === "recognizing text") {
        statusEl.textContent = `[OCR ${Math.round((msg.progress || 0) * 100)}%]\n${statusEl.textContent}`.slice(0, 10000);
      }
    },
  });
  return tesseractWorker;
}

function collectZoneCandidates(frames, zones, minZoneQuality) {
  const byZone = {};

  for (const zone of zones) {
    byZone[zone.id] = [];
  }

  for (const frame of frames) {
    for (const zoneEval of frame.zoneEvals) {
      byZone[zoneEval.zoneId].push({
        frameIndex: frame.frameIndex,
        tsMs: frame.tsMs,
        zoneId: zoneEval.zoneId,
        zoneCanvas: zoneEval.zoneCanvas,
        quality: zoneEval.quality.quality,
        qualityMetrics: zoneEval.quality,
      });
    }
  }

  for (const zoneId of Object.keys(byZone)) {
    byZone[zoneId].sort((a, b) => b.quality - a.quality);
    byZone[zoneId] = byZone[zoneId].map((candidate) => ({
      ...candidate,
      includeInOcr: candidate.quality >= minZoneQuality,
    }));
  }

  return byZone;
}

async function runZoneOCR(candidatesByZone, zonesById) {
  const worker = await ensureWorker();
  const readings = {};

  for (const zoneId of Object.keys(candidatesByZone)) {
    const zone = zonesById[zoneId];
    readings[zoneId] = [];

    for (const candidate of candidatesByZone[zoneId]) {
      if (!candidate.includeInOcr) {
        readings[zoneId].push({
          ...candidate,
          skipped: true,
          skipReason: "zona descartada por calidad",
        });
        continue;
      }

      await worker.setParameters({
        tessedit_pageseg_mode: String(zone.psm || 7),
        preserve_interword_spaces: "1",
      });

      const {
        data: { text, confidence },
      } = await worker.recognize(candidate.zoneCanvas);

      readings[zoneId].push({
        ...candidate,
        skipped: false,
        textRaw: text || "",
        ocrConfidence: typeof confidence === "number" ? confidence : 0,
      });
    }
  }

  return readings;
}

function consensusForZone(zoneId, zone, zoneReadings) {
  const validReadings = zoneReadings.filter((r) => !r.skipped && r.textRaw && r.textRaw.trim());

  if (!validReadings.length) {
    return {
      zoneId,
      value: "",
      confidence: 0,
      sourceFrame: null,
      candidates: [],
      reason: "sin-lecturas",
    };
  }

  const grouped = new Map();

  for (const r of validReadings) {
    const normalized = normalizeByKind(r.textRaw, zone.kind);
    const validation = validateField(normalized, zone.kind);
    const readingLooksWrong = isLikelyOcrError(normalized, zone.kind, r.ocrConfidence || 0);

    if (readingLooksWrong) {
      continue;
    }

    if (!grouped.has(normalized)) {
      grouped.set(normalized, {
        normalized,
        count: 0,
        weightedScore: 0,
        bestRead: null,
        validationOkCount: 0,
        validationReasons: new Set(),
      });
    }

    const g = grouped.get(normalized);
    g.count += 1;
    const ocr = clamp((r.ocrConfidence || 0) / 100, 0, 1);
    const q = clamp(r.quality, 0, 1);
    const readScore = 0.58 * ocr + 0.42 * q;
    g.weightedScore += readScore;
    if (!g.bestRead || readScore > g.bestRead.score) {
      g.bestRead = { ...r, score: readScore, normalized };
    }
    if (validation.ok) g.validationOkCount += 1;
    g.validationReasons.add(validation.reason);
  }

  if (!grouped.size) {
    return {
      zoneId,
      value: "",
      confidence: 0,
      sourceFrame: null,
      candidates: [],
      reason: "lecturas-descartadas-como-error",
    };
  }

  const ranked = [...grouped.values()].sort((a, b) => {
    const aScore = a.weightedScore + a.count * 0.35 + a.validationOkCount * 0.5;
    const bScore = b.weightedScore + b.count * 0.35 + b.validationOkCount * 0.5;
    return bScore - aScore;
  });

  const winner = ranked[0];
  const winnerValidation = validateField(winner.normalized, zone.kind);

  return {
    zoneId,
    value: winner.normalized,
    confidence: clamp((winner.weightedScore / Math.max(1, winner.count)) * 100, 0, 100),
    sourceFrame: winner.bestRead?.frameIndex ?? null,
    validation: winnerValidation,
    candidates: ranked.map((r) => ({
      value: r.normalized,
      count: r.count,
      score: Number(r.weightedScore.toFixed(3)),
      validationOkCount: r.validationOkCount,
    })),
    reason: "consenso-zona",
  };
}

function buildFinalByPieces(zones, readingsByZone) {
  const final = {};
  const debug = {};

  for (const zone of zones) {
    const zoneResult = consensusForZone(zone.id, zone, readingsByZone[zone.id] || []);
    final[zone.id] = {
      value: zoneResult.value,
      confidence: Number(zoneResult.confidence.toFixed(1)),
      sourceFrame: zoneResult.sourceFrame,
      valid: zoneResult.validation?.ok ?? false,
      reason: zoneResult.reason,
    };
    debug[zone.id] = zoneResult;
  }

  return { final, debug };
}

function renderOutputs(result, readingsByZone) {
  finalResultEl.textContent = JSON.stringify(result.final, null, 2);

  const view = {};
  for (const [zoneId, readings] of Object.entries(readingsByZone)) {
    view[zoneId] = readings.map((r) => {
      if (r.skipped) {
        return {
          frame: r.frameIndex,
          tsMs: r.tsMs,
          quality: Number(r.quality.toFixed(3)),
          skipped: true,
          why: r.skipReason,
        };
      }

      const kind = template.zones.find((z) => z.id === zoneId)?.kind;
      return {
        frame: r.frameIndex,
        tsMs: r.tsMs,
        quality: Number(r.quality.toFixed(3)),
        ocrConfidence: Number((r.ocrConfidence || 0).toFixed(1)),
        raw: (r.textRaw || "").trim(),
        normalized: normalizeByKind(r.textRaw || "", kind),
      };
    });
  }

  zoneReadingsEl.textContent = JSON.stringify(
    {
      zoneReadings: view,
      consensus: result.debug,
    },
    null,
    2
  );
}

async function captureAndProcess() {
  if (!stream || busy) return;

  busy = true;
  captureBtn.disabled = true;
  statusEl.textContent = "";

  try {
    const mode = modeSelect.value;
    const windowMs = clamp(Number(windowMsInput.value) || 3000, 1000, 6000);
    const sampleMs = clamp(Number(sampleMsInput.value) || 180, 80, 500);
    const maxFrames = clamp(Number(maxFramesInput.value) || 15, 5, 30);
    const minZoneQuality = clamp(Number(minZoneQualityInput.value) || 0.28, 0.05, 0.95);

    logStatus(`Inicio captura modo=${mode} ventana=${windowMs}ms sample=${sampleMs}ms qMin=${minZoneQuality}`);

    const frames = [];
    const start = performance.now();
    let nextShot = start;
    let frameIndex = 0;

    while (performance.now() - start < windowMs && frames.length < maxFrames) {
      const now = performance.now();
      if (now >= nextShot) {
        const baseCanvas = frameToCanvasFrame(video);
        const docRoiNorm = getDocumentRoi(mode);
        const docRectPx = {
          x: docRoiNorm.x * baseCanvas.width,
          y: docRoiNorm.y * baseCanvas.height,
          w: docRoiNorm.w * baseCanvas.width,
          h: docRoiNorm.h * baseCanvas.height,
        };

        const zoneEvals = template.zones.map((zone) => {
          const zonePx = toPixelsRect(zone, docRectPx);
          const zoneCanvas = cropCanvas(baseCanvas, zonePx);
          const quality = qualityMetrics(zoneCanvas);

          return {
            zoneId: zone.id,
            zoneCanvas,
            quality,
          };
        });

        frames.push({
          frameIndex,
          tsMs: Math.round(now - start),
          zoneEvals,
        });

        logStatus(`Frame ${frameIndex} capturado`);
        frameIndex += 1;
        nextShot += sampleMs;
      }
      await sleep(25);
    }

    logStatus(`Frames capturados: ${frames.length}`);

    if (!frames.length) {
      throw new Error("No se capturaron frames");
    }

    const candidatesByZone = collectZoneCandidates(frames, template.zones, minZoneQuality);

    for (const [zoneId, cands] of Object.entries(candidatesByZone)) {
      const usable = cands.filter((c) => c.includeInOcr).length;
      logStatus(`Zona ${zoneId}: muestras=${cands.length} paraOCR=${usable}`);
    }

    const zonesById = Object.fromEntries(template.zones.map((z) => [z.id, z]));
    const readingsByZone = await runZoneOCR(candidatesByZone, zonesById);
    const result = buildFinalByPieces(template.zones, readingsByZone);

    renderOutputs(result, readingsByZone);
    logStatus("OCR por zonas completado");
  } catch (error) {
    logStatus(`Error: ${error.message}`);
  } finally {
    captureBtn.disabled = false;
    busy = false;
  }
}

startCameraBtn.addEventListener("click", async () => {
  try {
    await startCamera();
  } catch (error) {
    logStatus(`No se pudo abrir cámara: ${error.message}`);
  }
});

stopCameraBtn.addEventListener("click", () => {
  stopCamera();
});

captureBtn.addEventListener("click", captureAndProcess);
applyTemplateBtn.addEventListener("click", applyTemplateFromEditor);

modeSelect.addEventListener("change", drawOverlay);
window.addEventListener("resize", drawOverlay);
video.addEventListener("loadedmetadata", () => {
  updateVideoLayout();
  drawOverlay();
});
video.addEventListener("playing", () => {
  updateVideoLayout();
  drawOverlay();
});

renderTemplateInEditor();
finalResultEl.textContent = "Esperando captura...";
zoneReadingsEl.textContent = "Esperando captura...";
statusEl.textContent = "Listo.";
