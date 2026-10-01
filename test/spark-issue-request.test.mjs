import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

test("student issue request creation is Spark-compatible and narrowly scoped", () => {
  const rules = read("firestore.rules");
  assert.match(rules, /function validStudentIssueRequestCreate\(requestId\)/);
  assert.match(rules, /profile\(\)\.role == "student"/);
  assert.match(rules, /profile\(\)\.active == true/);
  assert.match(rules, /data\.studentUid == request\.auth\.uid/);
  assert.match(rules, /data\.status == "pending"/);
  assert.match(rules, /data\.source == "android_student_app"/);
  assert.match(rules, /exists\(\/databases\/\$\(database\)\/documents\/books\/\$\(data\.bookId\)\)/);
  assert.match(rules, /documents\/books\/\$\(data\.bookId\)\)\.data\.status == "available"/);
  assert.match(rules, /data\.keys\(\)\.hasOnly\(\[/);
  assert.match(rules, /allow create: if validStudentIssueRequestCreate\(requestId\)/);
});

test("students cannot review requests or mutate circulation records", () => {
  const rules = read("firestore.rules");
  const issueRequestBlock = rules.match(/match \/issueRequests\/\{requestId\} \{[\s\S]*?\n    \}/)?.[0] || "";
  assert.match(issueRequestBlock, /allow update: if isLibrarian\(\)/);
  assert.doesNotMatch(issueRequestBlock, /request\.auth\.uid == resource\.data\.studentUid/);
  assert.match(rules, /match \/bookIssues\/\{issueId\} \{[\s\S]*?allow create, update: if active\(\) && \(staffRole\(\) \|\| role\(\) == "admin"\)/);
  assert.match(rules, /match \/books\/\{bookId\} \{[\s\S]*?allow create, update: if active\(\)[\s\S]*?&& isLibrarian\(\)/);
});

test("librarian issuance prefers the canonical document id and rechecks liabilities", () => {
  const script = read("public/js/librarian-dashboard.js");
  assert.match(script, /const bookDocId = requestData\.bookId \|\| requestData\.b_id/g);
  assert.match(script, /activeIssueConflictForBook\(precheckData\.bookId, precheckData\.b_id\)/);
  assert.match(script, /const eligibility = await canStudentIssueBook\(/);
  assert.match(script, /if \(bookHasIssueConflict\(bookData\)\)/);
  assert.match(script, /if \(requestData\.status !== "approved_for_pickup"\)/);
});
