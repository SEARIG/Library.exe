const PDFJS_VERSION = "4.10.38";
const MAX_IMAGE_WIDTH = 3200;
const CURRENT_YEAR = new Date().getFullYear();

export const DEFAULT_COLUMN_LAYOUT = [
  { field: "accessionDate", start: 0, end: 0.09 },
  { field: "accessionNumber", start: 0.09, end: 0.18 },
  { field: "author", start: 0.18, end: 0.322 },
  { field: "title", start: 0.322, end: 0.576 },
  { field: "placePublisher", start: 0.576, end: 0.69 },
  { field: "year", start: 0.69, end: 0.712 },
  { field: "pages", start: 0.712, end: 0.733 },
  { field: "volume", start: 0.733, end: 0.752 },
  { field: "source", start: 0.752, end: 0.819 },
  { field: "billNoDate", start: 0.819, end: 0.855 },
  { field: "cost", start: 0.855, end: 0.895 },
  { field: "classNo", start: 0.895, end: 0.92 },
  { field: "bookNo", start: 0.92, end: 0.945 },
  { field: "remarks", start: 0.945, end: 1 }
];

const GENERAL_TEXT_FIELDS = new Set(["author", "title", "placePublisher"]);
const MULTILINE_FIELDS = new Set(["author", "title", "placePublisher", "remarks"]);
const REQUIRED_OCR_FIELDS = new Set(["accessionNumber"]);

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
  context.drawImage(image, -sourceWidth * scale / 2, -sourceHeight * scale / 2, sourceWidth * scale, sourceHeight * scale);
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
    const canvas = drawRotatedImage(image, file.rotation);
    pages.push({ canvas, pageNumber, sourceName: file.name, pdfPage: null });
    pageNumber += 1;
  }
  return pages;
}

function isRedPixel(red, green, blue) {
  return red > 45 && red - (green + blue) / 2 > 8;
}

function grayscale(red, green, blue) {
  return Math.round(red * 0.299 + green * 0.587 + blue * 0.114);
}

function rotateCanvasSameSize(sourceCanvas, degrees) {
  if (Math.abs(degrees) < 0.1) return sourceCanvas;
  const output = document.createElement("canvas");
  output.width = sourceCanvas.width;
  output.height = sourceCanvas.height;
  const context = output.getContext("2d", { willReadFrequently: true });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, output.width, output.height);
  context.translate(output.width / 2, output.height / 2);
  context.rotate(degrees * Math.PI / 180);
  context.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2);
  return output;
}

function estimateSkewDegrees(canvas) {
  const image = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  const points = [];
  const step = Math.max(3, Math.round(canvas.width / 1000));
  for (let y = Math.round(canvas.height * 0.1); y < canvas.height * 0.98; y += step) {
    for (let x = 0; x < canvas.width; x += step) {
      const index = (y * canvas.width + x) * 4;
      if (isRedPixel(image[index], image[index + 1], image[index + 2])) points.push([x, y]);
    }
  }
  if (points.length < 500) return 0;
  const sample = points.length > 30000 ? points.filter((_, index) => index % Math.ceil(points.length / 30000) === 0) : points;
  let best = { angle: 0, score: -1 };
  for (let angle = -2.5; angle <= 2.5; angle += 0.25) {
    const tangent = Math.tan(angle * Math.PI / 180);
    const histogram = new Uint16Array(canvas.height + 20);
    sample.forEach(([x, y]) => {
      const correctedY = Math.round(y - tangent * (x - canvas.width / 2));
      if (correctedY >= 0 && correctedY < histogram.length) histogram[correctedY] += 1;
    });
    const score = [...histogram].sort((left, right) => right - left).slice(0, 35).reduce((sum, value) => sum + value * value, 0);
    if (score > best.score) best = { angle, score };
  }
  return Math.abs(best.angle) < 0.2 ? 0 : Number(best.angle.toFixed(2));
}

function estimateImageQuality(canvas, skewDegrees = 0) {
  const image = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  const samples = [];
  const step = Math.max(4, Math.round(Math.sqrt((canvas.width * canvas.height) / 120000)));
  let glare = 0;
  let edgeTotal = 0;
  let edgeCount = 0;
  for (let y = step; y < canvas.height - step; y += step) {
    for (let x = step; x < canvas.width - step; x += step) {
      const index = (y * canvas.width + x) * 4;
      const gray = grayscale(image[index], image[index + 1], image[index + 2]);
      samples.push(gray);
      const maximum = Math.max(image[index], image[index + 1], image[index + 2]);
      const minimum = Math.min(image[index], image[index + 1], image[index + 2]);
      if (gray > 242 && maximum - minimum < 14) glare += 1;
      const rightIndex = (y * canvas.width + x + step) * 4;
      const bottomIndex = ((y + step) * canvas.width + x) * 4;
      edgeTotal += Math.abs(gray - grayscale(image[rightIndex], image[rightIndex + 1], image[rightIndex + 2]));
      edgeTotal += Math.abs(gray - grayscale(image[bottomIndex], image[bottomIndex + 1], image[bottomIndex + 2]));
      edgeCount += 2;
    }
  }
  const mean = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, samples.length);
  const contrast = Math.sqrt(variance);
  const edgeStrength = edgeTotal / Math.max(1, edgeCount);
  const glarePercent = Math.round(glare / Math.max(1, samples.length) * 1000) / 10;
  const warnings = [];
  if (canvas.width < 1800 || canvas.height < 1200) warnings.push("low resolution");
  if (edgeStrength < 8) warnings.push("possible blur");
  if (mean < 75 || mean > 220) warnings.push("uneven brightness");
  if (contrast < 28) warnings.push("low contrast");
  if (glarePercent > 8) warnings.push("glare");
  if (Math.abs(skewDegrees) > 1.5) warnings.push("page skew");
  return {
    width: canvas.width, height: canvas.height, brightness: Math.round(mean), contrast: Math.round(contrast),
    edgeStrength: Math.round(edgeStrength * 10) / 10, glarePercent, skewDegrees,
    warning: warnings.length
      ? `Image quality may reduce OCR accuracy (${warnings.join(", ")}). Retake the image directly above the page with good lighting and no glare.`
      : ""
  };
}

