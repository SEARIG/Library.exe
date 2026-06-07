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

      transaction.update(issueRef, {
        status: "returned",
        returnDate: serverTimestamp(),
        returnedAt: serverTimestamp(),
        penaltyAmount
      });

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
