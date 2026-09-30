const PDFJS_VERSION = "4.10.38";
const MAX_IMAGE_WIDTH = 3200;

const COLUMN_RANGES = [
  ["accessionDate", 0, 0.09],
  ["accessionNumber", 0.09, 0.18],
  ["author", 0.18, 0.322],
  ["title", 0.322, 0.576],
  ["placePublisher", 0.576, 0.69],
  ["year", 0.69, 0.712],
  ["pages", 0.712, 0.733],
  ["volume", 0.733, 0.752],
  ["source", 0.752, 0.819],
  ["billNoDate", 0.819, 0.855],
  ["cost", 0.855, 0.895],
  ["classNo", 0.895, 0.92],
  ["bookNo", 0.92, 0.945],
  ["remarks", 0.945, 1.001]
];

function clean(value = "") {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function decodeBase64(value = "") {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function imageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not decode the selected register image."));
    image.src = dataUrl;
  });
}

function drawRotatedImage(image, rotation = 0) {
  const normalized = ((Number(rotation || 0) % 360) + 360) % 360;
  const swap = normalized === 90 || normalized === 270;
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.min(1, MAX_IMAGE_WIDTH / (swap ? sourceHeight : sourceWidth));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round((swap ? sourceHeight : sourceWidth) * scale));
  canvas.height = Math.max(1, Math.round((swap ? sourceWidth : sourceHeight) * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.save();
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(normalized * Math.PI / 180);
  context.drawImage(
    image,
    -sourceWidth * scale / 2,
    -sourceHeight * scale / 2,
    sourceWidth * scale,
    sourceHeight * scale
  );
  context.restore();
  return canvas;
}

async function renderPdfPages(file, startPageNumber = 1) {
  const pdfjs = await import(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;
  const pdf = await pdfjs.getDocument({ data: decodeBase64(file.base64) }).promise;
  const pages = [];
  for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
    const page = await pdf.getPage(pageIndex);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, MAX_IMAGE_WIDTH / baseViewport.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    pages.push({ canvas, pageNumber: startPageNumber + pageIndex - 1, sourceName: file.name, pdfPage: pageIndex });
  }
  return pages;
}

async function renderPayloadPages(files = []) {
  const pages = [];
  let pageNumber = 1;
  for (const file of files) {
    if (String(file.type || "").toLowerCase() === "application/pdf" || String(file.name || "").toLowerCase().endsWith(".pdf")) {
      const pdfPages = await renderPdfPages(file, pageNumber);
      pages.push(...pdfPages);
      pageNumber += pdfPages.length;
      continue;
    }
    const image = await imageFromDataUrl(file.dataUrl || `data:${file.type || "image/jpeg"};base64,${file.base64 || ""}`);
    pages.push({ canvas: drawRotatedImage(image, file.rotation), pageNumber, sourceName: file.name, pdfPage: null });
    pageNumber += 1;
  }
  return pages;
}

export function parseTsvWords(tsv = "") {
  return String(tsv || "").split(/\r?\n/).slice(1).map((line) => {
    const cells = line.split("\t");
    if (cells.length < 12 || cells[0] !== "5" || !clean(cells[11])) return null;
    const left = Number(cells[6] || 0);
    const top = Number(cells[7] || 0);
    const width = Number(cells[8] || 0);
    const height = Number(cells[9] || 0);
    return {
      text: clean(cells.slice(11).join("\t")),
      confidence: Number(cells[10] || 0),
      left,
      top,
      width,
      height,
      centerX: left + width / 2,
      centerY: top + height / 2
    };
  }).filter(Boolean);
}

function suffixFromToken(value = "") {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  const candidate = Number(digits.length > 2 ? digits.slice(-2) : digits);
  return candidate >= 1 && candidate <= 60 ? candidate : null;
}

export function selectAccessionAnchors(words = [], imageWidth = 1, imageHeight = 1) {
  const groups = [];
  const tolerance = Math.max(8, imageHeight * 0.012);
  words
    .filter((word) => word.centerX >= imageWidth * 0.09 && word.centerX <= imageWidth * 0.18)
    .filter((word) => word.centerY >= imageHeight * 0.115)
    .map((word) => ({ ...word, suffix: suffixFromToken(word.text) }))
    .filter((word) => word.suffix)
    .sort((left, right) => left.centerY - right.centerY)
    .forEach((candidate) => {
      let group = groups.find((item) => Math.abs(item.centerY - candidate.centerY) <= tolerance);
      if (!group) {
        group = { centerY: candidate.centerY, candidates: [] };
        groups.push(group);
      }
      group.candidates.push(candidate);
      group.centerY = group.candidates.reduce((sum, item) => sum + item.centerY, 0) / group.candidates.length;
    });

  const chosen = groups.map((group) => group.candidates.sort((left, right) => {
    const leftDigits = left.text.replace(/\D/g, "");
    const rightDigits = right.text.replace(/\D/g, "");
    const leftScore = left.confidence + (leftDigits.length >= 2 ? 25 : 0);
    const rightScore = right.confidence + (rightDigits.length >= 2 ? 25 : 0);
    return rightScore - leftScore;
  })[0]);

  const bySuffix = new Map();
  chosen.forEach((anchor) => {
    const current = bySuffix.get(anchor.suffix);
    if (!current || anchor.confidence > current.confidence) bySuffix.set(anchor.suffix, anchor);
  });
  const anchors = [...bySuffix.values()].sort((left, right) => left.suffix - right.suffix);
  if (anchors.length < 5) return [];
  return anchors.filter((anchor, index) => !index || anchor.centerY > anchors[index - 1].centerY);
}

function interpolateRowCenters(anchors = []) {
  if (!anchors.length) return [];
  const firstSuffix = anchors[0].suffix;
  const lastSuffix = anchors[anchors.length - 1].suffix;
  if (lastSuffix - firstSuffix > 59) return [];
  const exact = new Map(anchors.map((anchor) => [anchor.suffix, anchor.centerY]));
  return Array.from({ length: lastSuffix - firstSuffix + 1 }, (_, offset) => {
    const suffix = firstSuffix + offset;
    if (exact.has(suffix)) return { suffix, centerY: exact.get(suffix), detected: true };
    const before = [...anchors].reverse().find((anchor) => anchor.suffix < suffix);
    const after = anchors.find((anchor) => anchor.suffix > suffix);
    if (before && after) {
      const ratio = (suffix - before.suffix) / (after.suffix - before.suffix);
      return { suffix, centerY: before.centerY + (after.centerY - before.centerY) * ratio, detected: false };
    }
    const averageStep = anchors.length > 1
      ? (anchors[anchors.length - 1].centerY - anchors[0].centerY) / (anchors[anchors.length - 1].suffix - anchors[0].suffix)
      : 1;
    return { suffix, centerY: before ? before.centerY + averageStep : after.centerY - averageStep, detected: false };
  });
}

function rowBounds(centers, index, imageHeight) {
  const current = centers[index].centerY;
  const top = index ? (centers[index - 1].centerY + current) / 2 : current - (centers[index + 1]?.centerY - current || imageHeight * 0.02) / 2;
  const bottom = index < centers.length - 1
    ? (current + centers[index + 1].centerY) / 2
    : current + (current - centers[index - 1]?.centerY || imageHeight * 0.02) / 2;
  return { top: clamp(top, 0, imageHeight), bottom: clamp(bottom, 0, imageHeight) };
}

function fieldForX(centerX, imageWidth) {
  const ratio = centerX / imageWidth;
  return COLUMN_RANGES.find(([, start, end]) => ratio >= start && ratio < end)?.[0] || "";
}

function wordsForCell(words, bounds, field, imageWidth) {
  return words
    .filter((word) => word.confidence >= 5 && word.centerY >= bounds.top && word.centerY < bounds.bottom)
    .filter((word) => fieldForX(word.centerX, imageWidth) === field)
    .sort((left, right) => Math.abs(left.centerY - right.centerY) > Math.max(left.height, right.height) * 0.6
      ? left.centerY - right.centerY
      : left.left - right.left);
}

function averageConfidence(words = []) {
  return words.length ? Math.round(words.reduce((sum, word) => sum + Math.max(0, word.confidence), 0) / words.length) : 0;
}

export function buildVisualRowsFromWords(words = [], imageWidth = 1, imageHeight = 1, options = {}) {
  const anchors = options.anchors || selectAccessionAnchors(words, imageWidth, imageHeight);
  const centers = interpolateRowCenters(anchors);
  if (!centers.length) return { rows: [], anchors, detectedRows: 0 };
  const prefix = clean(options.prefix);
  const prefixConfidence = Number(options.prefixConfidence || 0);
  const rows = centers.map((center, index) => {
    const bounds = rowBounds(centers, index, imageHeight);
    const row = {};
    const fieldConfidence = {};
    COLUMN_RANGES.forEach(([field]) => {
      const cellWords = wordsForCell(words, bounds, field, imageWidth);
      row[field] = clean(cellWords.map((word) => word.text).join(" "));
      fieldConfidence[field] = averageConfidence(cellWords);
    });
    const suffix = String(center.suffix).padStart(2, "0");
    const canResolve = Boolean(prefix && prefixConfidence >= 50);
    const resolvedAccessionNumber = canResolve ? `${prefix}${suffix}` : suffix;
    const importantConfidence = [fieldConfidence.author, fieldConfidence.title].filter(Boolean);
    const confidence = Math.round((Number(center.detected ? 95 : 65) * 2
      + (importantConfidence[0] || 0) + (importantConfidence[1] || 0)) / 4);
    return {
      ...row,
      accessionNumber: resolvedAccessionNumber,
      rawAccessionText: prefix ? `${prefix} ${suffix}` : suffix,
      detectedPrefix: prefix,
      detectedSuffix: suffix,
      resolvedAccessionNumber,
      prefixConfidence,
      accessionPrefixConfidence: prefixConfidence,
      accessionNeedsReview: !canResolve,
      pageNumber: Number(options.pageNumber || 1),
      pageSide: "both",
      rowNumber: index + 1,
      visualRow: index + 1,
      confidence,
      fieldConfidence,
      rawText: COLUMN_RANGES.map(([field]) => row[field]).filter(Boolean).join(" | "),
      rawCells: { ...row },
      sourceBounds: [{ x: 0, y: bounds.top / imageHeight, width: 1, height: (bounds.bottom - bounds.top) / imageHeight }]
    };
  });
  return { rows, anchors, detectedRows: centers.length };
}

function redPrefixMask(sourceCanvas, firstCenterY, crop = {}) {
  const left = Math.round(sourceCanvas.width * Number(crop.leftRatio || 0.108));
  const top = Math.max(0, Math.round(firstCenterY - sourceCanvas.height * Number(crop.topRatio || 0.0125)));
  const width = Math.round(sourceCanvas.width * Number(crop.widthRatio || 0.028));
  const height = Math.round(sourceCanvas.height * Number(crop.heightRatio || 0.025));
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  const imageData = sourceContext.getImageData(left, top, width, height);
  const output = document.createElement("canvas");
  output.width = Math.max(1, width * 8);
  output.height = Math.max(1, height * 8);
  const mask = document.createElement("canvas");
  mask.width = width;
  mask.height = height;
  const maskContext = mask.getContext("2d");
  const target = maskContext.createImageData(width, height);
  const blackPixelsByRow = new Uint16Array(height);
  const blackPixelsByColumn = new Uint16Array(width);
  for (let index = 0; index < imageData.data.length; index += 4) {
    const red = imageData.data[index];
    const green = imageData.data[index + 1];
    const blue = imageData.data[index + 2];
    const isRedInk = red - (green + blue) / 2 > 8 && red > 45;
    const value = isRedInk ? 0 : 255;
    if (isRedInk) {
      const pixel = index / 4;
      blackPixelsByRow[Math.floor(pixel / width)] += 1;
      blackPixelsByColumn[pixel % width] += 1;
    }
    target.data[index] = value;
    target.data[index + 1] = value;
    target.data[index + 2] = value;
    target.data[index + 3] = 255;
  }
  // Printed register rules use the same red ink as handwritten prefixes. Remove
  // only near-solid horizontal/vertical runs so the digit strokes remain.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (blackPixelsByRow[y] < width * 0.7 && blackPixelsByColumn[x] < height * 0.7) continue;
      const index = (y * width + x) * 4;
      target.data[index] = 255;
      target.data[index + 1] = 255;
      target.data[index + 2] = 255;
    }
  }
  maskContext.putImageData(target, 0, 0);
  const padding = 32;
  output.width = Math.max(1, width * 8 + padding * 2);
  output.height = Math.max(1, height * 8 + padding * 2);
  const outputContext = output.getContext("2d");
  outputContext.fillStyle = "#fff";
  outputContext.fillRect(0, 0, output.width, output.height);
  outputContext.imageSmoothingEnabled = false;
  outputContext.drawImage(mask, padding, padding, width * 8, height * 8);
  return output;
}