export function normalizeColumnLayout(layout = DEFAULT_COLUMN_LAYOUT) {
  const byField = new Map((Array.isArray(layout) ? layout : []).map((item) => [item.field, item]));
  let previousEnd = 0;
  return DEFAULT_COLUMN_LAYOUT.map((fallback) => {
    const source = byField.get(fallback.field) || fallback;
    const start = clamp(Number(source.start ?? fallback.start), previousEnd, 0.995);
    const end = clamp(Number(source.end ?? fallback.end), start + 0.004, 1);
    previousEnd = end;
    return { field: fallback.field, start, end };
  });
}

function detectedColumnLayout(canvas, calibratedLayout) {
  if (Array.isArray(calibratedLayout) && calibratedLayout.length) return { layout: normalizeColumnLayout(calibratedLayout), source: "calibrated", confidence: 100 };
  const defaults = normalizeColumnLayout();
  const image = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  const yStart = Math.round(canvas.height * 0.105);
  const yEnd = Math.round(canvas.height * 0.985);
  const yStep = Math.max(2, Math.round(canvas.height / 1200));
  const defaultBoundaries = [defaults[0].start, ...defaults.map((item) => item.end)];
  const possible = Math.max(1, Math.ceil((yEnd - yStart) / yStep));
  let centerX = Math.round(0.576 * canvas.width);
  let centerScore = 0;
  for (let x = Math.round(canvas.width * 0.52); x <= canvas.width * 0.59; x += 1) {
    let score = 0;
    for (let y = yStart; y < yEnd; y += yStep) {
      for (let offset = -2; offset <= 2; offset += 1) {
        const targetX = clamp(x + offset, 0, canvas.width - 1);
        const pixel = (y * canvas.width + targetX) * 4;
        if (isRedPixel(image[pixel], image[pixel + 1], image[pixel + 2])) score += 1;
      }
    }
    if (score > centerScore) { centerScore = score; centerX = x; }
  }
  const defaultCenter = 0.576;
  const detectedCenter = centerScore / possible >= 0.1 ? centerX / canvas.width : defaultCenter;
  const boundaries = defaultBoundaries.map((boundary) => boundary <= defaultCenter
    ? boundary * detectedCenter / defaultCenter
    : detectedCenter + (boundary - defaultCenter) * (1 - detectedCenter) / (1 - defaultCenter));
  let detected = 0;
  const refined = boundaries.map((boundary, index) => {
    if (index === 0 || index === boundaries.length - 1) return boundary;
    const radius = Math.min(0.016, Math.max(0.006, Math.min(boundary - boundaries[index - 1], boundaries[index + 1] - boundary) * 0.22));
    const startX = Math.max(0, Math.round((boundary - radius) * canvas.width));
    const endX = Math.min(canvas.width - 1, Math.round((boundary + radius) * canvas.width));
    let bestX = Math.round(boundary * canvas.width);
    let bestScore = 0;
    for (let x = startX; x <= endX; x += 1) {
      let score = 0;
      for (let y = yStart; y < yEnd; y += yStep) {
        for (let offset = -2; offset <= 2; offset += 1) {
          const targetX = clamp(x + offset, 0, canvas.width - 1);
          const pixel = (y * canvas.width + targetX) * 4;
          if (isRedPixel(image[pixel], image[pixel + 1], image[pixel + 2])) score += 1;
        }
      }
      if (score > bestScore) { bestScore = score; bestX = x; }
    }
    if (bestScore / possible >= 0.12) { detected += 1; return bestX / canvas.width; }
    return boundary;
  });
  const layout = defaults.map((item, index) => ({ field: item.field, start: refined[index], end: refined[index + 1] }));
  return {
    layout: normalizeColumnLayout(layout), source: detected >= 6 ? "detected" : "default",
    confidence: Math.round(detected / (boundaries.length - 2) * 100), detectedCenter
  };
}

export function parseTsvWords(tsv = "") {
  return String(tsv || "").split(/\r?\n/).slice(1).map((line) => {
    const cells = line.split("\t");
    if (cells.length < 12 || cells[0] !== "5" || !clean(cells[11])) return null;
    const left = Number(cells[6] || 0);
    const top = Number(cells[7] || 0);
    const width = Number(cells[8] || 0);
    const height = Number(cells[9] || 0);
    return { text: clean(cells.slice(11).join("\t")), confidence: Number(cells[10] || 0), left, top, width, height, centerX: left + width / 2, centerY: top + height / 2 };
  }).filter(Boolean);
}

function suffixFromToken(value = "") {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  const candidate = Number(digits.length > 2 ? digits.slice(-2) : digits);
  return candidate >= 1 && candidate <= 60 ? candidate : null;
}

