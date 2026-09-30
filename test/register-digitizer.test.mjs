import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  REGISTER_EXPORT_HEADERS,
  alignRegisterRowSegments,
  createMockOcrResult,
  createRowCountDiagnostics,
  digitizedRowsToMatrix,
  isDittoValue,
  ocrFailureState,
  ocrModeForResult,
  paginateRows,
  parseOcrLikeRows,
  resolveAccessionSequences,
  resolveDittoValues,
  validateDigitizedRows
} from "../public/js/register-digitizer.mjs";
import {
  DEFAULT_COLUMN_LAYOUT,
  buildVisualRowsFromWords,
  chooseBestOcrCandidate,
  normalizeColumnLayout,
  normalizeOcrFieldText,
  selectAccessionAnchors
} from "../public/js/local-register-ocr.mjs";

function fixtureRows(count = 25) {
  return Array.from({ length: count }, (_, index) => ({
    accessionNumber: String(index + 1).padStart(2, "0"),
    author: index ? "do" : "A. Sharma",
    title: index ? "-do-" : "Complete Register Title",
    placePublisher: index ? "\"" : "Udaipur Press",
    year: "2001",
    cost: "100",
    confidence: 95,
    rowNumber: index + 1
  }));
}

test("parser preserves more than five OCR rows", () => {
  assert.equal(parseOcrLikeRows(fixtureRows(12)).length, 12);
});

test("25-row fixture returns all 25 records", () => {
  const result = createMockOcrResult([{ name: "register.jpg" }]);
  assert.equal(result.rows.length, 25);
  assert.equal(parseOcrLikeRows(result.rows).length, 25);
  assert.equal(result.debug.rowsDetected, 25);
});

test("parser has no hidden five-row maximum", () => {
  const rows = parseOcrLikeRows(fixtureRows(40));
  assert.equal(rows.length, 40);
  assert.equal(rows.at(-1).accessionNumber, "40");
});

test("ditto-only row survives preprocessing", () => {
  const rows = parseOcrLikeRows([
    { accessionNumber: "01", author: "A. Sharma", title: "First", placePublisher: "Udaipur" },
    { accessionNumber: "02", author: "do", title: "-do-", placePublisher: "\"" }
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].accessionNumber, "02");
});

test("ditto values resolve before validation", () => {
  const resolved = resolveDittoValues([
    { accessionNumber: "01", author: "A. Sharma", title: "First", placePublisher: "Udaipur", confidence: 95 },
    { accessionNumber: "02", author: "do", title: "-do-", placePublisher: "〃", confidence: 95 }
  ]);
  const validated = validateDigitizedRows(resolved);
  assert.equal(validated[1].author, "A. Sharma");
  assert.equal(validated[1].title, "First");
  assert.equal(validated[1].status, "Valid");
});

test("do, does, paired quotes, and handwritten dash variants repeat by column", () => {
  ["do", "-do-", "does", "-does-", "\"\"", "''", "〃", "—olo—", "—Ao—"].forEach((value) => {
    assert.equal(isDittoValue(value), true, `${value} should be a ditto marker`);
  });
  const resolved = resolveDittoValues([
    { accessionNumber: "01", author: "Author One", title: "Title One", placePublisher: "Publisher One" },
    { accessionNumber: "02", author: "-does-", title: "\"\"", placePublisher: "—olo—" }
  ]);
  assert.equal(resolved[1].author, "Author One");
  assert.equal(resolved[1].title, "Title One");
  assert.equal(resolved[1].placePublisher, "Publisher One");
  assert.equal(resolved[1].rawCells.author, "-does-");
  assert.equal(resolved[1].resolvedCells.author, "Author One");
});

test("page-level accession prefix is inherited across the sequence", () => {
  const rows = resolveAccessionSequences([
    { accessionNumber: "18 01", rawAccessionText: "18 01", detectedPrefix: "18", detectedSuffix: "01", prefixConfidence: 0.96 },
    { accessionNumber: "02", rawAccessionText: "02" },
    { accessionNumber: "03", rawAccessionText: "03" }
  ]);
  assert.deepEqual(rows.map((row) => row.accessionNumber), ["1801", "1802", "1803"]);
});

