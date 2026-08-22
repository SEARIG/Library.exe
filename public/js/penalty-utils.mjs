export const ISSUE_PERIOD_DAYS = 45;
export const PENALTY_RATE_PER_DAY = 5;

export function dateFrom(value) {
  if (!value) return null;
  const date = value.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function addCalendarDays(value, days) {
  const date = dateFrom(value);
  if (!date) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function calendarDayNumber(value) {
  const date = dateFrom(value);
  if (!date) return null;
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
}

export function completedCalendarDaysBetween(start, end) {
  const startDay = calendarDayNumber(start);
  const endDay = calendarDayNumber(end);
  if (startDay === null || endDay === null) return 0;
  return Math.max(0, endDay - startDay);
}

export function penaltyAmountOf(penalty = {}) {
  return Number(penalty.remainingAmount ?? penalty.amount ?? penalty.penaltyAmount ?? 0) || 0;
}

export function isPenaltyPaid(record = {}) {
  const status = String(record.paymentStatus || record.penaltyStatus || record.status || "").toLowerCase();
  return record.paid === true || ["paid", "cleared", "resolved"].includes(status);
}

export function isUnpaidPenaltyRecord(penalty = {}) {
  if (isPenaltyPaid(penalty) && penaltyAmountOf(penalty) <= 0) return false;
  return penaltyAmountOf(penalty) > 0 && !isPenaltyPaid(penalty);
}

export function isActiveIssue(issue = {}) {
  const status = String(issue.status || "").toLowerCase();
  return !issue.returnDate
    && !issue.returnedAt
    && !["returned", "closed", "cancelled", "rejected"].includes(status);
}

export function studentUidOfIssue(issue = {}) {
  return String(issue.studentUid || issue.userId || issue.issuedTo || "").trim();
}

export function bookIdOfIssue(issue = {}) {
  return String(issue.bookId || issue.b_id || "").trim();
}

export function accessionNumberOfIssue(issue = {}) {
  return String(issue.accessionNumber || "").trim();
}

export function issueIdOf(record = {}, fallback = "") {
  return String(record.issueId || record.currentIssueId || record.id || fallback || "").trim();
}

export function penaltyMatchesIssue(penalty = {}, issue = {}, issueId = "") {
  const penaltyIssueId = issueIdOf(penalty);
  const cleanIssueId = String(issue.issueId || issue.id || issueId || "").trim();
  if (penaltyIssueId && cleanIssueId && penaltyIssueId === cleanIssueId) return true;

  const penaltyStudentUid = String(penalty.studentUid || penalty.userId || "").trim();
  const issueStudentUid = studentUidOfIssue(issue);
  if (!penaltyStudentUid || !issueStudentUid || penaltyStudentUid !== issueStudentUid) return false;

  const penaltyBookId = String(penalty.bookId || penalty.b_id || "").trim();
  const issueBookId = bookIdOfIssue(issue);
  if (penaltyBookId && issueBookId && penaltyBookId === issueBookId) return true;

  const penaltyAccession = String(penalty.accessionNumber || "").trim();
  const issueAccession = accessionNumberOfIssue(issue);
  return Boolean(penaltyAccession && issueAccession && penaltyAccession === issueAccession);
}

export function findMatchingPenaltyForIssue(penaltyRows = [], issue = {}, issueId = "") {
  return penaltyRows.find((row) => {
    const data = row?.data || row || {};
    const id = row?.id || data.id || "";
    return penaltyMatchesIssue({ ...data, id }, { ...issue, id: issue.id || issueId }, issueId);
  }) || null;
}

export function issueDateOf(issue = {}) {
  return dateFrom(issue.issueDate || issue.issuedAt || issue.createdAt);
}

export function dueDateOf(issue = {}) {
  const persistedDueDate = dateFrom(issue.dueDate);
  if (persistedDueDate) return new Date(
    persistedDueDate.getFullYear(),
    persistedDueDate.getMonth(),
    persistedDueDate.getDate()
  );
  const issueDate = issueDateOf(issue);
  return issueDate ? addCalendarDays(issueDate, ISSUE_PERIOD_DAYS) : null;
}

export function calculateIssuePenalty(issue = {}, now = new Date()) {
  const dueDate = dueDateOf(issue);
  const returnedAt = dateFrom(issue.returnDate || issue.returnedAt);
  const calculationEnd = returnedAt || now;
  const overdueDays = dueDate ? completedCalendarDaysBetween(dueDate, calculationEnd) : 0;
  const calculatedAmount = overdueDays > 0 ? overdueDays * PENALTY_RATE_PER_DAY : 0;
  const paymentStatus = isPenaltyPaid(issue)
    ? "paid"
    : calculatedAmount > 0
      ? "unpaid"
      : "none";

  return {
    dueDate,
    overdueDays,
    ratePerDay: PENALTY_RATE_PER_DAY,
    calculatedAmount,
    calculatedPenalty: calculatedAmount,
    penaltyAmount: calculatedAmount,
    isOverdue: overdueDays > 0,
    paymentStatus
  };
}

export function calculatePenalty(issue = {}, currentDate = new Date()) {
  return calculateIssuePenalty(issue, currentDate);
}