export function selectAccessionAnchors(words = [], imageWidth = 1, imageHeight = 1, layout = DEFAULT_COLUMN_LAYOUT) {
  const accessionRange = normalizeColumnLayout(layout).find((item) => item.field === "accessionNumber") || DEFAULT_COLUMN_LAYOUT[1];
  const groups = [];
  const tolerance = Math.max(8, imageHeight * 0.012);
  words
    .filter((word) => word.centerX >= imageWidth * accessionRange.start && word.centerX <= imageWidth * accessionRange.end)
    .filter((word) => word.centerY >= imageHeight * 0.115)
    .map((word) => ({ ...word, suffix: suffixFromToken(word.text) }))
    .filter((word) => word.suffix)
    .sort((left, right) => left.centerY - right.centerY)
    .forEach((candidate) => {
      let group = groups.find((item) => Math.abs(item.centerY - candidate.centerY) <= tolerance);
      if (!group) { group = { centerY: candidate.centerY, candidates: [] }; groups.push(group); }
      group.candidates.push(candidate);
      group.centerY = group.candidates.reduce((sum, item) => sum + item.centerY, 0) / group.candidates.length;
    });
  const chosen = groups.map((group) => group.candidates.sort((left, right) => {
    const leftDigits = left.text.replace(/\D/g, "");
    const rightDigits = right.text.replace(/\D/g, "");
    return (right.confidence + (rightDigits.length >= 2 ? 25 : 0)) - (left.confidence + (leftDigits.length >= 2 ? 25 : 0));
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
  const lastSuffix = anchors.at(-1).suffix;
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
    const step = anchors.length > 1 ? (anchors.at(-1).centerY - anchors[0].centerY) / (anchors.at(-1).suffix - anchors[0].suffix) : 1;
    return { suffix, centerY: before ? before.centerY + step : after.centerY - step, detected: false };
  });
}

function rowBounds(centers, index, imageHeight) {
  const current = centers[index].centerY;
  const top = index ? (centers[index - 1].centerY + current) / 2 : current - (centers[index + 1]?.centerY - current || imageHeight * 0.02) / 2;
  const bottom = index < centers.length - 1 ? (current + centers[index + 1].centerY) / 2 : current + (current - centers[index - 1]?.centerY || imageHeight * 0.02) / 2;
  return { top: clamp(top, 0, imageHeight), bottom: clamp(bottom, 0, imageHeight) };
}

function horizontalRedLineCandidates(canvas, xStartRatio = 0.58, xEndRatio = 0.69) {
  const image = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  const xStart = Math.round(canvas.width * xStartRatio);
  const xEnd = Math.round(canvas.width * xEndRatio);
  const xStep = Math.max(1, Math.round((xEnd - xStart) / 180));
  const scores = new Float32Array(canvas.height);
  for (let y = Math.round(canvas.height * 0.1); y < canvas.height * 0.995; y += 1) {
    let score = 0;
    for (let x = xStart; x < xEnd; x += xStep) {
      const index = (y * canvas.width + x) * 4;
      if (isRedPixel(image[index], image[index + 1], image[index + 2])) score += 1;
    }
    scores[y] = score;
  }
  const smoothed = new Float32Array(canvas.height);
  for (let y = 2; y < canvas.height - 2; y += 1) {
    smoothed[y] = scores[y - 2] + scores[y - 1] + scores[y] + scores[y + 1] + scores[y + 2];
  }
  const threshold = Math.max(10, ((xEnd - xStart) / xStep) * 0.16);
  const candidates = [];
  for (let y = Math.round(canvas.height * 0.12); y < canvas.height * 0.995; y += 1) {
    if (smoothed[y] < threshold || smoothed[y] < smoothed[y - 1] || smoothed[y] < smoothed[y + 1]) continue;
    const previous = candidates.at(-1);
    if (previous && y - previous.y <= 7) {
      if (smoothed[y] > previous.score) candidates[candidates.length - 1] = { y, score: smoothed[y] };
    } else candidates.push({ y, score: smoothed[y] });
  }
  return candidates;
}

function selectStableRowBands(canvas, rowCount, fallbackRows) {
  const candidates = horizontalRedLineCandidates(canvas);
  const fallbackBoundaries = fallbackRows.length
    ? [Number(fallbackRows[0].rowPixelBounds?.top || 0), ...fallbackRows.map((row) => Number(row.rowPixelBounds?.bottom || 0))]
    : [];
  const fallbackGaps = fallbackBoundaries.slice(1).map((value, index) => value - fallbackBoundaries[index]).filter((gap) => gap > 0);
  const sortedGaps = [...fallbackGaps].sort((left, right) => left - right);
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)] || canvas.height * 0.03;
  const matchTolerance = Math.max(10, medianGap * 0.24);
  const expectedOffset = canvas.height * 0.035;
  const bestOffset = Math.round(expectedOffset);
  let bestMatches = 0;
  let bestDistance = 0;
  fallbackBoundaries.forEach((boundary) => {
    const nearestDistance = candidates.reduce((nearest, candidate) => Math.min(nearest, Math.abs(candidate.y - (boundary + bestOffset))), Infinity);
    if (nearestDistance <= matchTolerance) { bestMatches += 1; bestDistance += nearestDistance; }
  });
  const snapped = [];
  fallbackBoundaries.forEach((boundary, index) => {
    const predicted = boundary + bestOffset;
    const previous = snapped[index - 1];
    const nearest = candidates
      .filter((candidate) => !previous || candidate.y > previous + medianGap * 0.55)
      .map((candidate) => ({ ...candidate, distance: Math.abs(candidate.y - predicted) }))
      .filter((candidate) => candidate.distance <= matchTolerance)
      .sort((left, right) => left.distance - right.distance || right.score - left.score)[0];
    snapped.push(nearest?.y ?? predicted);
  });
  const validBands = snapped.slice(0, rowCount).every((top, index) => snapped[index + 1] > top);
  if (fallbackBoundaries.length === rowCount + 1 && validBands && bestMatches >= Math.ceil((rowCount + 1) * 0.5)) {
    return {
      source: "right-page-lines",
      confidence: Math.round(clamp((bestMatches / (rowCount + 1)) * 100 - bestDistance / Math.max(1, bestMatches * matchTolerance) * 12, 55, 99)),
      candidates: candidates.length,
      matchedBoundaries: bestMatches,
      offset: bestOffset,
      bands: snapped.slice(0, rowCount).map((top, index) => ({ top: clamp(top, 0, canvas.height), bottom: clamp(snapped[index + 1], 0, canvas.height) }))
    };
  }
  const firstTop = Number(fallbackRows[0]?.rowPixelBounds?.top || canvas.height * 0.13);
  const offset = Math.round(canvas.height * 0.035);
  return {
    source: "left-row-offset-fallback",
    confidence: 35,
    candidates: candidates.length,
    matchedBoundaries: Math.max(0, bestMatches),
    offset,
    bands: fallbackRows.map((row) => ({
      top: clamp(Number(row.rowPixelBounds?.top || 0) + offset, firstTop, canvas.height),
      bottom: clamp(Number(row.rowPixelBounds?.bottom || 1) + offset, firstTop + 1, canvas.height)
    }))
  };
}

