import {
  calculatePenalty,
  getStudentPenaltyLiability,
  isUnpaidPenaltyRecord
} from "./penalty-utils.mjs?v=2";

export function studentUidOf(record = {}, fallback = "") {
  return record.uid || record.studentUid || record.firebaseAuthUid || record.id || fallback;
}

export function titleOfIssue(issue = {}) {
  return issue.bookTitle || issue.title || issue.bookName || issue.bookId || issue.b_id || "Issued book";
}

export function accessionOf(record = {}) {
  return record.accessionNumber || record.blegal_num || record.blegalNumber || record.BLegalNumber || record.b_id || record.bookId || "-";
}

export function buildNoDuesRows({
  users = [],
  students = [],
  issues = [],
  penalties = [],
  books = [],
  now = new Date(),
  formatDate = defaultFormatDate
} = {}) {
  const normalizedUsers = normalizeRows(users);
  const normalizedStudents = normalizeRows(students);
  const normalizedIssues = normalizeRows(issues);
  const normalizedPenalties = normalizeRows(penalties);
  const normalizedBooks = normalizeRows(books);
  const usersByUid = new Map(normalizedUsers.map((item) => [item.id, item.data]));
  const studentMap = new Map();

  normalizedStudents.forEach((item) => {
    const uid = studentUidOf(item.data, item.id);
    if (uid) studentMap.set(uid, { id: item.id, ...item.data, uid });
  });

  normalizedUsers
    .filter((item) => item.data.role === "student")
    .forEach((item) => {
      const existing = studentMap.get(item.id) || {};
      studentMap.set(item.id, { ...item.data, ...existing, uid: item.id });
    });

  const issueRecords = normalizedIssues.map((item) => ({ id: item.id, ...item.data }));
  const penaltyRecords = normalizedPenalties.map((item) => ({ id: item.id, ...item.data }));

  return Array.from(studentMap.values()).map((student) => {
    const uid = student.uid || student.id;
    const user = usersByUid.get(uid) || {};
    const studentRecord = { ...user, ...student, uid };
    const liability = getStudentPenaltyLiability({
      student: studentRecord,
      issues: issueRecords,
      penalties: penaltyRecords,
      now
    });
    const activeIssues = liability.activeIssues;
    const overdueItems = liability.overdueIssues;
    const penaltyItems = liability.unpaidItems;
    const unresolvedCopyLiabilities = normalizedBooks.filter((item) => {
      const book = item.data;
      const status = String(book.status || "").toLowerCase();
      const holderUid = book.issuedStudentUid || book.issuedTo || book.studentUid || "";
      return ["lost", "damaged"].includes(status) && holderUid === uid;
    });
    const lostCount = unresolvedCopyLiabilities.filter((item) => String(item.data.status || "").toLowerCase() === "lost").length;
    const damagedCount = unresolvedCopyLiabilities.filter((item) => String(item.data.status || "").toLowerCase() === "damaged").length;
    const penaltyAmount = liability.totalUnpaid;
    const dueTypes = new Set();
    if (activeIssues.length) dueTypes.add("activeBook");
    if (overdueItems.length) dueTypes.add("overdue");
    if (penaltyAmount > 0) dueTypes.add("penalty");
    if (lostCount) dueTypes.add("lost");
    if (damagedCount) dueTypes.add("damaged");

    const activeIssueDetails = activeIssues.map((item) => ({
      issueId: item.id,
      bookTitle: titleOfIssue(item.data),
      accessionNumber: accessionOf(item.data),
      issueDate: item.data.issueDate || item.data.issuedAt || null,
      dueDate: item.data.dueDate || calculatePenalty(item.data, now).dueDate || null,
      status: item.data.status || "issued"
    }));
    const overdueBooks = overdueItems.map((item) => ({
      issueId: item.id,
      bookTitle: titleOfIssue(item.data),
      accessionNumber: accessionOf(item.data),
      dueDate: item.data.dueDate || item.calculation.dueDate || null,
      overdueDays: item.calculation.overdueDays,
      ratePerDay: item.calculation.ratePerDay,
      currentPenalty: item.calculation.calculatedAmount,
      paymentStatus: item.calculation.paymentStatus || "unpaid"
    }));
    const paidHistory = penaltyRecords
      .filter((penalty) => penalty.studentUid === uid || (studentRecord.email && penalty.studentEmail === studentRecord.email))
      .filter((penalty) => !isUnpaidPenaltyRecord(penalty))
      .sort((left, right) => {
        const leftDate = left.clearedAt?.toDate?.() || left.paidAt?.toDate?.() || new Date(left.clearedAt || left.paidAt || 0);
        const rightDate = right.clearedAt?.toDate?.() || right.paidAt?.toDate?.() || new Date(right.clearedAt || right.paidAt || 0);
        return rightDate - leftDate;
      });
    const blockers = [
      ...activeIssueDetails.map((book) => `Active book: ${book.bookTitle} (${book.accessionNumber})`),
      ...overdueBooks.map((book) => `NO DUES BLOCKED - Book: ${book.bookTitle}; Accession: ${book.accessionNumber}; Due: ${formatDate(book.dueDate)}; Overdue: ${book.overdueDays} days; Outstanding Penalty: ₹${book.currentPenalty.toFixed(0)}`),
      ...penaltyItems.map((item) => `Unpaid penalty: ₹${Number(item.amount || 0).toFixed(2)} for ${item.bookTitle || item.bookId || "library item"}`),
      ...unresolvedCopyLiabilities.map((item) => `Unresolved ${String(item.data.status || "copy").toLowerCase()} liability: ${item.data.title || item.data.bname || item.data.bookTitle || item.id}`)
    ];
    const blocked = blockers.length > 0;

    return {
      uid,
      name: studentRecord.name || "Unknown Student",
      email: studentRecord.email || "",
      phone: studentRecord.phone || "",
      rollNumber: studentRecord.rollNumber || studentRecord.rollNo || studentRecord.roll || "-",
      enrollmentNumber: studentRecord.enrollmentNumber || studentRecord.enrollmentNo || "",
      department: studentRecord.department || studentRecord.branch || studentRecord.course || "",
      year: studentRecord.year || studentRecord.semester || "",
      activeBooks: activeIssueDetails.length,
      overdueCount: overdueBooks.length,
      lostCount,
      damagedCount,
      activeIssueDetails,
      overdueBooks,
      penaltyItems,
      paidHistory,
      penaltyAmount,
      dueTypes,
      blockers,
      status: blocked ? "blocked" : "eligible"
    };
  }).sort((left, right) => {
    return right.penaltyAmount - left.penaltyAmount
      || right.overdueCount - left.overdueCount
      || right.activeBooks - left.activeBooks
      || left.name.localeCompare(right.name);
  });
}

function normalizeRows(rows = []) {
  return rows.map((item) => {
    const data = item?.data || item || {};
    return { id: item?.id || data.id || "", data };
  });
}

function defaultFormatDate(value) {
  if (!value) return "-";
  const date = value.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString();
}
