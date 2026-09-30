export const REGISTER_EXPORT_HEADERS = [
  "Accession No.", "Date", "Author", "Title", "Place & Publisher", "Year", "Pages", "Vol.",
  "Source", "Bill No. & Date", "Cost (Rs.)", "Class No.", "Book No.",
  "Withdrawal No., Date & Remarks", "Image URL", "Notes"
];

export const REGISTER_FIELDS = [
  "accessionNumber", "accessionDate", "author", "title", "placePublisher", "year", "pages", "volume",
  "source", "billNoDate", "cost", "classNo", "bookNo", "callNo", "remarks", "imageUrl", "notes"
];

export const REGISTER_FIELD_LABELS = {
  accessionNumber: "Accession No.",
  accessionDate: "Date",
  author: "Author",
  title: "Title",
  placePublisher: "Place & Publisher",
  year: "Year",
  pages: "Pages",
  volume: "Vol.",
  source: "Source",
  billNoDate: "Bill No. & Date",
  cost: "Cost (Rs.)",
  classNo: "Class No.",
  bookNo: "Book No.",
  callNo: "Call No.",
  remarks: "Withdrawal No., Date & Remarks",
  imageUrl: "Image URL",
  notes: "Notes"
};

const FIELD_ALIASES = {
  accessionNumber: ["accessionNumber", "accession", "accessionNo", "accession no", "accession no."],
  accessionDate: ["accessionDate", "date"],
  author: ["author", "authors"],
  title: ["title", "book title"],
  placePublisher: ["placePublisher", "place publisher", "place & publisher", "publisher"],
  year: ["year", "publication year"],
  pages: ["pages", "page"],
  volume: ["volume", "vol", "vol."],
  source: ["source", "acquisition source"],
  billNoDate: ["billNoDate", "bill no date", "bill no. & date", "bill"],
  cost: ["cost", "cost rs", "price"],
  classNo: ["classNo", "class no", "class no."],
  bookNo: ["bookNo", "book no", "book no."],
  callNo: ["callNo", "call no", "call no."],
  remarks: ["remarks", "withdrawalRemarks", "withdrawal remarks", "withdrawal no., date & remarks"],
  imageUrl: ["imageUrl", "image url", "cover url"],
  notes: ["notes", "note"]
};

const EXPORT_FIELD_BY_HEADER = {
  "Accession No.": "accessionNumber",
  Date: "accessionDate",
  Author: "author",
  Title: "title",
  "Place & Publisher": "placePublisher",
  Year: "year",
  Pages: "pages",
  "Vol.": "volume",
  Source: "source",
  "Bill No. & Date": "billNoDate",
  "Cost (Rs.)": "cost",
  "Class No.": "classNo",
  "Book No.": "bookNo",
  "Withdrawal No., Date & Remarks": "remarks",
  "Image URL": "imageUrl",
  Notes: "notes"
};
const DITTO_FIELDS = REGISTER_FIELDS.filter((field) => field !== "accessionNumber");
const DITTO_WORDS = new Set(["do", "does", "ditto"]);
const OCR_DITTO_WORDS = new Set(["olo", "dlo", "ao"]);

function normalizedLabel(value = "") {
  return String(value || "").trim().toLowerCase().replace(/&/g, "and").replace(/[.,()]/g, "").replace(/\s+/g, " ");
}

function fieldForLabel(label = "") {
  const target = normalizedLabel(label);
  return Object.entries(FIELD_ALIASES)
    .find(([, aliases]) => aliases.some((alias) => normalizedLabel(alias) === target))?.[0] || "";
}