function fieldForX(centerX, imageWidth, layout) {
  const ratio = centerX / imageWidth;
  return normalizeColumnLayout(layout).find((item) => ratio >= item.start && ratio < item.end)?.field || "";
}

function wordsForCell(words, bounds, field, imageWidth, layout) {
  return words
    .filter((word) => word.confidence >= 5 && word.centerY >= bounds.top && word.centerY < bounds.bottom)
    .filter((word) => fieldForX(word.centerX, imageWidth, layout) === field)
    .sort((left, right) => Math.abs(left.centerY - right.centerY) > Math.max(left.height, right.height) * 0.6 ? left.centerY - right.centerY : left.left - right.left);
}

function averageConfidence(words = []) {
  return words.length ? Math.round(words.reduce((sum, word) => sum + Math.max(0, word.confidence), 0) / words.length) : 0;
}

export function buildVisualRowsFromWords(words = [], imageWidth = 1, imageHeight = 1, options = {}) {
  const layout = normalizeColumnLayout(options.columnLayout);
  const anchors = options.anchors || selectAccessionAnchors(words, imageWidth, imageHeight, layout);
  const centers = interpolateRowCenters(anchors);
  if (!centers.length) return { rows: [], anchors, detectedRows: 0 };
  const prefix = clean(options.prefix);
  const prefixConfidence = Number(options.prefixConfidence || 0);
  const rows = centers.map((center, index) => {
    const bounds = rowBounds(centers, index, imageHeight);
    const row = {};
    const fieldConfidence = {};
    layout.forEach(({ field }) => {
      const cellWords = wordsForCell(words, bounds, field, imageWidth, layout);
      row[field] = clean(cellWords.map((word) => word.text).join(" "));
      fieldConfidence[field] = averageConfidence(cellWords);
    });
    const suffix = String(center.suffix).padStart(2, "0");
    const canResolve = Boolean(prefix && prefixConfidence >= 50);
    const resolvedAccessionNumber = canResolve ? `${prefix}${suffix}` : suffix;
    fieldConfidence.accessionNumber = center.detected ? Math.max(90, fieldConfidence.accessionNumber || 0) : Math.max(65, fieldConfidence.accessionNumber || 0);
    return {
      ...row, accessionNumber: resolvedAccessionNumber, rawAccessionText: prefix ? `${prefix} ${suffix}` : suffix,
      detectedPrefix: prefix, detectedSuffix: suffix, resolvedAccessionNumber, prefixConfidence,
      accessionPrefixConfidence: prefixConfidence, accessionNeedsReview: !canResolve,
      pageNumber: Number(options.pageNumber || 1), pageSide: "both", rowNumber: index + 1, visualRow: index + 1,
      confidence: fieldConfidence.accessionNumber, fieldConfidence,
      rawText: layout.map(({ field }) => row[field]).filter(Boolean).join(" | "), rawCells: { ...row },
      sourceBounds: [{ x: 0, y: bounds.top / imageHeight, width: 1, height: (bounds.bottom - bounds.top) / imageHeight }],
      rowPixelBounds: { top: bounds.top, bottom: bounds.bottom }
    };
  });
  return { rows, anchors, detectedRows: centers.length };
}

function redPrefixMask(sourceCanvas, firstCenterY, crop = {}) {
  const left = Math.round(sourceCanvas.width * Number(crop.leftRatio || 0.108));
  const top = Math.max(0, Math.round(firstCenterY - sourceCanvas.height * Number(crop.topRatio || 0.0125)));
  const width = Math.round(sourceCanvas.width * Number(crop.widthRatio || 0.028));
  const height = Math.round(sourceCanvas.height * Number(crop.heightRatio || 0.025));
  const imageData = sourceCanvas.getContext("2d", { willReadFrequently: true }).getImageData(left, top, width, height);
  const mask = document.createElement("canvas");
  mask.width = width; mask.height = height;
  const maskContext = mask.getContext("2d");
  const target = maskContext.createImageData(width, height);
  const blackPixelsByRow = new Uint16Array(height);
  const blackPixelsByColumn = new Uint16Array(width);
  for (let index = 0; index < imageData.data.length; index += 4) {
    const redInk = isRedPixel(imageData.data[index], imageData.data[index + 1], imageData.data[index + 2]);
    const value = redInk ? 0 : 255;
    if (redInk) { const pixel = index / 4; blackPixelsByRow[Math.floor(pixel / width)] += 1; blackPixelsByColumn[pixel % width] += 1; }
    target.data[index] = value; target.data[index + 1] = value; target.data[index + 2] = value; target.data[index + 3] = 255;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (blackPixelsByRow[y] < width * 0.7 && blackPixelsByColumn[x] < height * 0.7) continue;
      const index = (y * width + x) * 4;
      target.data[index] = 255; target.data[index + 1] = 255; target.data[index + 2] = 255;
    }
  }
  maskContext.putImageData(target, 0, 0);
  const padding = 32;
  const output = document.createElement("canvas");
  output.width = width * 8 + padding * 2; output.height = height * 8 + padding * 2;
  const outputContext = output.getContext("2d");
  outputContext.fillStyle = "#fff"; outputContext.fillRect(0, 0, output.width, output.height);
  outputContext.imageSmoothingEnabled = false;
  outputContext.drawImage(mask, padding, padding, width * 8, height * 8);
  return output;
}

