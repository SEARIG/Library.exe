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
  accessionNumber: ["Accession No.", "Accession Number", "Accession No"],
  accessionDate: ["Date"],
  author: ["Author"],
  title: ["Title"],
  placePublisher: ["Place & Publisher"],
  year: ["Year"],
  pages: ["Pages"],
  volume: ["Vol.", "Vol", "Volume"],
  source: ["Source"],
  billNoDate: ["Bill No. & Date", "Bill No & Date"],
  cost: ["Cost (Rs.)", "Cost"],
  classNo: ["Class No.", "Class No"],
  bookNo: ["Book No.", "Book No"],
  withdrawalRemarks: ["Withdrawal No., Date & Remarks", "Withdrawal Remarks"],
  imageUrl: ["Source Image", "Image URL", "Image Url", "Cover URL"],
  notes: ["Notes"],
  isbn: ["ISBN"],
  publisherBarcode: ["Publisher Barcode"],
  category: ["Category"],
  subject: ["Subject"]
};

function normalizedHeader(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[.,()]/g, "")
    .replace(/\s+/g, " ");
}

function cellText(value) {
  return String(value ?? "").trim();
}

const ACCESSION_HEADERS = new Set(FIELD_ALIASES.accessionNumber.map(normalizedHeader));

export function findAccessionHeaderRow(matrix = []) {
  return matrix.findIndex((row) =>
    (Array.isArray(row) ? row : []).some((cell) => ACCESSION_HEADERS.has(normalizedHeader(cell)))
  );
}

export function parseAccessionRegister(matrix = [], existingBooks = new Map(), updateExisting = false) {
  const headerRowIndex = findAccessionHeaderRow(matrix);
  if (headerRowIndex < 0) {
    throw new Error('Header row not found. The workbook must contain "Accession No." or "Accession Number".');
  }

  const header = matrix[headerRowIndex].map(normalizedHeader);
  const indexes = {};
  Object.entries(FIELD_ALIASES).forEach(([field, aliases]) => {
    indexes[field] = header.findIndex((value) => aliases.map(normalizedHeader).includes(value));
  });

  const seen = new Set();
  const rows = [];
  matrix.slice(headerRowIndex + 1).forEach((sourceRow, offset) => {
    const row = Array.isArray(sourceRow) ? sourceRow : [];
    if (!row.some((cell) => cellText(cell))) return;

    const parsed = { rowNumber: headerRowIndex + offset + 2 };
    Object.keys(FIELD_ALIASES).forEach((field) => {
      parsed[field] = indexes[field] >= 0 ? cellText(row[indexes[field]]) : "";
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
    accessionDate: cellText(row.accessionDate),
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
