export const REGISTER_EXPORT_HEADERS = [
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

export const REGISTER_FIELDS = [
  "accessionNumber",
  "accessionDate",
  "author",
  "title",
  "placePublisher",
  "year",
  "pages",
  "volume",
  "source",
  "billNoDate",
  "cost",
  "classNo",
  "bookNo",
  "withdrawalRemarks",
  "imageUrl",
  "notes"
];

const HEADER_BY_FIELD = {
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
  withdrawalRemarks: "Withdrawal No., Date & Remarks",
  imageUrl: "Image URL",
  notes: "Notes"
};

export function normalizeAccessionKey(value = "") {
  return String(value || "").trim().toLowerCase();
}

export function confidenceStatus(confidence = 0) {
  const value = Number(confidence || 0);
  if (value >= 90) return "high";
  if (value >= 80) return "medium";
  return "low";
}

export function createMockOcrResult(files = []) {
  const pageCount = files.reduce((sum, file) => {
    const isPdf = String(file.name || "").toLowerCase().endsWith(".pdf");
    return sum + (isPdf ? 2 : 1);
  }, 0) || 1;
  const rows = [
    {
      accessionNumber: "0001",
      accessionDate: "01/07/1998",
      author: "Dr. K. Sharma",
      title: "Fundamentals of Physics",
      placePublisher: "Udaipur: Academic Press",
      year: "1998",
      pages: "412",
      volume: "I",
      source: "Purchase",
      billNoDate: "B-12 / 01-07-1998",
      cost: "125.00",
      classNo: "530",
      bookNo: "SHA",
      withdrawalRemarks: "",
      imageUrl: "",
      notes: "clean handwriting",
      pageNumber: 1,
      rowNumber: 1,
      confidence: 96,
      rawText: "0001 Dr K Sharma Fundamentals of Physics"
    },
    {
      accessionNumber: "0002",
      accessionDate: "02/07/1998",
      author: "S. ?",
      title: "Organic Chemistry Notes",
      placePublisher: "Jaipur: College Pub.",
      year: "1999",
      pages: "288",
      volume: "",
      source: "Purchase",
      billNoDate: "B-13 / 02-07-1998",
      cost: "90",
      classNo: "547",
      bookNo: "ORG",
      withdrawalRemarks: "",
      imageUrl: "",
      notes: "low-confidence author",
      pageNumber: 1,
      rowNumber: 2,
      confidence: 82,
      rawText: "0002 S? Organic Chemistry Notes"
    },
    {
      accessionNumber: "0003",
      accessionDate: "03/07/1998",
      author: "M. Jain",
      title: "Data Structures and Algorithms",
      placePublisher: "Delhi: Tech House",
      year: "20O1",
      pages: "",
      volume: "",
      source: "Donation",
      billNoDate: "",
      cost: "abc",
      classNo: "005.73",
      bookNo: "JAI",
      withdrawalRemarks: "",
      imageUrl: "",
      notes: "unclear year and blank pages",
      pageNumber: Math.min(2, pageCount),
      rowNumber: 3,
      confidence: 74,
      rawText: "0003 M Jain Data Structures and Algorithms 20O1"
    },
    {
      accessionNumber: "0002",
      accessionDate: "04/07/1998",
      author: "Duplicate Author",
      title: "Repeated OCR Row",
      placePublisher: "",
      year: "2001",
      pages: "100",
      volume: "",
      source: "",
      billNoDate: "",
      cost: "50",
      classNo: "",
      bookNo: "",
      withdrawalRemarks: "",
      imageUrl: "",
      notes: "duplicate accession in upload",
      pageNumber: Math.min(2, pageCount),
      rowNumber: 4,
      confidence: 91,
      rawText: "0002 Duplicate Author Repeated OCR Row"
    },
    {
      accessionNumber: "0004",
      accessionDate: "05/07/1998",
      author: "A. Mehta",
      title: "Multi-line title: History of Rajasthan and Mewar Library Records",
      placePublisher: "Udaipur",
      year: "2004",
      pages: "350",
      volume: "II",
      source: "Gift",
      billNoDate: "",
      cost: "0",
      classNo: "954.4",
      bookNo: "MEH",
      withdrawalRemarks: "",
      imageUrl: "",
      notes: "multi-line title",
      pageNumber: pageCount,
      rowNumber: 5,
      confidence: 88,
      rawText: "0004 A Mehta History of Rajasthan / and Mewar Library Records"
    }
  ];
  return {
    provider: "mock",
    configured: false,
    message: "OCR credentials are not configured. Mock OCR fixture data is shown for review/testing.",
    pages: pageCount,
    rows
  };
}

export function validateDigitizedRows(rows = [], existingAccessions = new Set()) {
  const seen = new Map();
  return rows.map((row, index) => {
    const accession = String(row.accessionNumber || "").trim();
    const key = normalizeAccessionKey(accession);
    const errors = [];
    let duplicateType = "";

    if (!accession) errors.push("blank accession");
    if (!String(row.title || "").trim()) errors.push("missing title");
    if (key && seen.has(key)) {
      errors.push("duplicate inside upload");
      duplicateType = "upload";
    }
    if (key && existingAccessions.has(key)) {
      errors.push("duplicate against Firestore");
      duplicateType = duplicateType || "firestore";
    }
    if (row.year && !/^\d{4}$/.test(String(row.year).trim())) errors.push("invalid year");
    if (row.cost && Number.isNaN(Number(String(row.cost).replace(/,/g, "")))) errors.push("invalid cost");
    if (row.rawText && seen.get(key)?.rawText === row.rawText) errors.push("repeated OCR row");
    if (["author", "title", "placePublisher"].some((field) => String(row[field] || "").includes("?"))) {
      errors.push("uncertain OCR text");
    }
    if (Number(row.confidence || 0) < 80) errors.push("low confidence");

    if (key && !seen.has(key)) seen.set(key, row);

    const status = errors.some((error) => error.includes("duplicate"))
      ? "Duplicate"
      : errors.some((error) => ["blank accession", "invalid year", "invalid cost"].includes(error))
        ? "Invalid"
        : errors.length
          ? "Needs Review"
          : "Ready";

    return {
      ...row,
      id: row.id || `ocr-row-${index + 1}`,
      accessionNumber: accession,
      confidence: Number(row.confidence || 0),
      confidenceStatus: confidenceStatus(row.confidence),
      duplicateType,
      errors,
      status
    };
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
  return Object.fromEntries(REGISTER_FIELDS.map((field) => [HEADER_BY_FIELD[field], String(row[field] ?? "")]));
}

export function digitizedRowsToMatrix(rows = []) {
  return [
    REGISTER_EXPORT_HEADERS,
    ...rows.map((row) => REGISTER_EXPORT_HEADERS.map((header) => digitizedRowToExportRow(row)[header] || ""))
  ];
}

export function rowsReadyForImport(rows = []) {
  return rows.filter((row) => row.status === "Ready");
}