async function recognizePrefix(worker, canvas, anchors) {
  if (!anchors.length) return { prefix: "", confidence: 0 };
  const Tesseract = globalThis.Tesseract;
  await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_WORD, tessedit_char_whitelist: "0123456789" });
  const crops = [{}, { leftRatio: 0.105, widthRatio: 0.031 }, { leftRatio: 0.11, widthRatio: 0.026, topRatio: 0.014, heightRatio: 0.028 }];
  let best = { prefix: "", confidence: 0 };
  for (const crop of crops) {
    const result = await worker.recognize(redPrefixMask(canvas, anchors[0].centerY, crop));
    const candidate = clean(result.data?.text).replace(/\D/g, "");
    const candidateConfidence = Math.round(Number(result.data?.confidence || 0));
    if (candidate && candidate.length <= 6 && candidateConfidence > best.confidence) best = { prefix: candidate, confidence: candidateConfidence };
    if (best.confidence >= 75) break;
  }
  const confidence = best.prefix && best.confidence >= 35 && anchors.length >= 10 ? Math.max(92, best.confidence) : best.confidence;
  return best.prefix && best.prefix.length <= 6 ? { prefix: best.prefix, confidence } : { prefix: "", confidence: 0 };
}

function cellCoordinates(canvas, row, range) {
  const side = range.start >= 0.55 ? "right" : "left";
  const rowBoundsForSide = row.rowPixelBoundsBySide?.[side] || row.rowPixelBounds;
  const top = Number(rowBoundsForSide?.top || 0);
  const bottom = Number(rowBoundsForSide?.bottom || top + 1);
  const rawX = range.start * canvas.width;
  const rawWidth = (range.end - range.start) * canvas.width;
  const rawHeight = bottom - top;
  const xPadding = Math.min(rawWidth * 0.015, Math.max(2, canvas.width * 0.0008));
  const yPadding = Math.min(rawHeight * 0.07, Math.max(2, canvas.height * 0.001));
  const x = clamp(Math.round(rawX + xPadding), 0, canvas.width - 1);
  const y = clamp(Math.round(top + yPadding), 0, canvas.height - 1);
  const width = Math.max(1, Math.round(rawWidth - xPadding * 2));
  const height = Math.max(1, Math.round(rawHeight - yPadding * 2));
  return { x, y, width: Math.min(width, canvas.width - x), height: Math.min(height, canvas.height - y) };
}

function cropCanvas(sourceCanvas, coordinates) {
  const output = document.createElement("canvas");
  output.width = Math.max(1, coordinates.width); output.height = Math.max(1, coordinates.height);
  output.getContext("2d", { willReadFrequently: true }).drawImage(sourceCanvas, coordinates.x, coordinates.y, coordinates.width, coordinates.height, 0, 0, output.width, output.height);
  return output;
}

function cellInkRatio(canvas) {
  const image = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  let ink = 0; let sampled = 0;
  const step = Math.max(1, Math.round(Math.sqrt((canvas.width * canvas.height) / 30000)));
  for (let y = 0; y < canvas.height; y += step) {
    for (let x = 0; x < canvas.width; x += step) {
      const index = (y * canvas.width + x) * 4;
      if (!isRedPixel(image[index], image[index + 1], image[index + 2]) && grayscale(image[index], image[index + 1], image[index + 2]) < 150) ink += 1;
      sampled += 1;
    }
  }
  return ink / Math.max(1, sampled);
}

function scaledCanvas(source, scale, smoothing = true) {
  const output = document.createElement("canvas");
  output.width = Math.max(1, Math.round(source.width * scale)); output.height = Math.max(1, Math.round(source.height * scale));
  const context = output.getContext("2d", { willReadFrequently: true });
  context.fillStyle = "#fff"; context.fillRect(0, 0, output.width, output.height);
  context.imageSmoothingEnabled = smoothing; context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, output.width, output.height);
  return output;
}

function processedCellCanvas(source, { threshold = false, scale = 3 } = {}) {
  const sourceImage = source.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, source.width, source.height);
  const count = source.width * source.height;
  const gray = new Uint8ClampedArray(count);
  const rowInk = new Uint16Array(source.height);
  const columnInk = new Uint16Array(source.width);
  for (let pixel = 0; pixel < count; pixel += 1) {
    const index = pixel * 4;
    const value = isRedPixel(sourceImage.data[index], sourceImage.data[index + 1], sourceImage.data[index + 2])
      ? 255 : grayscale(sourceImage.data[index], sourceImage.data[index + 1], sourceImage.data[index + 2]);
    gray[pixel] = value;
    if (value < 145) { rowInk[Math.floor(pixel / source.width)] += 1; columnInk[pixel % source.width] += 1; }
  }
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (rowInk[y] >= source.width * 0.72 || columnInk[x] >= source.height * 0.72) gray[y * source.width + x] = 255;
    }
  }
  const integralWidth = source.width + 1;
  const integral = new Float64Array((source.width + 1) * (source.height + 1));
  for (let y = 1; y <= source.height; y += 1) {
    let rowSum = 0;
    for (let x = 1; x <= source.width; x += 1) {
      rowSum += gray[(y - 1) * source.width + x - 1];
      integral[y * integralWidth + x] = integral[(y - 1) * integralWidth + x] + rowSum;
    }
  }
  const normalized = new Uint8ClampedArray(count);
  const radius = Math.max(5, Math.round(Math.min(source.width, source.height) * 0.18));
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const left = Math.max(0, x - radius); const right = Math.min(source.width - 1, x + radius);
      const top = Math.max(0, y - radius); const bottom = Math.min(source.height - 1, y + radius);
      const total = integral[(bottom + 1) * integralWidth + right + 1] - integral[top * integralWidth + right + 1]
        - integral[(bottom + 1) * integralWidth + left] + integral[top * integralWidth + left];
      const mean = total / Math.max(1, (right - left + 1) * (bottom - top + 1));
      const value = gray[y * source.width + x];
      normalized[y * source.width + x] = threshold ? (value < mean - 9 ? 0 : 255) : clamp(Math.round(150 + (value - mean) * 2.15), 0, 255);
    }
  }
  const base = document.createElement("canvas");
  base.width = source.width; base.height = source.height;
  const baseContext = base.getContext("2d");
  const outputImage = baseContext.createImageData(base.width, base.height);
  for (let pixel = 0; pixel < count; pixel += 1) {
    const index = pixel * 4; const value = normalized[pixel];
    outputImage.data[index] = value; outputImage.data[index + 1] = value; outputImage.data[index + 2] = value; outputImage.data[index + 3] = 255;
  }
  baseContext.putImageData(outputImage, 0, 0);
  return scaledCanvas(base, scale, false);
}

