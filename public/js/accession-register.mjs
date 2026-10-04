import { normalizeLogicalAccession } from "./book-duplicates.mjs";

export const ACCESSION_TEMPLATE_HEADERS = [
  "Accession No.",
  "Date",
  "Author",
  "Title",
  "Place & Publisher",
  "Year",
  "Pages",
  "Vol.",
  "Source",
  "Bill No. & Date",
  "Cost (Rs.)",
  "Class No.",
  "Book No.",
  "Withdrawal No., Date & Remarks",
  "Image URL",
  "Notes"
];

export const ACCESSION_PARSER_VERSION = "2026-10-04-runtime-fix-1";

const FIELD_ALIASES = {
  accessionNumber: [
    "Accession No.",
    "Accession Number",
    "Accession No",
    "Accession",
    "Accession Num",
    "AccessionNum",
    "AccessionNo"
  ],
  accessionDate: ["Date"],
  author: ["Author"],
  title: ["Title"],
  placePublisher: ["Place & Publisher", "Publisher"],
  year: ["Year"],
  pages: ["Pages"],
  volume: ["Vol.", "Vol", "Volume"],
  source: ["Source"],
  billNoDate: ["Bill No. & Date", "Bill No & Date"],
  cost: ["Cost (Rs.)", "Cost"],
  classNo: ["Class No.", "Class No"],
  bookNo: ["Book No.", "Book No"],
  callNo: ["Call No.", "Call No"],
  withdrawalRemarks: ["Withdrawal No., Date & Remarks", "Withdrawal Remarks"],
  imageUrl: ["Source Image", "Image URL", "Image Url", "Cover URL"],
  notes: ["Notes"],
  isbn: ["ISBN"],
  publisherBarcode: ["Publisher Barcode"],
  category: ["Category"],
  subject: ["Subject"]
};

export const ACCESSION_HEADER_SCAN_LIMIT = 20;

const NON_DATA_SHEETS = new Set(["read me", "needs review"]);

function importHeaderText(value) {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  if (typeof value.v === "string" || typeof value.v === "number") return String(value.v);
  if (typeof value.w === "string") return value.w;
  if (typeof value.text === "string") return value.text;
  if (Array.isArray(value.richText)) {
    return value.richText.map((part) => part?.text || part?.t || "").join("");
  }
  if (Array.isArray(value.r)) {
    return value.r.map((part) => part?.text || part?.t || "").join("");
  }
  return String(value);
}

