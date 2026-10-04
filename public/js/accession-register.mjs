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
    const headerRowIndex = findAccessionHeaderRow(sheet.matrix, maxRows);
    if (headerRowIndex >= 0) {
      return {
        sheetName: sheet.name,
        matrix: sheet.matrix,
        headerRowIndex,
        sheetHeaderRow: headerRowIndex + 1,
        detectedColumns: (sheet.matrix[headerRowIndex] || []).map(cellText).filter(Boolean)
      };
    }
  }

  if (booksImport.length) {
    throw new Error("Books Import sheet found, but no accession-number column could be recognized.");
  }
  throw new Error("No valid accession-register sheet was found. Expected a column named 'Accession No.' or 'Accession Number'.");
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

    const key = parsed.accessionNumber.toLowerCase();
    const errors = [];
    let duplicateType = "";
    if (!parsed.accessionNumber) errors.push("Accession Number is required");
    if (!parsed.title) errors.push("Title is required");
    if (key && seen.has(key)) {
      errors.push("Duplicate accession number in file");
      duplicateType = "file";
    }
    if (key) seen.add(key);

    const existing = key ? existingBooks.get(key) : null;
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
