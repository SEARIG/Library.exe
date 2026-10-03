import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const page = fs.readFileSync("public/librarian-dashboard.html", "utf8");
const script = fs.readFileSync("public/js/librarian-dashboard.js", "utf8");
const styles = fs.readFileSync("public/css/style.css", "utf8");
const rules = fs.readFileSync("firestore.rules", "utf8");

test("book database is a filtered, sorted and paginated management table", () => {
  for (const id of ["bookSearch", "bookCategoryFilter", "bookAvailabilityFilter", "bookSort", "bookDatabasePagination"]) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
  for (const heading of ["Accession No.", "Place &amp; Publisher", "Bill No &amp; Date", "Issued Student UID", "Actions"]) {
    assert.match(script, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(script, /const BOOK_DATABASE_PAGE_SIZE = 25/);
  assert.match(script, /function filteredBookRows\(\)/);
  assert.match(script, /function displayBookStatus\(item\)/);
  assert.match(styles, /\.book-database-table th\s*{[^}]*position:\s*sticky/s);
  assert.match(styles, /tbody tr:nth-child\(even\)/);
});

test("book deletion is Admin-only and blocks active circulation", () => {
  assert.match(script, /session\.profile\.role === "admin"/);
  assert.match(script, /Are you sure you want to delete this book record\?/);
  assert.match(script, /bookHasIssueConflict\(data\) \|\| await activeIssueConflictForBook\(id, data\.b_id\)/);
  assert.match(script, /await deleteDoc\(doc\(db, "books", id\)\)/);
  assert.match(script, /Resolve the active issue request before deleting this book/);
  assert.match(rules, /match \/books\/\{bookId\}[\s\S]*?allow delete:\s*if isAdmin\(\);/);
});

test("import flow has drop zone, options, validation summary and safe confirmation", () => {
  for (const id of [
    "bookImportDropZone",
    "bookImportFileName",
    "updateExistingBooks",
    "skipDuplicateBooks",
    "preserveIssueHistory",
    "importReadyRows",
    "importDuplicateRows",
    "importInvalidRows",
    "confirmBookImportBtn"
  ]) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
  assert.match(page, /id="preserveIssueHistory"[^>]*checked disabled/);
  assert.match(script, /addEventListener\("drop"/);
  assert.match(script, /if \(!validRows\.length\) throw new Error/);
  assert.match(script, /issuedStudentUid:\s*null/);
});

test("export flow supports filters, scopes, Excel and CSV", () => {
  for (const id of [
    "exportCategoryFilter",
    "exportStatusFilter",
    "exportAccessionFrom",
    "exportAccessionTo",
    "exportDateFrom",
    "exportDateTo",
    "exportFormat",
    "exportScope",
    "bookExportSummary"
  ]) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
  assert.match(page, /Excel \(\.xlsx\)/);
  assert.match(page, /CSV \(\.csv\)/);
  assert.match(script, /function applyExportFilters\(items\)/);
  assert.match(script, /scope === "currentPage"/);
  assert.match(script, /XLSX\.utils\.sheet_to_csv/);
});

test("time slots use grouped responsive fields, live preview and reset", () => {
  for (const id of ["slotPreviewCard", "resetTimeSlotBtn", "slotStartDate", "slotEndDate", "slotStartTime", "slotEndTime", "slotMaxStudents"]) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
  assert.match(script, /function renderSlotPreview\(\)/);
  assert.match(script, /function applyScheduleToSlotForm\(schedule\)/);
  assert.match(script, /latestIssueReturnSchedule/);
  assert.match(styles, /\.time-slot-grid\s*{[\s\S]*?grid-template-columns:\s*repeat\(2,/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?\.time-slot-grid,[\s\S]*?grid-template-columns:\s*1fr/);
});