test("confident 18 plus 01 reconstructs accession 1801", () => {
  const [row] = resolveAccessionSequences([
    { accessionNumber: "18 01", rawAccessionText: "18 01", detectedPrefix: "18", detectedSuffix: "01", prefixConfidence: 94 }
  ]);
  assert.equal(row.resolvedAccessionNumber, "1801");
  assert.equal(row.accessionPrefixConfidence, 0.94);
  assert.equal(row.accessionNeedsReview, false);
});

test("low-confidence accession prefix is not invented", () => {
  const [row] = resolveAccessionSequences([
    { accessionNumber: "01", rawAccessionText: "18 01", detectedPrefix: "18", detectedSuffix: "01", prefixConfidence: 0.4 }
  ]);
  assert.equal(row.accessionNumber, "01");
  assert.equal(row.accessionNeedsReview, true);
});

test("left and right row segments align by Y-center tolerance", () => {
  const rows = alignRegisterRowSegments([
    { pageNumber: 1, pageSide: "left", bounds: { x: 0, y: 100, width: 500, height: 40 }, fields: { accessionNumber: "01", author: "A", title: "T1" }, confidence: 90 },
    { pageNumber: 1, pageSide: "left", bounds: { x: 0, y: 160, width: 500, height: 40 }, fields: { accessionNumber: "02", author: "B", title: "T2" }, confidence: 88 },
    { pageNumber: 1, pageSide: "right", bounds: { x: 510, y: 103, width: 500, height: 40 }, fields: { placePublisher: "P1", year: "2001" }, confidence: 92 },
    { pageNumber: 1, pageSide: "right", bounds: { x: 510, y: 157, width: 500, height: 40 }, fields: { placePublisher: "P2", year: "2002" }, confidence: 89 }
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].accessionNumber, "01");
  assert.equal(rows[0].placePublisher, "P1");
  assert.equal(rows[1].placePublisher, "P2");
  assert.equal(rows[0].sourceBounds.length, 2);
});

test("row-count mismatch produces an explicit warning", () => {
  const diagnostics = createRowCountDiagnostics({ detectedRows: 25, processedRows: 25, parsedRows: 5 });
  assert.equal(diagnostics.hasMismatch, true);
  assert.equal(diagnostics.warning, "Only 5 of 25 detected register rows were parsed.");
});

test("missing live visual row count cannot pass silently", () => {
  const diagnostics = createRowCountDiagnostics({ detectedRows: 0, processedRows: 5, parsedRows: 5 });
  assert.equal(diagnostics.detectionAvailable, false);
  assert.match(diagnostics.warning, /did not report a visual row count/);
});

test("pagination never truncates the extracted record set", () => {
  const rows = fixtureRows(25);
  const pages = [1, 2, 3].flatMap((page) => paginateRows(rows, page, 10).rows);
  assert.equal(pages.length, 25);
  assert.equal(paginateRows(rows, 1, 10).totalRows, 25);
  assert.equal(paginateRows(rows, 3, 10).rows.length, 5);
});

test("OCR mode is displayed from the provider result", () => {
  assert.equal(ocrModeForResult({ mode: "local", configured: true }), "LOCAL");
  assert.equal(ocrModeForResult({ mode: "live", configured: true }), "LIVE");
  assert.equal(ocrModeForResult({ mode: "mock", configured: false }), "MOCK");
});

test("failed live OCR returns no rows and only offers explicit mock data", () => {
  const state = ocrFailureState({ message: "engine unavailable" }, "LOCAL FAILED");
  assert.equal(state.mode, "LOCAL FAILED");
  assert.equal(state.offerMock, true);
  assert.deepEqual(state.rows, []);
  assert.match(state.message, /engine unavailable/);
});

