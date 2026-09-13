export const ISSUE_PERIOD_DAYS = 45;
export const PENALTY_RATE_PER_DAY = 5;

console.log("[PENALTY] web penalty build v2 loaded");

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

export function normalizedIdentifier(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "");
}

export function studentUidOfStudent(student = {}) {
  return String(student.uid || student.studentUid || student.firebaseAuthUid || student.id || "").trim();
}

export function studentEmailOfStudent(student = {}) {
  return String(student.email || student.studentEmail || "").trim().toLowerCase();
}

export function rollNoOfStudent(student = {}) {
  return student.rollNo || student.rollNumber || student.roll || "";
}

export function enrollmentNumberOfStudent(student = {}) {
  return student.enrollmentNumber || student.enrollmentNo || "";
}

export function issueBelongsToStudent(issue = {}, student = {}) {
  const uid = studentUidOfStudent(student);
  if (uid) {
    if (String(issue.studentUid || "").trim() === uid) return true;
    if (String(issue.userId || "").trim() === uid) return true;
    if (String(issue.studentId || "").trim() === uid) return true;
    if (String(issue.issuedTo || "").trim() === uid) return true;
  }

  const email = studentEmailOfStudent(student);
  if (email && String(issue.studentEmail || issue.email || "").trim().toLowerCase() === email) return true;

  const studentRoll = normalizedIdentifier(rollNoOfStudent(student));
  const issueRoll = normalizedIdentifier(issue.rollNo || issue.rollNumber || issue.roll || "");
  if (studentRoll && issueRoll && studentRoll === issueRoll) return true;

  const studentEnrollment = normalizedIdentifier(enrollmentNumberOfStudent(student));
  const issueEnrollment = normalizedIdentifier(issue.enrollmentNumber || issue.enrollmentNo || "");
  return Boolean(studentEnrollment && issueEnrollment && studentEnrollment === issueEnrollment);
}

export function isActiveIssue(issue = {}) {
  const status = String(issue.status || "").toLowerCase();
  if (issue.returnDate || issue.returnedAt) return false;
  if (["returned", "completed", "closed", "cancelled", "rejected"].includes(status)) return false;
  if (["issued", "active", "approved", "borrowed"].includes(status)) return true;
  return !status && Boolean(issue.bookId || issue.b_id || issue.accessionNumber || issue.currentIssueId);
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
  return String(record.issueId || record.currentIssueId || record.bookIssueId || record.id || fallback || "").trim();
}

