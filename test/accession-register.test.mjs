import test from "node:test";
import assert from "node:assert/strict";
import {
  accessionBookData,
  accessionExportRow,
  findAccessionHeaderRow,
  parseAccessionRegister
} from "../public/js/accession-register.mjs";

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

test("creates the required barcode and accession export headers", () => {
  const data = accessionBookData({ accessionNumber: "005", accessionDate: 44351, title: "Book" });
  assert.equal(data.barcodeValue, "ACC-005");
  assert.equal(data.accessionDate, "04/06/2021");
  const exported = accessionExportRow({ ...data, status: "available" });
  assert.equal(exported["Accession No."], "005");
  assert.equal(exported["Barcode Value"], "ACC-005");
  assert.ok(Object.hasOwn(exported, "Withdrawal No., Date & Remarks"));
});
