import test from "node:test";
import assert from "node:assert/strict";
import {
  calculatePenalty,
  findMatchingPenaltyForIssue,
  isActiveIssue,
  isUnpaidPenaltyRecord,
  penaltyAmountOf
} from "../public/js/penalty-utils.mjs";

const issueDate = "2026-07-01T10:30:00+05:30";

function localDateString(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

test("44 days after issue has no penalty", () => {
  const result = calculatePenalty({ issueDate }, new Date("2026-08-14T23:59:00+05:30"));
  assert.equal(result.overdueDays, 0);
  assert.equal(result.calculatedPenalty, 0);
  assert.equal(result.isOverdue, false);
});

test("exactly 45 days after issue has no penalty", () => {
  const result = calculatePenalty({ issueDate }, new Date("2026-08-15T23:59:00+05:30"));
  assert.equal(result.overdueDays, 0);
  assert.equal(result.calculatedPenalty, 0);
  assert.equal(result.isOverdue, false);
});

test("1 completed calendar day after due date is Rs.5", () => {
  const result = calculatePenalty({ issueDate }, new Date("2026-08-16T00:01:00+05:30"));
  assert.equal(result.overdueDays, 1);
  assert.equal(result.ratePerDay, 5);
  assert.equal(result.calculatedPenalty, 5);
});

test("14 overdue days is Rs.70", () => {
  const result = calculatePenalty({ issueDate }, new Date("2026-08-29T12:00:00+05:30"));
  assert.equal(result.overdueDays, 14);
  assert.equal(result.calculatedPenalty, 70);
});

test("13 overdue days is Rs.65", () => {
  const result = calculatePenalty({ issueDate }, new Date("2026-08-28T12:00:00+05:30"));
  assert.equal(result.overdueDays, 13);
  assert.equal(result.calculatedAmount, 65);
});

test("30 overdue days is Rs.150", () => {
  const result = calculatePenalty({ issueDate }, new Date("2026-09-14T12:00:00+05:30"));
  assert.equal(result.overdueDays, 30);
  assert.equal(result.calculatedPenalty, 150);
});

test("paid penalty is not treated as unpaid", () => {
  assert.equal(isUnpaidPenaltyRecord({
    penaltyAmount: 70,
    remainingAmount: 0,
    paid: true,
    status: "paid",
    paymentStatus: "paid"
  }), false);
});

test("unpaid overdue active issue blocks no dues eligibility", () => {
  const issue = { issueDate, status: "issued", returnDate: null };
  const result = calculatePenalty(issue, new Date("2026-08-29T12:00:00+05:30"));
  assert.equal(isActiveIssue(issue), true);
  assert.equal(result.isOverdue, true);
  assert.equal(result.calculatedPenalty > 0, true);
});

test("cleared liability can be excluded from unpaid totals", () => {
  const cleared = { penaltyAmount: 70, remainingAmount: 0, paid: true, penaltyStatus: "cleared" };
  assert.equal(isUnpaidPenaltyRecord(cleared), false);
  assert.equal(penaltyAmountOf(cleared), 0);
});

test("returned overdue issue stops increasing on return date", () => {
  const result = calculatePenalty({
    issueDate,
    dueDate: "2026-08-15T00:00:00+05:30",
    returnDate: "2026-08-28T16:00:00+05:30",
    status: "returned"
  }, new Date("2026-09-14T12:00:00+05:30"));
  assert.equal(result.overdueDays, 13);
  assert.equal(result.calculatedPenalty, 65);
});

test("legacy issue missing dueDate derives issueDate plus 45 days", () => {
  const result = calculatePenalty({ issuedAt: issueDate, status: "issued" }, new Date("2026-08-29T12:00:00+05:30"));
  assert.equal(localDateString(result.dueDate), "2026-08-15");
  assert.equal(result.overdueDays, 14);
  assert.equal(result.calculatedPenalty, 70);
});

test("matching persisted penalty prevents live issue duplicate by accession fallback", () => {
  const persisted = [{
    id: "old-penalty",
    data: {
      studentUid: "student-1",
      accessionNumber: "ACC-101",
      amount: 65,
      paid: false,
      status: "unpaid"
    }
  }];
  const issue = {
    id: "issue-without-penalty-doc-id",
    studentUid: "student-1",
    accessionNumber: "ACC-101",
    bookId: "book-1"
  };
  assert.equal(findMatchingPenaltyForIssue(persisted, issue, issue.id)?.id, "old-penalty");
});

test("multiple overdue books calculate independently and total correctly", () => {
  const first = calculatePenalty({ issueDate }, new Date("2026-08-29T12:00:00+05:30"));
  const second = calculatePenalty({ issueDate: "2026-06-15T09:00:00+05:30" }, new Date("2026-08-29T12:00:00+05:30"));
  assert.equal(first.calculatedPenalty, 70);
  assert.equal(second.calculatedPenalty, 150);
  assert.equal(first.calculatedPenalty + second.calculatedPenalty, 220);
});
