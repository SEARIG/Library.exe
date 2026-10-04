import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const librarian = fs.readFileSync("public/js/librarian-dashboard.js", "utf8");
const catalog = fs.readFileSync("public/js/library.js", "utf8");
const admin = fs.readFileSync("public/js/admin-dashboard.js", "utf8");
const service = fs.readFileSync("public/js/firestore-service.js", "utf8");

test("dashboard book metrics use Firestore aggregate counts instead of a 500-record array", () => {
  assert.match(librarian, /getCountFromServer\(booksRef\)/);
  assert.match(librarian, /where\("status", "==", status\)/);
  assert.doesNotMatch(librarian, /limit\(500\)/);
  assert.match(admin, /getCountFromServer\(collection\(db, "books"\)\)/);
});

test("catalog and Book Database use bounded cursor pages", () => {
  assert.match(catalog, /const pageSize = 24;/);
  assert.match(catalog, /startAfter\(cursor\)/);
  assert.match(catalog, /limit\(pageSize\)/);
  assert.match(librarian, /const BOOK_DATABASE_PAGE_SIZE = 25;/);
  assert.match(librarian, /startAfter\(cursor\)/);
  assert.match(librarian, /limit\(BOOK_DATABASE_PAGE_SIZE\)/);
});

test("accession lookup tries normalized legacy representations", () => {
  assert.match(service, /numericAccession\.padStart\(2, "0"\)/);
  assert.match(service, /numericAccession\.padStart\(3, "0"\)/);
  assert.match(service, /`ACC-\$\{numericAccession\}`/);
  assert.match(service, /"accessionNumber", "blegal_num", "blegalNumber", "BLegalNumber"/);
});
