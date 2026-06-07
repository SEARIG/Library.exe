import { app, auth, db } from "./firebase-config.js";
import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
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
  const returnBookCallable = httpsCallable(functions, "returnBook");
  const result = await returnBookCallable({ bookId });
  return result.data;
}
