import { auth, db } from "./firebase-config.js";
import {
  $,
  confirmAction,
  escapeHtml,
  formatDate,
  logDetailedError,
  renderEmpty,
  requireAuth,
  setLoading,
  showToast,
  statusBadge,
  wireSignOut
} from "./app.js";
import {
  accessionBarcode,
  accessionNumberOf,
  calculatePenalty,
  findBookByLibraryCode,
  getUnpaidPenaltySummary,
  getIssueReturnSchedule,
  isUnpaidPenaltyRecord,
  returnBook,
  scheduleLabel,
  titleOf
} from "./firestore-service.js";
import {
  EMAILJS_SETUP_MESSAGE,
  isEmailNotificationsConfigured,
  runReminderCheck,
  sendEmailNotification
} from "./notifications.js";
import {
  ACCESSION_TEMPLATE_HEADERS,
  accessionBookData,
  accessionExportRow,
  parseAccessionRegister
} from "./accession-register.mjs";
import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

wireSignOut();
const session = await requireAuth(["librarian", "admin"]);
const addBookForm = $("#addBookForm");
const bookSearch = $("#bookSearch");
const bookCategoryFilter = $("#bookCategoryFilter");
const bookAvailabilityFilter = $("#bookAvailabilityFilter");
let nextBookId = "1";
let editingBookId = null;
let editingExistingBook = null;
let latestBooks = [];
let latestPendingRequests = [];
let latestReturnRequests = [];
let latestPenalties = [];
let latestBarcodeDataUrl = "";
let selectedReturnRequest = null;
let pendingBookImportRows = [];
let pendingBookImportMatrix = [];
let pendingBookImportSheetName = "";
let publisherStream = null;
let publisherScanTimer = null;
let quickReturnStream = null;
let quickReturnScanTimer = null;
let selectedQuickReturn = null;
const showBookDebug = new URLSearchParams(window.location.search).get("debug") === "true"
  || localStorage.debugBooks === "true";
const testEmailButton = $("#sendTestEmailBtn");
if (testEmailButton) testEmailButton.title = EMAILJS_SETUP_MESSAGE;
const INDCAT_CONFIG = {
  enabled: false,
  apiUrl: ""
};
const BOOK_CATEGORIES = ["pyq", "textbook", "qna", "reference", "notes", "journal", "other"];

function logLibraryDiagnostics() {
  console.log("XLSX loaded:", typeof XLSX);
  console.log("jsPDF loaded:", typeof window.jspdf);
  console.log("JsBarcode loaded:", typeof JsBarcode);
  console.log("Excel import file input found:", Boolean(document.querySelector("input[type='file']")));
  console.log("Excel import buttons found:", Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit']"))
    .filter((item) => /import/i.test(item.textContent || item.value || item.id || ""))
    .map((item) => item.id || item.textContent || item.value));
  console.log("Export barcode Excel button found:", Boolean(document.getElementById("exportBarcodeExcelBtn")));
  console.log("Bulk barcode PDF button found:", Boolean(document.getElementById("generateBulkBarcodePdfBtn")));
  console.log("Metadata fetch button found:", Boolean(document.getElementById("fetchGoogleBookBtn")));
}

function timeOf(value) {
  if (!value) return 0;
  const date = value.toDate ? value.toDate() : new Date(value);
  return date.getTime();
}

