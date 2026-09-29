import test from "node:test";
import assert from "node:assert/strict";
import {
  REGISTER_EXPORT_HEADERS,
  createMockOcrResult,
  digitizedRowsToMatrix,
  rowsReadyForImport,
  summarizeDigitizedRows,
  validateDigitizedRows
} from "../public/js/register-digitizer.mjs";

test("mock OCR fixtures include handwriting edge cases", () => {
  const result = createMockOcrResult([{ name: "register.pdf" }, { name: "page.jpg" }]);
  assert.equal(result.provider, "mock");
  assert.equal(result.configured, false);
  assert.equal(result.pages, 3);
  assert.equal(result.rows.some((row) => row.accessionNumber === "0001"), true);
  assert.equal(result.rows.some((row) => Number(row.confidence) < 80), true);
  assert.equal(result.rows.some((row) => !row.pages), true);
  assert.equal(result.rows.some((row) => /multi-line/i.test(row.notes)), true);
});

test("validation preserves leading zeros and marks duplicates/invalid rows", () => {
  const result = createMockOcrResult([{ name: "register.pdf" }]);
  const rows = validateDigitizedRows(result.rows, new Set(["0003"]));
  assert.equal(rows[0].accessionNumber, "0001");
  assert.equal(rows[0].status, "Ready");
  assert.equal(rows[1].status, "Needs Review");
  assert.equal(rows[2].status, "Duplicate");
  assert.equal(rows[2].errors.includes("duplicate against Firestore"), true);
  assert.equal(rows[3].status, "Duplicate");
  assert.equal(rows[3].errors.includes("duplicate inside upload"), true);
  const summary = summarizeDigitizedRows(rows);
  assert.equal(summary.total, 5);
  assert.equal(summary.ready, 2);
  assert.equal(summary.needsReview, 1);
  assert.equal(summary.duplicates, 2);
});

test("export matrix uses exact importer-compatible headers", () => {
  const rows = validateDigitizedRows(createMockOcrResult([{ name: "one.png" }]).rows, new Set());
  const matrix = digitizedRowsToMatrix(rows);
  assert.deepEqual(matrix[0], REGISTER_EXPORT_HEADERS);
  assert.equal(matrix[1][0], "0001");
  assert.equal(rowsReadyForImport(rows).every((row) => row.status === "Ready"), true);
});