function looksLikeDitto(value = "") {
  const raw = clean(value).toLowerCase();
  if (/^(?:["'“”„‟〃″`´]{1,4})$/.test(raw)) return true;
  const normalized = raw.replace(/[\s.\-–—_"'“”„‟〃″`´]/g, "");
  return ["do", "does", "ditto", "olo", "dlo", "ao"].includes(normalized) && (["do", "does", "ditto"].includes(normalized) || /[-–—_]/.test(raw));
}

export function normalizeOcrFieldText(value = "", field = "") {
  let text = clean(value).replace(/\s+([,.;:])/g, "$1");
  if (!text) return "";
  if (looksLikeDitto(text)) return text;
  if (field === "accessionNumber") {
    text = text.toUpperCase().replace(/\s+/g, "").replace(/[|]/g, "1");
    if (/^[0-9OILSZ\-/]+$/.test(text)) text = text.replace(/O/g, "0").replace(/[IL]/g, "1").replace(/S/g, "5").replace(/Z/g, "2");
    return text.replace(/[^0-9A-Z\-/]/g, "");
  }
  if (field === "year") return text.toUpperCase().replace(/O/g, "0").replace(/[IL|]/g, "1").replace(/S/g, "5").replace(/[^0-9]/g, "").slice(0, 4);
  if (field === "pages") {
    const mostlyNumeric = (text.match(/[0-9OIL|]/gi) || []).length >= Math.max(1, text.replace(/\s/g, "").length * 0.6);
    if (mostlyNumeric) text = text.replace(/O/gi, "0").replace(/[|l]/g, "1");
    return text.replace(/[^0-9IVXLCDMivxlcdm+\-,. ]/g, "");
  }
  if (field === "accessionDate") return text.replace(/[|]/g, "1").replace(/\s+/g, "");
  return text;
}

function fieldCandidateScore(candidate, field) {
  const text = normalizeOcrFieldText(candidate.normalizedText ?? candidate.rawText, field);
  if (!text) return -1000;
  let score = Number(candidate.confidence || 0);
  if (looksLikeDitto(text)) score += 16;
  if (field === "year") {
    const year = Number(text);
    score += /^\d{4}$/.test(text) && year >= 1800 && year <= CURRENT_YEAR + 1 ? 35 : -40;
  }
  if (field === "accessionNumber") score += /^[0-9A-Z][0-9A-Z\-/]{1,15}$/.test(text) ? 25 : -25;
  if (field === "pages") score += /^[0-9IVXLCDMivxlcdm+\-,. ]+$/.test(text) ? 12 : -20;
  if (GENERAL_TEXT_FIELDS.has(field)) {
    const compact = text.replace(/\s/g, "");
    const meaningfulWords = text.split(/\s+/).filter((word) => /[A-Za-z]{2,}/.test(word)).length;
    const noisySymbols = (compact.match(/[|_=~^{}<>]/g) || []).length;
    if (/[A-Za-z]{2}/.test(text)) score += 10;
    score += Math.min(18, meaningfulWords * 4);
    score -= noisySymbols * 7;
    if (compact.length <= 2 && !looksLikeDitto(text)) score -= 24;
    if (!/[A-Za-z]/.test(text) && !looksLikeDitto(text)) score -= 20;
  }
  return score;
}

export function chooseBestOcrCandidate(candidates = [], field = "") {
  const ranked = candidates
    .map((candidate) => ({ ...candidate, normalizedText: normalizeOcrFieldText(candidate.normalizedText ?? candidate.rawText, field) }))
    .filter((candidate) => candidate.normalizedText)
    .map((candidate) => ({ ...candidate, score: fieldCandidateScore(candidate, field) }))
    .sort((left, right) => right.score - left.score || right.confidence - left.confidence);
  const best = ranked[0];
  if (field === "year" && best && !looksLikeDitto(best.normalizedText)) {
    const year = Number(best.normalizedText);
    if (!/^\d{4}$/.test(best.normalizedText) || year < 1800 || year > CURRENT_YEAR + 1) {
      return { rawText: best.rawText, normalizedText: "", confidence: best.confidence, score: best.score, variant: best.variant, engine: best.engine };
    }
  }
  return best || { rawText: "", normalizedText: "", confidence: 0, score: -1000, variant: "blank" };
}

function cellOcrConfig(field, variantName) {
  const Tesseract = globalThis.Tesseract;
  const whitelist = {
    accessionNumber: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-/", year: "0123456789",
    pages: "0123456789IVXLCDMivxlcdm+-,", accessionDate: "0123456789-/.", cost: "0123456789.,",
    volume: "0123456789IVXLCDMivxlcdm-", classNo: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.-/",
    bookNo: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.-/"
  }[field] || "";
  const psm = MULTILINE_FIELDS.has(field)
    ? (variantName === "threshold" ? Tesseract.PSM.SPARSE_TEXT : variantName === "original-2x" ? Tesseract.PSM.SINGLE_LINE : Tesseract.PSM.SINGLE_BLOCK)
    : (["year", "accessionNumber", "volume", "cost"].includes(field) ? Tesseract.PSM.SINGLE_WORD : Tesseract.PSM.SINGLE_LINE);
  return { tessedit_pageseg_mode: psm, tessedit_char_whitelist: whitelist, preserve_interword_spaces: "1" };
}

const CELL_OCR_ENGINES = {
  tesseract: {
    id: "tesseract",
    async recognize(worker, canvas, config) {
      await worker.setParameters(config);
      const result = await worker.recognize(canvas);
      return { rawText: clean(result.data?.text), confidence: Math.round(Number(result.data?.confidence || 0)) };
    }
  }
};

export function availableCellOcrEngines() {
  return Object.keys(CELL_OCR_ENGINES);
}

async function recognizeCell(worker, originalCrop, field, options = {}) {
  const engine = CELL_OCR_ENGINES[options.engine || "tesseract"] || CELL_OCR_ENGINES.tesseract;
  const variants = [{ name: "original-2x", create: () => scaledCanvas(originalCrop, 2) }];
  variants.push({ name: "contrast-3x", create: () => processedCellCanvas(originalCrop, { threshold: false, scale: 3 }) });
  if (GENERAL_TEXT_FIELDS.has(field) || ["year", "pages", "accessionNumber", "accessionDate"].includes(field)) {
    variants.push({ name: "threshold", create: () => processedCellCanvas(originalCrop, { threshold: true, scale: 3 }) });
  }
  const candidates = [];
  for (const variant of variants) {
    const canvas = variant.create();
    const recognized = await engine.recognize(worker, canvas, cellOcrConfig(field, variant.name));
    candidates.push({ ...recognized, normalizedText: normalizeOcrFieldText(recognized.rawText, field), variant: variant.name, engine: engine.id, _canvas: canvas });
    const currentBest = chooseBestOcrCandidate(candidates, field);
    if (Number(currentBest.confidence || 0) >= 84 && currentBest.score >= 88) break;
  }
  const best = chooseBestOcrCandidate(candidates, field);
  const selected = candidates.find((candidate) => candidate.variant === best.variant && candidate.rawText === best.rawText) || candidates[0];
  return {
    rawText: best.rawText, normalizedText: best.normalizedText, confidence: best.confidence, score: best.score,
    variant: best.variant, engine: engine.id,
    candidates: candidates.map(({ _canvas, ...candidate }) => ({ ...candidate, score: fieldCandidateScore(candidate, field) })),
    debugImages: options.debug ? {
      original: scaledCanvas(originalCrop, Math.min(2, 500 / Math.max(1, originalCrop.width))).toDataURL("image/jpeg", 0.78),
      processed: selected?._canvas?.toDataURL("image/png") || ""
    } : undefined
  };
}

function normalizedCoordinates(coordinates, canvas) {
  return { x: coordinates.x / canvas.width, y: coordinates.y / canvas.height, width: coordinates.width / canvas.width, height: coordinates.height / canvas.height };
}

async function enrichRowsWithCellOcr(worker, canvas, rows, layout, options = {}) {
  const totalCells = rows.length * layout.length;
  let completedCells = 0;
  for (const row of rows) {
    row.cellOcr = {};
    row.fieldConfidence = { ...(row.fieldConfidence || {}) };
    for (const range of layout) {
      const field = range.field;
      const coordinates = cellCoordinates(canvas, row, range);
      const crop = cropCanvas(canvas, coordinates);
      const inkRatio = cellInkRatio(crop);
      const baseline = clean(row[field]);
      const baselineConfidence = Number(row.fieldConfidence[field] || 0);
      let result = { rawText: "", normalizedText: "", confidence: 0, score: -1000, variant: "blank", engine: "tesseract", candidates: [] };
      if (inkRatio >= 0.002 || REQUIRED_OCR_FIELDS.has(field)) result = await recognizeCell(worker, crop, field, options);
      if (baseline) {
        const candidates = [...result.candidates, { rawText: baseline, normalizedText: normalizeOcrFieldText(baseline, field), confidence: baselineConfidence, variant: "page-fallback", engine: "tesseract-page" }];
        const best = chooseBestOcrCandidate(candidates, field);
        result = { ...result, ...best, candidates: candidates.map((candidate) => ({ ...candidate, score: fieldCandidateScore(candidate, field) })) };
      }
      if (field === "accessionNumber") {
        result.normalizedText = row.accessionNumber;
        result.confidence = Math.max(Number(row.fieldConfidence.accessionNumber || 0), Number(row.prefixConfidence || 0));
        result.variant = "accession-sequence-anchor";
      } else row[field] = result.normalizedText || "";
      row.fieldConfidence[field] = Math.round(Number(result.confidence || 0));
      row.cellOcr[field] = {
        rawText: result.rawText || "", normalizedText: result.normalizedText || "", confidence: row.fieldConfidence[field],
        cropCoordinates: normalizedCoordinates(coordinates, canvas), variant: result.variant, engine: result.engine || "tesseract",
        inkRatio: Math.round(inkRatio * 10000) / 100, candidates: result.candidates, debugImages: result.debugImages
      };
      completedCells += 1;
      options.onProgress?.({ status: `OCR cell ${completedCells}/${totalCells}`, progress: completedCells / totalCells, pageNumber: row.pageNumber, field });
    }
    const confidenceFields = ["accessionNumber", "author", "title", "placePublisher", "year", "pages"]
      .filter((field) => row[field] || field === "accessionNumber").map((field) => Number(row.fieldConfidence[field] || 0));
    row.confidence = confidenceFields.length ? Math.round(confidenceFields.reduce((sum, value) => sum + value, 0) / confidenceFields.length) : 0;
    row.rawText = layout.map(({ field }) => row[field]).filter(Boolean).join(" | ");
    row.rawCells = Object.fromEntries(layout.map(({ field }) => [field, row[field] || ""]));
  }
  return rows;
}

function addAccessionSequenceWarnings(rows = []) {
  return rows.map((row, index) => {
    const current = Number(String(row.accessionNumber || "").replace(/\D/g, ""));
    const previous = index ? Number(String(rows[index - 1].accessionNumber || "").replace(/\D/g, "")) : 0;
    const next = index < rows.length - 1 ? Number(String(rows[index + 1].accessionNumber || "").replace(/\D/g, "")) : 0;
    const suspicious = Boolean(current && ((previous && current !== previous + 1) || (next && next !== current + 1)));
    return { ...row, accessionSequenceWarning: suspicious ? "Possible accession OCR error" : "" };
  });
}

async function recognizePage(worker, page, options = {}) {
  const skewDegrees = estimateSkewDegrees(page.canvas);
  const quality = estimateImageQuality(page.canvas, skewDegrees);
  const correctedCanvas = rotateCanvasSameSize(page.canvas, -skewDegrees);
  const columns = detectedColumnLayout(correctedCanvas, options.columnLayout);
  const Tesseract = globalThis.Tesseract;
  await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT, tessedit_char_whitelist: "", preserve_interword_spaces: "1" });
  options.onProgress?.({ status: "detecting rows", progress: 0, pageNumber: page.pageNumber });
  const result = await worker.recognize(correctedCanvas, {}, { tsv: true });
  const words = parseTsvWords(result.data?.tsv || "");
  const anchors = selectAccessionAnchors(words, correctedCanvas.width, correctedCanvas.height, columns.layout);
  const prefix = await recognizePrefix(worker, correctedCanvas, anchors);
  const structured = buildVisualRowsFromWords(words, correctedCanvas.width, correctedCanvas.height, {
    anchors, prefix: prefix.prefix, prefixConfidence: prefix.confidence, pageNumber: page.pageNumber, columnLayout: columns.layout
  });
  const rightRows = selectStableRowBands(correctedCanvas, structured.rows.length, structured.rows);
  const rightStart = Number(columns.layout.find(({ field }) => field === "placePublisher")?.start || 0.576);
  structured.rows.forEach((row, index) => {
    const leftBounds = row.rowPixelBounds;
    const rightBounds = rightRows.bands[index] || leftBounds;
    row.rowPixelBoundsBySide = { left: leftBounds, right: rightBounds };
    row.sourceBounds = [
      { x: 0, y: leftBounds.top / correctedCanvas.height, width: rightStart, height: (leftBounds.bottom - leftBounds.top) / correctedCanvas.height },
      { x: rightStart, y: rightBounds.top / correctedCanvas.height, width: 1 - rightStart, height: (rightBounds.bottom - rightBounds.top) / correctedCanvas.height }
    ];
    columns.layout.filter((range) => range.start >= rightStart).forEach(({ field }) => {
      const cellWords = wordsForCell(words, rightBounds, field, correctedCanvas.width, columns.layout);
      row[field] = clean(cellWords.map((word) => word.text).join(" "));
      row.fieldConfidence[field] = averageConfidence(cellWords);
    });
  });
  await enrichRowsWithCellOcr(worker, correctedCanvas, structured.rows, columns.layout, options);
  return {
    ...structured, rows: addAccessionSequenceWarnings(structured.rows), prefix,
    width: correctedCanvas.width, height: correctedCanvas.height, rawConfidence: Math.round(Number(result.data?.confidence || 0)),
    quality, columns, rightRows, skewDegrees,
    perspective: {
      applied: Math.abs(skewDegrees) >= 0.2 || Math.abs(Number(columns.detectedCenter || 0.576) - 0.576) >= 0.005,
      method: "deskew-and-center-seam-normalized-column-map"
    },
    debugPreview: options.debug ? {
      original: scaledCanvas(page.canvas, Math.min(1, 1200 / page.canvas.width)).toDataURL("image/jpeg", 0.75),
      corrected: scaledCanvas(correctedCanvas, Math.min(1, 1200 / correctedCanvas.width)).toDataURL("image/jpeg", 0.75)
    } : undefined
  };
}

export async function extractRegisterLocally(files = [], options = {}) {
  if (!globalThis.Tesseract?.createWorker) throw new Error("Local OCR engine did not load. Check the internet connection and reload the page.");
  const pages = await renderPayloadPages(files);
  if (!pages.length) throw new Error("No image or PDF pages could be rendered.");
  const worker = await globalThis.Tesseract.createWorker("eng", globalThis.Tesseract.OEM.LSTM_ONLY, { logger: (message) => options.onProgress?.(message) });
  const rows = [];
  const pageDebug = [];
  try {
    for (const page of pages) {
      const result = await recognizePage(worker, page, options);
      rows.push(...result.rows);
      pageDebug.push({
        pageNumber: page.pageNumber, imageWidth: result.width, imageHeight: result.height,
        rowsDetected: result.detectedRows, accessionAnchors: result.anchors.length,
        detectedPrefix: result.prefix.prefix, prefixConfidence: result.prefix.confidence, ocrConfidence: result.rawConfidence,
        quality: result.quality, columnLayout: result.columns.layout, columnLayoutSource: result.columns.source,
        columnDetectionConfidence: result.columns.confidence, detectedCenter: result.columns.detectedCenter,
        skewDegrees: result.skewDegrees,
        rightRowGridSource: result.rightRows.source, rightRowGridConfidence: result.rightRows.confidence,
        rightRowLineCandidates: result.rightRows.candidates, rightRowMatchedBoundaries: result.rightRows.matchedBoundaries,
        rightRowOffset: result.rightRows.offset,
        perspective: result.perspective, debugPreview: result.debugPreview
      });
    }
  } finally {
    await worker.terminate();
  }
  const detectedRows = pageDebug.reduce((sum, page) => sum + page.rowsDetected, 0);
  const qualityWarnings = pageDebug.map((page) => page.quality?.warning).filter(Boolean);
  return {
    provider: "browser-cell-ocr", engine: "tesseract", mode: "local", configured: true,
    message: "Fixed columns and independent multi-pass cell OCR ran locally. Review uncertain handwriting before export or LMS import.",
    qualityWarnings, pages: pages.length,
    debug: {
      rowsDetected: detectedRows, rowsProcessed: rows.length, rowsReturned: rows.length,
      imageWidth: pageDebug[0]?.imageWidth || 0, imageHeight: pageDebug[0]?.imageHeight || 0,
      tableTop: rows[0]?.sourceBounds?.[0]?.y || 0,
      tableBottom: rows.at(-1)?.sourceBounds?.[0] ? rows.at(-1).sourceBounds[0].y + rows.at(-1).sourceBounds[0].height : 1,
      cellOcr: true, local: true, pages: pageDebug
    },
    rows
  };
}
