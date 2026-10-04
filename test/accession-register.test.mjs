import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCESSION_PARSER_VERSION,
  accessionBookData,
  accessionExportRow,
  findAccessionHeaderRow,
  normalizeImportHeader,
  parseAccessionWorkbook,
  selectAccessionRegisterSheet,
  parseAccessionRegister
} from "../public/js/accession-register.mjs";
import { normalizeAccessionNumber } from "../public/js/accession-utils.mjs";

const matrix = [
  ["Mohanlal Sukhadia University"],
  ["Accession Register"],
  ["Accession No.", "Date", "Author", "Title", "Source Image", "Cost (Rs.)"],
  ["01", "4/2/21", "Mandot (Vivek)", "Detectors", "https://example.com/cover.jpg", "295"],
  ["01", "", "Duplicate", "Duplicate title", "", ""]
];

test("detects a non-first accession header row and preserves leading zeros", () => {
  assert.equal(findAccessionHeaderRow(matrix), 2);
  const result = parseAccessionRegister(matrix);
  assert.equal(result.sheetHeaderRow, 3);
  assert.equal(result.rows[0].accessionNumber, "01");
  assert.equal(result.rows[0].imageUrl, "https://example.com/cover.jpg");
  assert.deepEqual(result.rows[1].errors, ["Duplicate accession number in file"]);
});

test("blocks existing accessions unless update mode is enabled", () => {
  const existing = new Map([["01", { id: "book-1" }]]);
  const blocked = parseAccessionRegister(matrix.slice(0, 4), existing, false).rows[0];
  assert.equal(blocked.duplicateType, "database");
  assert.ok(blocked.errors.length);

  const update = parseAccessionRegister(matrix.slice(0, 4), existing, true).rows[0];
  assert.equal(update.action, "update");
  assert.equal(update.existingBookId, "book-1");
  assert.deepEqual(update.errors, []);
});

test("prevents future imports from creating equivalent accession formats", () => {
  const importMatrix = [["Accession No.", "Title"], ["ACC-1", "Duplicate copy"]];
  const existing = new Map([["1", { id: "book-1" }]]);
  const blocked = parseAccessionRegister(importMatrix, existing, false).rows[0];
  assert.equal(blocked.duplicateType, "database");
  assert.match(blocked.errors.join(" "), /already exists/);
});

test("import duplicate prevention uses the shared accession normalization", () => {
  assert.equal(normalizeAccessionNumber("  ACC-0301 "), "301");
  const existing = new Map([[normalizeAccessionNumber("301"), { id: "book-301" }]]);
  const parsed = parseAccessionRegister([
    ["Accession No.", "Title"],
    ["ACC-0301", "Duplicate"]
  ], existing, false);
  assert.equal(parsed.rows[0].duplicateType, "database");
  assert.match(parsed.rows[0].errors.join(" "), /already exists/i);
});

test("creates the required barcode and accession export headers", () => {
  const data = accessionBookData({ accessionNumber: "005", accessionDate: 44351, title: "Book", classNo: "100", bookNo: "AUT" });
  assert.equal(data.barcodeValue, "ACC-005");
  assert.equal(data.accessionDate, "04/06/2021");
  assert.equal(data.callNo, "100 AUT");
  const exported = accessionExportRow({ ...data, status: "available" });
  assert.equal(exported["Accession No."], "005");
  assert.equal(exported["Barcode Value"], "ACC-005");
  assert.ok(Object.hasOwn(exported, "Withdrawal No., Date & Remarks"));
});

test("normalizes accession headers without requiring case or punctuation", () => {
  const aliases = [
    "Accession No.",
    " Accession No. ",
    "ACCESSION NO.",
    "Accession No",
    "Accession Number",
    "Accession\nNo.",
    "Accession\u00a0No.",
    "accession no."
  ];
  aliases.forEach((value) => {
    assert.equal(normalizeImportHeader(value), value.toLowerCase().includes("number") ? "accession number" : "accession no");
    assert.equal(findAccessionHeaderRow([["Date", value, "Title"]]), 0);
  });
  assert.equal(findAccessionHeaderRow([["Date", "Accession", "Title"]]), 0);
  assert.equal(findAccessionHeaderRow([["Date", "AccessionNo", "Title"]]), 0);
  assert.equal(findAccessionHeaderRow([["Date", "AccessionNum", "Title"]]), 0);
  assert.equal(findAccessionHeaderRow([
    ["Instructions"],
    ["ACCESSION NO.", "TITLE"]
  ]), 1);
  assert.equal(normalizeImportHeader({ richText: [{ text: "Accession" }, { text: " No." }] }), "accession no");
  assert.equal(normalizeImportHeader({ v: "Accession\nNumber" }), "accession number");
});