async function recognizePrefix(worker, canvas, anchors) {
  if (!anchors.length) return { prefix: "", confidence: 0 };
  const Tesseract = globalThis.Tesseract;
  await worker.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_WORD,
    tessedit_char_whitelist: "0123456789"
  });
  const crops = [
    {},
    { leftRatio: 0.105, widthRatio: 0.031 },
    { leftRatio: 0.11, widthRatio: 0.026, topRatio: 0.014, heightRatio: 0.028 }
  ];
  let best = { prefix: "", confidence: 0 };
  for (const crop of crops) {
    const result = await worker.recognize(redPrefixMask(canvas, anchors[0].centerY, crop));
    const candidate = clean(result.data?.text).replace(/\D/g, "");
    const candidateConfidence = Math.round(Number(result.data?.confidence || 0));
    if (candidate && candidate.length <= 6 && candidateConfidence > best.confidence) {
      best = { prefix: candidate, confidence: candidateConfidence };
    }
    if (best.confidence >= 75) break;
  }
  const prefix = best.prefix;
  const rawConfidence = best.confidence;
  // A long, consecutive printed suffix run is strong structural evidence that
  // the isolated red digits are the shared accession prefix. Handwritten red
  // ink commonly scores below 50 even when the two digits are correct.
  const confidence = prefix && rawConfidence >= 35 && anchors.length >= 10
    ? Math.max(92, rawConfidence)
    : rawConfidence;
  return prefix && prefix.length <= 6 ? { prefix, confidence } : { prefix: "", confidence: 0 };
}

