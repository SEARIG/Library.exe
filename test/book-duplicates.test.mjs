import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildDuplicateCleanupPlan
} from "../public/js/book-duplicates.mjs";
import { accessionNumberValue, normalizeAccessionNumber } from "../public/js/accession-utils.mjs";

function book(id, accessionNumber, data = {}) {
  return { id, data: { accessionNumber, status: "available", ...data } };
}

function reference(collection, id, data = {}) {
  return { collection, id, data };
}

test("normalizes equivalent logical accession values", () => {
  for (const value of [1, "1", "01", "001", " 1 ", "ACC-1"]) {
    assert.equal(normalizeAccessionNumber(value), "1");
  }
  assert.equal(normalizeAccessionNumber("A-01"), "A-01");
  assert.equal(accessionNumberValue({ b_id: "301" }), "");
});

test("no duplicate accession numbers produces an empty cleanup plan", () => {
  const plan = buildDuplicateCleanupPlan([book("a", "1"), book("b", "2")]);
  assert.equal(plan.duplicateGroupCount, 0);
  assert.equal(plan.deletableCount, 0);
  assert.equal(plan.uniqueAccessionCount, 2);
});

test("one duplicate pair keeps one deterministic canonical and deletes one", () => {
  const plan = buildDuplicateCleanupPlan([
    book("older", "01", { title: "Book", createdAt: "2020-01-01" }),
    book("newer", "ACC-1", { title: "Book", createdAt: "2021-01-01" })
  ]);
  assert.equal(plan.duplicateGroupCount, 1);
  assert.equal(plan.deletableCount, 1);
  assert.equal(plan.groups[0].canonical.id, "older");
  assert.equal(plan.groups[0].deletions[0].id, "newer");
});

test("three copies keep exactly one and delete two", () => {
  const plan = buildDuplicateCleanupPlan([
    book("a", "25", { title: "Book", author: "Author" }),
    book("b", "025", { title: "Book" }),
    book("c", "ACC-25", {})
  ]);
  assert.equal(plan.extraDuplicateCount, 2);
  assert.equal(plan.deletableCount, 2);
  assert.equal(plan.groups[0].canonical.id, "a");
});

test("active issue reference keeps the referenced record", () => {
  const plan = buildDuplicateCleanupPlan(
    [book("active-book", "40"), book("extra-book", "040", { title: "More complete" })],
    [reference("bookIssues", "issue-1", { bookId: "active-book", status: "issued" })]
  );
  assert.equal(plan.groups[0].canonical.id, "active-book");
  assert.deepEqual(plan.groups[0].deletions.map((item) => item.id), ["extra-book"]);
});

test("two referenced duplicates require manual review and are not deleted", () => {
  const plan = buildDuplicateCleanupPlan(
    [book("book-a", "50"), book("book-b", "050")],
    [
      reference("bookIssues", "issue-a", { bookId: "book-a", status: "issued" }),
      reference("issueRequests", "request-b", { bookId: "book-b", status: "pending" })
    ]
  );
  assert.equal(plan.groups[0].manualReview, true);
  assert.equal(plan.groups[0].deletions.length, 0);
  assert.equal(plan.skippedGroupCount, 1);
});

test("safe metadata fills blanks on a protected canonical record", () => {
  const plan = buildDuplicateCleanupPlan(
    [
      book("canonical", "70", { currentIssueId: "issue-70", title: "", author: "Author" }),
      book("donor", "070", { title: "Recovered title", author: "Author", subject: "Engineering" })
    ],
    [reference("bookIssues", "issue-70", { bookId: "canonical", status: "issued" })]
  );
  assert.deepEqual(plan.groups[0].metadataPatch, { title: "Recovered title", subject: "Engineering" });
  assert.equal(plan.metadataMergeCount, 2);
});

test("different logical accession numbers are never deletion candidates", () => {
  const plan = buildDuplicateCleanupPlan([book("a", "100"), book("b", "101")]);
  assert.equal(plan.groups.length, 0);
  assert.equal(plan.extraDuplicateCount, 0);
});

test("same accession remains a duplicate when title and author differ", () => {
  const plan = buildDuplicateCleanupPlan([
    book("a", "301", { title: "Book A", author: "Author X" }),
    book("b", "0301", { title: "Completely Different", author: "Author Y" })
  ]);
  assert.equal(plan.duplicateGroupCount, 1);
  assert.equal(plan.extraDuplicateCount, 1);
});

test("same title author ISBN and year never group different accessions", () => {
  const metadata = { title: "Shared Book", author: "Author X", isbn: "9780000000001", year: "2020" };
  const plan = buildDuplicateCleanupPlan([
    book("a", "301", metadata),
    book("b", "302", metadata)
  ]);
  assert.equal(plan.duplicateGroupCount, 0);
  assert.equal(plan.extraDuplicateCount, 0);
});

test("blank accessions are reported but never grouped or deleted", () => {
  const plan = buildDuplicateCleanupPlan([
    book("blank-a", "", { title: "Book A" }),
    book("blank-b", "   ", { title: "Book A" }),
    book("valid", "301", { title: "Book A" })
  ]);
  assert.equal(plan.missingAccessionCount, 2);
  assert.deepEqual(plan.missingAccessions.map((item) => item.id), ["blank-a", "blank-b"]);
  assert.equal(plan.duplicateGroupCount, 0);
  assert.equal(plan.deletableCount, 0);
});

test("document and legacy book ids never substitute for a missing accession", () => {
  const plan = buildDuplicateCleanupPlan([
    { id: "301", data: { b_id: "301", title: "Book A", status: "available" } },
    { id: "0301", data: { b_id: "0301", title: "Book A", status: "available" } }
  ]);
  assert.equal(plan.missingAccessionCount, 2);
  assert.equal(plan.duplicateGroupCount, 0);
  assert.equal(plan.deletableCount, 0);
});

test("duplicate cleanup UI and execution remain Admin-only", () => {
  const page = fs.readFileSync("public/librarian-dashboard.html", "utf8");
  const script = fs.readFileSync("public/js/librarian-dashboard.js", "utf8");
  const rules = fs.readFileSync("firestore.rules", "utf8");
  assert.match(page, /id="deleteDuplicateBooksBtn"[^>]*hidden/);
  assert.match(page, /id="duplicateCleanupModal"/);
  assert.match(page, /detected only when multiple book documents have the same accession number/);
  assert.match(script, /session\.profile\.role !== "admin"/);
  assert.match(script, /duplicateCleanupSignature\(refreshedPlan\)/);
  assert.match(script, /writeBatch\(db\)/);
  assert.match(rules, /match \/books\/\{bookId\}[\s\S]*?allow delete:\s*if isAdmin\(\);/);
});