function cleanCell(value = "") {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function createEmptyRegisterRow(overrides = {}) {
  return { ...Object.fromEntries(REGISTER_FIELDS.map((field) => [field, ""])), ...overrides };
}

export function normalizeAccessionKey(value = "") {
  return cleanCell(value).toLowerCase();
}

export function isDittoValue(value = "") {
  const raw = cleanCell(value).toLowerCase();
  if (!raw) return false;
  if (/^(?:["'“”„‟〃″`´]{1,4})$/.test(raw)) return true;
  const normalized = raw.replace(/[\s.\-–—_"'“”„‟〃″`´]/g, "");
  if (DITTO_WORDS.has(normalized)) return true;
  const hasRepeatDashes = /[-–—_]/.test(raw);
  return hasRepeatDashes && OCR_DITTO_WORDS.has(normalized);
}

export function resolveDittoValues(rows = []) {
  const previous = {};
  return rows.map((sourceRow) => {
    const row = createEmptyRegisterRow(sourceRow);
    row.rawCells = sourceRow.rawCells || Object.fromEntries(REGISTER_FIELDS.map((field) => [field, cleanCell(sourceRow[field])]));
    const resolvedFields = [];
    DITTO_FIELDS.forEach((field) => {
      const value = cleanCell(row[field]);
      if (isDittoValue(value)) {
        row[field] = previous[field] || "";
        resolvedFields.push(field);
      } else {
        row[field] = value;
      }
      if (cleanCell(row[field])) previous[field] = cleanCell(row[field]);
    });
    row.accessionNumber = cleanCell(row.accessionNumber);
    row.resolvedCells = Object.fromEntries(REGISTER_FIELDS.map((field) => [field, cleanCell(row[field])]));
    row.dittoResolvedFields = [...new Set([...(sourceRow.dittoResolvedFields || []), ...resolvedFields])];
    return row;
  });
}

function looksLikeDecoration(cells = []) {
  const joined = cells.map(cleanCell).filter(Boolean).join(" ").toLowerCase();
  if (!joined || /^(page\s*)?\d+$/.test(joined)) return true;
  const headerMatches = REGISTER_FIELDS.filter((field) =>
    FIELD_ALIASES[field].some((alias) => joined.includes(normalizedLabel(alias)))
  ).length;
  return headerMatches >= 3 || /accession register|mohanlal sukhadia university/.test(joined);
}

function objectToRegisterRow(source = {}, index = 0) {
  const row = createEmptyRegisterRow();
  Object.entries(source).forEach(([key, value]) => {
    const field = REGISTER_FIELDS.includes(key) ? key : fieldForLabel(key);
    if (field) row[field] = cleanCell(value);
  });
  return {
    ...row,
    id: source.id || `ocr-row-${index + 1}`,
    pageNumber: source.pageNumber || 1,
    pageSide: cleanCell(source.pageSide),
    rowNumber: source.rowNumber || index + 1,
    confidence: Number(source.confidence ?? 0),
    rawText: cleanCell(source.rawText || REGISTER_FIELDS.map((field) => row[field]).filter(Boolean).join(" | ")),
    rawCells: source.rawCells || null,
    rawAccessionText: cleanCell(source.rawAccessionText || row.accessionNumber),
    detectedPrefix: cleanCell(source.detectedPrefix),
    detectedSuffix: cleanCell(source.detectedSuffix),
    prefixConfidence: Number(source.prefixConfidence ?? source.accessionPrefixConfidence ?? 0),
    bounds: source.bounds || null,
    sourceBounds: Array.isArray(source.sourceBounds) ? source.sourceBounds : (source.bounds ? [source.bounds] : [])
  };
}

function mergeContinuationRow(previous, continuation) {
  const appendFields = new Set(["author", "title", "placePublisher", "billNoDate", "remarks"]);
  REGISTER_FIELDS.filter((field) => field !== "accessionNumber").forEach((field) => {
    const value = cleanCell(continuation[field]);
    if (!value) return;
    if (!cleanCell(previous[field])) previous[field] = value;
    else if (appendFields.has(field)) previous[field] = cleanCell(`${previous[field]} ${value}`);
  });
  previous.rawText = cleanCell(`${previous.rawText || ""} ${continuation.rawText || ""}`);
  previous.rawCells = [...(previous.rawCells || []), ...(continuation.rawCells || [])];
  return previous;
}

export function parseOcrLikeRows(input = []) {
  const sourceRows = typeof input === "string" ? input.split(/\r?\n/) : input;
  if (!Array.isArray(sourceRows)) return [];
  const parsed = [];
  sourceRows.forEach((source, index) => {
    if (source && typeof source === "object" && !Array.isArray(source)) {
      const row = objectToRegisterRow(source, index);
      if (looksLikeDecoration(REGISTER_FIELDS.map((field) => row[field]))) return;
      if (!row.accessionNumber && parsed.length) mergeContinuationRow(parsed[parsed.length - 1], row);
      else parsed.push(row);
      return;
    }
    const rawCells = (Array.isArray(source) ? source : String(source || "").split(/\t|\s*\|\s*/)).map(cleanCell);
    if (looksLikeDecoration(rawCells)) return;
    const row = createEmptyRegisterRow();
    REGISTER_FIELDS.forEach((field, fieldIndex) => { row[field] = rawCells[fieldIndex] || ""; });
    if (!row.accessionNumber && parsed.length && rawCells.some(Boolean)) {
      mergeContinuationRow(parsed[parsed.length - 1], { ...row, rawText: rawCells.join(" | "), rawCells });
      return;
    }
    parsed.push({ ...row, id: `ocr-row-${index + 1}`, pageNumber: 1, pageSide: "", rowNumber: index + 1,
      confidence: 0, rawText: rawCells.join(" | "), rawCells });
  });
  return resolveDittoValues(parsed);
}

export function confidenceStatus(confidence = 0) {
  const value = Number(confidence || 0);
  if (value >= 90) return "high";
  if (value >= 80) return "medium";
  return "low";
}

function confidenceRatio(value = 0) {
  const number = Number(value || 0);
  return number > 1 ? number / 100 : number;
}

export function resolveAccessionSequences(rows = [], minimumConfidence = 0.85) {
  const candidates = new Map();
  rows.forEach((row) => {
    const raw = cleanCell(row.rawAccessionText || row.accessionNumber);
    const spaced = raw.match(/^(\d{1,6})[\s\-/]+(\d{1,3})$/);
    const prefix = cleanCell(row.detectedPrefix || spaced?.[1]);
    const confidence = confidenceRatio(row.prefixConfidence ?? row.accessionPrefixConfidence ?? (spaced ? 0.9 : 0));
    if (prefix && confidence >= minimumConfidence) {
      const entry = candidates.get(prefix) || { count: 0, confidence: 0 };
      entry.count += 1;
      entry.confidence = Math.max(entry.confidence, confidence);
      candidates.set(prefix, entry);
    }
  });
  const ranked = [...candidates.entries()].sort((a, b) => b[1].count - a[1].count || b[1].confidence - a[1].confidence);
  const pagePrefix = ranked.length && (!ranked[1] || ranked[0][1].count > ranked[1][1].count || ranked[0][0] === ranked[1][0])
    ? ranked[0][0]
    : "";
  const pagePrefixConfidence = pagePrefix ? ranked[0][1].confidence : 0;

  return rows.map((sourceRow) => {
    const row = { ...sourceRow };
    const raw = cleanCell(row.rawAccessionText || row.accessionNumber);
    const spaced = raw.match(/^(\d{1,6})[\s\-/]+(\d{1,3})$/);
    const detectedPrefix = cleanCell(row.detectedPrefix || spaced?.[1] || pagePrefix);
    let detectedSuffix = cleanCell(row.detectedSuffix || spaced?.[2]);
    if (!detectedSuffix && pagePrefix && /^\d{1,3}$/.test(raw)) detectedSuffix = raw;
    if (!detectedSuffix && pagePrefix && raw.startsWith(pagePrefix) && raw.length > pagePrefix.length) {
      detectedSuffix = raw.slice(pagePrefix.length);
    }
    const explicitConfidence = confidenceRatio(row.prefixConfidence ?? row.accessionPrefixConfidence ?? 0);
    const resolvedConfidence = Math.max(explicitConfidence, detectedPrefix === pagePrefix ? pagePrefixConfidence : 0);
    const canResolve = Boolean(pagePrefix && detectedPrefix === pagePrefix && detectedSuffix && resolvedConfidence >= minimumConfidence);
    const lowConfidencePrefix = Boolean(detectedPrefix && detectedSuffix && !canResolve);
    const resolved = canResolve ? `${pagePrefix}${detectedSuffix}` : cleanCell(row.accessionNumber || raw);
    return {
      ...row,
      rawAccessionText: raw,
      detectedPrefix,
      detectedSuffix,
      resolvedAccessionNumber: resolved,
      accessionNumber: resolved,
      accessionPrefixConfidence: resolvedConfidence,
      accessionNeedsReview: lowConfidencePrefix
    };
  });
}

function segmentBounds(segment = {}) {
  const source = segment.bounds || segment.sourceBounds?.[0] || {};
  const y = Number(source.y ?? source.top ?? segment.y ?? 0);
  const height = Math.max(1, Number(source.height ?? segment.height ?? 1));
  return { ...source, y, height, centerY: y + height / 2 };
}

function segmentFields(segment = {}) {
  return segment.fields || segment.row || segment.cells || segment;
}

export function alignRegisterRowSegments(segments = [], toleranceRatio = 0.7) {
  const indexed = segments.map((segment, index) => ({
    ...segment,
    _index: index,
    _bounds: segmentBounds(segment),
    pageNumber: Number(segment.pageNumber || 1),
    pageSide: cleanCell(segment.pageSide || segment.side).toLowerCase()
  }));
  const standalone = indexed.filter((item) => !["left", "right"].includes(item.pageSide));
  const left = indexed.filter((item) => item.pageSide === "left");
  const right = indexed.filter((item) => item.pageSide === "right");
  const usedRight = new Set();
  const merged = left.map((leftSegment) => {
    const candidates = right
      .filter((rightSegment) => rightSegment.pageNumber === leftSegment.pageNumber && !usedRight.has(rightSegment._index))
      .map((rightSegment) => ({
        rightSegment,
        distance: Math.abs(leftSegment._bounds.centerY - rightSegment._bounds.centerY),
        tolerance: Math.max(leftSegment._bounds.height, rightSegment._bounds.height) * toleranceRatio
      }))
      .filter((match) => match.distance <= match.tolerance)
      .sort((a, b) => a.distance - b.distance);
    const match = candidates[0]?.rightSegment;
    if (match) usedRight.add(match._index);
    const leftFields = segmentFields(leftSegment);
    const rightFields = match ? segmentFields(match) : {};
    return {
      ...leftFields,
      ...Object.fromEntries(Object.entries(rightFields).filter(([, value]) => cleanCell(value))),
      pageNumber: leftSegment.pageNumber,
      pageSide: match ? "both" : "left",
      rowNumber: leftSegment.rowNumber || match?.rowNumber || leftSegment._index + 1,
      confidence: Math.min(Number(leftSegment.confidence ?? 100), Number(match?.confidence ?? 100)),
      rawText: cleanCell(`${leftSegment.rawText || ""} ${match?.rawText || ""}`),
      sourceBounds: [leftSegment._bounds, ...(match ? [match._bounds] : [])]
    };
  });
  right.filter((item) => !usedRight.has(item._index)).forEach((item) => {
    merged.push({ ...segmentFields(item), pageNumber: item.pageNumber, pageSide: "right",
      rowNumber: item.rowNumber || item._index + 1, confidence: Number(item.confidence ?? 0),
      rawText: cleanCell(item.rawText), sourceBounds: [item._bounds] });
  });
  standalone.forEach((item) => merged.push({ ...segmentFields(item), ...item, sourceBounds: [item._bounds] }));
  return merged.sort((a, b) => Number(a.pageNumber || 1) - Number(b.pageNumber || 1)
    || Math.min(...(a.sourceBounds || [{ centerY: a.rowNumber || 0 }]).map((bound) => Number(bound.centerY ?? bound.y ?? 0)))
    - Math.min(...(b.sourceBounds || [{ centerY: b.rowNumber || 0 }]).map((bound) => Number(bound.centerY ?? bound.y ?? 0))));
}

export function createRowCountDiagnostics({ detectedRows = 0, processedRows = 0, parsedRows = 0 } = {}) {
  const detected = Math.max(0, Number(detectedRows || 0));
  const processed = Math.max(0, Number(processedRows || parsedRows || 0));
  const parsed = Math.max(0, Number(parsedRows || 0));
  const detectionAvailable = detected > 0;
  return {
    detectedRows: detected,
    processedRows: processed,
    parsedRows: parsed,
    detectionAvailable,
    hasMismatch: detectionAvailable && detected > parsed,
    warning: !detectionAvailable && parsed
      ? "Live OCR did not report a visual row count. Verify the full page before export."
      : detected > parsed ? `Only ${parsed} of ${detected} detected register rows were parsed.` : ""
  };
}

export function paginateRows(rows = [], page = 1, pageSize = 10) {
  const safeSize = Math.max(1, Number(pageSize || 10));
  const totalPages = Math.max(1, Math.ceil(rows.length / safeSize));
  const safePage = Math.min(totalPages, Math.max(1, Number(page || 1)));
  return { rows: rows.slice((safePage - 1) * safeSize, safePage * safeSize), page: safePage, pageSize: safeSize,
    totalRows: rows.length, totalPages };
}

export function ocrModeForResult(result = {}) {
  if (result.mode === "local") return "LOCAL";
  return result.mode === "live" || result.configured === true ? "LIVE" : "MOCK";
}

export function ocrFailureState(error = {}, mode = "LIVE FAILED") {
  return {
    mode,
    offerMock: true,
    rows: [],
    message: cleanCell(error.message || "Live OCR failed.")
  };
}

export function createMockOcrResult(files = []) {
  const pageCount = files.reduce((sum, file) => sum + (String(file.name || "").toLowerCase().endsWith(".pdf") ? 2 : 1), 0) || 1;
  const rows = Array.from({ length: 25 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return {
      accessionNumber: `MOCK-${number}`,
      rawAccessionText: `MOCK-${number}`,
      author: index === 0 ? "Mock Author" : "do",
      title: index === 0 ? "Mock Register Book 01" : `Mock Register Book ${number}`,
      placePublisher: index === 0 ? "Mock Place: Test Publisher" : "-do-",
      year: "2000",
      pages: String(100 + index),
      source: index === 0 ? "Test Data" : "\"",
      billNoDate: `TEST-${number}`,
      cost: "0",
      classNo: "000",
      bookNo: `M${number}`,
      callNo: `000 M${number}`,
      remarks: "Explicit mock test row",
      pageNumber: 1,
      pageSide: "both",
      rowNumber: index + 1,
      confidence: 100,
      rawText: `MOCK-${number} explicit test data`
    };
  });
  return {
    provider: "mock",
    mode: "mock",
    configured: false,
    message: "Explicit mock test data. No uploaded handwriting was read.",
    pages: pageCount,
    debug: { rowsDetected: rows.length, rowsProcessed: rows.length, rowsReturned: rows.length, mock: true },
    rows
  };
}

export function validateDigitizedRows(rows = [], existingAccessions = new Set()) {
  const seen = new Map();
  return rows.map((sourceRow, index) => {
    const row = createEmptyRegisterRow(sourceRow);
    const accession = cleanCell(row.accessionNumber);
    const key = normalizeAccessionKey(accession);
    const errors = [];
    let duplicateType = "";
    if (!accession) errors.push("missing accession number");
    if (!cleanCell(row.title)) errors.push("missing title");
    if (!cleanCell(row.author)) errors.push("missing author");
    if (key && seen.has(key)) { errors.push("duplicate inside upload"); duplicateType = "upload"; }
    if (key && existingAccessions.has(key)) { errors.push("duplicate against Firestore"); duplicateType ||= "firestore"; }
    if (row.year && !/^\d{4}$/.test(cleanCell(row.year))) errors.push("invalid year");
    if (row.cost && Number.isNaN(Number(cleanCell(row.cost).replace(/,/g, "")))) errors.push("invalid cost");
    if (row.rawText && seen.get(key)?.rawText === row.rawText) errors.push("repeated OCR row");
    if (["author", "title", "placePublisher"].some((field) => cleanCell(row[field]).includes("?"))) errors.push("uncertain OCR text");
    if (row.accessionNeedsReview) errors.push("uncertain accession prefix");
    if (Number(row.confidence || 0) < 80 && !["manual", "reviewed"].includes(row.origin)) errors.push("low confidence");
    if (key && !seen.has(key)) seen.set(key, row);
    const status = errors.some((error) => error.includes("duplicate")) ? "Duplicate"
      : errors.some((error) => ["missing accession number", "missing title", "invalid year", "invalid cost"].includes(error)) ? "Invalid"
        : errors.length ? "Needs Review" : "Ready";
    return { ...row, id: row.id || `ocr-row-${index + 1}`, accessionNumber: accession,
      confidence: Number(row.confidence || 0), confidenceStatus: confidenceStatus(row.confidence), duplicateType, errors, status };
  });
}

export function summarizeDigitizedRows(rows = []) {
  return rows.reduce((summary, row) => {
    summary.total += 1;
    if (row.status === "Ready") summary.ready += 1;
    if (row.status === "Needs Review") summary.needsReview += 1;
    if (row.status === "Duplicate") summary.duplicates += 1;
    if (row.status === "Invalid") summary.invalid += 1;
    return summary;
  }, { total: 0, ready: 0, needsReview: 0, duplicates: 0, invalid: 0 });
}

export function digitizedRowToExportRow(row = {}) {
  return Object.fromEntries(REGISTER_EXPORT_HEADERS.map((header) => [header, cleanCell(row[EXPORT_FIELD_BY_HEADER[header]])]));
}

export function digitizedRowsToMatrix(rows = []) {
  return [REGISTER_EXPORT_HEADERS, ...rows.map((row) => REGISTER_EXPORT_HEADERS.map((header) => digitizedRowToExportRow(row)[header] || ""))];
}

export function rowsReadyForImport(rows = []) {
  return rows.filter((row) => row.status === "Ready");
}