export function normalizeImportHeader(value) {
  return importHeaderText(value)
    .replace(/\u00a0/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cellText(value) {
  return String(value ?? "").trim();
}

function accessionDateText(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return cellText(value);
  }
  const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
  if (Number.isNaN(date.getTime())) return cellText(value);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

const ACCESSION_HEADERS = new Set(FIELD_ALIASES.accessionNumber.map(normalizeImportHeader));
const KNOWN_MLSU_TEMPLATE_HEADERS = new Set([
  "Accession No.",
  "Date",
  "Author",
  "Title",
  "Place & Publisher",
  "Year",
  "Pages",
  "Vol.",
  "Source",
  "Bill No. & Date",
  "Cost (Rs.)",
  "Notes"
].map(normalizeImportHeader));

function knownMlsuTemplateHeaderRow(row = []) {
  const normalized = new Set((Array.isArray(row) ? row : []).map(normalizeImportHeader).filter(Boolean));
  return [...KNOWN_MLSU_TEMPLATE_HEADERS].every((header) => normalized.has(header));
}

function directA1Value(cell) {
  if (!cell || typeof cell !== "object") return cellText(cell);
  return cellText(cell.v ?? cell.w ?? "");
}

function withDirectA1(matrix = [], a1) {
  const value = directA1Value(a1);
  if (!ACCESSION_HEADERS.has(normalizeImportHeader(value))) return matrix;
  const rows = Array.isArray(matrix) ? matrix.map((row) => Array.isArray(row) ? [...row] : []) : [];
  if (!rows.length) rows.push([]);
  rows[0][0] = value;
  return rows;
}

export function findAccessionHeaderRow(matrix = [], maxRows = ACCESSION_HEADER_SCAN_LIMIT) {
  return matrix.slice(0, Math.max(0, maxRows)).findIndex((row) =>
    (Array.isArray(row) ? row : []).some((cell) => ACCESSION_HEADERS.has(normalizeImportHeader(cell)))
  );
}

export function selectAccessionRegisterSheet(worksheets = [], maxRows = ACCESSION_HEADER_SCAN_LIMIT) {
  const sheets = (Array.isArray(worksheets) ? worksheets : [])
    .filter((sheet) => sheet && typeof sheet.name === "string" && Array.isArray(sheet.matrix));
  const booksImport = sheets.filter((sheet) => normalizeImportHeader(sheet.name) === "books import");
  const fallbackSheets = sheets.filter((sheet) =>
    normalizeImportHeader(sheet.name) !== "books import"
    && !NON_DATA_SHEETS.has(normalizeImportHeader(sheet.name))
  );

  for (const sheet of [...booksImport, ...fallbackSheets]) {
    const matrix = withDirectA1(sheet.matrix, sheet.a1);
    const knownTemplateRowIndex = matrix
      .slice(0, Math.max(0, maxRows))
      .findIndex(knownMlsuTemplateHeaderRow);
    const headerRowIndex = knownTemplateRowIndex >= 0
      ? knownTemplateRowIndex
      : findAccessionHeaderRow(matrix, maxRows);
    if (headerRowIndex >= 0) {
      return {
        sheetName: sheet.name,
        matrix,
        headerRowIndex,
        sheetHeaderRow: headerRowIndex + 1,
        detectedColumns: (matrix[headerRowIndex] || []).map(cellText).filter(Boolean),
        a1: sheet.a1 || null
      };
    }
  }

  if (booksImport.length) {
    throw new Error("Books Import sheet found, but no accession-number column could be recognized.");
  }
  throw new Error("No valid accession-register sheet was found. Expected a column named 'Accession No.' or 'Accession Number'.");
}

function readFileAsArrayBuffer(file) {
  if (file && typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    if (typeof FileReader === "undefined") {
      reject(new Error("This browser cannot read the selected workbook."));
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => resolve(event.target.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read the selected workbook."));
    reader.readAsArrayBuffer(file);
  });
}

export async function parseAccessionWorkbook(file, xlsx = globalThis.XLSX, options = {}) {
  if (!file) throw new Error("Choose an accession register file.");
  if (!xlsx?.read || !xlsx?.utils?.sheet_to_json) throw new Error("XLSX library is not loaded.");

  const logger = options.logger || console;
  const buffer = await readFileAsArrayBuffer(file);
  const workbook = xlsx.read(buffer, { type: "array", cellDates: false });
  if (!workbook.SheetNames?.length) throw new Error("The workbook does not contain a worksheet.");

  const worksheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    return {
      name,
      a1: sheet?.A1 ? { v: sheet.A1.v, t: sheet.A1.t, w: sheet.A1.w } : null,
      matrix: xlsx.utils.sheet_to_json(sheet, {
        header: 1,
        defval: "",
        raw: false,
        blankrows: true
      })
    };
  });
  const booksImportSheet = worksheets.find((sheet) => normalizeImportHeader(sheet.name) === "books import");
  const headerCandidates = worksheets.map((sheet) => ({
    sheet: sheet.name,
    rows: sheet.matrix.slice(0, ACCESSION_HEADER_SCAN_LIMIT).map((row, index) => ({
      row: index + 1,
      normalized: (Array.isArray(row) ? row : []).map(normalizeImportHeader)
    }))
  }));

  logger.group?.("ACCESSION IMPORT DEBUG");
  try {
    logger.log?.("File:", file.name || "(unnamed)");
    logger.log?.("Size:", Number(file.size) || buffer.byteLength || 0);
    logger.log?.("Parser version:", ACCESSION_PARSER_VERSION);
    logger.log?.("Function:", "parseAccessionWorkbook");
    logger.log?.("Workbook sheets:", workbook.SheetNames);
    logger.log?.("Books Import!A1.v:", booksImportSheet?.a1?.v);
    logger.log?.("Books Import!A1.t:", booksImportSheet?.a1?.t);
    logger.log?.("Books Import!A1.w:", booksImportSheet?.a1?.w);
    logger.log?.("First 5 rows:", booksImportSheet?.matrix?.slice(0, 5) || []);
    logger.log?.("Header candidate rows:", headerCandidates);

    const selected = selectAccessionRegisterSheet(worksheets);
    const normalizedHeaders = (selected.matrix[selected.headerRowIndex] || []).map(normalizeImportHeader);
    logger.log?.("Selected sheet:", selected.sheetName);
    logger.log?.("Detected header index:", selected.headerRowIndex);
    logger.log?.("Normalized headers:", normalizedHeaders);

    return {
      sheetName: selected.sheetName,
      matrix: selected.matrix,
      sheetHeaderRow: selected.sheetHeaderRow,
      headerRowIndex: selected.headerRowIndex,
      detectedColumns: selected.detectedColumns,
      a1: selected.a1
    };
  } finally {
    logger.groupEnd?.();
  }
}

if (typeof window !== "undefined") {
  window.__MLSU_ACCESSION_PARSER_VERSION__ = ACCESSION_PARSER_VERSION;
  window.__MLSU_PARSE_ACCESSION__ = parseAccessionWorkbook;
}

export function parseAccessionRegister(matrix = [], existingBooks = new Map(), updateExisting = false) {
  const headerRowIndex = findAccessionHeaderRow(matrix);
  if (headerRowIndex < 0) {
    throw new Error("No valid accession-register sheet was found. Expected a column named 'Accession No.' or 'Accession Number'.");
  }

  const header = matrix[headerRowIndex].map(normalizeImportHeader);
  const indexes = {};
  Object.entries(FIELD_ALIASES).forEach(([field, aliases]) => {
    indexes[field] = header.findIndex((value) => aliases.map(normalizeImportHeader).includes(value));
  });

  const seen = new Set();
  const normalizedExistingBooks = new Map(
    [...existingBooks.entries()].map(([key, value]) => [normalizeLogicalAccession(key), value])
  );
  const rows = [];
  matrix.slice(headerRowIndex + 1).forEach((sourceRow, offset) => {
    const row = Array.isArray(sourceRow) ? sourceRow : [];
    if (!row.some((cell) => cellText(cell))) return;

    const parsed = { rowNumber: headerRowIndex + offset + 2 };
    Object.keys(FIELD_ALIASES).forEach((field) => {
      const value = indexes[field] >= 0 ? row[indexes[field]] : "";
      parsed[field] = field === "accessionDate" ? accessionDateText(value) : cellText(value);
    });
    parsed.category ||= "";
    parsed.subject ||= "";
    parsed.isbn ||= "";
    parsed.publisherBarcode ||= parsed.isbn;

    const key = normalizeLogicalAccession(parsed.accessionNumber);
    const errors = [];
    let duplicateType = "";
    if (!parsed.accessionNumber) errors.push("Accession Number is required");
    if (!parsed.title) errors.push("Title is required");
    if (key && seen.has(key)) {
      errors.push("Duplicate accession number in file");
      duplicateType = "file";
    }
    if (key) seen.add(key);

    const existing = key ? normalizedExistingBooks.get(key) : null;
    if (existing && !updateExisting) {
      errors.push("Accession number already exists");
      duplicateType = duplicateType || "database";
    }

    parsed.existingBookId = existing?.id || "";
    parsed.action = existing && updateExisting ? "update" : "create";
    parsed.duplicateType = duplicateType;
    parsed.errors = errors;
    rows.push(parsed);
  });

  return { sheetHeaderRow: headerRowIndex + 1, rows };
}

export function accessionBookData(row = {}) {
  const accessionNumber = cellText(row.accessionNumber);
  return {
    accessionNumber,
    accessionDate: accessionDateText(row.accessionDate),
    author: cellText(row.author),
    title: cellText(row.title),
    placePublisher: cellText(row.placePublisher),
    year: cellText(row.year),
    pages: cellText(row.pages),
    volume: cellText(row.volume),
    source: cellText(row.source),
    billNoDate: cellText(row.billNoDate),
    cost: cellText(row.cost),
    classNo: cellText(row.classNo),
    bookNo: cellText(row.bookNo),
    callNo: cellText(row.callNo || [row.classNo, row.bookNo].filter(Boolean).join(" ")),
    withdrawalRemarks: cellText(row.withdrawalRemarks),
    imageUrl: cellText(row.imageUrl),
    notes: cellText(row.notes),
    isbn: cellText(row.isbn),
    publisherBarcode: cellText(row.publisherBarcode || row.isbn),
    category: cellText(row.category),
    subject: cellText(row.subject),
    barcodeValue: accessionNumber ? `ACC-${accessionNumber}` : ""
  };
}

export function accessionExportRow(book = {}, formatDate = (value) => String(value ?? "")) {
  const accessionNumber = cellText(book.accessionNumber || book.blegal_num || book.b_id);
  return {
    "Accession No.": accessionNumber,
    Date: cellText(book.accessionDate),
    Author: cellText(book.author),
    Title: cellText(book.title || book.bname || book.bookTitle),
    "Place & Publisher": cellText(book.placePublisher || book.publisher),
    Year: cellText(book.year),
    Pages: cellText(book.pages),
    "Vol.": cellText(book.volume),
    Source: cellText(book.source),
    "Bill No. & Date": cellText(book.billNoDate),
    "Cost (Rs.)": cellText(book.cost),
    "Class No.": cellText(book.classNo),
    "Book No.": cellText(book.bookNo),
    "Withdrawal No., Date & Remarks": cellText(book.withdrawalRemarks),
    "Image URL": cellText(book.imageUrl),
    Notes: cellText(book.notes),
    Status: cellText(book.status || "available"),
    "Issued Student UID": cellText(book.issuedStudentUid || book.issuedTo),
    "Barcode Value": cellText(book.barcodeValue || (accessionNumber ? `ACC-${accessionNumber}` : "")),
    "Barcode Printed": book.barcodePrinted === true ? "Yes" : "No",
    "Created At": book.createdAt ? formatDate(book.createdAt) : "",
    "Updated At": book.updatedAt ? formatDate(book.updatedAt) : ""
  };
}