export function penaltyMatchesIssue(penalty = {}, issue = {}, issueId = "") {
  const penaltyIssueId = issueIdOf(penalty);
  const cleanIssueId = String(issue.issueId || issue.id || issueId || "").trim();
  if (penaltyIssueId && cleanIssueId && penaltyIssueId === cleanIssueId) return true;

  const penaltyStudentUid = String(penalty.studentUid || penalty.userId || penalty.studentId || "").trim();
  const issueStudentUid = studentUidOfIssue(issue);
  const sameKnownStudent = penaltyStudentUid && issueStudentUid && penaltyStudentUid === issueStudentUid;
  const sameEmail = String(penalty.studentEmail || "").trim().toLowerCase()
    && String(issue.studentEmail || "").trim().toLowerCase()
    && String(penalty.studentEmail || "").trim().toLowerCase() === String(issue.studentEmail || "").trim().toLowerCase();
  if (!sameKnownStudent && !sameEmail) return false;

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
  const issueDate = issueDateOf(issue);
  if (issueDate) return addCalendarDays(issueDate, ISSUE_PERIOD_DAYS);
  const persistedDueDate = dateFrom(issue.dueDate);
  return persistedDueDate ? new Date(
    persistedDueDate.getFullYear(),
    persistedDueDate.getMonth(),
    persistedDueDate.getDate()
  ) : null;
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

function paidCoverageAmount(penalty = {}) {
  return Math.max(
    0,
    Number(penalty.paymentAmount || 0),
    Number(penalty.amountPaid || 0),
    Number(penalty.paidAmount || 0),
    Number(penalty.clearedAmount || 0),
    Number(penalty.amount || 0),
    Number(penalty.penaltyAmount || 0)
  );
}

function persistedPenaltyItem(penalty = {}, fallbackId = "") {
  const amount = Math.max(0, penaltyAmountOf(penalty));
  return {
    id: fallbackId || penalty.id || issueIdOf(penalty),
    source: "persisted",
    penalty,
    issue: null,
    issueId: issueIdOf(penalty, fallbackId),
    studentUid: penalty.studentUid || penalty.userId || penalty.studentId || "",
    studentName: penalty.studentName || "",
    rollNo: penalty.rollNo || penalty.rollNumber || "",
    enrollmentNumber: penalty.enrollmentNumber || penalty.enrollmentNo || "",
    bookId: penalty.bookId || penalty.b_id || "",
    bookTitle: penalty.bookTitle || penalty.title || penalty.bookId || "Penalty",
    accessionNumber: penalty.accessionNumber || "",
    issueDate: penalty.issueDate || penalty.issuedAt || null,
    dueDate: penalty.dueDate || null,
    overdueDays: Number(penalty.lateDays || penalty.daysLate || 0) || 0,
    ratePerDay: Number(penalty.ratePerDay || PENALTY_RATE_PER_DAY) || PENALTY_RATE_PER_DAY,
    amount,
    status: penalty.paymentStatus || penalty.penaltyStatus || penalty.status || "unpaid"
  };
}

function calculatedIssueItem(issue = {}, issueId = "", calculation, amount, persistedPenalty = null) {
  return {
    id: issueId || issue.issueId || issue.id || "",
    source: persistedPenalty ? "merged" : "calculated",
    penalty: persistedPenalty,
    issue,
    issueId: issueId || issue.issueId || issue.id || "",
    studentUid: issue.studentUid || issue.userId || issue.studentId || issue.issuedTo || "",
    studentName: issue.studentName || issue.issuedToName || "",
    rollNo: issue.rollNo || issue.rollNumber || "",
    enrollmentNumber: issue.enrollmentNumber || issue.enrollmentNo || "",
    bookId: issue.bookId || issue.b_id || "",
    bookTitle: issue.bookTitle || issue.title || issue.bookId || "Issued book",
    accessionNumber: issue.accessionNumber || "",
    issueDate: issue.issueDate || issue.issuedAt || null,
    dueDate: issue.dueDate || calculation.dueDate || null,
    overdueDays: calculation.overdueDays,
    ratePerDay: calculation.ratePerDay,
    amount,
    status: persistedPenalty?.paymentStatus || persistedPenalty?.penaltyStatus || persistedPenalty?.status || "unpaid",
    calculated: calculation
  };
}

export function getStudentPenaltyLiability({
  student = {},
  issues = [],
  penalties = [],
  now = new Date()
} = {}) {
  const penaltyRows = penalties.map((item) => {
    const data = item?.data || item || {};
    return { id: item?.id || data.id || issueIdOf(data), data };
  });
  const activeIssues = issues
    .map((item) => ({ id: item?.id || item?.issueId || "", data: item?.data || item || {} }))
    .filter((item) => issueBelongsToStudent({ ...item.data, id: item.id }, student))
    .filter((item) => isActiveIssue(item.data));

  const calculatedItems = [];
  const consumedPenaltyIds = new Set();

  activeIssues.forEach((item) => {
    const issue = { ...item.data, id: item.id };
    const calculation = calculateIssuePenalty(issue, now);
    const persistedRow = findMatchingPenaltyForIssue(penaltyRows, issue, item.id);
    if (persistedRow?.id) consumedPenaltyIds.add(persistedRow.id);
    if (!calculation.isOverdue || calculation.calculatedAmount <= 0) return;

    const persistedPenalty = persistedRow?.data || null;
    if (persistedPenalty && isPenaltyPaid(persistedPenalty)) {
      const outstandingAfterPayment = Math.max(0, calculation.calculatedAmount - paidCoverageAmount(persistedPenalty));
      if (outstandingAfterPayment > 0) {
        calculatedItems.push(calculatedIssueItem(issue, item.id, calculation, outstandingAfterPayment, persistedPenalty));
      }
      return;
    }

    const amount = Math.max(calculation.calculatedAmount, persistedPenalty ? penaltyAmountOf(persistedPenalty) : 0);
    if (amount > 0) calculatedItems.push(calculatedIssueItem(issue, item.id, calculation, amount, persistedPenalty));
  });

  const persistedItems = penaltyRows
    .filter((row) => !consumedPenaltyIds.has(row.id))
    .filter((row) => !isPenaltyPaid(row.data))
    .filter((row) => issueBelongsToStudent({
      studentUid: row.data.studentUid || row.data.userId || row.data.studentId || "",
      studentEmail: row.data.studentEmail || "",
      rollNo: row.data.rollNo || row.data.rollNumber || "",
      enrollmentNumber: row.data.enrollmentNumber || row.data.enrollmentNo || "",
      bookId: row.data.bookId || row.data.b_id || "",
      accessionNumber: row.data.accessionNumber || ""
    }, student))
    .map((row) => persistedPenaltyItem(row.data, row.id))
    .filter((item) => item.amount > 0);

  const overdueIssues = activeIssues
    .map((item) => {
      const calculation = calculateIssuePenalty({ ...item.data, id: item.id }, now);
      return { id: item.id, data: item.data, calculation };
    })
    .filter((item) => item.calculation.isOverdue);
  const unpaidItems = [...calculatedItems, ...persistedItems];
  const totalUnpaid = unpaidItems.reduce((sum, item) => sum + Math.max(0, Number(item.amount || 0)), 0);

  return {
    activeIssues,
    overdueIssues,
    calculatedItems,
    persistedItems,
    unpaidItems,
    totalUnpaid,
    hasOutstandingDues: totalUnpaid > 0 || activeIssues.length > 0
  };
}

export function logPenaltyDebugForStudent({
  student = {},
  activeIssues = [],
  persistedPenalties = [],
  liability = null,
  now = new Date()
} = {}) {
  const uid = studentUidOfStudent(student);
  const name = student.name || student.studentName || "";
  const rollNo = rollNoOfStudent(student);
  const enrollmentNumber = enrollmentNumberOfStudent(student);
  console.log("[PENALTY-DEBUG] student", { uid, name, rollNo, enrollmentNumber });
  console.log("[PENALTY-DEBUG] active issues", activeIssues);
  activeIssues.forEach((item) => {
    const issue = item?.data || item || {};
    console.log("[PENALTY-DEBUG] issue", {
      issueId: item?.id || issue.id || issue.issueId || "",
      studentUid: issue.studentUid,
      userId: issue.userId,
      studentEmail: issue.studentEmail,
      bookId: issue.bookId,
      accessionNumber: issue.accessionNumber,
      issueDate: issue.issueDate,
      dueDate: issue.dueDate,
      status: issue.status,
      calculatedPenalty: calculateIssuePenalty(issue, now)
    });
  });
  console.log("[PENALTY-DEBUG] persisted penalties", persistedPenalties);
  const livePenaltyTotal = liability?.calculatedItems?.reduce((sum, item) => sum + Math.max(0, Number(item.amount || 0)), 0) || 0;
  const persistedUnpaidTotal = liability?.persistedItems?.reduce((sum, item) => sum + Math.max(0, Number(item.amount || 0)), 0) || 0;
  console.log("[PENALTY-DEBUG] final liability", {
    livePenaltyTotal,
    persistedUnpaidTotal,
    mergedTotal: liability?.totalUnpaid || 0,
    displayedTotal: liability?.totalUnpaid || 0
  });
}
