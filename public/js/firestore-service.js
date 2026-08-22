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
  findMatchingPenaltyForIssue,
  isActiveIssue,
  isPenaltyPaid,
  isUnpaidPenaltyRecord as isUnpaidPenaltyRecordUtil,
  issueIdOf,
  penaltyAmountOf
} from "./penalty-utils.mjs";

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
  const activeIssuesQuery = query(collection(db, "bookIssues"), where("studentUid", "==", cleanUid), where("status", "==", "issued"));
  const [penaltiesSnap, activeIssuesSnap] = await Promise.all([
    getDocs(penaltiesQuery),
    getDocs(activeIssuesQuery)
  ]);
  const activeIssues = activeIssuesSnap.docs.map((item) => ({ id: item.id, ...item.data() }));
  const penaltyRows = penaltiesSnap.docs.map((item) => ({ id: item.id, data: item.data() }));
  const penaltyRecords = penaltiesSnap.docs
    .map((item) => {
      const penalty = item.data();
      const matchedIssue = activeIssues.find((issue) => findMatchingPenaltyForIssue([{ id: item.id, data: penalty }], issue, issue.id));
      const activeIssue = matchedIssue || null;
      const calculation = activeIssue ? calculatePenalty(activeIssue, new Date()) : null;
      const currentAmount = calculation?.calculatedPenalty || 0;
      const persistedAmount = penaltyAmountOf(penalty);
      return calculation && isUnpaidPenaltyRecord(penalty) && currentAmount > persistedAmount
        ? {
            id: item.id,
            ...penalty,
            dueDate: penalty.dueDate || calculation.dueDate,
            lateDays: calculation.overdueDays,
            daysLate: calculation.overdueDays,
            ratePerDay: calculation.ratePerDay,
            amount: currentAmount,
            penaltyAmount: currentAmount,
            remainingAmount: currentAmount
          }
        : { id: item.id, ...penalty };
    })
    .filter(isUnpaidPenaltyRecord);
  const existingUnpaidIssueIds = new Set(penaltyRecords.map((penalty) => issueIdOf(penalty, penalty.id)));

  const calculatedIssueRecords = activeIssues
    .filter(isActiveIssue)
    .map((issue) => {
      const calculation = calculatePenalty(issue, new Date());
      const persistedPenaltyRow = findMatchingPenaltyForIssue(penaltyRows, issue, issue.id);
      const persistedPenalty = persistedPenaltyRow?.data || null;
      if (!calculation.isOverdue || calculation.calculatedPenalty <= 0 || isPenaltyPaid(persistedPenalty || {})) return null;
      if (existingUnpaidIssueIds.has(issue.id) || persistedPenaltyRow) return null;
      return {
        id: issue.id,
        penaltyId: issue.id,
        issueId: issue.id,
        calculated: true,
        studentUid: cleanUid,
        studentName: issue.studentName || "",
        studentEmail: issue.studentEmail || "",
        studentPhone: issue.studentPhone || "",
        bookId: issue.bookId || issue.b_id || "",
        b_id: issue.b_id || issue.bookId || "",
        accessionNumber: issue.accessionNumber || "",
        bookBarcodeValue: issue.bookBarcodeValue || issue.barcodeValue || "",
        bookTitle: issue.bookTitle || issue.title || issue.bookId || "",
        issueDate: issue.issueDate || issue.issuedAt || null,
        dueDate: issue.dueDate || calculation.dueDate || null,
        lateDays: calculation.overdueDays,
        daysLate: calculation.overdueDays,
        ratePerDay: calculation.ratePerDay,
        amount: calculation.calculatedPenalty,
        penaltyAmount: calculation.calculatedPenalty,
        remainingAmount: calculation.calculatedPenalty,
        paid: false,
        status: "unpaid",
        paymentStatus: "unpaid"
      };
    })
    .filter(Boolean);

  const records = [...penaltyRecords, ...calculatedIssueRecords];
  const totalPendingPenalty = records.reduce((sum, penalty) => {
    const amount = penaltyAmountOf(penalty);
    return sum + Math.max(0, amount);
  }, 0);

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

  try {
    const penaltySummary = await getUnpaidPenaltySummary(auth.currentUser.uid);
    if (penaltySummary.hasUnpaid) {
      const error = new Error(`Please clear your pending library penalty before requesting another book. Total pending penalty: Rs.${penaltySummary.totalPendingPenalty.toFixed(2)}`);
      error.code = "penalty/unpaid";
      error.totalPendingPenalty = penaltySummary.totalPendingPenalty;
      throw error;
    }
  } catch (error) {
    if (error.code === "penalty/unpaid") throw error;
    console.error("Penalty check failed before issue request:", {
      query: "penalties where studentUid == currentUser.uid",
      code: error?.code,
      message: error?.message
    });
    throw error;
  }

  const issueDate = new Date();
  const dueDate = addDays(issueDate, ISSUE_DAYS);
  const ref = doc(collection(db, "issueRequests"));
  const payload = {
    requestId: ref.id,
    studentUid: student.uid,
    studentName: student.name,
    rollNumber: student.rollNumber || "",
    bookId: bookDocId,
    b_id: bookDocId,
    accessionNumber,
    author: book.author || "",
    title: titleOf(book),
    placePublisher: book.placePublisher || book.publisher || "",
    year: book.year || "",
    pages: book.pages || "",
    volume: book.volume || "",
    imageUrl: book.imageUrl || "",
    barcodeValue: book.barcodeValue || accessionBarcode(accessionNumber),
    bookBarcodeValue: book.barcodeValue || accessionBarcode(accessionNumber),
    bookTitle: titleOf(book),
    subject: book.subject || "",
    category: book.category || "",
    bookImage: book.imageUrl || "",
    issueDate: Timestamp.fromDate(issueDate),
    dueDate: Timestamp.fromDate(dueDate),
    confirmationChecked: true,
    status: "pending",
    createdAt: serverTimestamp(),
    reviewedBy: null,
    reviewedAt: null
  };
  console.log("Issue request payload:", payload);

  try {
    await setDoc(ref, payload);
  } catch (error) {
    console.error("Issue request Firestore error:", {
      code: error?.code,
      message: error?.message
    });
    throw error;
  }

  return {
    requestId: ref.id,
    issueDate,
    dueDate
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

  const [freshBookSnap, pendingSnap, penaltySummary] = await Promise.all([
    getDoc(doc(db, "books", bookDocId)),
    getDocs(query(
      collection(db, "issueRequests"),
      where("studentUid", "==", auth.currentUser.uid),
      where("status", "==", "pending")
    )),
    getUnpaidPenaltySummary(auth.currentUser.uid)
  ]);

  if (!freshBookSnap.exists()) throw new Error("Book record not found.");
  const freshBook = { id: freshBookSnap.id, ...freshBookSnap.data() };
  if (freshBook.status !== "available") {
    throw new Error("This book is not available.");
  }
  if (penaltySummary.hasUnpaid) {
    const error = new Error(`Please clear your pending library penalty before requesting another book. Total pending penalty: Rs.${penaltySummary.totalPendingPenalty.toFixed(2)}`);
    error.code = "penalty/unpaid";
    error.totalPendingPenalty = penaltySummary.totalPendingPenalty;
    throw error;
  }
  const duplicate = pendingSnap.docs.some((item) => {
    const request = item.data();
    return (request.b_id || request.bookId) === (freshBook.b_id || freshBookSnap.id);
  });
  if (duplicate) {
    throw new Error("You already have a pending request for this book.");
  }

  const issueDate = new Date();
  const dueDate = addDays(issueDate, ISSUE_DAYS);
  const ref = doc(collection(db, "issueRequests"));
  const userSnap = await getDoc(doc(db, "users", auth.currentUser.uid));
  const userRole = userSnap.exists() ? userSnap.data().role || "" : "";
  const requestPayload = {
    type: "issue",
    requestId: ref.id,
    studentUid: auth.currentUser.uid,
    studentName: student.name || auth.currentUser.displayName || "",
    studentEmail: student.email || auth.currentUser.email || "",
    studentPhone: student.phone || "",
    rollNumber: student.rollNumber || "",
    bookId: freshBook.b_id || freshBookSnap.id,
    b_id: freshBook.b_id || freshBookSnap.id,
    accessionNumber: accessionNumberOf(freshBook),
    author: freshBook.author || "",
    title: titleOf(freshBook),
    placePublisher: freshBook.placePublisher || freshBook.publisher || "",
    year: freshBook.year || "",
    pages: freshBook.pages || "",
    volume: freshBook.volume || "",
    imageUrl: freshBook.imageUrl || "",
    bookTitle: titleOf(freshBook),
    barcodeValue: freshBook.barcodeValue || accessionBarcode(accessionNumberOf(freshBook)),
    bookBarcodeValue: freshBook.barcodeValue || accessionBarcode(accessionNumberOf(freshBook)),
    bookImage: freshBook.imageUrl || "",
    subject: freshBook.subject || "",
    category: freshBook.category || "",
    status: "pending",
    issueDate: Timestamp.fromDate(issueDate),
    dueDate: Timestamp.fromDate(dueDate),
    requestedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    preferredSlot: scheduleLabel(schedule),
    scheduleSnapshot: schedule || null,
    confirmationChecked: true,
    source: "library_catalog",
    reviewedBy: null,
    reviewedAt: null
  };
  console.log("Current user uid:", auth.currentUser.uid);
  console.log("Current user role:", userRole);
  console.log("Creating issue request from library:", requestPayload);
  try {
    await setDoc(ref, requestPayload);
  } catch (error) {
    console.error("Library issue request Firestore error:", {
      code: error?.code,
      message: error?.message,
      payload: requestPayload
    });
    throw error;
  }
  return { requestId: ref.id, payload: requestPayload };
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
