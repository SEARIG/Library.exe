export const REGISTER_EXPORT_HEADERS = [
  "Accession No.", "Author", "Title", "Place & Publisher", "Year", "Pages", "Source",
  "Bill No. & Date", "Cost (Rs.)", "Class No.", "Book No.", "Call No.",
  "Withdrawal No., Date & Remarks"
];

export const REGISTER_FIELDS = [
  "accessionNumber", "author", "title", "placePublisher", "year", "pages", "source",
  "billNoDate", "cost", "classNo", "bookNo", "callNo", "remarks"
];

export const REGISTER_FIELD_LABELS = {
  accessionNumber: "Accession No.",
  author: "Author",
  title: "Title",
  placePublisher: "Place & Publisher",
  year: "Year",
  pages: "Pages",
  source: "Source",
  billNoDate: "Bill No. & Date",
  cost: "Cost (Rs.)",
  classNo: "Class No.",
  bookNo: "Book No.",
  callNo: "Call No.",
  remarks: "Withdrawal No., Date & Remarks"
};

const FIELD_ALIASES = {
  accessionNumber: ["accessionNumber", "accession", "accessionNo", "accession no", "accession no."],
  author: ["author", "authors"],
  title: ["title", "book title"],
  placePublisher: ["placePublisher", "place publisher", "place & publisher", "publisher"],
  year: ["year", "publication year"],
  pages: ["pages", "page"],
  source: ["source", "acquisition source"],
  billNoDate: ["billNoDate", "bill no date", "bill no. & date", "bill"],
  cost: ["cost", "cost rs", "price"],
  classNo: ["classNo", "class no", "class no."],
  bookNo: ["bookNo", "book no", "book no."],
  callNo: ["callNo", "call no", "call no."],
  remarks: ["remarks", "withdrawalRemarks", "withdrawal remarks", "withdrawal no., date & remarks"]
};

const HEADER_BY_FIELD = Object.fromEntries(
  REGISTER_FIELDS.map((field) => [field, REGISTER_FIELD_LABELS[field]])
);
const DITTO_FIELDS = REGISTER_FIELDS.filter((field) => field !== "accessionNumber");
const DITTO_MARKS = new Set(["do", "do.", "-do-", "-do.-", "ditto", "\"", "''", "“", "”", "„", "〃", "″"]);

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
  return DITTO_MARKS.has(cleanCell(value).toLowerCase());
}

export function resolveDittoValues(rows = []) {
  const previous = {};
  return rows.map((sourceRow) => {
    const row = createEmptyRegisterRow(sourceRow);
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
    rawCells: source.rawCells || null
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

export function createMockOcrResult(files = []) {
  const pageCount = files.reduce((sum, file) => sum + (String(file.name || "").toLowerCase().endsWith(".pdf") ? 2 : 1), 0) || 1;
  return {
    provider: "mock",
    configured: false,
    message: "OCR credentials are not configured. Mock register rows are shown for review/testing.",
    pages: pageCount,
    rows: [
      { accessionNumber: "0001", author: "Dr. K. Sharma", title: "Fundamentals of Physics",
        placePublisher: "Udaipur: Academic Press", year: "1998", pages: "412", source: "Purchase",
        billNoDate: "B-12 / 01-07-1998", cost: "125.00", classNo: "530", bookNo: "SHA", callNo: "530 SHA",
        remarks: "clean handwriting", pageNumber: 1, pageSide: "left", rowNumber: 1, confidence: 96,
        rawText: "0001 Dr K Sharma Fundamentals of Physics" },
      { accessionNumber: "0002", author: "do", title: "Organic Chemistry Notes", placePublisher: "-do-",
        year: "1999", pages: "288", source: "\"", billNoDate: "B-13 / 02-07-1998", cost: "90", classNo: "547",
        bookNo: "ORG", callNo: "547 ORG", remarks: "low-confidence title", pageNumber: 1, pageSide: "left",
        rowNumber: 2, confidence: 82, rawText: "0002 do Organic Chemistry Notes -do-" },
      { accessionNumber: "0003", author: "M. Jain", title: "Data Structures and Algorithms",
        placePublisher: "Delhi: Tech House", year: "20O1", pages: "", source: "Donation", billNoDate: "", cost: "abc",
        classNo: "005.73", bookNo: "JAI", callNo: "005.73 JAI", remarks: "unclear year and blank cell",
        pageNumber: Math.min(2, pageCount), pageSide: "right", rowNumber: 3, confidence: 74,
        rawText: "0003 M Jain Data Structures and Algorithms 20O1" },
      { accessionNumber: "0002", author: "Duplicate Author", title: "Repeated OCR Row", placePublisher: "",
        year: "2001", pages: "100", source: "", billNoDate: "", cost: "50", classNo: "", bookNo: "", callNo: "",
        remarks: "duplicate accession", pageNumber: Math.min(2, pageCount), pageSide: "right", rowNumber: 4,
        confidence: 91, rawText: "0002 Duplicate Author Repeated OCR Row" },
      { accessionNumber: "0004", author: "A. Mehta",
        title: "Multi-line title: History of Rajasthan and Mewar Library Records", placePublisher: "Udaipur",
        year: "2004", pages: "350", source: "Gift", billNoDate: "", cost: "0", classNo: "954.4", bookNo: "MEH",
        callNo: "954.4 MEH", remarks: "multi-line title", pageNumber: pageCount, pageSide: "left", rowNumber: 5,
        confidence: 88, rawText: "0004 A Mehta History of Rajasthan / and Mewar Library Records" }
    ]
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
  return Object.fromEntries(REGISTER_FIELDS.map((field) => [HEADER_BY_FIELD[field], cleanCell(row[field])]));
}

export function digitizedRowsToMatrix(rows = []) {
  return [REGISTER_EXPORT_HEADERS, ...rows.map((row) => REGISTER_EXPORT_HEADERS.map((header) => digitizedRowToExportRow(row)[header] || ""))];
}

export function rowsReadyForImport(rows = []) {
  return rows.filter((row) => row.status === "Ready");
}
