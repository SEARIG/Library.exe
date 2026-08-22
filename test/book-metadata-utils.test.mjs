import test from "node:test";
import assert from "node:assert/strict";
import {
  assertNoPrivateMetadataFields,
  collectReusableMetadata,
  createMetadataKey,
  hasReusableMetadata,
  metadataKeyCandidates,
  normalizeBarcode,
  normalizeIsbn,
  normalizeTextKey,
  reusableMetadataPayload
} from "../public/js/book-metadata-utils.mjs";

test("normalizes ISBN, barcode, and text metadata keys", () => {
  assert.equal(normalizeIsbn("978-81 2034579x"), "978812034579X");
  assert.equal(normalizeBarcode(" 890-123 456/7890 "), "890123456/7890");
  assert.equal(normalizeTextKey("  Data Structures & Algorithms / C++  "), "data_structures_algorithms_c");
  assert.equal(createMetadataKey("isbn", "978-81 203 4579-7"), "isbn:9788120345797");
  assert.equal(createMetadataKey("publisherBarcode", "890/123"), "publisherBarcode:890_123");
});

test("builds preferred metadata keys before title-author fallback", () => {
  const metadata = collectReusableMetadata({
    isbn: "978-81-203-4579-7",
    publisherBarcode: "8901234567890",
    title: "Machine Design",
    author: "V B Bhandari"
  });
  assert.deepEqual(metadataKeyCandidates(metadata), [
    { key: "isbn:9788120345797", keyType: "isbn" },
    { key: "publisherBarcode:8901234567890", keyType: "publisherBarcode" }
  ]);

  const fallback = collectReusableMetadata({ title: "Machine Design", author: "V B Bhandari" });
  assert.deepEqual(metadataKeyCandidates(fallback), [
    { key: "titleAuthor:machine_design_v_b_bhandari", keyType: "titleAuthor" }
  ]);
});

test("metadata payload excludes private copy and acquisition fields", () => {
  const metadata = collectReusableMetadata({
    accessionNumber: "001",
    title: "Thermodynamics",
    author: "R K Rajput",
    billNoDate: "03 / 4/6/21",
    cost: "295",
    issuedStudentUid: "student-1",
    currentIssueId: "issue-1",
    publisher: "Laxmi Publications",
    imageUrl: "https://example.com/cover.jpg"
  });
  assert.equal(hasReusableMetadata(metadata), true);
  const payload = reusableMetadataPayload(metadata, {
    key: "titleAuthor:thermodynamics_r_k_rajput",
    keyType: "titleAuthor"
  }, { source: "manual" });
  assert.equal(payload.title, "Thermodynamics");
  assert.equal(payload.author, "R K Rajput");
  assert.equal(payload.publisher, "Laxmi Publications");
  assert.equal(payload.source, "manual");
  assert.equal(assertNoPrivateMetadataFields(payload), true);
  assert.equal(Object.hasOwn(payload, "cost"), false);
  assert.equal(Object.hasOwn(payload, "billNoDate"), false);
  assert.equal(Object.hasOwn(payload, "issuedStudentUid"), false);
  assert.equal(Object.hasOwn(payload, "currentIssueId"), false);
});
