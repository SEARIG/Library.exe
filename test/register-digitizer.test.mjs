import test from "node:test";
import assert from "node:assert/strict";
import {
  REGISTER_EXPORT_HEADERS,
  createMockOcrResult,
  digitizedRowsToMatrix,
  parseOcrLikeRows,
  resolveDittoValues,
  validateDigitizedRows
} from "../public/js/register-digitizer.mjs";

test("ditto resolution inherits the previous non-empty value in the same column", () => {
  const rows = resolveDittoValues([
    { accessionNumber: "0001", author: "A. Sharma", placePublisher: "Udaipur Press", source: "Purchase", title: "First" },
    { accessionNumber: "0002", author: "do", placePublisher: "-do-", source: "\"", title: "Second" },
    { accessionNumber: "0003", author: "〃", placePublisher: "Ditto", source: "do.", title: "Third" }
  ]);
  assert.equal(rows[1].author, "A. Sharma");
  assert.equal(rows[1].placePublisher, "Udaipur Press");
  assert.equal(rows[1].source, "Purchase");
  assert.equal(rows[2].author, "A. Sharma");
  assert.deepEqual(rows[1].dittoResolvedFields.sort(), ["author", "placePublisher", "source"]);
  assert.equal(rows[1].accessionNumber, "0002");
});

test("duplicate accession detection covers upload rows and existing Firestore keys", () => {
  const rows = validateDigitizedRows([
    { accessionNumber: "0001", author: "One", title: "Book One", confidence: 95 },
    { accessionNumber: "0001", author: "Two", title: "Book Two", confidence: 95 },
    { accessionNumber: "0003", author: "Three", title: "Book Three", confidence: 95 }
  ], new Set(["0003"]));
  assert.equal(rows[0].status, "Ready");
  assert.equal(rows[1].status, "Duplicate");
  assert.equal(rows[1].errors.includes("duplicate inside upload"), true);
  assert.equal(rows[2].status, "Duplicate");
  assert.equal(rows[2].errors.includes("duplicate against Firestore"), true);
});

test("required fields and numeric year/cost validation produce review badges", () => {
  const rows = validateDigitizedRows([
    { accessionNumber: "", author: "", title: "", confidence: 90 },
    { accessionNumber: "0002", author: "Writer", title: "Valid title", year: "20O4", cost: "Rs. 10", confidence: 90 },
    { accessionNumber: "0003", author: "", title: "Readable title", year: "2004", cost: "10.50", confidence: 90 }
  ]);
  assert.equal(rows[0].status, "Invalid");
  assert.equal(rows[0].errors.includes("missing accession number"), true);
  assert.equal(rows[0].errors.includes("missing title"), true);
  assert.equal(rows[1].status, "Invalid");
  assert.equal(rows[1].errors.includes("invalid year"), true);
  assert.equal(rows[1].errors.includes("invalid cost"), true);
  assert.equal(rows[2].status, "Needs Review");
  assert.equal(rows[2].errors.includes("missing author"), true);
});

test("OCR-like table parsing ignores decoration, joins continuation text, and resolves ditto", () => {
  const parsed = parseOcrLikeRows([
    "Mohanlal Sukhadia University Accession Register",
    "Accession No. | Author | Title | Place & Publisher | Year | Pages | Source | Bill No. & Date | Cost | Class No. | Book No. | Call No. | Remarks",
    "Page 7",
    "0007 | R. Mehta | History of Mewar | Udaipur Press | 2001 | 240 | Purchase | B-7 | 150 | 954 | MEH | 954 MEH | Clear",
    " | | and Rajasthan library records",
    "0008 | do | Political Thought | -do- | 2002 | 200 | \" | B-8 | 175 | 320 | MEH | 320 MEH |"
  ]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].accessionNumber, "0007");
  assert.match(parsed[0].title, /History of Mewar and Rajasthan library records/);
  assert.equal(parsed[1].author, "R. Mehta");
  assert.equal(parsed[1].placePublisher, "Udaipur Press");
  assert.equal(parsed[1].source, "Purchase");

  const mock = parseOcrLikeRows(createMockOcrResult([{ name: "register.pdf" }]).rows);
  assert.equal(mock[1].author, "Dr. K. Sharma");
  assert.equal(mock[1].dittoResolvedFields.includes("author"), true);
});

test("Excel export matrix uses the 13 reviewed LMS column mappings", () => {
  const rows = validateDigitizedRows([{
    accessionNumber: "0001",
    author: "A. Author",
    title: "A Book",
    placePublisher: "Udaipur Press",
    year: "2026",
    pages: "120",
    source: "Purchase",
    billNoDate: "B-1 / 01-01-2026",
    cost: "250",
    classNo: "100",
    bookNo: "AUT",
    callNo: "100 AUT",
    remarks: "",
    confidence: 100,
    origin: "manual"
  }]);
  const matrix = digitizedRowsToMatrix(rows);
  assert.deepEqual(matrix[0], REGISTER_EXPORT_HEADERS);
  assert.equal(matrix[0].length, 13);
  assert.equal(matrix[1][0], "0001");
  assert.equal(matrix[1][11], "100 AUT");
  assert.equal(matrix[1][12], "");
});
