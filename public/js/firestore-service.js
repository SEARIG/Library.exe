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

const ISSUE_DAYS = 45;
const PENALTY_PER_DAY = 5;
const functions = getFunctions(app);

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
  const amount = Number(penalty.amount ?? penalty.penaltyAmount ?? 0);
  const hasRemainingAmount = penalty.remainingAmount !== undefined && penalty.remainingAmount !== null;
  const remainingAmount = Number(penalty.remainingAmount ?? 0);
  if (remainingAmount > 0) return true;
  if (hasRemainingAmount && remainingAmount <= 0 && penalty.paid === true && String(penalty.status || "").toLowerCase() === "paid") {
    return false;
  }
  if (penalty.paid === true && String(penalty.status || "").toLowerCase() === "paid") return false;
  if (amount <= 0) return false;
  return penalty.paid !== true || String(penalty.status || "").toLowerCase() !== "paid";
}

export async function getUnpaidPenaltySummary(studentUid) {
  const cleanUid = String(studentUid || "").trim();
  if (!cleanUid) {
    return { hasUnpaid: false, totalPendingPenalty: 0, records: [] };
  }

  console.log("Checking unpaid penalties for student:", cleanUid);
  const penaltiesQuery = query(collection(db, "penalties"), where("studentUid", "==", cleanUid));
  const snap = await getDocs(penaltiesQuery);
  const records = snap.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .filter(isUnpaidPenaltyRecord);
  const totalPendingPenalty = records.reduce((sum, penalty) => {
    const amount = Number(penalty.remainingAmount ?? penalty.amount ?? penalty.penaltyAmount ?? 0);
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
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

export function daysBetween(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((endDate - startDate) / 86400000));
}

export function calculatePenalty(issueDate, returnDate = new Date()) {
  const totalDays = daysBetween(issueDate, returnDate);
  const overdueDays = Math.max(0, totalDays - ISSUE_DAYS);
  return {
    totalDays,
    overdueDays,
    penaltyAmount: overdueDays * PENALTY_PER_DAY
  };
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
  if (!barcode) throw new Error("Enter or scan a barcode.");

  const barcodeQuery = query(collection(db, "books"), where("barcodeValue", "==", barcode), limit(1));
  const matches = await getDocs(barcodeQuery);
  console.log("Library barcode query result:", {
    empty: matches.empty,
    size: matches.size
  });
  if (!matches.empty) {
    const snap = matches.docs[0];
    console.log("Found book document id:", snap.id);
    return { id: snap.id, ...snap.data() };
  }

  throw new Error("Book not found. Please scan the library barcode sticker.");
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
  if (!book.b_id || !book.barcodeValue) {
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
    bookId: book.b_id,
    b_id: book.b_id,
    bookBarcodeValue: book.barcodeValue,
    bookTitle: book.bname || "",
    subject: book.subject || "",
    category: book.category || "",
    blegal_num: book.blegal_num || "",
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
    bookTitle: freshBook.bname || freshBook.title || "",
    barcodeValue: freshBook.barcodeValue || "",
    bookBarcodeValue: freshBook.barcodeValue || "",
    bookImage: freshBook.imageUrl || "",
    subject: freshBook.subject || "",
    category: freshBook.category || "",
    blegal_num: freshBook.blegal_num || "",
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

  const issueDate = issue.issueDate?.toDate ? issue.issueDate.toDate() : new Date(issue.issueDate);
  const penalty = Number.isNaN(issueDate.getTime())
    ? { overdueDays: 0, penaltyAmount: 0 }
    : calculatePenalty(issueDate, new Date());
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
    bookTitle: issue.bookTitle || issue.bookId || "",
    barcodeValue: issue.bookBarcodeValue || issue.barcodeValue || "",
    bookBarcodeValue: issue.bookBarcodeValue || issue.barcodeValue || "",
    currentIssueId: issueId,
    status: "pending",
    requestedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    preferredSlot: scheduleLabel(schedule),
    scheduleSnapshot: schedule || null,
    estimatedPenalty: penalty.penaltyAmount || 0,
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

  const barcodeQuery = query(collection(db, "books"), where("barcodeValue", "==", scannedValue), limit(1));
  const matches = await getDocs(barcodeQuery);
  console.log("Return barcode query result:", {
    empty: matches.empty,
    size: matches.size
  });

  if (matches.empty) {
    throw new Error("Book not found. Please scan the library barcode sticker.");
  }

  const bookSnap = matches.docs[0];
  const bookDocId = bookSnap.id;
  const bookData = bookSnap.data();
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

      const issueDate = issue.issueDate?.toDate ? issue.issueDate.toDate() : new Date(issue.issueDate);
      const daysUsed = Number.isNaN(issueDate.getTime()) ? 0 : daysBetween(issueDate, returnDate);
      const lateDays = Math.max(0, daysUsed - ISSUE_DAYS);
      const penaltyAmount = lateDays * (issue.penaltyPerDay || PENALTY_PER_DAY);
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
          bookBarcodeValue: issue.bookBarcodeValue || scannedValue,
          bookTitle: issue.bookTitle || issue.bookId || bookDocId,
          issueDate: issue.issueDate || null,
          dueDate: issue.dueDate || null,
          returnDate: serverTimestamp(),
          lateDays,
          daysLate: lateDays,
          amount: penaltyAmount,
          penaltyAmount,
          remainingAmount: penaltyAmount,
          paid: false,
          status: "unpaid",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }, { merge: true });
      }

      transaction.update(bookRef, {
        status: "available",
        issuedTo: null,
        issuedToName: null,
        issuedToEmail: null,
        currentIssueId: null,
        updatedAt: serverTimestamp()
      });

      return {
        issueId,
        bookId: bookDocId,
        barcodeValue: scannedValue,
        studentUid: issue.studentUid || "",
        studentName: issue.studentName || "",
        studentEmail: issue.studentEmail || "",
        bookTitle: issue.bookTitle || issue.bookId || bookDocId,
        issueDate: issue.issueDate || null,
        dueDate: issue.dueDate || null,
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
