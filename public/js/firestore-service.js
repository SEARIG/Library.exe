import { app, auth, db } from "./firebase-config.js";
import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";
import {
  ISSUE_PERIOD_DAYS,
  PENALTY_RATE_PER_DAY,
  addCalendarDays,
  calculatePenalty as calculateIssuePenalty,
  completedCalendarDaysBetween,
  getStudentPenaltyLiability,
  isUnpaidPenaltyRecord as isUnpaidPenaltyRecordUtil,
  issueBelongsToStudent,
  studentUidOfStudent
} from "./penalty-utils.mjs?v=2";

const ISSUE_DAYS = ISSUE_PERIOD_DAYS;
const PENALTY_PER_DAY = PENALTY_RATE_PER_DAY;
const functions = getFunctions(app);

export function accessionNumberOf(book = {}) {
  return String(
    book.accessionNumber
    || book.blegal_num
    || book.blegalNumber
    || book.BLegalNumber
    || book.b_id
    || ""
  ).trim();
}

export function titleOf(book = {}) {
  return book.title || book.bname || book.bookTitle || book.bookName || "";
}

export function accessionBarcode(accessionNumber) {
  const value = String(accessionNumber || "").trim();
  return value ? `ACC-${value}` : "";
}

export function compareAccessionNumbers(left, right) {
  return String(left || "").localeCompare(String(right || ""), undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

async function firstBookByField(field, value) {
  if (!value) return null;
  const snap = await getDocs(query(collection(db, "books"), where(field, "==", value), limit(1)));
  if (snap.empty) return null;
  const item = snap.docs[0];
  return { id: item.id, ...item.data() };
}

export async function findBookByLibraryCode(value) {
  const scannedValue = String(value || "").trim().replace(/\s+/g, "");
  if (!scannedValue) throw new Error("Enter or scan a library barcode or accession number.");

  const attempts = [];
  const tryField = async (field, candidate) => {
    if (!candidate) return null;
    attempts.push({ field, candidate });
    return firstBookByField(field, candidate);
  };

  let book = await tryField("barcodeValue", scannedValue);
  if (book) return book;

  const accessionCandidate = scannedValue.toUpperCase().startsWith("ACC-")
    ? scannedValue.slice(4)
    : scannedValue;
  book = await tryField("accessionNumber", accessionCandidate);
  if (book) return book;

  for (const legacyField of ["blegal_num", "blegalNumber", "BLegalNumber"]) {
    book = await tryField(legacyField, accessionCandidate);
    if (book) return book;
  }

  const oldIdCandidate = scannedValue.toUpperCase().startsWith("BOOK-")
    ? scannedValue.slice(5)
    : scannedValue;
  const directSnap = await getDoc(doc(db, "books", oldIdCandidate));
  attempts.push({ field: "documentId", candidate: oldIdCandidate });
  if (directSnap.exists()) return { id: directSnap.id, ...directSnap.data() };

  book = await tryField("b_id", oldIdCandidate);
  if (book) return book;
  if (/^\d+$/.test(oldIdCandidate)) {
    book = await tryField("b_id", Number(oldIdCandidate));
    if (book) return book;
  }

  console.log("Book lookup attempts:", attempts);
  throw new Error("Book not found. Scan ACC-{accessionNumber}, enter the accession number, or use an existing BOOK-{b_id} barcode.");
}

export function scheduleApplies(schedule = {}, type = "issue") {
  if (!schedule?.active) return false;
  const appliesTo = String(schedule.appliesTo || "both").toLowerCase();
  return appliesTo === "both" || appliesTo === type;
}

export function scheduleLabel(schedule = {}) {
  if (!schedule?.active) return "No active library time slot set.";
  const startDate = schedule.startDate || "";
  const endDate = schedule.endDate || "";
  const dateLabel = startDate && endDate && startDate !== endDate
    ? `${startDate} to ${endDate}`
    : startDate || "Until changed";
  return `${dateLabel}, ${schedule.startTime || "-"} - ${schedule.endTime || "-"}`;
}

export async function getIssueReturnSchedule() {
  const snap = await getDoc(doc(db, "librarySettings", "issueReturnSchedule"));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export function isUnpaidPenaltyRecord(penalty = {}) {
  return isUnpaidPenaltyRecordUtil(penalty);
}

export async function getUnpaidPenaltySummary(studentUid) {
  const cleanUid = String(studentUid || "").trim();
  if (!cleanUid) {
    return { hasUnpaid: false, totalPendingPenalty: 0, records: [] };
  }

  console.log("Checking unpaid penalties for student:", cleanUid);
  const penaltiesQuery = query(collection(db, "penalties"), where("studentUid", "==", cleanUid));
  const activeIssuesQuery = query(collection(db, "bookIssues"), where("studentUid", "==", cleanUid));
  const [penaltiesSnap, activeIssuesSnap] = await Promise.all([
    getDocs(penaltiesQuery),
    getDocs(activeIssuesQuery)
  ]);
  const liability = getStudentPenaltyLiability({
    student: { uid: cleanUid },
    issues: activeIssuesSnap.docs.map((item) => ({ id: item.id, ...item.data() })),
    penalties: penaltiesSnap.docs.map((item) => ({ id: item.id, ...item.data() })),
    now: new Date()
  });
  const records = liability.unpaidItems.map((item) => ({
    id: item.id,
    penaltyId: item.id,
    issueId: item.issueId,
    calculated: item.source !== "persisted",
    studentUid: item.studentUid || studentUidOfStudent({ uid: cleanUid }),
    studentName: item.studentName || "",
    studentEmail: item.issue?.studentEmail || item.penalty?.studentEmail || "",
    studentPhone: item.issue?.studentPhone || item.penalty?.studentPhone || "",
    bookId: item.bookId,
    b_id: item.bookId,
    accessionNumber: item.accessionNumber,
    bookBarcodeValue: item.issue?.bookBarcodeValue || item.issue?.barcodeValue || item.penalty?.bookBarcodeValue || "",
    bookTitle: item.bookTitle,
    issueDate: item.issueDate,
    dueDate: item.dueDate,
    lateDays: item.overdueDays,
    daysLate: item.overdueDays,
    ratePerDay: item.ratePerDay,
    amount: item.amount,
    penaltyAmount: item.amount,
    remainingAmount: item.amount,
    paid: false,
    status: "unpaid",
    paymentStatus: "unpaid"
  }));
  const totalPendingPenalty = liability.totalUnpaid;

  console.log("Unpaid penalty summary:", {
    studentUid: cleanUid,
    count: records.length,
    totalPendingPenalty
  });

  return {
    hasUnpaid: records.length > 0,
    totalPendingPenalty,
    records
  };
}

export function addDays(date, days) {
  return addCalendarDays(date, days);
}

export function daysBetween(start, end) {
  return completedCalendarDaysBetween(start, end);
}

export function calculatePenalty(issue, currentDate = new Date()) {
  return calculateIssuePenalty(issue, currentDate);
}

export async function createStudentProfile(uid, profile) {
  const common = {
    uid,
    name: profile.name,
    email: profile.email,
    phone: profile.phone,
    createdAt: serverTimestamp()
  };

  await setDoc(doc(db, "users", uid), {
    ...common,
    role: "student",
    active: true
  });

  await setDoc(doc(db, "students", uid), {
    ...common,
    rollNumber: profile.rollNumber,
    department: profile.department,
    year: profile.year,
    active: true,
    updatedAt: serverTimestamp()
  });
}

export async function getStudentProfile(uid) {
  const snap = await getDoc(doc(db, "students", uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

async function getQueryRowsSafely(firestoreQuery, label) {
  try {
    const snap = await getDocs(firestoreQuery);
    return snap.docs.map((item) => ({ id: item.id, ...item.data() }));
  } catch (error) {
    console.warn(`Issue eligibility query skipped: ${label}`, {
      code: error?.code,
      message: error?.message
    });
    return [];
  }
}

function uniqueRows(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    const key = row.id || JSON.stringify(row);
    if (!map.has(key)) map.set(key, row);
  });
  return Array.from(map.values());
}

export async function canStudentIssueBook(studentOrUid) {
  const uid = typeof studentOrUid === "string" ? studentOrUid : studentOrUid?.uid || studentOrUid?.studentUid || studentOrUid?.id || "";
  if (!uid) {
    return {
      eligible: false,
      totalPendingPenalty: 0,
      overdueBooks: 0,
      activeBooks: 0,
      blockers: [{ type: "other", message: "Student record is missing." }]
    };
  }

  const [studentSnap, userSnap] = await Promise.all([
    getDoc(doc(db, "students", uid)).catch(() => null),
    getDoc(doc(db, "users", uid)).catch(() => null)
  ]);
  const student = {
    ...(userSnap?.exists?.() ? userSnap.data() : {}),
    ...(studentSnap?.exists?.() ? studentSnap.data() : {}),
    ...(typeof studentOrUid === "object" ? studentOrUid : {}),
    uid
  };
  const email = String(student.email || student.studentEmail || "").trim().toLowerCase();
  const rollNo = student.rollNo || student.rollNumber || student.roll || "";
  const enrollmentNumber = student.enrollmentNumber || student.enrollmentNo || "";

  const issueQueries = [
    ["bookIssues.studentUid", query(collection(db, "bookIssues"), where("studentUid", "==", uid))],
    ["bookIssues.userId", query(collection(db, "bookIssues"), where("userId", "==", uid))],
    ["bookIssues.studentId", query(collection(db, "bookIssues"), where("studentId", "==", uid))],
    ["bookIssues.issuedTo", query(collection(db, "bookIssues"), where("issuedTo", "==", uid))],
    ["issueRecords.studentUid", query(collection(db, "issueRecords"), where("studentUid", "==", uid))]
  ];
  if (email) {
    issueQueries.push(["bookIssues.studentEmail", query(collection(db, "bookIssues"), where("studentEmail", "==", email))]);
    issueQueries.push(["issueRecords.studentEmail", query(collection(db, "issueRecords"), where("studentEmail", "==", email))]);
  }
  const penaltyQueries = [
    ["penalties.studentUid", query(collection(db, "penalties"), where("studentUid", "==", uid))]
  ];
  if (email) penaltyQueries.push(["penalties.studentEmail", query(collection(db, "penalties"), where("studentEmail", "==", email))]);
  const bookQueries = [
    ["books.issuedStudentUid", query(collection(db, "books"), where("issuedStudentUid", "==", uid))],
    ["books.issuedTo", query(collection(db, "books"), where("issuedTo", "==", uid))]
  ];

  const [issueRows, penaltyRows, bookRows] = await Promise.all([
    Promise.all(issueQueries.map(([label, firestoreQuery]) => getQueryRowsSafely(firestoreQuery, label))).then((groups) => uniqueRows(groups.flat())),
    Promise.all(penaltyQueries.map(([label, firestoreQuery]) => getQueryRowsSafely(firestoreQuery, label))).then((groups) => uniqueRows(groups.flat())),
    Promise.all(bookQueries.map(([label, firestoreQuery]) => getQueryRowsSafely(firestoreQuery, label))).then((groups) => uniqueRows(groups.flat()))
  ]);

  const liability = getStudentPenaltyLiability({
    student,
    issues: issueRows,
    penalties: penaltyRows,
    now: new Date()
  });
  const lostDamagedBlockers = bookRows
    .filter((book) => ["lost", "damaged"].includes(String(book.status || "").toLowerCase()))
    .filter((book) => issueBelongsToStudent({
      studentUid: book.issuedStudentUid || book.issuedTo || book.studentUid || "",
      studentEmail: book.issuedToEmail || book.studentEmail || "",
      bookId: book.bookId || book.b_id || book.id,
      accessionNumber: accessionNumberOf(book)
    }, student))
    .map((book) => ({
      type: String(book.status || "").toLowerCase(),
      message: `Student has an unresolved ${String(book.status || "").toLowerCase()} book liability.`,
      bookId: book.bookId || book.b_id || book.id || "",
      accessionNumber: accessionNumberOf(book),
      amount: 0
    }));
  const penaltyBlockers = liability.unpaidItems.map((item) => ({
    type: "penalty",
    message: `₹${Number(item.amount || 0).toFixed(2)} pending library penalty.`,
    bookId: item.bookId,
    accessionNumber: item.accessionNumber,
    amount: Number(item.amount || 0),
    overdueDays: item.overdueDays
  }));
  const activeIssueBlockers = liability.activeIssues.map((item) => ({
    type: "activeIssue",
    message: "Student already has an unreturned library book.",
    bookId: item.data.bookId || item.data.b_id || "",
    accessionNumber: item.data.accessionNumber || "",
    amount: 0,
    overdueDays: 0
  }));
  const overdueBlockers = liability.overdueIssues.map((item) => ({
    type: "overdue",
    message: "Student has an overdue/unreturned library book.",
    bookId: item.data.bookId || item.data.b_id || "",
    accessionNumber: item.data.accessionNumber || "",
    amount: 0,
    overdueDays: item.calculation.overdueDays
  }));
  const inactiveBlocker = student.active === false || String(student.status || "").toLowerCase() === "inactive"
    ? [{ type: "other", message: "Student account is inactive." }]
    : [];
  const blockers = [...inactiveBlocker, ...penaltyBlockers, ...overdueBlockers, ...lostDamagedBlockers];
  blockers.push(...activeIssueBlockers);
  const uniqueBlockers = [];
  const blockerKeys = new Set();
  blockers.forEach((blocker) => {
    const key = [blocker.type, blocker.bookId, blocker.accessionNumber, blocker.amount, blocker.overdueDays].join("|");
    if (!blockerKeys.has(key)) {
      blockerKeys.add(key);
      uniqueBlockers.push(blocker);
    }
  });

  return {
    eligible: uniqueBlockers.length === 0,
    totalPendingPenalty: liability.totalUnpaid,
    overdueBooks: liability.overdueIssues.length,
    activeBooks: liability.activeIssues.length,
    blockers: uniqueBlockers
  };
}

export function issueEligibilityError(eligibility) {
  const error = new Error(`Book Issue Blocked. You have pending library dues. Please clear them before requesting another book. Pending Penalty: Rs.${Number(eligibility?.totalPendingPenalty || 0).toFixed(2)}. Overdue Books: ${eligibility?.overdueBooks || 0}.`);
  error.code = "dues/blocked";
  error.totalPendingPenalty = Number(eligibility?.totalPendingPenalty || 0);
  error.overdueBooks = Number(eligibility?.overdueBooks || 0);
  error.blockers = eligibility?.blockers || [];
  return error;
}

function normalizeIssueRequestError(error) {
  const details = error?.details || error?.customData?.details;
  if (error?.code === "functions/failed-precondition" && details?.blockers) {
    throw issueEligibilityError(details);
  }
  throw error;
}

export async function findBookByBarcode(value) {
  const barcode = String(value || "").trim().replace(/\s+/g, "");
  console.log("Scanned barcode value:", barcode);
  const book = await findBookByLibraryCode(barcode);
  console.log("Found book document id:", book.id);
  return book;
}

export async function createIssueRequest({ student, book }) {
  if (!auth.currentUser) throw new Error("Login is required.");
  console.log("Current user uid:", auth.currentUser.uid);
  if (auth.currentUser.uid !== student.uid) {
    throw new Error("You can create issue requests only for your own account.");
  }
  if (book.status !== "available") {
    throw new Error("This book is not available.");
  }
  const bookDocId = book.b_id || book.bookId || book.id;
  const accessionNumber = accessionNumberOf(book);
  if (!bookDocId || !accessionNumber) {
    throw new Error("Invalid library book record. Please scan the library barcode sticker.");
  }

  const eligibility = await canStudentIssueBook({ ...student, uid: auth.currentUser.uid });
  if (!eligibility.eligible) {
    throw issueEligibilityError(eligibility);
  }

  const requestLegacyBookIssue = httpsCallable(functions, "requestLegacyBookIssue");
  let result;
  try {
    result = await requestLegacyBookIssue({
      bookId: bookDocId,
      libraryBarcode: book.barcodeValue || accessionBarcode(accessionNumber)
    });
  } catch (error) {
    normalizeIssueRequestError(error);
  }
  const data = result.data || {};
  return {
    requestId: data.requestId,
    payload: data.payload || {},
    issueDate: data.payload?.issueDate ? new Date(data.payload.issueDate) : null,
    dueDate: data.payload?.dueDate ? new Date(data.payload.dueDate) : null
  };
}

export async function createCatalogIssueRequest({ student, book, confirmationChecked = true }) {
  if (!auth.currentUser) throw new Error("Login is required.");
  if (auth.currentUser.uid !== student.uid) {
    throw new Error("You can create issue requests only for your own account.");
  }
  if (!confirmationChecked) {
    throw new Error("Please confirm the selected library time.");
  }

  const bookDocId = book.b_id || book.bookId || book.id;
  if (!bookDocId) throw new Error("Invalid book record.");

  const schedule = await getIssueReturnSchedule();
  if (!scheduleApplies(schedule, "issue")) {
    throw new Error("Issue request time is not active. Please contact the librarian.");
  }

  const [freshBookSnap, pendingSnap, eligibility] = await Promise.all([
    getDoc(doc(db, "books", bookDocId)),
    getDocs(query(
      collection(db, "issueRequests"),
      where("studentUid", "==", auth.currentUser.uid),
      where("status", "==", "pending")
    )),
    canStudentIssueBook({ ...student, uid: auth.currentUser.uid })
  ]);

  if (!freshBookSnap.exists()) throw new Error("Book record not found.");
  const freshBook = { id: freshBookSnap.id, ...freshBookSnap.data() };
  if (freshBook.status !== "available") {
    throw new Error("This book is not available.");
  }
  if (!eligibility.eligible) {
    throw issueEligibilityError(eligibility);
  }
  const duplicate = pendingSnap.docs.some((item) => {
    const request = item.data();
    return (request.b_id || request.bookId) === (freshBook.b_id || freshBookSnap.id);
  });
  if (duplicate) {
    throw new Error("You already have a pending request for this book.");
  }

  const requestLegacyBookIssue = httpsCallable(functions, "requestLegacyBookIssue");
  let result;
  try {
    result = await requestLegacyBookIssue({
      bookId: freshBook.b_id || freshBookSnap.id,
      libraryBarcode: freshBook.barcodeValue || accessionBarcode(accessionNumberOf(freshBook))
    });
  } catch (error) {
    normalizeIssueRequestError(error);
  }
  return result.data || {};
}

export async function createReturnRequest({ student, issue, confirmationChecked = true }) {
  if (!auth.currentUser) throw new Error("Login is required.");
  if (auth.currentUser.uid !== student.uid) {
    throw new Error("You can create return requests only for your own account.");
  }
  if (!confirmationChecked) {
    throw new Error("Please confirm the selected library time.");
  }
  if (!issue?.issueId && !issue?.id) throw new Error("Invalid issued book record.");

  const schedule = await getIssueReturnSchedule();
  if (!scheduleApplies(schedule, "return")) {
    throw new Error("Return request time is not active. Please contact the librarian.");
  }

  const issueId = issue.issueId || issue.id;
  const pendingSnap = await getDocs(query(
    collection(db, "returnRequests"),
    where("studentUid", "==", auth.currentUser.uid),
    where("status", "==", "pending")
  ));
  const duplicate = pendingSnap.docs.some((item) => item.data().currentIssueId === issueId);
  if (duplicate) throw new Error("You already have a pending return request for this book.");

  const penalty = calculatePenalty(issue, new Date());
  const ref = doc(collection(db, "returnRequests"));
  const payload = {
    type: "return",
    requestId: ref.id,
    studentUid: auth.currentUser.uid,
    studentName: student.name || auth.currentUser.displayName || "",
    studentEmail: student.email || auth.currentUser.email || "",
    studentPhone: student.phone || "",
    bookId: issue.bookId || issue.b_id || "",
    b_id: issue.b_id || issue.bookId || "",
    accessionNumber: issue.accessionNumber || "",
    author: issue.author || "",
    title: issue.title || issue.bookTitle || "",
    placePublisher: issue.placePublisher || "",
    year: issue.year || "",
    pages: issue.pages || "",
    bookTitle: issue.title || issue.bookTitle || issue.bookId || "",
    barcodeValue: issue.bookBarcodeValue || issue.barcodeValue || "",
    bookBarcodeValue: issue.bookBarcodeValue || issue.barcodeValue || "",
    currentIssueId: issueId,
    status: "pending",
    requestedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    preferredSlot: scheduleLabel(schedule),
    scheduleSnapshot: schedule || null,
    estimatedPenalty: penalty.calculatedPenalty || 0,
    confirmationChecked: true,
    reviewedBy: null,
    reviewedAt: null
  };
  console.log("Return request payload:", payload);
  await setDoc(ref, payload);
  return { requestId: ref.id, payload };
}

export async function approveIssue(requestId) {
  const approveIssueRequest = httpsCallable(functions, "approveIssueRequest");
  const result = await approveIssueRequest({ requestId });
  return result.data;
}

export async function rejectIssue(requestId, reason = "Rejected by librarian") {
  const rejectIssueRequest = httpsCallable(functions, "rejectIssueRequest");
  const result = await rejectIssueRequest({ requestId, reason });
  return result.data;
}

export async function returnBook(bookId) {
  const scannedValue = String(bookId || "").trim().replace(/\s+/g, "");
  console.log("Return scanned library barcode:", scannedValue);
  if (!scannedValue) throw new Error("Scan or enter the library barcode.");

  const matchedBook = await findBookByLibraryCode(scannedValue);
  const bookDocId = matchedBook.id;
  const bookData = matchedBook;
  const issueId = bookData.currentIssueId;
  console.log("Return book document:", {
    bookDocId,
    barcodeValue: bookData.barcodeValue,
    currentIssueId: issueId,
    status: bookData.status
  });

  if (!issueId) {
    throw new Error("No active issue found for this book.");
  }

  const bookRef = doc(db, "books", bookDocId);
  const issueRef = doc(db, "bookIssues", issueId);
  const returnDate = new Date();

  try {
    return await runTransaction(db, async (transaction) => {
      const [freshBookSnap, issueSnap] = await Promise.all([
        transaction.get(bookRef),
        transaction.get(issueRef)
      ]);

      if (!freshBookSnap.exists()) {
        throw new Error("Book record not found.");
      }
      if (!issueSnap.exists()) {
        throw new Error("Active issue record not found.");
      }

      const freshBook = freshBookSnap.data();
      const issue = issueSnap.data();
      console.log("Return active issue data:", issue);

      if (freshBook.status !== "issued") {
        throw new Error("This book is not currently issued.");
      }
      if (issue.status !== "issued") {
        throw new Error("This issue is already closed.");
      }

      const penalty = calculatePenalty(issue, returnDate);
      const daysUsed = daysBetween(issue.issueDate || issue.issuedAt, returnDate);
      const lateDays = penalty.overdueDays;
      const penaltyAmount = penalty.calculatedPenalty;
      const penaltyRef = doc(db, "penalties", issueId);

      transaction.update(issueRef, {
        status: "returned",
        returnDate: serverTimestamp(),
        returnedAt: serverTimestamp(),
        penaltyAmount
      });

      if (penaltyAmount > 0) {
        transaction.set(penaltyRef, {
          penaltyId: penaltyRef.id,
          issueId,
          studentUid: issue.studentUid || "",
          studentName: issue.studentName || "",
          studentEmail: issue.studentEmail || "",
          studentPhone: issue.studentPhone || "",
          bookId: issue.bookId || bookDocId,
          b_id: issue.b_id || issue.bookId || bookDocId,
          accessionNumber: issue.accessionNumber || accessionNumberOf(freshBook),
          bookBarcodeValue: issue.bookBarcodeValue || scannedValue,
          bookTitle: issue.bookTitle || issue.bookId || bookDocId,
          issueDate: issue.issueDate || null,
          dueDate: issue.dueDate || penalty.dueDate || null,
          returnDate: serverTimestamp(),
          lateDays,
          daysLate: lateDays,
          ratePerDay: penalty.ratePerDay,
          amount: penaltyAmount,
          penaltyAmount,
          remainingAmount: penaltyAmount,
          paid: false,
          status: "unpaid",
          paymentStatus: "unpaid",
          penaltyStatus: "unpaid",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }, { merge: true });
      }

      transaction.update(bookRef, {
        status: "available",
        issuedStudentUid: null,
        issuedTo: null,
        issuedToName: null,
        issuedToEmail: null,
        currentIssueId: null,
        updatedAt: serverTimestamp()
      });

      return {
        issueId,
        bookId: bookDocId,
        accessionNumber: issue.accessionNumber || accessionNumberOf(freshBook),
        author: issue.author || freshBook.author || "",
        title: issue.title || issue.bookTitle || titleOf(freshBook),
        barcodeValue: freshBook.barcodeValue || accessionBarcode(accessionNumberOf(freshBook)),
        studentUid: issue.studentUid || "",
        studentName: issue.studentName || "",
        studentEmail: issue.studentEmail || "",
        bookTitle: issue.bookTitle || issue.bookId || bookDocId,
        issueDate: issue.issueDate || null,
        dueDate: issue.dueDate || penalty.dueDate || null,
        returnDate,
        daysUsed,
        lateDays,
        penaltyAmount
      };
    });
  } catch (error) {
    console.error("Return book failed full error:", error);
    console.error("Return book failed code:", error.code);
    console.error("Return book failed message:", error.message);
    throw error;
  }
}