test("prefers Books Import, scans later header rows, and skips helper sheets", () => {
  const selected = selectAccessionRegisterSheet([
    { name: "Read Me", matrix: [["Accession No.", "Not actual data"]] },
    { name: "Needs Review", matrix: [["Accession Number", "Review note"]] },
    {
      name: "Books Import",
      matrix: [
        ["Mohanlal Sukhadia University"],
        ["Digitized accession register"],
        [" accession number ", "Author", "Title", "Publisher", "Volume", "Cost"],
        ["001", "Author One", "Book One", "MLSU Press", "I", "150"]
      ]
    }
  ]);
  assert.equal(selected.sheetName, "Books Import");
  assert.equal(selected.sheetHeaderRow, 3);
  const parsed = parseAccessionRegister(selected.matrix);
  assert.equal(parsed.rows[0].accessionNumber, "001");
  assert.equal(parsed.rows[0].placePublisher, "MLSU Press");
  assert.equal(parsed.rows[0].volume, "I");
  assert.equal(parsed.rows[0].cost, "150");
});

test("falls back to another data worksheet and supports a CSV-style single sheet", () => {
  const fallback = selectAccessionRegisterSheet([
    { name: "Read Me", matrix: [["Instructions only"]] },
    { name: "Register Data", matrix: [["accession no", "title"], ["01", "Book"]] }
  ]);
  assert.equal(fallback.sheetName, "Register Data");

  const csv = selectAccessionRegisterSheet([
    { name: "Sheet1", matrix: [["Accession Number", "Title"], ["300", "CSV Book"]] }
  ]);
  assert.equal(parseAccessionRegister(csv.matrix).rows[0].accessionNumber, "300");
});

test("uses specific workbook selection errors", () => {
  assert.throws(
    () => selectAccessionRegisterSheet([{ name: "Books Import", matrix: [["Title"]] }]),
    /Books Import sheet found, but no accession-number column could be recognized\./
  );
  assert.throws(
    () => selectAccessionRegisterSheet([{ name: "Read Me", matrix: [["Instructions"]] }]),
    /No valid accession-register sheet was found/
  );
});

test("allows optional metadata to remain blank and scans the first 20 rows", () => {
  const padded = Array.from({ length: 19 }, () => [""]);
  padded.push(["Accession No.", "Title", "Date", "Year", "Pages"]);
  padded.push(["151", "Minimal Book", "", "", ""]);
  assert.equal(findAccessionHeaderRow(padded), 19);
  const row = parseAccessionRegister(padded).rows[0];
  assert.deepEqual(row.errors, []);
  assert.equal(row.accessionDate, "");
  assert.equal(row.year, "");
  assert.equal(row.pages, "");
});

test("canonical workbook parser reads Books Import and exposes runtime diagnostics", async () => {
  const logs = [];
  const logger = {
    group: (...values) => logs.push(values),
    log: (...values) => logs.push(values),
    groupEnd: () => {}
  };
  const worksheet = {
    A1: { v: "Accession No.", t: "s", w: "Accession No." },
    matrix: [
      ["", "Date", "Author", "Title", "Place & Publisher", "Year", "Pages", "Vol.", "Source", "Bill No. & Date", "Cost (Rs.)", "Notes"],
      ["001", "", "Author", "Title", "Publisher", "2020", "100", "", "", "", "10", ""]
    ]
  };
  const xlsx = {
    read: () => ({ SheetNames: ["Books Import"], Sheets: { "Books Import": worksheet } }),
    utils: { sheet_to_json: (sheet) => sheet.matrix }
  };
  const file = {
    name: "register.xlsx",
    size: 123,
    arrayBuffer: async () => new ArrayBuffer(8)
  };

  const result = await parseAccessionWorkbook(file, xlsx, { logger });
  assert.equal(ACCESSION_PARSER_VERSION, "2026-10-04-runtime-fix-1");
  assert.equal(result.sheetName, "Books Import");
  assert.equal(result.headerRowIndex, 0);
  assert.equal(result.matrix[0][0], "Accession No.");
  assert.ok(logs.some((entry) => entry[0] === "Books Import!A1.v:" && entry[1] === "Accession No."));
  assert.ok(logs.some((entry) => entry[0] === "Detected header index:" && entry[1] === 0));
});