test("local OCR failure cannot silently enter the mock fixture path", () => {
  const clientSource = readFileSync(new URL("../public/js/register-digitizer.js", import.meta.url), "utf8");
  assert.match(clientSource, /extractRegisterLocally/);
  const extractionStart = clientSource.indexOf("async function startExtraction");
  const catchStart = clientSource.indexOf("} catch (error) {", extractionStart);
  const catchBlock = clientSource.slice(catchStart, clientSource.indexOf("} finally {", catchStart));
  assert.doesNotMatch(catchBlock, /createMockOcrResult/);
  assert.match(clientSource, /No mock rows were substituted/);
});

test("Register OCR runs locally without a Firebase callable dependency", () => {
  const clientSource = readFileSync(new URL("../public/js/register-digitizer.js", import.meta.url), "utf8");
  const localSource = readFileSync(new URL("../public/js/local-register-ocr.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(clientSource, /getFunctions|httpsCallable|extractRegisterOcr/);
  assert.match(clientSource, /extractRegisterLocally/);
  assert.match(localSource, /Tesseract\.createWorker/);
  assert.match(localSource, /recognizeCell/);
  assert.match(localSource, /processedCellCanvas/);
  assert.match(localSource, /detectedColumnLayout/);
  assert.doesNotMatch(clientSource, /cloudfunctions\.net\/extractRegisterOcr/);
});

test("local OCR accession anchors preserve all 25 visual rows", () => {
  const words = Array.from({ length: 25 }, (_, index) => ({
    text: index === 12 ? "413" : String(index + 1).padStart(2, "0"),
    confidence: 95,
    left: 500,
    top: 400 + index * 105,
    width: 50,
    height: 35,
    centerX: 525,
    centerY: 417.5 + index * 105
  }));
  words.push({ text: "Author", confidence: 90, left: 800, top: 400, width: 100, height: 30, centerX: 850, centerY: 415 });
  words.push({ text: "Title", confidence: 90, left: 1500, top: 400, width: 100, height: 30, centerX: 1550, centerY: 415 });
  const anchors = selectAccessionAnchors(words, 4096, 3072);
  const result = buildVisualRowsFromWords(words, 4096, 3072, { anchors, prefix: "18", prefixConfidence: 60, pageNumber: 1 });
  assert.equal(anchors.length, 25);
  assert.equal(result.detectedRows, 25);
  assert.equal(result.rows[0].accessionNumber, "1801");
  assert.equal(result.rows[12].accessionNumber, "1813");
  assert.equal(result.rows[24].accessionNumber, "1825");
});

test("duplicate accession detection covers upload and Firestore keys", () => {
  const rows = validateDigitizedRows([
    { accessionNumber: "01", author: "One", title: "Book One", confidence: 95 },
    { accessionNumber: "01", author: "Two", title: "Book Two", confidence: 95 },
    { accessionNumber: "03", author: "Three", title: "Book Three", confidence: 95 }
  ], new Set(["03"]));
  assert.equal(rows[0].status, "Valid");
  assert.equal(rows[1].status, "Duplicate");
  assert.equal(rows[2].status, "Duplicate");
});

test("required fields and numeric year/cost validation produce review states", () => {
  const rows = validateDigitizedRows([
    { accessionNumber: "", author: "", title: "", confidence: 90 },
    { accessionNumber: "02", author: "Writer", title: "Valid", year: "20O4", cost: "Rs. 10", confidence: 90 },
    { accessionNumber: "03", author: "", title: "Readable", year: "2004", cost: "10.50", confidence: 90 }
  ]);
  assert.equal(rows[0].status, "Invalid");
  assert.equal(rows[1].status, "Needs Review");
  assert.equal(rows[2].status, "Valid");
});

test("field-specific OCR normalization only corrects numeric contexts", () => {
  assert.equal(normalizeOcrFieldText(" 20O4 ", "year"), "2004");
  assert.equal(normalizeOcrFieldText("18O1", "accessionNumber"), "1801");
  assert.equal(normalizeOcrFieldText("  Reiser   (John)  ", "author"), "Reiser (John)");
  assert.equal(normalizeOcrFieldText("xii + 465", "pages"), "xii + 465");
});

test("multi-pass selection rewards valid year and readable text", () => {
  const year = chooseBestOcrCandidate([
    { rawText: "2OO7", confidence: 62, variant: "original" },
    { rawText: "2007", confidence: 58, variant: "threshold" }
  ], "year");
  assert.equal(year.normalizedText, "2007");
  const author = chooseBestOcrCandidate([
    { rawText: "R", confidence: 88, variant: "threshold" },
    { rawText: "Reiser (John)", confidence: 72, variant: "contrast" }
  ], "author");
  assert.equal(author.normalizedText, "Reiser (John)");
});

test("column calibration preserves stable ordered page boundaries", () => {
  const calibrated = DEFAULT_COLUMN_LAYOUT.map((item) => ({ ...item }));
  calibrated[1].end = 0.181;
  calibrated[2].start = 0.181;
  const normalized = normalizeColumnLayout(calibrated);
  assert.equal(normalized.length, DEFAULT_COLUMN_LAYOUT.length);
  assert.equal(normalized[1].end, 0.181);
  normalized.forEach((item, index) => {
    assert.ok(item.end > item.start);
    if (index) assert.ok(item.start >= normalized[index - 1].end);
  });
});

test("weak optional metadata needs review but does not invalidate the row", () => {
  const [row] = validateDigitizedRows([{
    accessionNumber: "1801",
    author: "Reiser",
    title: "Engineering Thermodynamics",
    year: "20O7",
    confidence: 75,
    fieldConfidence: { accessionNumber: 96, author: 72, title: 81, year: 44 }
  }]);
  assert.equal(row.status, "Needs Review");
  assert.ok(row.errors.includes("invalid year"));
});

test("OCR table parsing ignores decoration and merges continuation by column", () => {
  const parsed = parseOcrLikeRows([
    "Mohanlal Sukhadia University Accession Register",
    "Accession No. | Date | Author | Title | Place & Publisher | Year | Pages | Vol. | Source | Bill No. & Date | Cost | Class No. | Book No. | Call No. | Remarks | Image URL | Notes",
    "Page 7",
    "07 | | R. Mehta | History of Mewar | Udaipur Press | 2001 | 240 | | Purchase | B-7 | 150 | 954 | MEH | 954 MEH | Clear | |",
    " | | | and Rajasthan library records",
    "08 | | do | Political Thought | -do- | 2002 | 200 | | \" | B-8 | 175 | 320 | MEH | 320 MEH | | |"
  ]);
  assert.equal(parsed.length, 2);
  assert.match(parsed[0].title, /History of Mewar and Rajasthan library records/);
  assert.equal(parsed[1].author, "R. Mehta");
  assert.equal(parsed[1].placePublisher, "Udaipur Press");
});

test("Excel export matrix uses the exact 16-column LMS import template", () => {
  const rows = validateDigitizedRows([{
    accessionNumber: "1801", accessionDate: "01/01/2026", author: "A. Author", title: "A Book", placePublisher: "Udaipur Press",
    year: "2026", pages: "120", volume: "1", source: "Purchase", billNoDate: "B-1 / 01-01-2026", cost: "250",
    classNo: "100", bookNo: "AUT", callNo: "100 AUT", remarks: "", imageUrl: "", notes: "Reviewed", confidence: 100, origin: "manual"
  }]);
  const matrix = digitizedRowsToMatrix(rows);
  assert.deepEqual(matrix[0], REGISTER_EXPORT_HEADERS);
  assert.equal(matrix[0].length, 16);
  assert.equal(matrix[1][0], "1801");
  assert.equal(matrix[1][1], "01/01/2026");
  assert.equal(matrix[1][7], "1");
  assert.equal(matrix[1][15], "Reviewed");
});