function shortUid(uid = "") {
  const value = String(uid || "");
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function bookTitle(book) {
  return titleOf(book);
}

function bookIdOf(book, fallbackId = "") {
  return book.b_id || book.bookId || fallbackId;
}

function barcodeValueFor(accessionNumber, fallbackBid = "") {
  return accessionBarcode(accessionNumber) || `BOOK-${fallbackBid}`;
}

function readWorkbookRows(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const workbook = window.XLSX.read(event.target.result, {
          type: "array",
          cellDates: false
        });
        const sheetName = workbook.SheetNames.find((name) => name.trim().toLowerCase() === "register data")
          || workbook.SheetNames[0];
        if (!sheetName) throw new Error("The workbook does not contain a worksheet.");
        const sheet = workbook.Sheets[sheetName];
        resolve({
          sheetName,
          matrix: window.XLSX.utils.sheet_to_json(sheet, {
            header: 1,
            defval: "",
            raw: false,
            blankrows: false
          })
        });
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function numberValue(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeAccession(value) {
  return String(value || "").trim();
}

function accessionValuesForCopies(base, copies) {
  return Array.from({ length: copies }, (_, index) => index === 0 ? base : `${base}-${index + 1}`);
}

function downloadWorkbookTemplate(filename, rows, sheetName = "Template") {
  if (!window.XLSX) throw new Error("XLSX library is not loaded.");
  const sheet = window.XLSX.utils.json_to_sheet(rows);
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  window.XLSX.writeFile(workbook, filename);
}

function existingAccessionMap() {
  return new Map(latestBooks
    .map((item) => [accessionNumberOf(item.data).toLowerCase(), item])
    .filter(([accession]) => accession));
}

function normalizeBookImportRows(matrix) {
  return parseAccessionRegister(
    matrix,
    existingAccessionMap(),
    $("#updateExistingBooks")?.checked === true
  );
}

function renderBookImportPreview(rows, sheetName = "", headerRow = 0) {
  pendingBookImportRows = rows;
  const readyCount = rows.filter((row) => !row.errors.length).length;
  const errorCount = rows.filter((row) => row.errors.length).length;
  const duplicateCount = rows.filter((row) => row.duplicateType).length;
  $("#confirmBookImportBtn").disabled = readyCount === 0;
  $("#bookImportResult").innerHTML = `
    <div class="${errorCount ? "empty" : "success-box"}">
      <strong>${rows.length} row(s) parsed</strong>
      <span>Sheet: ${escapeHtml(sheetName || "Register Data")} | Header row: ${headerRow || "-"}</span>
      <span>Ready to import/update: ${readyCount}</span>
      <span>Validation errors: ${errorCount}</span>
      <span>Duplicates: ${duplicateCount}</span>
    </div>`;
  if (!rows.length) {
    renderEmpty($("#bookImportPreview"), "No rows found.");
    return;
  }
  $("#bookImportPreview").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Row</th>
          <th>Accession Number</th>
          <th>Author</th>
          <th>Title</th>
          <th>Place &amp; Publisher</th>
          <th>Year</th>
          <th>Pages</th>
          <th>Cost</th>
          <th>Image URL</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td>${row.rowNumber}</td>
            <td>${escapeHtml(row.accessionNumber)}</td>
            <td>${escapeHtml(row.author)}</td>
            <td>${escapeHtml(row.title)}</td>
            <td>${escapeHtml(row.placePublisher)}</td>
            <td>${escapeHtml(row.year)}</td>
            <td>${escapeHtml(row.pages)}</td>
            <td>${escapeHtml(row.cost)}</td>
            <td>${escapeHtml(row.imageUrl)}</td>
            <td>${row.errors.length
              ? escapeHtml(row.errors.join("; "))
              : row.action === "update" ? "Ready: update existing" : "Ready: import"}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

async function importPreviewedBooks() {
  const validRows = pendingBookImportRows.filter((row) => !row.errors.length);
  if (!validRows.length) throw new Error("No valid book rows to import.");
  const importBatchId = `books_import_${Date.now()}`;
  let imported = 0;
  let updated = 0;

  for (const row of validRows) {
    const registerData = accessionBookData(row);
    if (row.action === "update" && row.existingBookId) {
      await updateDoc(doc(db, "books", row.existingBookId), {
        ...registerData,
        bname: registerData.title,
        publisher: registerData.placePublisher,
        metadataSource: "accession_register_import",
        importBatchId,
        updatedAt: serverTimestamp()
      });
      updated += 1;
    } else {
      await runTransaction(db, async (transaction) => {
        const counterRef = doc(db, "counters", "books");
        const counterSnap = await transaction.get(counterRef);
        const bId = String((counterSnap.exists() ? Number(counterSnap.data().lastId || 0) : 0) + 1);
        const bookRef = doc(db, "books", bId);
        transaction.set(bookRef, {
          ...registerData,
          b_id: bId,
          bname: registerData.title,
          publisher: registerData.placePublisher,
          metadataSource: "accession_register_import",
          barcodeDataUrl: "",
          barcodePrinted: false,
          barcodePrintedAt: null,
          barcodePrintedBy: null,
          barcodePrintBatchId: null,
          importBatchId,
          status: "available",
          issuedStudentUid: null,
          issuedTo: null,
          issuedToName: null,
          issuedToEmail: null,
          currentIssueId: null,
          createdBy: session.user.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
        transaction.set(counterRef, { lastId: Number(bId) }, { merge: true });
      });
      imported += 1;
    }
  }

  const skipped = pendingBookImportRows.length - validRows.length;
  const duplicateCount = pendingBookImportRows.filter((row) => row.duplicateType).length;
  $("#barcodeImportBatchFilter").value = importBatchId;
  renderBarcodePrintManager();
  $("#bookImportResult").innerHTML = `
    <div class="success-box">
      <strong>Accession register import complete</strong>
      <span>Imported count: ${imported}</span>
      <span>Updated count: ${updated}</span>
      <span>Skipped count: ${skipped}</span>
      <span>Errors: ${skipped}</span>
      <span>Duplicate count: ${duplicateCount}</span>
      <span>Import batch: ${escapeHtml(importBatchId)}</span>
    </div>`;
  $("#confirmBookImportBtn").disabled = true;
  pendingBookImportRows = [];
  return { imported, updated, skipped, duplicateCount, importBatchId };
}

function collectBookMetadata() {
  const title = $("#bnameInput").value.trim();
  const placePublisher = $("#publisherInput").value.trim();
  return {
    accessionNumber: normalizeAccession($("#accessionNumberInput").value),
    accessionDate: $("#accessionDateInput").value.trim(),
    title,
    bname: title,
    author: $("#authorInput").value.trim(),
    placePublisher,
    publisher: placePublisher,
    year: $("#yearInput").value.trim(),
    pages: $("#pagesInput").value.trim(),
    volume: $("#volumeInput").value.trim(),
    source: $("#sourceInput").value.trim(),
    billNoDate: $("#billNoDateInput").value.trim(),
    cost: $("#costInput").value.trim(),
    classNo: $("#classNoInput").value.trim(),
    bookNo: $("#bookNoInput").value.trim(),
    withdrawalRemarks: $("#withdrawalRemarksInput").value.trim(),
    subject: $("#subjectInput").value.trim(),
    category: $("#category").value,
    publisherBarcode: $("#publisherBarcodeInput").value.trim(),
    isbn: ($("#isbnInput").value || $("#publisherBarcodeInput").value).trim(),
    imageUrl: $("#imageUrlInput").value.trim(),
    notes: $("#notesInput").value.trim(),
    updatedAt: serverTimestamp()
  };
}

function metadataDocId(code) {
  return cleanBookMetadataCode(code).toUpperCase();
}

function titleKeywords(title = "") {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3)
    .slice(0, 12);
}

function normalizeLocalMetadata(data = {}, cleanCode = "") {
  const title = data.bname || data.title || "";
  const isbn = data.isbn || data.isbn13 || data.isbn10 || cleanCode;
  return {
    title,
    authors: data.author || data.authors || "",
    publisher: data.publisher || "",
    subject: data.subject || "",
    category: data.category || inferCategory(title),
    imageUrl: data.imageUrl || "",
    isbn,
    isbn13: String(isbn).length === 13 ? isbn : "",
    isbn10: String(isbn).length === 10 ? isbn : "",
    source: "Local Metadata Database",
    metadataSource: "local",
    raw: data
  };
}

async function saveBookMetadataForFuture(source = "manual") {
  const cleanCode = metadataDocId($("#isbnInput").value || $("#publisherBarcodeInput").value);
  if (!cleanCode) throw new Error("Enter publisher ISBN/barcode before saving metadata.");
  const metadata = collectBookMetadata();
  if (!metadata.bname) throw new Error("Book Name is required before saving metadata.");
  const payload = {
    isbn: metadata.isbn || cleanCode,
    publisherBarcode: metadata.publisherBarcode || cleanCode,
    bname: metadata.bname,
    author: metadata.author || "",
    publisher: metadata.publisher || "",
    subject: metadata.subject || "General",
    category: metadata.category || inferCategory(metadata.bname),
    imageUrl: metadata.imageUrl || "",
    source,
    bnameKeywords: titleKeywords(metadata.bname),
    updatedAt: serverTimestamp()
  };
  const ref = doc(db, "bookMetadata", cleanCode);
  const existing = await getDoc(ref);
  await setDoc(ref, {
    ...payload,
    createdAt: existing.exists() ? existing.data().createdAt || serverTimestamp() : serverTimestamp()
  }, { merge: true });
  return payload;
}

function localBookForRequest(request = {}) {
  const bookDocId = request.b_id || request.bookId;
  return latestBooks.find((item) => item.id === bookDocId || item.data.b_id === bookDocId)?.data || null;
}

function localBookForIssue(issue = {}) {
  const bookDocId = issue.b_id || issue.bookId;
  return latestBooks.find((item) => item.id === bookDocId || item.data.b_id === bookDocId)?.data || null;
}

async function resolveIssueStudent(issue = {}) {
  if (issue.studentName) return {
    name: issue.studentName,
    email: issue.studentEmail || ""
  };
  const book = localBookForIssue(issue);
  if (book?.issuedToName) return {
    name: book.issuedToName,
    email: book.issuedToEmail || ""
  };
  if (issue.studentUid) {
    const studentSnap = await getDoc(doc(db, "students", issue.studentUid));
    if (studentSnap.exists()) {
      const student = studentSnap.data();
      return {
        name: student.name || "Unknown student",
        email: student.email || ""
      };
    }
  }
  return { name: "Unknown student", email: "" };
}

async function approveRequest(requestId) {
  console.log("Selected requestId:", requestId);
  const requestRef = doc(db, "issueRequests", requestId);
  const precheckSnap = await getDoc(requestRef);
  if (!precheckSnap.exists()) {
    throw new Error("Issue request not found.");
  }
  const precheckData = precheckSnap.data();
  if (precheckData.status !== "pending") {
    throw new Error("This request was already processed.");
  }
  const penaltySummary = await getUnpaidPenaltySummary(precheckData.studentUid);
  if (penaltySummary.hasUnpaid) {
    const error = new Error(`Cannot approve. Student has pending penalty of Rs.${penaltySummary.totalPendingPenalty.toFixed(2)}.`);
    error.code = "penalty/unpaid";
    error.totalPendingPenalty = penaltySummary.totalPendingPenalty;
    throw error;
  }

  let notificationPayload = null;
  const transactionResult = await runTransaction(db, async (transaction) => {
    const requestSnap = await transaction.get(requestRef);
    if (!requestSnap.exists()) {
      throw new Error("Issue request not found.");
    }

    const requestData = requestSnap.data();
    console.log("Issue request data:", requestData);
    console.log("Book ID fields:", {
      b_id: requestData.b_id,
      bookId: requestData.bookId,
      bookBarcodeValue: requestData.bookBarcodeValue
    });

    if (requestData.status !== "pending") {
      throw new Error("This request was already processed.");
    }

    const bookDocId = requestData.b_id || requestData.bookId;
    if (!bookDocId) {
      throw new Error("Missing book id in issue request.");
    }

    const bookRef = doc(db, "books", bookDocId);
    const studentRef = doc(db, "students", requestData.studentUid);
    const [bookSnap, studentSnap] = await Promise.all([
      transaction.get(bookRef),
      transaction.get(studentRef)
    ]);
    if (!bookSnap.exists()) {
      throw new Error(`Book ${bookDocId} not found.`);
    }

    const bookData = bookSnap.data();
    if (bookData.status !== "available") {
      const requestUpdate = {
        status: "rejected",
        reviewedBy: auth.currentUser.uid,
        reviewedAt: serverTimestamp(),
        rejectionReason: "Book already issued or unavailable."
      };
      console.log("Rejecting unavailable book request:", { requestId, requestUpdate });
      transaction.update(requestRef, requestUpdate);
      return { conflict: true };
    }

    const issueRef = doc(collection(db, "bookIssues"));
    const issueId = issueRef.id;
    const studentData = studentSnap.exists() ? studentSnap.data() : {};
    const studentName = requestData.studentName || studentData.name || "Unknown student";
    const studentEmail = requestData.studentEmail || studentData.email || "";
    const studentPhone = requestData.studentPhone || studentData.phone || "";
    const issuePayload = {
      issueId,
      requestId,
      studentUid: requestData.studentUid,
      studentName,
      studentEmail,
      studentPhone,
      b_id: bookDocId,
      bookId: bookDocId,
      accessionNumber: requestData.accessionNumber || accessionNumberOf(bookData),
      author: requestData.author || bookData.author || "",
      title: requestData.title || requestData.bookTitle || bookTitle(bookData),
      placePublisher: requestData.placePublisher || bookData.placePublisher || bookData.publisher || "",
      year: requestData.year || bookData.year || "",
      pages: requestData.pages || bookData.pages || "",
      volume: requestData.volume || bookData.volume || "",
      imageUrl: requestData.imageUrl || requestData.bookImage || bookData.imageUrl || "",
      barcodeValue: requestData.barcodeValue || requestData.bookBarcodeValue || bookData.barcodeValue || "",
      bookBarcodeValue: requestData.barcodeValue || requestData.bookBarcodeValue || bookData.barcodeValue || "",
      bookTitle: requestData.title || requestData.bookTitle || requestData.bname || bookTitle(bookData),
      subject: requestData.subject || bookData.subject || "",
      category: requestData.category || bookData.category || "",
      issueDate: requestData.issueDate,
      dueDate: requestData.dueDate,
      returnDate: null,
      status: "issued",
      penaltyPerDay: 5,
      penaltyAmount: 0,
      reminder15Sent: false,
      reminder30Sent: false,
      reminder45Sent: false,
      reminder15DaysLeftSent: false,
      reminder7DaysLeftSent: false,
      reminder3DaysLeftSent: false,
      reminder1DayLeftSent: false,
      overdueReminderSent: false,
      approvedBy: auth.currentUser.uid,
      approvedAt: serverTimestamp(),
      createdAt: serverTimestamp()
    };
    const bookUpdate = {
      status: "issued",
      issuedStudentUid: requestData.studentUid,
      issuedTo: requestData.studentUid,
      issuedToName: studentName,
      issuedToEmail: studentEmail,
      currentIssueId: issueId,
      updatedAt: serverTimestamp()
    };
    const requestUpdate = {
      status: "approved",
      reviewedBy: auth.currentUser.uid,
      reviewedAt: serverTimestamp(),
      issueId
    };

    console.log("Creating bookIssues payload:", issuePayload);
    transaction.set(issueRef, issuePayload);
    console.log("Updating book document:", { bookDocId, bookUpdate });
    transaction.update(bookRef, bookUpdate);
    console.log("Updating issue request:", { requestId, requestUpdate });
    transaction.update(requestRef, requestUpdate);
    notificationPayload = {
      studentUid: requestData.studentUid,
      studentName,
      studentEmail,
      bookTitle: issuePayload.bookTitle,
      issueDate: requestData.issueDate,
      dueDate: requestData.dueDate
    };
    return { conflict: false };
  });

  if (transactionResult?.conflict) {
    return { conflict: true };
  }

  if (notificationPayload?.studentUid) {
    const studentSnap = await getDoc(doc(db, "students", notificationPayload.studentUid));
    const student = studentSnap.exists() ? studentSnap.data() : {};
    notificationPayload.studentEmail = notificationPayload.studentEmail || student.email || "";
    notificationPayload.studentName = notificationPayload.studentName || student.name || "Student";
  }

  return { conflict: false, notificationPayload };
}

async function rejectRequest(requestId) {
  console.log("Selected requestId:", requestId);
  let rejectedRequest = null;
  await runTransaction(db, async (transaction) => {
    const requestRef = doc(db, "issueRequests", requestId);
    const requestSnap = await transaction.get(requestRef);
    if (!requestSnap.exists()) {
      throw new Error("Issue request not found.");
    }

    const requestData = requestSnap.data();
    rejectedRequest = requestData;
    console.log("Issue request data:", requestData);
    console.log("Book ID fields:", {
      b_id: requestData.b_id,
      bookId: requestData.bookId,
      bookBarcodeValue: requestData.bookBarcodeValue
    });

    if (requestData.status !== "pending") {
      throw new Error("This request was already processed.");
    }

    const requestUpdate = {
      status: "rejected",
      reviewedBy: auth.currentUser.uid,
      reviewedAt: serverTimestamp()
    };
    console.log("Updating issue request:", { requestId, requestUpdate });
    transaction.update(requestRef, requestUpdate);
  });
  return rejectedRequest;
}

function setNextBookId(lastId = 0) {
  nextBookId = String(Number(lastId || 0) + 1);
  if (!editingBookId) {
    $("#autoBId").value = nextBookId;
    const accessionNumber = $("#accessionNumberInput")?.value.trim() || "";
    renderBarcode(barcodeValueFor(accessionNumber, nextBookId), accessionNumber);
  }
}

onSnapshot(doc(db, "counters", "books"), (snap) => {
  setNextBookId(snap.exists() ? snap.data().lastId : 0);
});

function renderBarcode(value, accessionNumber = $("#accessionNumberInput")?.value.trim() || "") {
  $("#stickerBId").textContent = `Accession No: ${accessionNumber || "-"}`;
  $("#stickerBookTitle").textContent = `Title: ${$("#bnameInput")?.value.trim() || "-"}`;
  $("#stickerBarcodeValue").textContent = value || "ACC-";
  const barcodeValueInput = document.getElementById("libraryBarcodeValueInput");
  if (barcodeValueInput) barcodeValueInput.value = value || "";
  if (!value || !window.JsBarcode) return;
  window.JsBarcode("#libraryBarcodeSvg", value, {
    format: "CODE128",
    width: 2,
    height: 72,
    displayValue: true,
    margin: 8
  });
  latestBarcodeDataUrl = "";
}

function svgToPngDataUrl() {
  return new Promise((resolve, reject) => {
    const svg = $("#libraryBarcodeSvg");
    const xml = new XMLSerializer().serializeToString(svg);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(360, image.width || 360);
      canvas.height = Math.max(130, image.height || 130);
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = reject;
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  });
}

async function ensureBarcodeDataUrl() {
  if (!latestBarcodeDataUrl) {
    latestBarcodeDataUrl = await svgToPngDataUrl();
  }
  return latestBarcodeDataUrl;
}

function cleanBookMetadataCode(rawCode) {
  return String(rawCode || "")
    .trim()
    .replace(/[-\s]/g, "")
    .replace(/[^A-Za-z0-9]/g, "");
}

function cleanGoogleBookCode(rawCode) {
  return cleanBookMetadataCode(rawCode);
}

function updateGoogleFetchDebug(details) {
  const debugBox = document.getElementById("googleFetchDebug");
  if (!debugBox) return;
  debugBox.hidden = !showBookDebug;
  if (!showBookDebug) return;
  const attempts = details.attempts || [details];
  debugBox.innerHTML = `
    <strong>Online Metadata Debug</strong>
    <span>ISBN scanned: ${escapeHtml(details.cleanCode || "-")}</span>
    <span>Cleaned code: ${escapeHtml(details.cleanCode || "-")}</span>
    <span>Local metadata found: ${details.localMetadataFound ? "yes" : "no"}</span>
    <span>Selected source: ${escapeHtml(details.selectedSource || "-")}</span>
    ${attempts.map((attempt) => `
      <span>Source tried: ${escapeHtml(attempt.source || "-")}</span>
      <span>API URL tried: ${escapeHtml(attempt.url || "-")}</span>
      <span>Response status: ${escapeHtml(attempt.status ?? "-")}</span>
      <span>Results found: ${escapeHtml(attempt.resultCount ?? "-")}</span>
      <span>Error: ${escapeHtml(attempt.error || "-")}</span>
    `).join("")}`;
}

function setMetadataSourceBadge(source) {
  const badge = document.getElementById("metadataSourceBadge");
  if (!badge) return;
  const labels = {
    google: "Fetched from Google Books",
    openlibrary: "Fetched from Open Library",
    loc: "Fetched from Library of Congress",
    indcat: "Fetched from INDCAT",
    local: "Fetched from Local Database"
  };
  badge.textContent = labels[source] || "";
  badge.hidden = !source;
}

function inferCategory(title = "") {
  const normalized = title.toLowerCase();
  if (normalized.includes("pyq")) return "pyq";
  if (normalized.includes("question") || normalized.includes("question bank") || normalized.includes("qna")) return "qna";
  return "textbook";
}

function inferSubject(title = "") {
  const normalized = title.toLowerCase();
  const subjects = [
    "Machine Design",
    "Operations Research",
    "Thermodynamics",
    "Engineering Drawing"
  ];
  return subjects.find((subject) => normalized.includes(subject.toLowerCase())) || "General";
}

function normalizeGoogleBook(info, cleanCode) {
  const identifiers = info.industryIdentifiers || [];
  const isbn13 = identifiers.find((item) => item.type === "ISBN_13")?.identifier || "";
  const isbn10 = identifiers.find((item) => item.type === "ISBN_10")?.identifier || "";
  return {
    title: info.title || "",
    authors: Array.isArray(info.authors) ? info.authors.join(", ") : "",
    publisher: info.publisher || "",
    subject: Array.isArray(info.categories) ? info.categories.join(", ") : "",
    category: inferCategory(info.title || ""),
    imageUrl: info.imageLinks?.thumbnail
      ? info.imageLinks.thumbnail.replace("http://", "https://")
      : "",
    isbn13,
    isbn10,
    isbn: isbn13 || isbn10 || cleanCode,
    source: "Google Books",
    metadataSource: "google",
    raw: info
  };
}

async function fetchOpenLibraryAuthorName(authorRef) {
  if (!authorRef?.key) return "";
  try {
    const response = await fetch(`https://openlibrary.org${authorRef.key}.json`, {
      method: "GET",
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) return "";
    const data = await response.json();
    return data.name || "";
  } catch {
    return "";
  }
}

async function normalizeOpenLibraryIsbn(data, cleanCode) {
  const authorNames = await Promise.all((data.authors || []).slice(0, 4).map(fetchOpenLibraryAuthorName));
  return {
    title: data.title || "",
    authors: authorNames.filter(Boolean).join(", "),
    publisher: Array.isArray(data.publishers) ? data.publishers.join(", ") : "",
    subject: Array.isArray(data.subjects) ? data.subjects.slice(0, 3).join(", ") : "",
    category: inferCategory(data.title || ""),
    imageUrl: data.covers?.[0] ? `https://covers.openlibrary.org/b/id/${data.covers[0]}-M.jpg` : "",
    isbn13: Array.isArray(data.isbn_13) ? data.isbn_13[0] : "",
    isbn10: Array.isArray(data.isbn_10) ? data.isbn_10[0] : "",
    isbn: (Array.isArray(data.isbn_13) && data.isbn_13[0]) || (Array.isArray(data.isbn_10) && data.isbn_10[0]) || cleanCode,
    source: "Open Library ISBN",
    metadataSource: "openlibrary",
    raw: data
  };
}

function normalizeOpenLibrarySearch(doc, cleanCode) {
  return {
    title: doc.title || "",
    authors: Array.isArray(doc.author_name) ? doc.author_name.join(", ") : "",
    publisher: Array.isArray(doc.publisher) ? doc.publisher[0] || "" : "",
    subject: Array.isArray(doc.subject) ? doc.subject.slice(0, 3).join(", ") : "",
    category: inferCategory(doc.title || ""),
    imageUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : "",
    isbn13: Array.isArray(doc.isbn) ? doc.isbn.find((item) => String(item).length === 13) || "" : "",
    isbn10: Array.isArray(doc.isbn) ? doc.isbn.find((item) => String(item).length === 10) || "" : "",
    isbn: cleanCode,
    source: "Open Library Search",
    metadataSource: "openlibrary",
    raw: doc
  };
}

function normalizeLibraryOfCongress(result, cleanCode) {
  const title = result.title || "";
  return {
    title,
    authors: Array.isArray(result.contributor)
      ? result.contributor.join(", ")
      : Array.isArray(result.item?.contributors)
        ? result.item.contributors.join(", ")
        : "",
    publisher: Array.isArray(result.publisher) ? result.publisher.join(", ") : "",
    subject: Array.isArray(result.subject) ? result.subject.slice(0, 3).join(", ") : "",
    category: inferCategory(title),
    imageUrl: Array.isArray(result.image_url) ? result.image_url[0] || "" : "",
    isbn13: /^\d{13}$/.test(cleanCode) ? cleanCode : "",
    isbn10: /^\d{10}$/.test(cleanCode) ? cleanCode : "",
    isbn: cleanCode,
    source: "Library of Congress",
    metadataSource: "loc",
    raw: result
  };
}

function normalizeIndcat(data, cleanCode) {
  const title = data.title || data.bookTitle || data.name || "";
  const authors = Array.isArray(data.authors)
    ? data.authors.join(", ")
    : data.authors || data.author || "";
  const publisher = Array.isArray(data.publisher)
    ? data.publisher.join(", ")
    : data.publisher || "";
  const subject = Array.isArray(data.subject)
    ? data.subject.slice(0, 3).join(", ")
    : data.subject || data.category || "";
  const isbn = data.isbn || data.isbn13 || data.isbn10 || cleanCode;
  return {
    title,
    authors,
    publisher,
    subject,
    category: inferCategory(title),
    imageUrl: data.imageUrl || data.image || "",
    isbn13: String(isbn).length === 13 ? isbn : "",
    isbn10: String(isbn).length === 10 ? isbn : "",
    isbn,
    source: "INDCAT",
    metadataSource: "indcat",
    raw: data
  };
}

function indcatFallback(cleanCode) {
  return {
    source: "INDCAT",
    found: false,
    fallbackUrl: `https://indcat.inflibnet.ac.in/index.php/search/book?search=${encodeURIComponent(cleanCode)}`,
    message: "INDCAT does not expose a public JSON API in this setup. Open search manually."
  };
}

async function findLocalMetadata(cleanCode) {
  if (!cleanCode) return null;
  const docSnap = await getDoc(doc(db, "bookMetadata", metadataDocId(cleanCode)));
  if (docSnap.exists()) return normalizeLocalMetadata(docSnap.data(), cleanCode);

  const isbnSnap = await getDocs(query(collection(db, "bookMetadata"), where("isbn", "==", cleanCode), limit(1)));
  if (!isbnSnap.empty) return normalizeLocalMetadata(isbnSnap.docs[0].data(), cleanCode);

  const barcodeSnap = await getDocs(query(collection(db, "bookMetadata"), where("publisherBarcode", "==", cleanCode), limit(1)));
  if (!barcodeSnap.empty) return normalizeLocalMetadata(barcodeSnap.docs[0].data(), cleanCode);

  return null;
}

async function findLocalMetadataByTitle(title) {
  const keywords = titleKeywords(title);
  if (!keywords.length) return null;
  const snap = await getDocs(query(collection(db, "bookMetadata"), where("bnameKeywords", "array-contains", keywords[0]), limit(10)));
  const normalizedTitle = String(title || "").toLowerCase();
  const found = snap.docs.find((item) => {
    const name = String(item.data().bname || "").toLowerCase();
    return keywords.some((word) => name.includes(word)) || normalizedTitle.includes(name);
  }) || snap.docs[0];
  return found ? normalizeLocalMetadata(found.data(), found.id) : null;
}

async function lookupBookMetadata(rawCode) {
  const cleanCode = cleanBookMetadataCode(rawCode);
  const typedTitle = $("#bnameInput")?.value?.trim() || "";
  console.log("lookupBookMetadata diagnostics:", { rawCode, cleanCode, typedTitle });

  if (!cleanCode && !typedTitle) {
    throw new Error("Enter or scan ISBN/publisher barcode first.");
  }

  const attempts = [];
  const lookups = [
    {
      source: "Local Metadata Database",
      url: cleanCode ? `bookMetadata/${metadataDocId(cleanCode)} or isbn/publisherBarcode == ${cleanCode}` : `bookMetadata title keywords for ${typedTitle}`,
      getResult: async () => cleanCode ? findLocalMetadata(cleanCode) : findLocalMetadataByTitle(typedTitle)
    },
    {
      source: "Local Database",
      url: `Firestore books where publisherBarcode/isbn == ${cleanCode}`,
      getResult: async () => {
        const localMatches = latestBooks.find(({ data }) =>
          data.publisherBarcode === cleanCode
          || data.isbn === cleanCode
        );
        return localMatches ? {
          title: localMatches.data.bname || "",
          authors: localMatches.data.author || "",
          publisher: localMatches.data.publisher || "",
          subject: localMatches.data.subject || "",
          category: localMatches.data.category || inferCategory(localMatches.data.bname || ""),
          imageUrl: localMatches.data.imageUrl || "",
          isbn: localMatches.data.isbn || cleanCode,
          isbn13: String(localMatches.data.isbn || cleanCode).length === 13 ? localMatches.data.isbn || cleanCode : "",
          isbn10: String(localMatches.data.isbn || cleanCode).length === 10 ? localMatches.data.isbn || cleanCode : "",
          source: "Local Database",
          metadataSource: "local",
          raw: localMatches.data
        } : null;
      }
    },
    {
      source: "Google Books ISBN",
      url: `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(cleanCode)}`,
      getCount: (data) => data.items?.length || 0,
      getResult: (data) => data.items?.[0]?.volumeInfo ? normalizeGoogleBook(data.items[0].volumeInfo, cleanCode) : null
    },
    {
      source: "Google Books General",
      url: `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(cleanCode)}`,
      getCount: (data) => data.items?.length || 0,
      getResult: (data) => data.items?.[0]?.volumeInfo ? normalizeGoogleBook(data.items[0].volumeInfo, cleanCode) : null
    },
    {
      source: "Open Library ISBN",
      url: `https://openlibrary.org/isbn/${encodeURIComponent(cleanCode)}.json`,
      getCount: (data) => data.title ? 1 : 0,
      getResult: async (data) => data.title ? normalizeOpenLibraryIsbn(data, cleanCode) : null
    },
    {
      source: "Open Library Search",
      url: `https://openlibrary.org/search.json?isbn=${encodeURIComponent(cleanCode)}`,
      getCount: (data) => data.docs?.length || 0,
      getResult: (data) => data.docs?.[0] ? normalizeOpenLibrarySearch(data.docs[0], cleanCode) : null
    },
    {
      source: "Library of Congress",
      url: `https://www.loc.gov/books/?fo=json&q=${encodeURIComponent(cleanCode)}`,
      getCount: (data) => data.results?.filter((item) => item.title).length || 0,
      getResult: (data) => {
        const result = data.results?.find((item) => item.title);
        return result ? normalizeLibraryOfCongress(result, cleanCode) : null;
      }
    },
    {
      source: "INDCAT",
      url: INDCAT_CONFIG.enabled && INDCAT_CONFIG.apiUrl
        ? `${INDCAT_CONFIG.apiUrl}?isbn=${encodeURIComponent(cleanCode)}`
        : indcatFallback(cleanCode).fallbackUrl,
      getCount: (data) => data && (data.title || data.bookTitle || data.name) ? 1 : 0,
      getResult: (data) => data ? normalizeIndcat(data, cleanCode) : null,
      fallback: !INDCAT_CONFIG.enabled || !INDCAT_CONFIG.apiUrl
    }
  ];

  for (const lookup of lookups) {
    if (lookup.source === "Local Metadata Database") {
      const localMetadata = await lookup.getResult();
      attempts.push({
        source: lookup.source,
        url: lookup.url,
        status: "local",
        resultCount: localMetadata ? 1 : 0,
        error: ""
      });
      updateGoogleFetchDebug({
        cleanCode,
        attempts,
        localMetadataFound: Boolean(localMetadata),
        selectedSource: localMetadata ? "Local Metadata Database" : ""
      });
      if (localMetadata) return localMetadata;
      if (!cleanCode) return { found: false, indcatFallback: null, attempts };
      continue;
    }

    if (lookup.source === "Local Database") {
      const localResult = await lookup.getResult();
      attempts.push({
        source: lookup.source,
        url: lookup.url,
        status: "local",
        resultCount: localResult ? 1 : 0,
        error: ""
      });
      updateGoogleFetchDebug({
        cleanCode,
        attempts,
        localMetadataFound: false,
        selectedSource: localResult ? "Local Firestore" : ""
      });
      if (localResult) return localResult;
      continue;
    }

    if (lookup.fallback) {
      const fallback = indcatFallback(cleanCode);
      attempts.push({
        source: lookup.source,
        url: fallback.fallbackUrl,
        status: "fallback",
        resultCount: 0,
        error: fallback.message
      });
      updateGoogleFetchDebug({ cleanCode, attempts });
      continue;
    }

    if (lookup.source === "Library of Congress") {
      console.log("Trying Library of Congress:", lookup.url);
    }
    console.log("Trying metadata URL:", lookup.url);

    try {
      const response = await fetch(lookup.url, {
        method: "GET",
        headers: {
          "Accept": "application/json"
        }
      });

      console.log("Metadata response status:", response.status);

      if (!response.ok) {
        const text = await response.text();
        if (response.status !== 429) {
          console.error("Metadata API error response:", text);
        }
        attempts.push({
          source: lookup.source,
          url: lookup.url,
          status: response.status,
          resultCount: 0,
          error: response.status === 429 ? "Quota exceeded; continuing to next source." : text
        });
        updateGoogleFetchDebug({ cleanCode, attempts });
        continue;
      }

      let data;
      try {
        data = await response.json();
      } catch (parseError) {
        console.error(`${lookup.source} JSON parse failed:`, parseError);
        attempts.push({
          source: lookup.source,
          url: lookup.url,
          status: response.status,
          resultCount: 0,
          error: `JSON parse failed: ${parseError.message}`
        });
        updateGoogleFetchDebug({ cleanCode, attempts });
        continue;
      }
      if (lookup.source === "Library of Congress") {
        console.log("LOC result:", data);
      } else {
        console.log("Metadata data:", data);
      }
      const resultCount = lookup.getCount(data);
      attempts.push({
        source: lookup.source,
        url: lookup.url,
        status: response.status,
        resultCount,
        error: ""
      });
      updateGoogleFetchDebug({ cleanCode, attempts });

      if (resultCount > 0) {
        const result = await lookup.getResult(data);
        if (result && (result.title || result.publisher || result.authors || result.subject)) {
          updateGoogleFetchDebug({ cleanCode, attempts, selectedSource: result.source });
          return result;
        }
      }
    } catch (error) {
      console.error(`${lookup.source} lookup failed:`, error);
      attempts.push({
        source: lookup.source,
        url: lookup.url,
        status: "error",
        resultCount: 0,
        error: error.message
      });
      updateGoogleFetchDebug({ cleanCode, attempts });
    }
  }

  return { found: false, indcatFallback: indcatFallback(cleanCode), attempts };
}

async function fetchGoogleBookDetails(rawCode) {
  return lookupBookMetadata(rawCode);
}

async function fetchGoogleBook(event) {
  event?.preventDefault();
  const barcodeInput = document.getElementById("publisherBarcodeInput");
  const cleanCode = cleanGoogleBookCode(barcodeInput?.value);

  try {
    const info = await fetchGoogleBookDetails(barcodeInput?.value);
    if (!info || info.found === false) {
      const isbnEl = document.getElementById("isbnInput");
      if (isbnEl) isbnEl.value = cleanCode;
      if (barcodeInput) barcodeInput.value = cleanCode;
      $("#bookFetchPreview").innerHTML = `
        <div class="empty">
          <span>Online metadata not found. Enter details once and this system will remember it.</span>
        </div>`;
      showToast("No online metadata found. Please enter details once. Future scans will auto-fill from local database.", "warning");
      return;
    }

    const bnameEl = document.getElementById("bnameInput");
    const subjectEl = document.getElementById("subjectInput");
    const authorEl = document.getElementById("authorInput");
    const publisherEl = document.getElementById("publisherInput");
    const isbnEl = document.getElementById("isbnInput");
    const imageUrlEl = document.getElementById("imageUrlInput");
    const publisherBarcodeEl = document.getElementById("publisherBarcodeInput");
    const metadataSourceEl = document.getElementById("metadataSourceInput");

    if (bnameEl && info.title) bnameEl.value = info.title;
    if (subjectEl) subjectEl.value = info.subject || info.category || inferSubject(info.title) || "General";
    $("#category").value = info.category || inferCategory(info.title);
    if (authorEl) authorEl.value = info.authors;
    if (publisherEl) publisherEl.value = info.publisher;
    if (isbnEl) isbnEl.value = info.isbn || info.isbn13 || info.isbn10 || cleanCode;
    if (imageUrlEl) imageUrlEl.value = info.imageUrl;
    if (publisherBarcodeEl) publisherBarcodeEl.value = cleanCode;
    if (metadataSourceEl) metadataSourceEl.value = info.metadataSource || "";
    setMetadataSourceBadge(info.metadataSource);

    $("#bookFetchPreview").innerHTML = `
      <article class="book-preview">
        <img src="${escapeHtml(info.imageUrl || "assets/book-placeholder.svg")}" alt="">
        <div>
          <strong>${escapeHtml(info.title || "Untitled book")}</strong>
          <span>${escapeHtml(info.authors || "Unknown author")}</span>
          <span>${escapeHtml(info.publisher || "Publisher not found")}</span>
          <span>${escapeHtml(info.source || "Online metadata")}</span>
        </div>
      </article>`;
    const successMessage = info.metadataSource === "local"
      ? "Book details filled from local library database."
      : `Book details fetched from ${info.source}.`;
    showToast(successMessage, "success");
  } catch (error) {
    console.error("Online metadata fetch failed:", error);
    updateGoogleFetchDebug({
      cleanCode,
      url: "-",
      status: "-",
      resultCount: "-",
      error: error.message
    });
    showToast("Online metadata lookup failed. Please fill manually once. Future scans will use local database.", "warning");
  }
}

async function stopPublisherScanner() {
  window.clearInterval(publisherScanTimer);
  publisherScanTimer = null;
  if (publisherStream) {
    publisherStream.getTracks().forEach((track) => track.stop());
    publisherStream = null;
  }
  $("#publisherScannerVideo").hidden = true;
}

async function startPublisherScanner() {
  if (!("BarcodeDetector" in window)) {
    showToast("Camera barcode detection is not supported here. Enter the ISBN manually.", "error");
    return;
  }

  const video = $("#publisherScannerVideo");
  const detector = new BarcodeDetector({ formats: ["code_128", "code_39", "ean_13", "ean_8", "qr_code"] });
  publisherStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  video.srcObject = publisherStream;
  video.hidden = false;
  publisherScanTimer = window.setInterval(async () => {
    const codes = await detector.detect(video);
    if (!codes.length) return;
    $("#publisherBarcodeInput").value = codes[0].rawValue;
    await stopPublisherScanner();
    showToast("Publisher barcode scanned.", "success");
  }, 750);
}

async function stopQuickReturnScanner() {
  window.clearInterval(quickReturnScanTimer);
  quickReturnScanTimer = null;
  if (quickReturnStream) {
    quickReturnStream.getTracks().forEach((track) => track.stop());
    quickReturnStream = null;
  }
  $("#quickReturnScannerVideo").hidden = true;
  $("#startQuickReturnScannerBtn").hidden = false;
  $("#stopQuickReturnScannerBtn").hidden = true;
}

async function startQuickReturnScanner() {
  if (!("BarcodeDetector" in window)) {
    showToast("Camera barcode detection is not supported here. Enter BOOK-1 manually.", "error");
    return;
  }

  const video = $("#quickReturnScannerVideo");
  const detector = new BarcodeDetector({ formats: ["code_128", "code_39", "ean_13", "ean_8", "qr_code"] });
  quickReturnStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  video.srcObject = quickReturnStream;
  video.hidden = false;
  $("#startQuickReturnScannerBtn").hidden = true;
  $("#stopQuickReturnScannerBtn").hidden = false;
  quickReturnScanTimer = window.setInterval(async () => {
    const codes = await detector.detect(video);
    if (!codes.length) return;
    const scannedValue = String(codes[0].rawValue || "").trim().replace(/\s+/g, "");
    console.log("Quick return scanned barcode:", scannedValue);
    $("#quickReturnBookId").value = scannedValue;
    await stopQuickReturnScanner();
    showToast("Library barcode scanned for return.", "success");
  }, 750);
}

async function saveBook(event) {
  event.preventDefault();
  setLoading(addBookForm, true);
  try {
    const metadataUpdate = collectBookMetadata();
    const totalCopies = editingBookId ? 1 : numberValue($("#totalCopiesInput").value, 1);

    if (!metadataUpdate.accessionNumber) throw new Error("Accession Number is required.");
    if (!metadataUpdate.title) throw new Error("Title is required.");

    const requestedAccessions = accessionValuesForCopies(metadataUpdate.accessionNumber, totalCopies);
    const duplicate = latestBooks.find((item) => {
      if (editingBookId && item.id === editingBookId) return false;
      return requestedAccessions.some((accession) => accessionNumberOf(item.data).toLowerCase() === accession.toLowerCase());
    });
    if (duplicate) {
      throw new Error(`Accession Number already exists: ${accessionNumberOf(duplicate.data)}`);
    }
    renderBarcode(barcodeValueFor(metadataUpdate.accessionNumber, editingBookId || nextBookId), metadataUpdate.accessionNumber);

    if (editingBookId) {
      console.log("Saving existing book metadata only:", editingBookId);
      const currentSnap = await getDoc(doc(db, "books", editingBookId));
      if (!currentSnap.exists()) {
        throw new Error("Book record not found.");
      }
      const currentBook = currentSnap.data();
      console.log("Preserving status:", currentBook.status);
      if (currentBook.status !== "available") {
        showToast("Book is currently issued/lost/damaged. Only metadata will be updated. Availability will not change.", "warning");
      }
      await updateDoc(doc(db, "books", editingBookId), {
        ...metadataUpdate,
        barcodeValue: barcodeValueFor(metadataUpdate.accessionNumber, currentBook.b_id || editingBookId)
      });
      showToast("Book details saved. Availability was not changed.", "success");
    } else {
      const createdBooks = await runTransaction(db, async (transaction) => {
        const counterRef = doc(db, "counters", "books");
        const counterSnap = await transaction.get(counterRef);
        const lastId = counterSnap.exists() ? Number(counterSnap.data().lastId || 0) : 0;
        const created = requestedAccessions.map((accessionNumber, index) => {
          const bId = String(lastId + index + 1);
          const bookRef = doc(db, "books", bId);
          transaction.set(bookRef, {
            ...metadataUpdate,
            accessionNumber,
            b_id: bId,
            metadataSource: $("#metadataSourceInput").value.trim(),
            barcodeValue: barcodeValueFor(accessionNumber, bId),
            barcodeDataUrl: "",
            status: "available",
            issuedStudentUid: null,
            issuedTo: null,
            issuedToName: null,
            issuedToEmail: null,
            currentIssueId: null,
            barcodePrinted: false,
            barcodePrintedAt: null,
            barcodePrintedBy: null,
            barcodePrintBatchId: null,
            createdBy: session.user.uid,
            createdAt: serverTimestamp()
          });
          return { bId, accessionNumber };
        });
        transaction.set(counterRef, { lastId: lastId + created.length }, { merge: true });
        return created;
      });
      const firstCreated = createdBooks[0];
      renderBarcode(barcodeValueFor(firstCreated.accessionNumber, firstCreated.bId), firstCreated.accessionNumber);
      await updateDoc(doc(db, "books", firstCreated.bId), {
        barcodeDataUrl: await ensureBarcodeDataUrl(),
        updatedAt: serverTimestamp()
      });
      showToast(`${createdBooks.length} book record${createdBooks.length === 1 ? "" : "s"} saved successfully.`, "success");
    }

    try {
      await saveBookMetadataForFuture($("#metadataSourceInput").value.trim() || "manual");
    } catch (metadataError) {
      console.error("Saving reusable book metadata failed:", metadataError);
      showToast("Book saved, but reusable metadata could not be saved.", "warning");
    }

    editingBookId = null;
    editingExistingBook = null;
    addBookForm.reset();
    $("#category").value = "pyq";
    $("#totalCopiesInput").value = "1";
    $("#totalCopiesInput").disabled = false;
    $("#saveBookBtn").textContent = "Save Book";
    $("#bookSaveModeHelp").textContent = "Availability is controlled only by issue, return, lost, and found actions.";
    $("#bookFetchPreview").innerHTML = `<div class="empty">Fetch details or fill the book manually.</div>`;
    $("#metadataSourceInput").value = "";
    setMetadataSourceBadge("");
    latestBarcodeDataUrl = "";
    const counterSnap = await getDoc(doc(db, "counters", "books"));
    setNextBookId(counterSnap.exists() ? counterSnap.data().lastId : 0);
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  } finally {
    setLoading(addBookForm, false);
  }
}

function renderBooksTable() {
  const search = bookSearch.value.trim().toLowerCase();
  const categoryFilter = String(bookCategoryFilter?.value || "").toLowerCase();
  const availabilityFilter = String(bookAvailabilityFilter?.value || "").toLowerCase();
  const rows = latestBooks.filter(({ data }) => {
    const status = String(data.status || "available").toLowerCase();
    const category = String(data.category || "").toLowerCase();
    const haystack = [
      accessionNumberOf(data),
      bookTitle(data),
      data.author,
      data.placePublisher,
      data.publisher,
      data.year,
      data.classNo,
      data.bookNo,
      data.subject,
      data.category,
      data.isbn,
      data.publisherBarcode
    ].join(" ").toLowerCase();
    if (search && !haystack.includes(search)) return false;
    if (categoryFilter && category !== categoryFilter) return false;
    if (availabilityFilter && status !== availabilityFilter) return false;
    return true;
  });
  const target = $("#booksTable");
  if (!rows.length) {
    renderEmpty(target, "No matching books found.");
    return;
  }

  target.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Accession Number</th>
          <th>Date</th>
          <th>Author</th>
          <th>Title</th>
          <th>Place &amp; Publisher</th>
          <th>Year</th>
          <th>Pages</th>
          <th>Vol.</th>
          <th>Source</th>
          <th>Bill No &amp; Date</th>
          <th>Cost</th>
          <th>Class No.</th>
          <th>Book No.</th>
          <th>Status</th>
          <th>Issued Student UID</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(({ id, data }) => `
          <tr data-book-id="${escapeHtml(id)}">
            <td>${escapeHtml(accessionNumberOf(data) || "-")}</td>
            <td>${escapeHtml(data.accessionDate || "-")}</td>
            <td>${escapeHtml(data.author || "-")}</td>
            <td><strong>${escapeHtml(bookTitle(data) || "-")}</strong></td>
            <td>${escapeHtml(data.placePublisher || data.publisher || "-")}</td>
            <td>${escapeHtml(data.year || "-")}</td>
            <td>${escapeHtml(data.pages || "-")}</td>
            <td>${escapeHtml(data.volume || "-")}</td>
            <td>${escapeHtml(data.source || "-")}</td>
            <td>${escapeHtml(data.billNoDate || "-")}</td>
            <td>${escapeHtml(data.cost || "-")}</td>
            <td>${escapeHtml(data.classNo || "-")}</td>
            <td>${escapeHtml(data.bookNo || "-")}</td>
            <td>${statusBadge(data.status)}</td>
            <td>${escapeHtml(data.status === "issued" ? (data.issuedStudentUid || data.issuedTo || "-") : "-")}</td>
            <td>
              <div class="row-actions">
                <button class="btn btn-muted" data-book-action="view">View</button>
                <button class="btn btn-muted" data-book-action="edit">Edit</button>
                <button class="btn btn-muted" data-book-action="print">Print Barcode</button>
                ${data.status === "lost"
                  ? `<button class="btn btn-primary" data-book-action="found">Mark Found</button>`
                  : `<button class="btn btn-muted" data-book-action="lost">Mark Lost</button>`}
                <button class="btn btn-muted" data-book-action="damaged">Mark Damaged</button>
              </div>
            </td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

function availabilityLabel(status = "") {
  const value = String(status || "available").toLowerCase();
  if (value === "available") return "Available";
  if (value === "issued") return "Not Available";
  if (value === "lost") return "Lost";
  if (value === "damaged") return "Damaged";
  return value || "Available";
}

function barcodeBookId(item) {
  return accessionNumberOf(item.data) || item.data.b_id || item.id;
}

function barcodeBookTitle(data = {}) {
  return bookTitle(data) || data.title || "Untitled book";
}

function shortBookName(name = "") {
  const value = String(name || "");
  return value.length > 28 ? `${value.slice(0, 25)}...` : value;
}

function selectedBarcodeIds() {
  return Array.from(document.querySelectorAll(".barcode-print-select:checked"))
    .map((input) => input.value);
}

function barcodeFilterValue(id) {
  return String(document.getElementById(id)?.value || "").trim().toLowerCase();
}

function filteredBarcodeBooks() {
  const printStatus = $("#barcodePrintStatusFilter")?.value || "notPrinted";
  const rangeFrom = barcodeFilterValue("barcodeRangeFrom");
  const rangeTo = barcodeFilterValue("barcodeRangeTo");
  const category = barcodeFilterValue("barcodeCategoryFilter");
  const importBatch = barcodeFilterValue("barcodeImportBatchFilter");
  const status = barcodeFilterValue("barcodeBookStatusFilter");

  return latestBooks.filter((item) => {
    const data = item.data;
    const accession = accessionNumberOf(data).toLowerCase();
    const printed = data.barcodePrinted === true;
    if (printStatus === "notPrinted" && printed) return false;
    if (printStatus === "printed" && !printed) return false;
    if (rangeFrom && accession.localeCompare(rangeFrom) < 0) return false;
    if (rangeTo && accession.localeCompare(rangeTo) > 0) return false;
    if (category && String(data.category || "").toLowerCase() !== category) return false;
    if (importBatch && String(data.importBatchId || "").toLowerCase() !== importBatch) return false;
    if (status && String(data.status || "").toLowerCase() !== status) return false;
    return true;
  });
}

function renderBarcodeSummary(count = selectedBarcodeIds().length) {
  const pages = Math.max(1, Math.ceil(count / 24));
  $("#barcodePrintSummary").innerHTML = `
    <div class="success-box">
      <strong>${count} barcode${count === 1 ? "" : "s"} selected</strong>
      <span>${count} barcode${count === 1 ? "" : "s"} will be generated on ${pages} page${pages === 1 ? "" : "s"}.</span>
    </div>`;
}

function renderBarcodePrintManager() {
  const rows = filteredBarcodeBooks();
  const target = $("#barcodePrintTable");
  if (!target) return;
  if (!rows.length) {
    renderEmpty(target, "No books match the barcode print filters.");
    renderBarcodeSummary(0);
    return;
  }

  target.innerHTML = `
    <table>
      <thead>
        <tr>
          <th><span class="sr-only">Select</span></th>
          <th>Accession Number</th>
          <th>Book Name</th>
          <th>Barcode Value</th>
          <th>Print Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((item) => {
          const data = item.data;
          const printed = data.barcodePrinted === true;
          const bid = barcodeBookId(item);
          return `
            <tr data-barcode-book-id="${escapeHtml(item.id)}">
              <td><input class="barcode-print-select" type="checkbox" value="${escapeHtml(item.id)}" ${printed ? "" : "checked"}></td>
              <td>${escapeHtml(bid)}</td>
              <td><strong>${escapeHtml(barcodeBookTitle(data))}</strong><span>${escapeHtml(data.category || "")}</span></td>
              <td>${escapeHtml(data.barcodeValue || barcodeValueFor(bid, data.b_id || item.id))}</td>
              <td>${printed ? `<span class="badge badge-issued">Printed</span>` : `<span class="badge badge-available">Not Printed</span>`}</td>
              <td>${printed ? `<button class="btn btn-muted reprint-barcode-btn" data-book-id="${escapeHtml(item.id)}" type="button">Reprint</button>` : ""}</td>
            </tr>`;
        }).join("")}
      </tbody>
    </table>`;
  renderBarcodeSummary(selectedBarcodeIds().length);
}

function barcodeImageDataUrl(value) {
  return new Promise((resolve, reject) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    window.JsBarcode(svg, value, {
      format: "CODE128",
      width: 1.6,
      height: 38,
      displayValue: false,
      margin: 0
    });
    const xml = new XMLSerializer().serializeToString(svg);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 90;
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 8, 8, canvas.width - 16, canvas.height - 16);
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = reject;
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  });
}

function timestampForFile() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

async function generateBarcodePdfForBooks(items, batchId) {
  if (!window.jspdf?.jsPDF) throw new Error("jsPDF is not loaded.");
  if (!window.JsBarcode) throw new Error("JsBarcode is not loaded.");
  console.log("Bulk barcode PDF diagnostics:", {
    selectedBooks: items.length,
    batchId,
    jsPDFLoaded: typeof window.jspdf,
    jsBarcodeLoaded: typeof JsBarcode
  });
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const stickerWidth = 63;
  const stickerHeight = 33;
  const marginX = 10.5;
  const marginY = 12;
  const gapX = 0;
  const gapY = 0;

  for (let index = 0; index < items.length; index += 1) {
    if (index > 0 && index % 24 === 0) pdf.addPage();
    const pageIndex = index % 24;
    const col = pageIndex % 3;
    const row = Math.floor(pageIndex / 3);
    const x = marginX + col * (stickerWidth + gapX);
    const y = marginY + row * (stickerHeight + gapY);
    const data = items[index].data;
    const accessionNumber = barcodeBookId(items[index]);
    const barcodeValue = data.barcodeValue || barcodeValueFor(accessionNumber, data.b_id || items[index].id);
    const barcodeImage = await barcodeImageDataUrl(barcodeValue);
    console.log("Barcode image generated:", { bookId: items[index].id, accessionNumber, barcodeValue });

    pdf.setDrawColor(210, 216, 224);
    pdf.roundedRect(x, y, stickerWidth - 1.5, stickerHeight - 1.5, 1.5, 1.5);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(7);
    pdf.text("Mohanlal Sukhadia University LMS", x + 3, y + 4.5);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(6);
    pdf.text(`Accession No: ${accessionNumber}`, x + 3, y + 8);
    pdf.text(`Title: ${shortBookName(barcodeBookTitle(data))}`, x + 3, y + 12);
    pdf.addImage(barcodeImage, "PNG", x + 5, y + 14.5, stickerWidth - 12, 11);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(7);
    pdf.text(barcodeValue, x + stickerWidth / 2, y + 30, { align: "center" });
  }

  const pdfFileName = `barcodes_batch_${timestampForFile()}.pdf`;
  pdf.save(pdfFileName);
  console.log("PDF generation succeeds:", { pdfFileName, totalBooks: items.length, batchId });
  return { pdfFileName, batchId };
}

async function writeBarcodePrintLog(book, action, batchId) {
  await addDoc(collection(db, "barcodePrintLogs"), {
    bookId: book.id,
    barcodeValue: book.data.barcodeValue || barcodeValueFor(barcodeBookId(book)),
    action,
    userId: auth.currentUser.uid,
    createdAt: serverTimestamp(),
    batchId
  });
}

async function markBarcodeBooksPrinted(items, batchId, pdfFileName, action = "printed") {
  await setDoc(doc(db, "barcodePrintBatches", batchId), {
    batchId,
    createdBy: auth.currentUser.uid,
    createdAt: serverTimestamp(),
    totalBooks: items.length,
    bookIds: items.map((item) => item.id),
    pdfFileName,
    status: "generated"
  });

  await Promise.all(items.map(async (item) => {
    const updatePayload = action === "printed" && item.data.barcodePrinted !== true
      ? {
          barcodePrinted: true,
          barcodePrintedAt: serverTimestamp(),
          barcodePrintedBy: auth.currentUser.uid,
          barcodePrintBatchId: batchId,
          updatedAt: serverTimestamp()
        }
      : {
          lastReprintedAt: serverTimestamp(),
          lastReprintedBy: auth.currentUser.uid,
          updatedAt: serverTimestamp()
        };
    await updateDoc(doc(db, "books", item.id), updatePayload);
    await writeBarcodePrintLog(item, action, batchId);
  }));
}

function selectedBarcodeBooks() {
  const ids = new Set(selectedBarcodeIds());
  return latestBooks.filter((item) => ids.has(item.id));
}

async function generateBulkBarcodePdf(markAfterGenerate = true, items = selectedBarcodeBooks(), action = "printed") {
  if (!items.length) {
    showToast("Select at least one book for barcode export.", "warning");
    return;
  }
  const batchId = `batch_${Date.now()}`;
  const { pdfFileName } = await generateBarcodePdfForBooks(items, batchId);
  if (markAfterGenerate) {
    const confirmed = await confirmAction(action === "reprinted" ? "Record this barcode reprint?" : "Mark these barcodes as printed?");
    if (confirmed) {
      await markBarcodeBooksPrinted(items, batchId, pdfFileName, action);
      showToast("Barcode batch generated and marked as printed.", "success");
    } else {
      showToast("Barcode PDF generated.", "success");
    }
  }
}

function exportBarcodeExcel() {
  if (!window.XLSX) throw new Error("XLSX export library is not loaded.");
  const rows = filteredBarcodeBooks().map((item) => {
    const data = item.data;
    return {
      "Accession Number": accessionNumberOf(data),
      Title: barcodeBookTitle(data),
      "Barcode Value": data.barcodeValue || barcodeValueFor(accessionNumberOf(data), data.b_id || item.id),
      "Barcode Printed": data.barcodePrinted === true ? "Yes" : "No",
      "Printed At": data.barcodePrintedAt ? formatDate(data.barcodePrintedAt) : "",
      "Printed By": data.barcodePrintedBy || "",
      Status: data.status || "",
      Category: data.category || ""
    };
  });
  const sheet = window.XLSX.utils.json_to_sheet(rows);
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, sheet, "Barcodes");
  console.log("Excel export diagnostics:", {
    xlsxLoaded: typeof XLSX,
    rows: rows.length,
    workbookGenerated: Boolean(workbook)
  });
  window.XLSX.writeFile(workbook, "barcode_export.xlsx");
  console.log("Excel download triggered:", "barcode_export.xlsx");
}

function exportBooksExcel() {
  if (!window.XLSX) throw new Error("XLSX export library is not loaded.");
  const search = bookSearch.value.trim().toLowerCase();
  const categoryFilter = String(bookCategoryFilter?.value || "").toLowerCase();
  const availabilityFilter = String(bookAvailabilityFilter?.value || "").toLowerCase();
  const rows = latestBooks
    .filter(({ data }) => {
      const status = String(data.status || "available").toLowerCase();
      const category = String(data.category || "").toLowerCase();
      const haystack = [
        accessionNumberOf(data),
        bookTitle(data),
        data.author,
        data.placePublisher,
        data.publisher,
        data.year,
        data.subject,
        data.category,
        data.isbn,
        data.publisherBarcode
      ].join(" ").toLowerCase();
      if (search && !haystack.includes(search)) return false;
      if (categoryFilter && category !== categoryFilter) return false;
      if (availabilityFilter && status !== availabilityFilter) return false;
      return true;
    })
    .map(({ id, data }) => accessionExportRow({
      ...data,
      accessionNumber: accessionNumberOf(data),
      title: bookTitle(data),
      barcodeValue: data.barcodeValue || barcodeValueFor(accessionNumberOf(data), data.b_id || id)
    }, formatDate));
  const sheet = window.XLSX.utils.json_to_sheet(rows);
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, sheet, "Register Data");
  console.log("Books Excel export diagnostics:", {
    xlsxLoaded: typeof XLSX,
    rows: rows.length,
    workbookGenerated: Boolean(workbook)
  });
  window.XLSX.writeFile(workbook, "accession_register_export.xlsx");
  console.log("Excel download triggered:", "accession_register_export.xlsx");
}

function loadBookIntoForm(id, data) {
  editingBookId = id;
  editingExistingBook = { id, ...data };
  $("#autoBId").value = data.b_id || id;
  $("#accessionNumberInput").value = accessionNumberOf(data);
  $("#accessionDateInput").value = data.accessionDate || "";
  $("#bnameInput").value = bookTitle(data);
  $("#subjectInput").value = data.subject || "";
  $("#category").value = data.category || "other";
  $("#publisherBarcodeInput").value = data.publisherBarcode || data.isbn || "";
  $("#isbnInput").value = data.isbn || data.publisherBarcode || "";
  $("#authorInput").value = data.author || "";
  $("#publisherInput").value = data.placePublisher || data.publisher || "";
  $("#yearInput").value = data.year || "";
  $("#pagesInput").value = data.pages || "";
  $("#volumeInput").value = data.volume || "";
  $("#sourceInput").value = data.source || "";
  $("#billNoDateInput").value = data.billNoDate || "";
  $("#costInput").value = data.cost || "";
  $("#classNoInput").value = data.classNo || "";
  $("#bookNoInput").value = data.bookNo || "";
  $("#withdrawalRemarksInput").value = data.withdrawalRemarks || "";
  $("#totalCopiesInput").value = "1";
  $("#totalCopiesInput").disabled = true;
  $("#imageUrlInput").value = data.imageUrl || "";
  $("#notesInput").value = data.notes || "";
  $("#metadataSourceInput").value = data.metadataSource || "";
  setMetadataSourceBadge(data.metadataSource || "");
  $("#bookFetchPreview").innerHTML = `
    <article class="book-preview">
      <img src="${escapeHtml(data.imageUrl || "assets/book-placeholder.svg")}" alt="">
      <div>
        <strong>${escapeHtml(bookTitle(data))}</strong>
        <span>${escapeHtml(data.author || "Unknown author")}</span>
        <span>${escapeHtml(data.publisher || "")}</span>
      </div>
    </article>`;
  renderBarcode(data.barcodeValue || barcodeValueFor(accessionNumberOf(data), data.b_id || id), accessionNumberOf(data));
  $("#saveBookBtn").textContent = "Save Book Details";
  $("#bookSaveModeHelp").textContent = "Availability is controlled only by issue, return, lost, and found actions.";
  showToast("Book loaded for editing.", "success");
}

function showBookDetails(data) {
  $("#bookDetailsContent").innerHTML = `
    <span>Accession Number</span><strong>${escapeHtml(accessionNumberOf(data) || "-")}</strong>
    <span>Withdrawal No., Date &amp; Remarks</span><strong>${escapeHtml(data.withdrawalRemarks || "-")}</strong>
    <span>Image URL</span><strong>${escapeHtml(data.imageUrl || "-")}</strong>
    <span>Notes</span><strong>${escapeHtml(data.notes || "-")}</strong>
    <span>Barcode Value</span><strong>${escapeHtml(data.barcodeValue || barcodeValueFor(accessionNumberOf(data), data.b_id))}</strong>
    <span>Created At</span><strong>${data.createdAt ? escapeHtml(formatDate(data.createdAt)) : "-"}</strong>
    <span>Updated At</span><strong>${data.updatedAt ? escapeHtml(formatDate(data.updatedAt)) : "-"}</strong>`;
  $("#bookDetailsDialog").showModal();
}

async function printStickerFor(data) {
  renderBarcode(data.barcodeValue || barcodeValueFor(accessionNumberOf(data), data.b_id), accessionNumberOf(data));
  const html = $("#barcodeSticker").outerHTML;
  const printWindow = window.open("", "_blank", "width=420,height=420");
  if (!printWindow) {
    showToast("Popup blocked. Allow popups to print barcode stickers.", "error");
    return;
  }
  printWindow.document.write(`<html><head><title>Barcode</title><link rel="stylesheet" href="css/style.css"></head><body>${html}<script>window.print(); window.close();</script></body></html>`);
  printWindow.document.close();
}

addBookForm.addEventListener("submit", saveBook);
$("#accessionNumberInput").addEventListener("input", () => {
  const accessionNumber = $("#accessionNumberInput").value.trim();
  renderBarcode(barcodeValueFor(accessionNumber, $("#autoBId").value || nextBookId), accessionNumber);
});
$("#bnameInput").addEventListener("input", () => {
  $("#stickerBookTitle").textContent = `Title: ${$("#bnameInput").value.trim() || "-"}`;
});
function onDomReady(callback) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", callback, { once: true });
  } else {
    callback();
  }
}

onDomReady(() => {
  logLibraryDiagnostics();
  const fetchBtn = document.getElementById("fetchGoogleBookBtn");
  const barcodeInput = document.getElementById("publisherBarcodeInput");

  if (!fetchBtn || !barcodeInput) {
    console.error("Google fetch button/input missing", { fetchBtn, barcodeInput });
    return;
  }

  fetchBtn.addEventListener("click", fetchGoogleBook);
  console.log("Metadata fetch click handler attached:", true);
});
$("#scanPublisherBtn").addEventListener("click", () => startPublisherScanner().catch((error) => {
  logDetailedError(error);
  showToast(error.message, "error");
}));
$("#saveMetadataBtn").addEventListener("click", async () => {
  try {
    await saveBookMetadataForFuture("manual");
    showToast("Metadata saved for future scans.", "success");
  } catch (error) {
    console.error("Save metadata failed:", error);
    showToast(error.message || "Could not save metadata.", "error");
  }
});
$("#generateBarcodeBtn").addEventListener("click", () => {
  const accessionNumber = $("#accessionNumberInput").value.trim();
  if (!accessionNumber) {
    showToast("Enter Accession Number first.", "warning");
    return;
  }
  renderBarcode(barcodeValueFor(accessionNumber, $("#autoBId").value || nextBookId), accessionNumber);
  showToast("Library barcode generated.", "success");
});
$("#downloadBarcodeBtn").addEventListener("click", async () => {
  const dataUrl = await ensureBarcodeDataUrl();
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = `${$("#stickerBarcodeValue").textContent || "barcode"}.png`;
  link.click();
});
$("#printBarcodeBtn").addEventListener("click", () => printStickerFor({
  accessionNumber: $("#accessionNumberInput").value.trim(),
  title: $("#bnameInput").value.trim(),
  b_id: $("#autoBId").value,
  barcodeValue: $("#stickerBarcodeValue").textContent
}));
$("#downloadBooksTemplateBtn").addEventListener("click", () => {
  try {
    const example = Object.fromEntries(ACCESSION_TEMPLATE_HEADERS.map((header) => [header, ""]));
    Object.assign(example, {
      "Accession No.": "01",
      Date: "4/2/21",
      Author: "Mandot (Vivek)",
      Title: "An Introduction to Detectors + Accelerators",
      "Place & Publisher": "Himanshu Pub., Udaipur",
      Year: "2016",
      Pages: "80",
      Source: "Arya's Pub. & Dist.",
      "Bill No. & Date": "03 / 4/6/21",
      "Cost (Rs.)": "295",
      "Image URL": "https://example.com/book-cover.jpg",
      Notes: "Example note"
    });
    downloadWorkbookTemplate("accession_register_template.xlsx", [example], "Register Data");
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
});
$("#importBooksBtn").addEventListener("click", () => $("#bookImportFile").click());
$("#bookImportFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const workbookData = await readWorkbookRows(file);
    pendingBookImportMatrix = workbookData.matrix;
    pendingBookImportSheetName = workbookData.sheetName;
    const parsed = normalizeBookImportRows(pendingBookImportMatrix);
    renderBookImportPreview(parsed.rows, workbookData.sheetName, parsed.sheetHeaderRow);
    showToast("Book import preview ready.", "success");
  } catch (error) {
    logDetailedError(error);
    showToast("Could not parse book import file.", "error");
  } finally {
    event.target.value = "";
  }
});
$("#updateExistingBooks")?.addEventListener("change", () => {
  if (!pendingBookImportMatrix.length) return;
  try {
    const parsed = normalizeBookImportRows(pendingBookImportMatrix);
    renderBookImportPreview(parsed.rows, pendingBookImportSheetName, parsed.sheetHeaderRow);
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
});
$("#confirmBookImportBtn").addEventListener("click", async () => {
  try {
    const result = await importPreviewedBooks();
    showToast(`Imported ${result.imported} book copy/copies.`, "success");
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
});
bookSearch.addEventListener("input", renderBooksTable);
if (bookCategoryFilter) bookCategoryFilter.addEventListener("change", renderBooksTable);
if (bookAvailabilityFilter) bookAvailabilityFilter.addEventListener("change", renderBooksTable);
$("#exportBooksExcelBtn").addEventListener("click", () => {
  try {
    exportBooksExcel();
    showToast("Books Excel exported.", "success");
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
});

$("#booksTable").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-book-action]");
  if (!button) return;
  const id = button.closest("[data-book-id]").dataset.bookId;
  const found = latestBooks.find((item) => item.id === id);
  if (!found) return;
  const data = found.data;

  try {
    if (button.dataset.bookAction === "view") {
      showBookDetails(data);
    } else if (button.dataset.bookAction === "edit") {
      loadBookIntoForm(id, data);
    } else if (button.dataset.bookAction === "print") {
      await printStickerFor(data);
    } else if (button.dataset.bookAction === "found") {
      await updateDoc(doc(db, "books", id), {
        status: "available",
        issuedStudentUid: null,
        issuedTo: null,
        issuedToName: null,
        issuedToEmail: null,
        currentIssueId: null,
        updatedAt: serverTimestamp()
      });
      showToast("Book marked as found and available.", "success");
    } else if (button.dataset.bookAction === "lost" || button.dataset.bookAction === "damaged") {
      await updateDoc(doc(db, "books", id), {
        status: button.dataset.bookAction,
        updatedAt: serverTimestamp()
      });
      showToast(`Book marked ${button.dataset.bookAction}.`, "success");
    }
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
});
$("#bookDetailsDialog")?.querySelector(".dialog-close")?.addEventListener("click", () => {
  $("#bookDetailsDialog").close();
});

[
  "barcodePrintStatusFilter",
  "barcodeRangeFrom",
  "barcodeRangeTo",
  "barcodeCategoryFilter",
  "barcodeImportBatchFilter",
  "barcodeBookStatusFilter"
].forEach((id) => {
  const element = document.getElementById(id);
  if (!element) return;
  element.addEventListener("input", renderBarcodePrintManager);
  element.addEventListener("change", renderBarcodePrintManager);
});

$("#barcodePrintTable").addEventListener("change", (event) => {
  if (event.target.classList.contains("barcode-print-select")) {
    renderBarcodeSummary(selectedBarcodeIds().length);
  }
});

$("#barcodePrintTable").addEventListener("click", async (event) => {
  const button = event.target.closest(".reprint-barcode-btn");
  if (!button) return;
  const item = latestBooks.find((book) => book.id === button.dataset.bookId);
  if (!item) return;
  try {
    await generateBulkBarcodePdf(true, [item], "reprinted");
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
});

$("#selectVisibleBarcodesBtn").addEventListener("click", () => {
  document.querySelectorAll(".barcode-print-select").forEach((input) => {
    input.checked = true;
  });
  renderBarcodeSummary(selectedBarcodeIds().length);
});

$("#previewBarcodesBtn").addEventListener("click", () => {
  renderBarcodeSummary(selectedBarcodeIds().length);
});

$("#generateBulkBarcodePdfBtn").addEventListener("click", async () => {
  console.log("Generate Bulk PDF click handler invoked:", {
    selectedBooks: selectedBarcodeBooks().length,
    visibleBooks: filteredBarcodeBooks().length
  });
  try {
    await generateBulkBarcodePdf(true);
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
});

$("#markSelectedPrintedBtn").addEventListener("click", async () => {
  const items = selectedBarcodeBooks();
  if (!items.length) {
    showToast("Select at least one book to mark as printed.", "warning");
    return;
  }
  const confirmed = await confirmAction("Mark selected barcodes as printed?");
  if (!confirmed) return;
  try {
    const batchId = `manual_${Date.now()}`;
    await markBarcodeBooksPrinted(items, batchId, "", "printed");
    showToast("Selected barcodes marked as printed.", "success");
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
});

$("#exportBarcodeExcelBtn").addEventListener("click", () => {
  console.log("Export Barcode Excel click handler invoked:", {
    visibleBooks: filteredBarcodeBooks().length,
    selectedBooks: selectedBarcodeBooks().length
  });
  try {
    exportBarcodeExcel();
    showToast("Barcode Excel exported.", "success");
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
});

function setDefaultSlotDates() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const weekEnd = new Date(tomorrow);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const toInputDate = (date) => date.toISOString().slice(0, 10);
  if (!$("#slotStartDate").value) $("#slotStartDate").value = toInputDate(tomorrow);
  if (!$("#slotEndDate").value) $("#slotEndDate").value = toInputDate(weekEnd);
  if (!$("#slotStartTime").value) $("#slotStartTime").value = "12:30";
  if (!$("#slotEndTime").value) $("#slotEndTime").value = "14:00";
}

function renderActiveSchedule(schedule) {
  const target = $("#activeScheduleCard");
  if (!target) return;
  if (!schedule?.active) {
    target.innerHTML = `<strong>No active issue/return time set.</strong><span>Use Set Issue / Return Time to allow scheduled requests.</span>`;
    return;
  }
  target.innerHTML = `
    <strong>Issue/Return allowed: ${escapeHtml(schedule.startTime || "-")} - ${escapeHtml(schedule.endTime || "-")}</strong>
    <span>${escapeHtml(scheduleLabel(schedule))}</span>
    <span>Applies to: ${escapeHtml(schedule.appliesTo || "both")} | Max students: ${Number(schedule.maxStudentsPerSlot || 0)}</span>
    ${schedule.notes ? `<span>${escapeHtml(schedule.notes)}</span>` : ""}`;
}

$("#slotRepeatMode")?.addEventListener("change", () => {
  const mode = $("#slotRepeatMode").value;
  const start = $("#slotStartDate").value ? new Date($("#slotStartDate").value) : new Date();
  $("#slotEndDate").required = mode !== "untilChanged";
  if (mode === "tomorrow") {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const value = tomorrow.toISOString().slice(0, 10);
    $("#slotStartDate").value = value;
    $("#slotEndDate").value = value;
  } else if (mode === "week") {
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    $("#slotEndDate").value = end.toISOString().slice(0, 10);
  } else if (mode === "untilChanged") {
    $("#slotEndDate").value = "";
    $("#slotEndDate").required = false;
  }
});

$("#timeSlotForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoading(event.target, true);
  try {
    const repeatMode = $("#slotRepeatMode").value;
    const payload = {
      active: true,
      startDate: $("#slotStartDate").value,
      endDate: repeatMode === "untilChanged" ? "" : $("#slotEndDate").value,
      startTime: $("#slotStartTime").value,
      endTime: $("#slotEndTime").value,
      appliesTo: $("#slotAppliesTo").value,
      repeatMode,
      maxStudentsPerSlot: Number($("#slotMaxStudents").value || 20),
      notes: $("#slotNotes").value.trim(),
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser.uid
    };
    await setDoc(doc(db, "librarySettings", "issueReturnSchedule"), payload, { merge: true });
    showToast("Issue/return time slot saved.", "success");
  } catch (error) {
    logDetailedError(error);
    showToast(error.message || "Could not save time slot.", "error");
  } finally {
    setLoading(event.target, false);
  }
});

setDefaultSlotDates();

onSnapshot(
  doc(db, "librarySettings", "issueReturnSchedule"),
  (snap) => {
    const schedule = snap.exists() ? snap.data() : null;
    renderActiveSchedule(schedule);
    if (!schedule) return;
    $("#slotStartDate").value = schedule.startDate || $("#slotStartDate").value;
    $("#slotEndDate").value = schedule.endDate || "";
    $("#slotStartTime").value = schedule.startTime || $("#slotStartTime").value;
    $("#slotEndTime").value = schedule.endTime || $("#slotEndTime").value;
    $("#slotAppliesTo").value = schedule.appliesTo || "both";
    $("#slotRepeatMode").value = schedule.repeatMode || "untilChanged";
    $("#slotMaxStudents").value = schedule.maxStudentsPerSlot || 20;
    $("#slotNotes").value = schedule.notes || "";
  },
  (error) => {
    console.error("Issue/return schedule load failed:", error);
    renderActiveSchedule(null);
  }
);

function penaltyAmountOf(penalty = {}) {
  return Number(penalty.remainingAmount ?? penalty.amount ?? penalty.penaltyAmount ?? 0);
}

function renderPenaltyDetails() {
  const statusFilter = $("#penaltyStatusFilter")?.value || "all";
  const search = String($("#penaltySearchInput")?.value || "").trim().toLowerCase();
  const total = latestPenalties.length;
  const unpaid = latestPenalties.filter((item) => isUnpaidPenaltyRecord(item.data));
  const paid = latestPenalties.filter((item) => !isUnpaidPenaltyRecord(item.data));
  const pendingAmount = unpaid.reduce((sum, item) => sum + Math.max(0, penaltyAmountOf(item.data)), 0);

  const metricMap = {
    metricPenalties: unpaid.length,
    penaltyTotalCount: total,
    penaltyUnpaidCount: unpaid.length,
    penaltyPaidCount: paid.length,
    penaltyPendingAmount: `Rs.${pendingAmount.toFixed(2)}`
  };
  Object.entries(metricMap).forEach(([id, value]) => {
    const target = document.getElementById(id);
    if (target) target.textContent = String(value);
  });

  const rows = latestPenalties.filter((item) => {
    const penalty = item.data;
    const isUnpaid = isUnpaidPenaltyRecord(penalty);
    if (statusFilter === "unpaid" && !isUnpaid) return false;
    if (statusFilter === "paid" && isUnpaid) return false;
    if (!search) return true;
    return [
      penalty.studentName,
      penalty.studentEmail,
      penalty.studentPhone,
      penalty.studentUid,
      penalty.bookTitle,
      penalty.bookId,
      penalty.b_id,
      penalty.bookBarcodeValue
    ].join(" ").toLowerCase().includes(search);
  });

  const target = $("#penaltyDetailsList");
  if (!target) return;
  if (!rows.length) {
    renderEmpty(target, "No penalty records found.");
    return;
  }

  target.innerHTML = rows
    .sort((a, b) => timeOf(b.data.createdAt || b.data.returnDate) - timeOf(a.data.createdAt || a.data.returnDate))
    .map((item) => {
      const penalty = item.data;
      const isUnpaid = isUnpaidPenaltyRecord(penalty);
      const amount = penaltyAmountOf(penalty);
      return `
        <article class="list-row penalty-row" data-penalty-id="${escapeHtml(item.id)}">
          <div>
            <strong>${escapeHtml(penalty.studentName || "Unknown student")} - Rs.${amount.toFixed(2)}</strong>
            <span>Email: ${escapeHtml(penalty.studentEmail || "")}</span>
            <span>Phone: ${escapeHtml(penalty.studentPhone || "")}</span>
            <span>UID: ${escapeHtml(shortUid(penalty.studentUid || ""))}</span>
            <span>Book: ${escapeHtml(penalty.bookTitle || penalty.bookId || "")}</span>
            <span>B_ID: ${escapeHtml(penalty.b_id || penalty.bookId || "")} | Barcode: ${escapeHtml(penalty.bookBarcodeValue || "")}</span>
            <span>Issue: ${formatDate(penalty.issueDate)} | Due: ${formatDate(penalty.dueDate)} | Return: ${formatDate(penalty.returnDate)}</span>
            <span>Late Days: ${Number(penalty.lateDays || penalty.daysLate || 0)}</span>
            <span>Contact Details: ${escapeHtml([penalty.studentEmail, penalty.studentPhone].filter(Boolean).join(" | "))}</span>
          </div>
          <div class="row-actions">
            ${statusBadge(isUnpaid ? "unpaid" : "paid")}
            <button class="btn btn-primary mark-penalty-paid-btn" data-penalty-id="${escapeHtml(item.id)}" type="button" ${isUnpaid ? "" : "disabled"}>Mark Paid</button>
            <button class="btn btn-muted view-student-btn" data-student-uid="${escapeHtml(penalty.studentUid || "")}" type="button">View Student</button>
            <button class="btn btn-muted view-book-btn" data-book-id="${escapeHtml(penalty.b_id || penalty.bookId || "")}" type="button">View Book</button>
          </div>
        </article>`;
    }).join("");
}

$("#penaltyStatusFilter")?.addEventListener("change", renderPenaltyDetails);
$("#penaltySearchInput")?.addEventListener("input", renderPenaltyDetails);
$("#penaltyDetailsList")?.addEventListener("click", async (event) => {
  const markPaidBtn = event.target.closest(".mark-penalty-paid-btn");
  const viewStudentBtn = event.target.closest(".view-student-btn");
  const viewBookBtn = event.target.closest(".view-book-btn");

  if (markPaidBtn) {
    const penaltyId = markPaidBtn.dataset.penaltyId;
    const confirmed = await confirmAction("Mark this penalty as paid?");
    if (!confirmed) return;
    markPaidBtn.disabled = true;
    try {
      await updateDoc(doc(db, "penalties", penaltyId), {
        paid: true,
        status: "paid",
        remainingAmount: 0,
        paidAt: serverTimestamp(),
        paidBy: auth.currentUser.uid,
        updatedAt: serverTimestamp()
      });
      showToast("Penalty marked as paid.", "success");
    } catch (error) {
      logDetailedError(error);
      showToast(`${error.code || "error"}: ${error.message}`, "error");
    } finally {
      markPaidBtn.disabled = false;
    }
    return;
  }

  if (viewStudentBtn) {
    const studentUid = viewStudentBtn.dataset.studentUid;
    showToast(studentUid ? `Student UID: ${studentUid}` : "Student UID not available.", "info");
    return;
  }

  if (viewBookBtn) {
    const bookId = viewBookBtn.dataset.bookId;
    const book = latestBooks.find((item) => item.id === bookId || item.data.b_id === bookId);
    showToast(book ? `Book: ${bookTitle(book.data)}` : "Book record not found in loaded list.", book ? "info" : "warning");
  }
});

onSnapshot(
  query(collection(db, "issueRequests"), where("status", "==", "pending")),
  (snap) => {
    latestPendingRequests = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
    const pendingMetric = $("#metricPendingRequests");
    const newRequestMetric = $("#metricNewBookRequests");
    if (pendingMetric) pendingMetric.textContent = String(snap.size);
    if (newRequestMetric) newRequestMetric.textContent = String(snap.size);
    renderPendingRequests();
  }
);

onSnapshot(
  collection(db, "penalties"),
  (snap) => {
    latestPenalties = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
    renderPenaltyDetails();
  },
  (error) => {
    console.error("Penalty details query failed:", {
      query: "penalties",
      code: error?.code,
      message: error?.message
    });
    renderEmpty($("#penaltyDetailsList"), "Could not load penalty details.");
  }
);

onSnapshot(
  query(collection(db, "returnRequests"), where("status", "==", "pending")),
  (snap) => {
    latestReturnRequests = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
    renderReturnRequests();
  },
  (error) => {
    console.error("Pending return requests query failed:", {
      query: "returnRequests where status == pending",
      code: error?.code,
      message: error?.message
    });
    renderEmpty($("#pendingReturnRequests"), "Could not load return requests.");
  }
);

function renderPendingRequests() {
  const target = $("#pendingRequests");
  if (!latestPendingRequests.length) {
    renderEmpty(target, "No pending issue requests.");
    return;
  }
  target.innerHTML = latestPendingRequests.sort((a, b) => timeOf(a.data.createdAt) - timeOf(b.data.createdAt)).map((item) => {
    const request = item.data;
    const book = localBookForRequest(request);
    const unavailable = book && book.status !== "available";
    return `
      <article class="request-card" data-request-id="${item.id}">
        <img src="${escapeHtml(request.bookImage || "assets/book-placeholder.svg")}" alt="">
        <div>
          <strong>${escapeHtml(request.bookTitle)}</strong>
          <span>${escapeHtml(request.bookId)} requested by ${escapeHtml(request.studentName)}</span>
          <span>Requested ${formatDate(request.requestedAt || request.createdAt)} | Slot ${escapeHtml(request.preferredSlot || "-")}</span>
          <span>Issue ${formatDate(request.issueDate)} | Due ${formatDate(request.dueDate)}</span>
          ${unavailable ? `<span class="badge badge-issued">Book already issued</span>` : ""}
        </div>
        <div class="row-actions">
          <button class="btn btn-primary approve-request-btn" data-request-id="${item.id}" type="button" ${unavailable ? "disabled" : ""}>Approve</button>
          <button class="btn btn-muted reject-request-btn" data-request-id="${item.id}" type="button">Reject</button>
        </div>
      </article>`;
  }).join("");
}

$("#pendingRequests").addEventListener("click", async (event) => {
  const approveBtn = event.target.closest(".approve-request-btn");
  const rejectBtn = event.target.closest(".reject-request-btn");
  if (!approveBtn && !rejectBtn) return;
  const button = approveBtn || rejectBtn;
  const requestId = button.dataset.requestId;
  if (approveBtn) console.log("Approve clicked:", requestId);
  if (rejectBtn) console.log("Reject clicked:", requestId);
  const confirmed = await confirmAction(approveBtn ? "Approve this book issue?" : "Reject this issue request?");
  if (!confirmed) return;
  button.disabled = true;
  try {
    if (approveBtn) {
      const result = await approveRequest(requestId);
      if (result?.conflict) {
        showToast("This book is already issued or unavailable.", "warning");
        return;
      }
      try {
        await sendEmailNotification("Book Issue Approved", {
          ...result.notificationPayload,
          returnDate: "-",
          penaltyAmount: 0
        });
        showToast("Book issued successfully. Email sent.", "success");
      } catch (error) {
        console.error("Issue email notification failed:", error);
        showToast("Book issued successfully but email failed.", "warning");
      }
    } else {
      const rejected = await rejectRequest(requestId);
      try {
        await sendEmailNotification("Issue Request Rejected", {
          studentName: rejected?.studentName || "Student",
          studentEmail: rejected?.studentEmail || "",
          bookTitle: rejected?.bookTitle || "",
          issueDate: rejected?.issueDate || "-",
          dueDate: rejected?.dueDate || "-",
          returnDate: "-",
          penaltyAmount: 0
        });
      } catch (emailError) {
        console.error("Issue rejected email failed:", emailError);
      }
      showToast("Issue request rejected.", "success");
    }
  } catch (error) {
    if (approveBtn) {
      console.error("Approve failed full error:", error);
      console.error("Approve failed code:", error.code);
      console.error("Approve failed message:", error.message);
    } else {
      console.error("Reject failed full error:", error);
      console.error("Reject failed code:", error.code);
      console.error("Reject failed message:", error.message);
    }
    if (error.message === "This request was already processed.") {
      showToast("This request was already processed.", "warning");
    } else if (error.code === "penalty/unpaid") {
      showToast(error.message, "warning");
    } else if (error.message.includes("not available")) {
      showToast("This book is already issued or unavailable.", "warning");
    } else {
      showToast(`${error.code || "error"}: ${error.message}`, "error");
    }
  } finally {
    button.disabled = false;
  }
});

$("#pendingReturnRequests")?.addEventListener("click", async (event) => {
  const confirmBtn = event.target.closest(".confirm-return-request-btn");
  const rejectBtn = event.target.closest(".reject-return-request-btn");
  if (!confirmBtn && !rejectBtn) return;
  const requestId = (confirmBtn || rejectBtn).dataset.requestId;
  const requestItem = latestReturnRequests.find((item) => item.id === requestId);
  if (!requestItem) return;

  if (rejectBtn) {
    const confirmed = await confirmAction("Reject this return request?");
    if (!confirmed) return;
    rejectBtn.disabled = true;
    try {
      await updateDoc(doc(db, "returnRequests", requestId), {
        status: "rejected",
        reviewedBy: auth.currentUser.uid,
        reviewedAt: serverTimestamp()
      });
      try {
        await sendEmailNotification("Return Rejected", {
          studentName: requestItem.data.studentName || "Student",
          studentEmail: requestItem.data.studentEmail || "",
          bookTitle: requestItem.data.bookTitle || "",
          issueDate: "-",
          dueDate: "-",
          returnDate: "-",
          penaltyAmount: requestItem.data.estimatedPenalty || 0
        });
      } catch (emailError) {
        console.error("Return rejected email failed:", emailError);
      }
      showToast("Return request rejected.", "success");
    } catch (error) {
      logDetailedError(error);
      showToast(`${error.code || "error"}: ${error.message}`, "error");
    } finally {
      rejectBtn.disabled = false;
    }
    return;
  }

  selectedReturnRequest = requestItem;
  $("#confirmReturnRequestDetails").innerHTML = `
    <article class="list-row">
      <div>
        <strong>${escapeHtml(requestItem.data.bookTitle || requestItem.data.bookId || "Return request")}</strong>
        <span>Student: ${escapeHtml(requestItem.data.studentName || "")}</span>
        <span>B_ID: ${escapeHtml(requestItem.data.b_id || requestItem.data.bookId || "")}</span>
        <span>Expected barcode: ${escapeHtml(requestItem.data.bookBarcodeValue || requestItem.data.barcodeValue || "")}</span>
        <span>Estimated penalty: Rs.${Number(requestItem.data.estimatedPenalty || 0).toFixed(2)}</span>
      </div>
    </article>`;
  $("#confirmReturnBarcode").value = "";
  $("#confirmReturnRequestDialog").showModal();
});

$("#confirmReturnRequestDialog")?.querySelector(".dialog-close")?.addEventListener("click", () => {
  $("#confirmReturnRequestDialog").close();
});

$("#confirmReturnRequestForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedReturnRequest) return;
  setLoading(event.target, true);
  try {
    const scanned = $("#confirmReturnBarcode").value.trim().replace(/\s+/g, "");
    const expected = String(selectedReturnRequest.data.bookBarcodeValue || selectedReturnRequest.data.barcodeValue || "").trim();
    if (!scanned) throw new Error("Scan or enter the library barcode.");
    if (expected && scanned !== expected) {
      throw new Error("Scanned barcode does not match this return request.");
    }
    const bookDocId = selectedReturnRequest.data.b_id || selectedReturnRequest.data.bookId;
    if (bookDocId && selectedReturnRequest.data.currentIssueId) {
      const bookSnap = await getDoc(doc(db, "books", bookDocId));
      const bookData = bookSnap.exists() ? bookSnap.data() : null;
      if (!bookData || bookData.currentIssueId !== selectedReturnRequest.data.currentIssueId) {
        throw new Error("This return request does not match the current active issue.");
      }
    }
    const data = await returnBook(scanned);
    await updateDoc(doc(db, "returnRequests", selectedReturnRequest.id), {
      status: "completed",
      completedAt: serverTimestamp(),
      reviewedBy: auth.currentUser.uid,
      reviewedAt: serverTimestamp(),
      finalPenalty: data.penaltyAmount || 0,
      returnIssueId: data.issueId || selectedReturnRequest.data.currentIssueId || ""
    });
    try {
      await sendEmailNotification("Book Return Completed", {
        studentName: selectedReturnRequest.data.studentName || data.studentName || "Student",
        studentEmail: selectedReturnRequest.data.studentEmail || data.studentEmail || "",
        bookTitle: selectedReturnRequest.data.bookTitle || data.bookTitle || "",
        issueDate: data.issueDate,
        dueDate: data.dueDate,
        returnDate: data.returnDate,
        penaltyAmount: data.penaltyAmount || 0
      });
    } catch (emailError) {
      console.error("Return completed email failed:", emailError);
    }
    $("#confirmReturnRequestDialog").close();
    showToast("Book return completed.", "success");
  } catch (error) {
    console.error("Confirm return request failed:", {
      code: error?.code,
      message: error?.message,
      stack: error?.stack
    });
    showToast(`${error.code || "error"}: ${error.message}`, "error");
  } finally {
    setLoading(event.target, false);
  }
});

onSnapshot(
  query(collection(db, "bookIssues"), where("status", "==", "issued"), limit(25)),
  async (snap) => {
    const target = $("#activeIssues");
    if (snap.empty) {
      renderEmpty(target, "No active issues.");
      return;
    }
    const cards = await Promise.all(snap.docs.sort((a, b) => timeOf(a.data().dueDate) - timeOf(b.data().dueDate)).map(async (item) => {
      const issue = item.data();
      const student = await resolveIssueStudent(issue);
      return `
        <article class="list-row">
          <div>
            <strong>Book: ${escapeHtml(issue.bookTitle || issue.bookId || issue.b_id || "Issued book")}</strong>
            <span>Issued To: ${escapeHtml(student.name)}</span>
            <span>Student Email: ${escapeHtml(issue.studentEmail || student.email || "")}</span>
            <span>UID: ${escapeHtml(shortUid(issue.studentUid))}</span>
            <span>B_ID: ${escapeHtml(issue.b_id || issue.bookId || "")}</span>
            <span>Barcode: ${escapeHtml(issue.bookBarcodeValue || "")}</span>
            <span>Issue Date: ${formatDate(issue.issueDate)}</span>
            <span>Due Date: ${formatDate(issue.dueDate)}</span>
          </div>
          ${statusBadge(issue.status)}
        </article>`;
    }));
    target.innerHTML = cards.join("");
  }
);

onSnapshot(
  query(collection(db, "bookIssues"), where("status", "==", "returned"), limit(25)),
  (snap) => {
    const target = $("#returnsList");
    if (snap.empty) {
      renderEmpty(target, "No returns recorded yet.");
      return;
    }
    target.innerHTML = snap.docs.sort((a, b) => timeOf(b.data().returnedAt) - timeOf(a.data().returnedAt)).map((item) => {
      const issue = item.data();
      return `
        <article class="list-row">
          <div>
            <strong>${escapeHtml(issue.bookId)}</strong>
            <span>Returned ${formatDate(issue.returnDate)} | Penalty Rs.${Number(issue.penaltyAmount || 0).toFixed(2)}</span>
          </div>
          ${statusBadge(issue.status)}
        </article>`;
    }).join("");
  }
);

onSnapshot(
  query(collection(db, "students"), orderBy("createdAt", "desc"), limit(20)),
  (snap) => {
    const target = $("#recentStudents");
    if (snap.empty) {
      renderEmpty(target, "No students found.");
      return;
    }
    target.innerHTML = snap.docs.map((item) => {
      const student = item.data();
      return `
        <article class="list-row">
          <div>
            <strong>${escapeHtml(student.name)}</strong>
            <span>${escapeHtml(student.rollNumber || "")} | ${escapeHtml(student.department || "")} | ${escapeHtml(student.year || "")}</span>
          </div>
          ${statusBadge(student.active ? "active" : "inactive")}
        </article>`;
    }).join("");
  }
);

onSnapshot(
  query(collection(db, "books"), orderBy("updatedAt", "desc"), limit(500)),
  (snap) => {
    latestBooks = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
    const counts = latestBooks.reduce((acc, item) => {
      const status = String(item.data.status || "available").toLowerCase();
      acc.total += 1;
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, { total: 0, available: 0, issued: 0, lost: 0, damaged: 0 });
    const metricMap = {
      metricTotalBooks: counts.total,
      metricIssuedBooks: counts.issued,
      metricAvailableBooks: counts.available,
      metricLostBooks: counts.lost,
      metricDamagedBooks: counts.damaged
    };
    Object.entries(metricMap).forEach(([id, value]) => {
      const target = document.getElementById(id);
      if (target) target.textContent = String(value || 0);
    });
    renderBooksTable();
    renderBarcodePrintManager();
    renderPendingRequests();
    const target = $("#recentBooks");
    if (snap.empty) {
      renderEmpty(target, "No books found.");
      return;
    }
    target.innerHTML = latestBooks.slice(0, 8).map((item) => {
      const book = item.data;
      return `
        <article class="list-row">
          <div>
            <strong>${escapeHtml(bookTitle(book))}</strong>
            <span>${escapeHtml(book.b_id || item.id)} | ${escapeHtml(book.category || "")}</span>
          </div>
          ${statusBadge(book.status)}
        </article>`;
    }).join("");
  }
);

$("#quickReturnForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoading(event.target, true);
  try {
    const lookupValue = $("#quickReturnBookId").value.trim();
    const book = await findBookByLibraryCode(lookupValue);
    if (!book.currentIssueId) throw new Error("No active issue found for this book.");
    const issueSnap = await getDoc(doc(db, "bookIssues", book.currentIssueId));
    if (!issueSnap.exists()) throw new Error("Active issue record not found.");
    const issue = issueSnap.data();
    const issueDate = issue.issueDate?.toDate ? issue.issueDate.toDate() : new Date(issue.issueDate);
    const penalty = Number.isNaN(issueDate.getTime()) ? { penaltyAmount: 0 } : calculatePenalty(issueDate, new Date());
    selectedQuickReturn = { lookupValue, book, issue };
    $("#quickReturnDetails").innerHTML = `
      <span>Accession Number</span><strong>${escapeHtml(issue.accessionNumber || accessionNumberOf(book) || "-")}</strong>
      <span>Author</span><strong>${escapeHtml(issue.author || book.author || "-")}</strong>
      <span>Title</span><strong>${escapeHtml(issue.title || issue.bookTitle || bookTitle(book) || "-")}</strong>
      <span>Student UID</span><strong>${escapeHtml(issue.studentUid || "-")}</strong>
      <span>Student Name</span><strong>${escapeHtml(issue.studentName || "-")}</strong>
      <span>Issue Date</span><strong>${escapeHtml(formatDate(issue.issueDate))}</strong>
      <span>Due Date</span><strong>${escapeHtml(formatDate(issue.dueDate))}</strong>
      <span>Penalty</span><strong>Rs.${Number(penalty.penaltyAmount || 0).toFixed(2)}</strong>`;
    $("#quickReturnDialog").showModal();
  } catch (error) {
    console.error("Quick return lookup failed:", error);
    showToast(`${error.code || "error"}: ${error.message}`, "error");
  } finally {
    setLoading(event.target, false);
  }
});

$("#confirmQuickReturnForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedQuickReturn) return;
  setLoading(event.target, true);
  try {
    const data = await returnBook(selectedQuickReturn.lookupValue);
    console.log("Return completed:", data);
    if (data.studentUid) {
      const studentSnap = await getDoc(doc(db, "students", data.studentUid));
      const student = studentSnap.exists() ? studentSnap.data() : {};
      const returnPayload = {
        studentName: student.name || data.studentName || "Student",
        studentEmail: data.studentEmail || student.email || "",
        bookTitle: data.bookTitle,
        issueDate: data.issueDate,
        dueDate: data.dueDate,
        returnDate: data.returnDate,
        penaltyAmount: data.penaltyAmount
      };
      try {
        await sendEmailNotification("Book Returned", returnPayload);
        if (Number(data.penaltyAmount || 0) > 0) {
          await sendEmailNotification("Penalty Notice", returnPayload);
        }
        showToast("Return processed. Email sent.", "success");
      } catch (error) {
        console.error("Return email notification failed:", error);
        showToast("Return processed but email failed.", "warning");
      }
    } else {
      showToast("Book returned successfully.", "success");
    }
    if (Number(data.penaltyAmount || 0) > 0) {
      showToast(`Book returned with Rs.${Number(data.penaltyAmount).toFixed(2)} penalty.`, "success");
    }
    $("#quickReturnForm").reset();
    $("#quickReturnDialog").close();
    selectedQuickReturn = null;
  } catch (error) {
    console.error("Quick return failed full error:", error);
    console.error("Quick return failed code:", error.code);
    console.error("Quick return failed message:", error.message);
    showToast(`${error.code || "error"}: ${error.message}`, "error");
  } finally {
    setLoading(event.target, false);
  }
});
$("#quickReturnDialog")?.querySelector(".dialog-close")?.addEventListener("click", () => {
  selectedQuickReturn = null;
  $("#quickReturnDialog").close();
});
$("#startQuickReturnScannerBtn").addEventListener("click", () => startQuickReturnScanner().catch((error) => {
  logDetailedError(error);
  showToast(error.message, "error");
}));
$("#stopQuickReturnScannerBtn").addEventListener("click", () => stopQuickReturnScanner());

function renderNotificationResult(result) {
  $("#notificationResult").innerHTML = `
    <div class="success-box">
      <strong>Reminder check complete</strong>
      <span>Checked: ${result.checked}</span>
      <span>Emails sent: ${result.sent}</span>
      <span>Overdue books: ${result.overdue || 0}</span>
      <span>Skipped: ${result.skipped}</span>
    </div>`;
}

function renderReturnRequests() {
  const target = $("#pendingReturnRequests");
  if (!target) return;
  if (!latestReturnRequests.length) {
    renderEmpty(target, "No pending return requests.");
    return;
  }
  target.innerHTML = latestReturnRequests
    .sort((a, b) => timeOf(a.data.requestedAt || a.data.createdAt) - timeOf(b.data.requestedAt || b.data.createdAt))
    .map((item) => {
      const request = item.data;
      return `
        <article class="request-card" data-return-request-id="${escapeHtml(item.id)}">
          <img src="assets/book-placeholder.svg" alt="">
          <div>
            <strong>${escapeHtml(request.bookTitle || request.bookId || "Return request")}</strong>
            <span>${escapeHtml(request.b_id || request.bookId || "")} requested by ${escapeHtml(request.studentName || "")}</span>
            <span>Contact: ${escapeHtml([request.studentEmail, request.studentPhone].filter(Boolean).join(" | "))}</span>
            <span>Requested ${formatDate(request.requestedAt || request.createdAt)} | Slot ${escapeHtml(request.preferredSlot || "-")}</span>
            <span>Current penalty: Rs.${Number(request.estimatedPenalty || 0).toFixed(2)}</span>
          </div>
          <div class="row-actions">
            <button class="btn btn-primary confirm-return-request-btn" data-request-id="${escapeHtml(item.id)}" type="button">Confirm Return</button>
            <button class="btn btn-muted reject-return-request-btn" data-request-id="${escapeHtml(item.id)}" type="button">Reject</button>
          </div>
        </article>`;
    }).join("");
}

$("#runReminderCheckBtn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await runReminderCheck();
    renderNotificationResult(result);
    showToast("Reminder check complete.", "success");
  } catch (error) {
    logDetailedError(error);
    $("#notificationResult").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#sendTestEmailBtn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    if (!isEmailNotificationsConfigured()) {
      $("#notificationResult").innerHTML = `<div class="empty">${escapeHtml(EMAILJS_SETUP_MESSAGE)}</div>`;
      showToast(EMAILJS_SETUP_MESSAGE, "warning");
      return;
    }
    const today = new Date();
    const result = await sendEmailNotification("Test Notification", {
      studentName: session.profile.name || "MLSU User",
      studentEmail: session.profile.email || session.user.email,
      bookTitle: "EmailJS Test",
      issueDate: today,
      dueDate: today,
      returnDate: "-",
      penaltyAmount: 0
    });
    $("#notificationResult").innerHTML = `
      <div class="success-box">
        <strong>Test email ${result.sent ? "sent" : "skipped"}</strong>
        <span>Checked: 1</span>
        <span>Emails sent: ${result.sent ? 1 : 0}</span>
        <span>Skipped: ${result.sent ? 0 : 1}</span>
      </div>`;
    showToast("Test email sent successfully.", "success");
  } catch (error) {
    logDetailedError(error);
    const message = error.message?.toLowerCase().includes("emailjs") ? EMAILJS_SETUP_MESSAGE : error.message;
    $("#notificationResult").innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
    showToast(message, "error");
  } finally {
    button.disabled = false;
  }
});