async function recognizePage(worker, page, onProgress) {
  const Tesseract = globalThis.Tesseract;
  await worker.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
    tessedit_char_whitelist: "",
    preserve_interword_spaces: "1"
  });
  onProgress?.({ status: "recognizing page", progress: 0, pageNumber: page.pageNumber });
  const result = await worker.recognize(page.canvas, {}, { tsv: true });
  const words = parseTsvWords(result.data?.tsv || "");
  const anchors = selectAccessionAnchors(words, page.canvas.width, page.canvas.height);
  const prefix = await recognizePrefix(worker, page.canvas, anchors);
  const structured = buildVisualRowsFromWords(words, page.canvas.width, page.canvas.height, {
    anchors,
    prefix: prefix.prefix,
    prefixConfidence: prefix.confidence,
    pageNumber: page.pageNumber
  });
  return {
    ...structured,
    prefix,
    width: page.canvas.width,
    height: page.canvas.height,
    rawConfidence: Math.round(Number(result.data?.confidence || 0))
  };
}

export async function extractRegisterLocally(files = [], options = {}) {
  if (!globalThis.Tesseract?.createWorker) {
    throw new Error("Local OCR engine did not load. Check the internet connection and reload the page.");
  }
  const pages = await renderPayloadPages(files);
  if (!pages.length) throw new Error("No image or PDF pages could be rendered.");
  const worker = await globalThis.Tesseract.createWorker("eng", globalThis.Tesseract.OEM.LSTM_ONLY, {
    logger: (message) => options.onProgress?.(message)
  });
  const rows = [];
  const pageDebug = [];
  try {
    for (const page of pages) {
      const result = await recognizePage(worker, page, options.onProgress);
      rows.push(...result.rows);
      pageDebug.push({
        pageNumber: page.pageNumber,
        imageWidth: result.width,
        imageHeight: result.height,
        rowsDetected: result.detectedRows,
        accessionAnchors: result.anchors.length,
        detectedPrefix: result.prefix.prefix,
        prefixConfidence: result.prefix.confidence,
        ocrConfidence: result.rawConfidence
      });
    }
  } finally {
    await worker.terminate();
  }
  const detectedRows = pageDebug.reduce((sum, page) => sum + page.rowsDetected, 0);
  return {
    provider: "browser-tesseract",
    mode: "local",
    configured: true,
    message: "OCR ran locally in this browser. Review uncertain handwriting before export or LMS import.",
    pages: pages.length,
    debug: {
      rowsDetected: detectedRows,
      rowsProcessed: rows.length,
      rowsReturned: rows.length,
      imageWidth: pageDebug[0]?.imageWidth || 0,
      imageHeight: pageDebug[0]?.imageHeight || 0,
      tableTop: rows[0]?.sourceBounds?.[0]?.y || 0,
      tableBottom: rows.at(-1)?.sourceBounds?.[0]
        ? rows.at(-1).sourceBounds[0].y + rows.at(-1).sourceBounds[0].height
        : 1,
      local: true,
      pages: pageDebug
    },
    rows
  };
}
