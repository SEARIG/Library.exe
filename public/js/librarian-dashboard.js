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
  addDays,
  calculatePenalty,
  canStudentIssueBook,
  compareAccessionNumbers,
  findBookByLibraryCode,
  issueEligibilityError,
  getIssueReturnSchedule,
  isUnpaidPenaltyRecord,
  returnBook,
  scheduleLabel,
  titleOf
} from "./firestore-service.js?v=4";
import {
  EMAILJS_SETUP_MESSAGE,
  isEmailNotificationsConfigured,
  runReminderCheck,
  sendEmailNotification
} from "./notifications.js";
import {
  ACCESSION_PARSER_VERSION,
  ACCESSION_TEMPLATE_HEADERS,
  accessionBookData,
  accessionExportRow,
  parseAccessionWorkbook,
  parseAccessionRegister,
} from "./accession-register.mjs?v=6";
import {
  buildDuplicateCleanupPlan,
  duplicateCleanupSignature
} from "./book-duplicates.mjs?v=2";
import { accessionNumberValue, normalizeAccessionNumber } from "./accession-utils.mjs";
import {
  collection,
  deleteDoc,
  doc,
  documentId,
  addDoc,
  arrayUnion,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  startAfter,
  Timestamp,
  updateDoc,
  writeBatch,
  where
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  collectReusableMetadata,
  createMetadataKey,
  hasReusableMetadata,
  mergeReusableMetadata,
  metadataKeyCandidates,
  normalizeBarcode,
  normalizeIsbn,
  normalizeProviderSource,
  reusableMetadataPayload,
  titleKeywords
} from "./book-metadata-utils.mjs";
import {
  getStudentPenaltyLiability,
  issueIdOf
} from "./penalty-utils.mjs?v=2";

wireSignOut();
const session = await requireAuth(["librarian", "admin"]);
$("#deleteDuplicateBooksBtn")?.toggleAttribute("hidden", session.profile.role !== "admin");
const addBookForm = $("#addBookForm");
const bookSearch = $("#bookSearch");
const bookCategoryFilter = $("#bookCategoryFilter");
const bookAvailabilityFilter = $("#bookAvailabilityFilter");
const bookSort = $("#bookSort");
const BOOK_DATABASE_PAGE_SIZE = 25;
const BOOK_DATABASE_SCAN_SIZE = 100;
let nextBookId = "1";
let editingBookId = null;
let editingExistingBook = null;
let latestBooks = [];
let bookDatabaseRows = [];
let bookDatabaseTotal = 0;
let bookDatabasePageCursors = [null];
let bookDatabaseSearchMode = false;
let bookDatabaseLoadSequence = 0;
let bookDatabasePage = 1;
let latestPendingRequests = [];
let latestReturnRequests = [];
let latestPenalties = [];
let latestActiveIssues = [];
let pendingDuplicateCleanupPlan = null;
let latestBarcodeDataUrl = "";
let selectedReturnRequest = null;
let selectedPickupRequest = null;
let pendingBookImportRows = [];
let pendingBookImportMatrix = [];
let pendingBookImportSheetName = "";
let publisherStream = null;
let publisherScanTimer = null;
let quickReturnStream = null;
let quickReturnScanTimer = null;
let selectedQuickReturn = null;
let latestIssueReturnSchedule = null;
const showBookDebug = new URLSearchParams(window.location.search).get("debug") === "true"
  || localStorage.debugBooks === "true";
const testEmailButton = $("#sendTestEmailBtn");
if (testEmailButton) testEmailButton.title = EMAILJS_SETUP_MESSAGE;
const INDCAT_CONFIG = {
  enabled: false,
  apiUrl: ""
};
const BOOK_CATEGORIES = ["pyq", "textbook", "qna", "reference", "notes", "journal", "other"];
const SLD_STATUS = {
  searching: "Searching saved metadata...",
  foundSld: "Found in Self Learning DB",
  foundOnline: "Found online",
  foundExisting: "Found from Existing Book",
  notFound: "Not found, manual entry required",
  saved: "Saved to Self Learning DB"
};

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

function eventTime(value) {
  if (!value) return 0;
  const date = value.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function renderRecentActivity() {
  const target = $("#recentBooks");
  if (!target) return;
  const events = [
    ...latestBooks.slice(0, 20).map((item) => ({
      type: "book added",
      title: bookTitle(item.data),
      meta: `Accession No.: ${accessionNumberOf(item.data) || item.data.b_id || item.id}`,
      status: item.data.status || "book",
      time: eventTime(item.data.updatedAt || item.data.createdAt)
    })),
    ...latestPendingRequests.map((item) => ({
      type: "issue request",
      title: item.data.bookTitle || item.data.title || item.data.bookId || "Issue request",
      meta: `${item.data.studentName || "Student"} | ${formatDate(item.data.createdAt || item.data.requestedAt)}`,
      status: item.data.status || "pending",
      time: eventTime(item.data.createdAt || item.data.requestedAt)
    })),
    ...latestReturnRequests.map((item) => ({
      type: "return request",
      title: item.data.bookTitle || item.data.title || item.data.bookId || "Return request",
      meta: `${item.data.studentName || "Student"} | ${formatDate(item.data.createdAt || item.data.requestedAt)}`,
      status: item.data.status || "pending",
      time: eventTime(item.data.createdAt || item.data.requestedAt)
    })),
    ...latestActiveIssues.slice(0, 20).map((item) => ({
      type: "book issued",
      title: item.data.bookTitle || item.data.title || item.data.bookId || "Issued book",
      meta: `Accession No.: ${item.data.accessionNumber || item.data.bookId || "-"} | Due ${formatDate(item.data.dueDate)}`,
      status: item.data.status || "issued",
      time: eventTime(item.data.issueDate || item.data.issuedAt || item.data.createdAt)
    }))
  ].sort((left, right) => right.time - left.time).slice(0, 10);

  if (!events.length) {
    renderEmpty(target, "No recent activity yet.");
    return;
  }

  target.innerHTML = events.map((event) => `
    <article class="list-row compact-activity-row">
      <div>
        <strong>${escapeHtml(event.title)}</strong>
        <span>${escapeHtml(event.type)} | ${escapeHtml(event.meta)}</span>
      </div>
      ${statusBadge(event.status)}
    </article>`).join("");
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

console.info(`[ACCESSION IMPORT] Loaded parser ${ACCESSION_PARSER_VERSION}`);

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
    .map((item) => [normalizeAccessionNumber(accessionNumberValue(item.data)), item])
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
  const duplicateCount = rows.filter((row) => row.duplicateType).length;
  const errorCount = rows.filter((row) => row.errors.length && !row.duplicateType).length;
  const skipDuplicates = $("#skipDuplicateBooks")?.checked !== false;
  $("#confirmBookImportBtn").disabled = readyCount === 0;
  $("#importTotalRows").textContent = String(rows.length);
  $("#importReadyRows").textContent = String(readyCount);
  $("#importDuplicateRows").textContent = String(duplicateCount);
  $("#importInvalidRows").textContent = String(errorCount);
  $("#bookImportResult").innerHTML = `
    <strong>${rows.length} row${rows.length === 1 ? "" : "s"} parsed</strong>
    <span>Sheet: ${escapeHtml(sheetName || "Register Data")} · Header row: ${headerRow || "-"}</span>
    <span>${readyCount} ready · ${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"} · ${errorCount} invalid</span>`;
  if (!rows.length) {
    renderEmpty($("#bookImportPreview"), "No rows found.");
    return;
  }
  $("#bookImportPreview").innerHTML = `
    <table class="import-validation-table">
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
          <tr class="${row.errors.length ? "validation-row-invalid" : "validation-row-ready"}">
            <td>${row.rowNumber}</td>
            <td class="${!row.accessionNumber ? "validation-cell-invalid" : ""}">${escapeHtml(row.accessionNumber)}</td>
            <td>${escapeHtml(row.author)}</td>
            <td class="${!row.title ? "validation-cell-invalid" : ""}">${escapeHtml(row.title)}</td>
            <td>${escapeHtml(row.placePublisher)}</td>
            <td>${escapeHtml(row.year)}</td>
            <td>${escapeHtml(row.pages)}</td>
            <td>${escapeHtml(row.cost)}</td>
            <td>${escapeHtml(row.imageUrl)}</td>
            <td>${row.duplicateType && skipDuplicates
              ? `<span class="badge badge-pending">Skipped duplicate</span>`
              : row.errors.length
                ? `<span class="validation-message">${escapeHtml(row.errors.join("; "))}</span>`
                : row.action === "update"
                  ? `<span class="badge badge-approved">Ready to update</span>`
                  : `<span class="badge badge-available">Ready to import</span>`}</td>
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

    try {
      const savedKeys = await upsertReusableBookMetadata(registerData, "accession_register_import");
      if (savedKeys.length) {
        console.log("[SLD] Import taught metadata:", savedKeys);
      }
    } catch (metadataError) {
      console.warn("[SLD] Import metadata upsert failed:", metadataError);
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
  pendingBookImportMatrix = [];
  pendingBookImportSheetName = "";
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
  return normalizeBarcode(code).replace(/[/\\?#\[\]*]/g, "_");
}

function normalizeLocalMetadata(data = {}, cleanCode = "") {
  const title = data.title || data.bname || data.bookTitle || "";
  const isbn = data.isbn || data.isbn13 || data.isbn10 || cleanCode;
  const placePublisher = data.placePublisher || data.publisher || "";
  return {
    title,
    authors: data.author || data.authors || "",
    publisher: placePublisher,
    placePublisher,
    year: data.year || data.publishedDate || "",
    pages: data.pages || data.pageCount || "",
    volume: data.volume || "",
    subject: data.subject || "",
    category: data.category || inferCategory(title),
    imageUrl: data.imageUrl || "",
    publisherBarcode: data.publisherBarcode || cleanCode,
    isbn,
    isbn13: String(isbn).length === 13 ? isbn : "",
    isbn10: String(isbn).length === 10 ? isbn : "",
    source: "Self Learning DB",
    metadataSource: "sld",
    raw: data
  };
}

function setSldStatus(message = SLD_STATUS.notFound, type = "") {
  const status = document.getElementById("sldStatusIndicator");
  if (!status) return;
  status.textContent = message;
  status.dataset.state = type || "";
}

async function upsertReusableBookMetadata(record = collectBookMetadata(), source = "manual") {
  const metadata = collectReusableMetadata(record);
  if (!hasReusableMetadata(metadata)) return [];
  const keys = metadataKeyCandidates(metadata);
  if (!keys.length) return [];

  const savedKeys = [];
  for (const keyInfo of keys) {
    console.log("[SLD] Lookup key:", keyInfo.key);
    const ref = doc(db, "bookMetadata", keyInfo.key);
    const existingSnap = await getDoc(ref);
    const existing = existingSnap.exists() ? existingSnap.data() : {};
    const publicMetadata = mergeReusableMetadata(existing, metadata);
    const payload = {
      ...reusableMetadataPayload(publicMetadata, keyInfo, {
        source: normalizeProviderSource(source, existing.source),
        existing,
        existingSource: existing.source
      }),
      usageCount: Number(existing.usageCount || 0) + 1,
      updatedAt: serverTimestamp(),
      updatedBy: session.user.uid
    };
    if (!existingSnap.exists()) {
      payload.createdAt = serverTimestamp();
      payload.createdBy = session.user.uid;
    } else if (existing.createdAt) {
      payload.createdAt = existing.createdAt;
    }
    if (existing.createdBy) payload.createdBy = existing.createdBy;

    await setDoc(ref, payload);
    console.log("[SLD] Upsert saved:", keyInfo.key);
    savedKeys.push(keyInfo.key);
  }
  return savedKeys;
}

async function saveBookMetadataForFuture(source = "manual") {
  const metadata = collectBookMetadata();
  if (!metadata.isbn && !metadata.publisherBarcode && !metadata.title) {
    throw new Error("Enter ISBN/publisher barcode or title before saving metadata.");
  }
  if (!metadata.title && !metadata.author) {
    throw new Error("Title or Author is required before saving metadata.");
  }
  const savedKeys = await upsertReusableBookMetadata(metadata, source);
  if (!savedKeys.length) {
    throw new Error("No reusable metadata was available to save.");
  }
  setSldStatus(SLD_STATUS.saved, "saved");
  return savedKeys;
}

function localBookForRequest(request = {}) {
  const bookDocId = request.bookId || request.b_id;
  return latestBooks.find((item) => item.id === bookDocId || item.data.b_id === bookDocId)?.data || null;
}

function bookHasIssueConflict(book = {}) {
  return String(book.status || "").toLowerCase() !== "available"
    || Boolean(book.currentIssueId || book.issuedStudentUid || book.issuedTo);
}

async function activeIssueConflictForBook(bookDocumentId, legacyBookId = "") {
  const identifiers = [...new Set([bookDocumentId, legacyBookId].filter(Boolean))];
  if (!identifiers.length) return false;
  const snapshots = await Promise.all(identifiers.flatMap((value) => [
    getDocs(query(collection(db, "bookIssues"), where("bookId", "==", value))),
    getDocs(query(collection(db, "bookIssues"), where("b_id", "==", value)))
  ]));
  return snapshots.some((snap) => snap.docs.some((item) => item.data().status === "issued"));
}

function localBookForIssue(issue = {}) {
  const bookDocId = issue.bookId || issue.b_id;
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

function asDate(value) {
  if (!value) return null;
  if (value.toDate) return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pickupWindowLabel(request = {}) {
  const parts = [
    request.pickupDate || "",
    request.pickupStartTime && request.pickupEndTime ? `${request.pickupStartTime} - ${request.pickupEndTime}` : ""
  ].filter(Boolean);
  return parts.join(", ") || "-";
}

function pickupExpired(request = {}, now = new Date()) {
  const expiresAt = asDate(request.pickupExpiresAt);
  return Boolean(expiresAt && expiresAt.getTime() < now.getTime());
}

async function approveForPickup(requestId, pickup = {}) {
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
  if (await activeIssueConflictForBook(precheckData.bookId, precheckData.b_id)) {
    throw new Error("This book has a conflicting active issue and is not available.");
  }
  const eligibility = await canStudentIssueBook({
    uid: precheckData.studentUid,
    studentUid: precheckData.studentUid,
    name: precheckData.studentName,
    email: precheckData.studentEmail,
    rollNumber: precheckData.rollNumber
  });
  if (!eligibility.eligible) {
    const error = issueEligibilityError(eligibility);
    error.message = `Cannot approve. Student has unresolved library dues. Pending Penalty: Rs.${Number(eligibility.totalPendingPenalty || 0).toFixed(2)}. Overdue Books: ${eligibility.overdueBooks || 0}.`;
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

    const bookDocId = requestData.bookId || requestData.b_id;
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
    if (bookHasIssueConflict(bookData)) {
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

    const studentData = studentSnap.exists() ? studentSnap.data() : {};
    const studentName = requestData.studentName || studentData.name || "Unknown student";
    const studentEmail = requestData.studentEmail || studentData.email || "";
    const expiresAtDate = new Date(pickup.expiresAt);
    if (Number.isNaN(expiresAtDate.getTime())) {
      throw new Error("Enter a valid pickup expiration time.");
    }
    const requestUpdate = {
      status: "approved_for_pickup",
      pickupDate: pickup.date || "",
      pickupStartTime: pickup.startTime || "",
      pickupEndTime: pickup.endTime || "",
      pickupNotes: pickup.notes || "",
      pickupExpiresAt: Timestamp.fromDate(expiresAtDate),
      approvedForPickupBy: auth.currentUser.uid,
      approvedForPickupAt: serverTimestamp(),
      reviewedBy: auth.currentUser.uid,
      reviewedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    console.log("Updating issue request for pickup approval:", { requestId, requestUpdate });
    transaction.update(requestRef, requestUpdate);
    notificationPayload = {
      studentUid: requestData.studentUid,
      studentName,
      studentEmail,
      bookTitle: requestData.title || requestData.bookTitle || requestData.bname || bookTitle(bookData),
      pickupDate: requestUpdate.pickupDate,
      pickupStartTime: requestUpdate.pickupStartTime,
      pickupEndTime: requestUpdate.pickupEndTime,
      pickupNotes: requestUpdate.pickupNotes
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

async function markIssuedRequest(requestId) {
  console.log("Mark issued requestId:", requestId);
  const requestRef = doc(db, "issueRequests", requestId);
  const precheckSnap = await getDoc(requestRef);
  if (!precheckSnap.exists()) {
    throw new Error("Issue request not found.");
  }
  const precheckData = precheckSnap.data();
  if (precheckData.status !== "approved_for_pickup") {
    throw new Error("Only pickup-approved requests can be marked issued.");
  }
  if (await activeIssueConflictForBook(precheckData.bookId, precheckData.b_id)) {
    throw new Error("This book has a conflicting active issue and is not available.");
  }
  if (pickupExpired(precheckData)) {
    await updateDoc(requestRef, {
      status: "expired",
      expiredAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    throw new Error("This pickup approval has expired. Ask the student to request again.");
  }
  const eligibility = await canStudentIssueBook({
    uid: precheckData.studentUid,
    studentUid: precheckData.studentUid,
    name: precheckData.studentName,
    email: precheckData.studentEmail,
    rollNumber: precheckData.rollNumber,
    enrollmentNumber: precheckData.enrollmentNumber
  });
  if (!eligibility.eligible) {
    const error = issueEligibilityError(eligibility);
    error.message = `Cannot issue. Student has unresolved library dues. Pending Penalty: Rs.${Number(eligibility.totalPendingPenalty || 0).toFixed(2)}. Overdue Books: ${eligibility.overdueBooks || 0}.`;
    throw error;
  }

  let notificationPayload = null;
  const transactionResult = await runTransaction(db, async (transaction) => {
    const requestSnap = await transaction.get(requestRef);
    if (!requestSnap.exists()) {
      throw new Error("Issue request not found.");
    }

    const requestData = requestSnap.data();
    if (requestData.status !== "approved_for_pickup") {
      throw new Error("Only pickup-approved requests can be marked issued.");
    }
    if (pickupExpired(requestData)) {
      transaction.update(requestRef, {
        status: "expired",
        expiredAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      return { expired: true };
    }

    const issueRef = doc(collection(db, "bookIssues"));
    const issueId = issueRef.id;
    const bookDocId = requestData.bookId || requestData.b_id;
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
    if (bookHasIssueConflict(bookData)) {
      transaction.update(requestRef, {
        status: "rejected",
        reviewedBy: auth.currentUser.uid,
        reviewedAt: serverTimestamp(),
        rejectionReason: "Book already issued or unavailable.",
        updatedAt: serverTimestamp()
      });
      return { conflict: true };
    }
    const studentData = studentSnap.exists() ? studentSnap.data() : {};
    const studentName = requestData.studentName || studentData.name || "Unknown student";
    const studentEmail = requestData.studentEmail || studentData.email || "";
    const studentPhone = requestData.studentPhone || studentData.phone || "";
    const issuedAt = new Date();
    const dueAt = addDays(issuedAt, 45);
    const issuePayload = {
      issueId,
      requestId,
      studentUid: requestData.studentUid,
      studentName,
      studentEmail,
      studentPhone,
      b_id: requestData.b_id || bookData.b_id || bookDocId,
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
      issueDate: Timestamp.fromDate(issuedAt),
      issuedAt: Timestamp.fromDate(issuedAt),
      dueDate: Timestamp.fromDate(dueAt),
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
      status: "issued",
      reviewedBy: auth.currentUser.uid,
      reviewedAt: serverTimestamp(),
      issuedBy: auth.currentUser.uid,
      issuedAt: serverTimestamp(),
      issueId,
      updatedAt: serverTimestamp()
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
      issueDate: issuedAt,
      dueDate: dueAt
    };
    return { conflict: false };
  });

  if (transactionResult?.conflict) {
    return { conflict: true };
  }
  if (transactionResult?.expired) {
    throw new Error("This pickup approval has expired. Ask the student to request again.");
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

    if (!["pending", "approved_for_pickup"].includes(requestData.status)) {
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
  return normalizeBarcode(rawCode);
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
    google: "Found in Google Books",
    google_books: "Found in Google Books",
    openlibrary: "Found in Open Library",
    open_library: "Found in Open Library",
    loc: "Fetched from Library of Congress",
    indcat: "Fetched from INDCAT",
    local: "Found from Existing Book",
    local_book: "Found from Existing Book",
    sld: "Found in Self Learning DB",
    self_learning: "Found in Self Learning DB",
    online: "Found online"
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
    year: info.publishedDate || "",
    pages: info.pageCount ? String(info.pageCount) : "",
    volume: "",
    isbn13,
    isbn10,
    isbn: isbn13 || isbn10 || cleanCode,
    source: "Google Books",
    metadataSource: "google_books",
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
    year: data.publish_date || "",
    pages: data.number_of_pages ? String(data.number_of_pages) : "",
    volume: "",
    isbn13: Array.isArray(data.isbn_13) ? data.isbn_13[0] : "",
    isbn10: Array.isArray(data.isbn_10) ? data.isbn_10[0] : "",
    isbn: (Array.isArray(data.isbn_13) && data.isbn_13[0]) || (Array.isArray(data.isbn_10) && data.isbn_10[0]) || cleanCode,
    source: "Open Library ISBN",
    metadataSource: "open_library",
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
    year: doc.first_publish_year ? String(doc.first_publish_year) : "",
    pages: "",
    volume: "",
    isbn13: Array.isArray(doc.isbn) ? doc.isbn.find((item) => String(item).length === 13) || "" : "",
    isbn10: Array.isArray(doc.isbn) ? doc.isbn.find((item) => String(item).length === 10) || "" : "",
    isbn: cleanCode,
    source: "Open Library Search",
    metadataSource: "open_library",
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
  const isbn = normalizeIsbn(cleanCode);
  const barcode = normalizeBarcode(cleanCode);
  const candidateKeys = [
    createMetadataKey("isbn", isbn),
    createMetadataKey("publisherBarcode", barcode),
    metadataDocId(cleanCode)
  ].filter(Boolean);

  for (const key of [...new Set(candidateKeys)]) {
    console.log("[SLD] Lookup key:", key);
    try {
      const docSnap = await getDoc(doc(db, "bookMetadata", key));
      if (docSnap.exists()) {
        const metadata = normalizeLocalMetadata(docSnap.data(), cleanCode);
        console.log("[SLD] Found metadata:", metadata);
        return metadata;
      }
    } catch (error) {
      console.warn("[SLD] Lookup failed:", error);
    }
  }

  const isbnValues = [...new Set([isbn, cleanCode].filter(Boolean))];
  for (const value of isbnValues) {
    try {
      console.log("[SLD] Lookup key:", `isbn == ${value}`);
      const isbnSnap = await getDocs(query(collection(db, "bookMetadata"), where("isbn", "==", value), limit(1)));
      if (!isbnSnap.empty) {
        const metadata = normalizeLocalMetadata(isbnSnap.docs[0].data(), cleanCode);
        console.log("[SLD] Found metadata:", metadata);
        return metadata;
      }
    } catch (error) {
      console.warn("[SLD] Lookup failed:", error);
    }
  }

  const barcodeValues = [...new Set([barcode, cleanCode].filter(Boolean))];
  for (const value of barcodeValues) {
    try {
      console.log("[SLD] Lookup key:", `publisherBarcode == ${value}`);
      const barcodeSnap = await getDocs(query(collection(db, "bookMetadata"), where("publisherBarcode", "==", value), limit(1)));
      if (!barcodeSnap.empty) {
        const metadata = normalizeLocalMetadata(barcodeSnap.docs[0].data(), cleanCode);
        console.log("[SLD] Found metadata:", metadata);
        return metadata;
      }
    } catch (error) {
      console.warn("[SLD] Lookup failed:", error);
    }
  }

  return null;
}

async function findLocalMetadataByTitle(title) {
  const keywords = titleKeywords(title);
  if (!keywords.length) return null;
  const key = createMetadataKey("titleAuthor", title);
  console.log("[SLD] Lookup key:", key);
  try {
    const direct = await getDoc(doc(db, "bookMetadata", key));
    if (direct.exists()) {
      const metadata = normalizeLocalMetadata(direct.data(), key);
      console.log("[SLD] Found metadata:", metadata);
      return metadata;
    }
  } catch (error) {
    console.warn("[SLD] Lookup failed:", error);
  }

  for (const keywordField of ["titleKeywords", "bnameKeywords"]) {
    try {
      const snap = await getDocs(query(collection(db, "bookMetadata"), where(keywordField, "array-contains", keywords[0]), limit(10)));
      const normalizedTitle = String(title || "").toLowerCase();
      const found = snap.docs.find((item) => {
        const name = String(item.data().title || item.data().bname || "").toLowerCase();
        return keywords.some((word) => name.includes(word)) || normalizedTitle.includes(name);
      }) || snap.docs[0];
      if (found) {
        const metadata = normalizeLocalMetadata(found.data(), found.id);
        console.log("[SLD] Found metadata:", metadata);
        return metadata;
      }
    } catch (error) {
      console.warn("[SLD] Lookup failed:", error);
    }
  }
  return null;
}

function applyBookMetadataToForm(info = {}, cleanCode = "") {
  const bnameEl = document.getElementById("bnameInput");
  const subjectEl = document.getElementById("subjectInput");
  const authorEl = document.getElementById("authorInput");
  const publisherEl = document.getElementById("publisherInput");
  const isbnEl = document.getElementById("isbnInput");
  const imageUrlEl = document.getElementById("imageUrlInput");
  const publisherBarcodeEl = document.getElementById("publisherBarcodeInput");
  const metadataSourceEl = document.getElementById("metadataSourceInput");
  const yearEl = document.getElementById("yearInput");
  const pagesEl = document.getElementById("pagesInput");
  const volumeEl = document.getElementById("volumeInput");

  if (bnameEl && info.title) bnameEl.value = info.title;
  if (subjectEl) subjectEl.value = info.subject || info.category || inferSubject(info.title) || "General";
  $("#category").value = info.category || inferCategory(info.title);
  if (authorEl && info.authors) authorEl.value = info.authors;
  if (publisherEl && (info.placePublisher || info.publisher)) publisherEl.value = info.placePublisher || info.publisher;
  if (isbnEl) isbnEl.value = info.isbn || info.isbn13 || info.isbn10 || cleanCode;
  if (imageUrlEl && info.imageUrl) imageUrlEl.value = info.imageUrl;
  if (yearEl && info.year) yearEl.value = info.year;
  if (pagesEl && info.pages) pagesEl.value = info.pages;
  if (volumeEl && info.volume) volumeEl.value = info.volume;
  if (publisherBarcodeEl && cleanCode) publisherBarcodeEl.value = cleanCode;
  if (metadataSourceEl) metadataSourceEl.value = info.metadataSource || "";
  setMetadataSourceBadge(info.metadataSource);

  $("#bookFetchPreview").innerHTML = `
    <article class="book-preview">
      <img src="${escapeHtml(info.imageUrl || "assets/book-placeholder.svg")}" alt="">
      <div>
        <strong>${escapeHtml(info.title || "Untitled book")}</strong>
        <span>${escapeHtml(info.authors || "Unknown author")}</span>
        <span>${escapeHtml(info.placePublisher || info.publisher || "Publisher not found")}</span>
        <span>${escapeHtml(info.source || "Book metadata")}</span>
      </div>
    </article>`;
}

async function lookupBookMetadata(rawCode) {
  const cleanCode = cleanBookMetadataCode(rawCode);
  const typedTitle = $("#bnameInput")?.value?.trim() || "";
  console.log("lookupBookMetadata diagnostics:", { rawCode, cleanCode, typedTitle });

  if (!cleanCode && !typedTitle) {
    throw new Error("Enter or scan ISBN/publisher barcode first.");
  }

  setSldStatus(SLD_STATUS.searching, "searching");
  const attempts = [];
  const lookups = [
    {
      source: "Self Learning DB",
      url: cleanCode ? `bookMetadata isbn/publisherBarcode keys for ${cleanCode}` : `bookMetadata title keywords for ${typedTitle}`,
      getResult: async () => cleanCode ? findLocalMetadata(cleanCode) : findLocalMetadataByTitle(typedTitle)
    },
    {
      source: "Existing Book",
      url: `Firestore books where publisherBarcode/isbn == ${cleanCode}`,
      getResult: async () => {
        const cleanIsbn = normalizeIsbn(cleanCode);
        const cleanBarcode = normalizeBarcode(cleanCode);
        const localMatches = latestBooks.find(({ data }) =>
          normalizeBarcode(data.publisherBarcode) === cleanBarcode
          || normalizeIsbn(data.isbn) === cleanIsbn
        );
        return localMatches ? {
          title: localMatches.data.title || localMatches.data.bname || localMatches.data.bookTitle || "",
          authors: localMatches.data.author || "",
          publisher: localMatches.data.placePublisher || localMatches.data.publisher || "",
          placePublisher: localMatches.data.placePublisher || localMatches.data.publisher || "",
          year: localMatches.data.year || "",
          pages: localMatches.data.pages || "",
          volume: localMatches.data.volume || "",
          subject: localMatches.data.subject || "",
          category: localMatches.data.category || inferCategory(localMatches.data.title || localMatches.data.bname || ""),
          imageUrl: localMatches.data.imageUrl || "",
          isbn: localMatches.data.isbn || cleanCode,
          isbn13: String(localMatches.data.isbn || cleanCode).length === 13 ? localMatches.data.isbn || cleanCode : "",
          isbn10: String(localMatches.data.isbn || cleanCode).length === 10 ? localMatches.data.isbn || cleanCode : "",
          source: "Existing Book",
          metadataSource: "local_book",
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
      url: `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(cleanCode || typedTitle)}`,
      getCount: (data) => data.items?.length || 0,
      getResult: (data) => data.items?.[0]?.volumeInfo ? normalizeGoogleBook(data.items[0].volumeInfo, cleanCode || typedTitle) : null
    },
    {
      source: "Open Library ISBN",
      url: `https://openlibrary.org/isbn/${encodeURIComponent(cleanCode)}.json`,
      getCount: (data) => data.title ? 1 : 0,
      getResult: async (data) => data.title ? normalizeOpenLibraryIsbn(data, cleanCode) : null
    },
    {
      source: "Open Library Search",
      url: cleanCode
        ? `https://openlibrary.org/search.json?isbn=${encodeURIComponent(cleanCode)}`
        : `https://openlibrary.org/search.json?title=${encodeURIComponent(typedTitle)}`,
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
    if (lookup.source === "Self Learning DB") {
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
        selectedSource: localMetadata ? "Self Learning DB" : ""
      });
      if (localMetadata) {
        setSldStatus(SLD_STATUS.foundSld, "found");
        return localMetadata;
      }
      continue;
    }

    if (lookup.source === "Existing Book") {
      if (!cleanCode) continue;
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
        selectedSource: localResult ? "Existing Book" : ""
      });
      if (localResult) {
        setSldStatus(SLD_STATUS.foundExisting, "found-existing");
        return localResult;
      }
      continue;
    }

    if (!cleanCode && (lookup.source === "Google Books ISBN" || lookup.source === "Open Library ISBN" || lookup.source === "INDCAT")) {
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
          setSldStatus(SLD_STATUS.foundOnline, "found-online");
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

  setSldStatus(SLD_STATUS.notFound, "not-found");
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
      setMetadataSourceBadge("");
      setSldStatus(SLD_STATUS.notFound, "not-found");
      showToast("No online metadata found. Please enter details once. Future scans will auto-fill from local database.", "warning");
      return;
    }

    applyBookMetadataToForm(info, cleanCode);
    const successMessage = info.metadataSource === "sld"
      ? "Book details loaded from Self Learning DB."
      : info.metadataSource === "local_book"
        ? "Book details filled from an existing book record."
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
    setSldStatus(SLD_STATUS.notFound, "not-found");
  }
}

async function checkSavedMetadataForCurrentCode() {
  const barcodeInput = document.getElementById("publisherBarcodeInput");
  const cleanCode = cleanGoogleBookCode(barcodeInput?.value);
  if (!cleanCode) return;
  setSldStatus(SLD_STATUS.searching, "searching");
  try {
    const info = await findLocalMetadata(cleanCode);
    if (!info) {
      setSldStatus(SLD_STATUS.notFound, "not-found");
      return;
    }
    applyBookMetadataToForm(info, cleanCode);
    setSldStatus(SLD_STATUS.foundSld, "found");
    showToast("Book details loaded from Self Learning DB.", "success");
  } catch (error) {
    console.warn("[SLD] Lookup failed:", error);
    setSldStatus(SLD_STATUS.notFound, "not-found");
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
    await fetchGoogleBook();
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
    setSldStatus(SLD_STATUS.notFound, "not-found");
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

function requestStateForBook(item) {
  const accession = String(accessionNumberOf(item.data) || "").toLowerCase();
  const legacyId = String(item.data.b_id || "");
  const request = latestPendingRequests.find(({ data }) => {
    const requestBookId = String(data.bookId || data.b_id || "");
    const requestAccession = String(data.accessionNumber || "").toLowerCase();
    return requestBookId === item.id
      || (legacyId && requestBookId === legacyId)
      || (accession && requestAccession === accession);
  });
  if (request?.data?.status === "approved_for_pickup") return "reserved";
  if (request?.data?.status === "pending") return "requested";
  return "";
}

function displayBookStatus(item) {
  const persisted = String(item.data.status || "available").toLowerCase();
  return persisted === "available" ? (requestStateForBook(item) || persisted) : persisted;
}

function filteredBookRows() {
  const search = bookSearch.value.trim().toLowerCase();
  const categoryFilter = String(bookCategoryFilter?.value || "").toLowerCase();
  const availabilityFilter = String(bookAvailabilityFilter?.value || "").toLowerCase();
  const sortMode = bookSort?.value || "accessionAsc";
  return bookDatabaseRows
    .filter(({ data }) => {
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
      return true;
    })
    .filter((item) => !availabilityFilter || displayBookStatus(item) === availabilityFilter)
    .sort((left, right) => {
      if (sortMode === "accessionDesc") {
        return compareAccessionNumbers(accessionNumberOf(right.data), accessionNumberOf(left.data));
      }
      if (sortMode === "titleAsc") {
        return bookTitle(left.data).localeCompare(bookTitle(right.data), undefined, { sensitivity: "base" });
      }
      if (sortMode === "authorAsc") {
        return String(left.data.author || "").localeCompare(String(right.data.author || ""), undefined, { sensitivity: "base" });
      }
      return compareAccessionNumbers(accessionNumberOf(left.data), accessionNumberOf(right.data));
    });
}

function currentBookDatabaseRows() {
  const rows = filteredBookRows();
  if (!bookDatabaseSearchMode) return rows;
  const totalPages = Math.max(1, Math.ceil(rows.length / BOOK_DATABASE_PAGE_SIZE));
  bookDatabasePage = Math.min(Math.max(1, bookDatabasePage), totalPages);
  const start = (bookDatabasePage - 1) * BOOK_DATABASE_PAGE_SIZE;
  return rows.slice(start, start + BOOK_DATABASE_PAGE_SIZE);
}

function renderBookDatabasePagination(totalPages) {
  const target = $("#bookDatabasePagination");
  if (!target) return;
  if (totalPages <= 1) {
    target.innerHTML = "";
    return;
  }
  target.innerHTML = `
    <button type="button" class="btn btn-muted" data-book-page="${bookDatabasePage - 1}" ${bookDatabasePage === 1 ? "disabled" : ""}>Previous</button>
    <span class="pagination-status">Page ${bookDatabasePage} of ${totalPages}</span>
    <button type="button" class="btn btn-muted" data-book-page="${bookDatabasePage + 1}" ${bookDatabasePage === totalPages ? "disabled" : ""}>Next</button>`;
}

function renderBooksTable() {
  const allRows = filteredBookRows();
  const matchingTotal = bookDatabaseSearchMode ? allRows.length : bookDatabaseTotal;
  const totalPages = Math.max(1, Math.ceil(matchingTotal / BOOK_DATABASE_PAGE_SIZE));
  bookDatabasePage = Math.min(Math.max(1, bookDatabasePage), totalPages);
  const rows = currentBookDatabaseRows();
  const target = $("#booksTable");
  const firstVisible = matchingTotal && rows.length ? ((bookDatabasePage - 1) * BOOK_DATABASE_PAGE_SIZE) + 1 : 0;
  const lastVisible = Math.min(firstVisible + rows.length - 1, matchingTotal);
  $("#bookDatabaseSummary").innerHTML = `<strong>${matchingTotal} matching record${matchingTotal === 1 ? "" : "s"}</strong><span>Showing ${firstVisible}–${Math.max(firstVisible, lastVisible)} of ${matchingTotal} · Page ${bookDatabasePage} of ${totalPages}${bookDatabaseSearchMode ? " · complete-library search" : ""}</span>`;
  renderBookDatabasePagination(totalPages);
  renderBookExportSummary();
  if (!rows.length) {
    renderEmpty(target, "No matching books found.");
    return;
  }

  target.innerHTML = `
    <table class="book-database-table">
      <thead>
        <tr>
          <th>Accession No.</th>
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
          <th>Status</th>
          <th>Issued Student UID</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((item) => {
          const { id, data } = item;
          const status = displayBookStatus(item);
          return `
          <tr data-book-id="${escapeHtml(id)}">
            <td>${escapeHtml(accessionNumberOf(data) || "-")}</td>
            <td>${escapeHtml(data.accessionDate || "-")}</td>
            <td><span class="table-text-clip" title="${escapeHtml(data.author || "-")}">${escapeHtml(data.author || "-")}</span></td>
            <td><strong class="table-text-clip" title="${escapeHtml(bookTitle(data) || "-")}">${escapeHtml(bookTitle(data) || "-")}</strong></td>
            <td><span class="table-text-clip" title="${escapeHtml(data.placePublisher || data.publisher || "-")}">${escapeHtml(data.placePublisher || data.publisher || "-")}</span></td>
            <td>${escapeHtml(data.year || "-")}</td>
            <td>${escapeHtml(data.pages || "-")}</td>
            <td>${escapeHtml(data.volume || "-")}</td>
            <td>${escapeHtml(data.source || "-")}</td>
            <td>${escapeHtml(data.billNoDate || "-")}</td>
            <td>${escapeHtml(data.cost || "-")}</td>
            <td>${statusBadge(status)}</td>
            <td>${escapeHtml(data.status === "issued" ? (data.issuedStudentUid || data.issuedTo || "-") : "-")}</td>
            <td class="database-action-cell">
              <div class="row-actions database-primary-actions">
                <button type="button" class="btn btn-muted" data-book-action="view">View</button>
                <button type="button" class="btn btn-muted" data-book-action="edit">Edit</button>
                ${session.profile.role === "admin" ? `<button type="button" class="btn btn-danger-soft" data-book-action="delete">Delete</button>` : ""}
                <details class="row-action-menu">
                  <summary aria-label="More book actions">More</summary>
                  <div>
                    <button type="button" class="btn btn-muted" data-book-action="print">Print Barcode</button>
                ${data.status === "lost"
                  ? `<button type="button" class="btn btn-primary" data-book-action="found">Mark Found</button>`
                  : `<button type="button" class="btn btn-muted" data-book-action="lost">Mark Lost</button>`}
                    <button type="button" class="btn btn-muted" data-book-action="damaged">Mark Damaged</button>
                  </div>
                </details>
              </div>
            </td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;
}

function cacheLoadedBooks(rows = []) {
  const byId = new Map(latestBooks.map((item) => [item.id, item]));
  rows.forEach((item) => byId.set(item.id, item));
  latestBooks = [...byId.values()];
}

async function loadAllBooksIncrementally(sequence = null) {
  const rows = [];
  let cursor = null;
  while (true) {
    const constraints = [orderBy(documentId()), limit(BOOK_DATABASE_SCAN_SIZE)];
    if (cursor) constraints.splice(1, 0, startAfter(cursor));
    const snap = await getDocs(query(collection(db, "books"), ...constraints));
    rows.push(...snap.docs.map((item) => ({ id: item.id, data: item.data() })));
    if (sequence !== null && sequence !== bookDatabaseLoadSequence) return null;
    if (snap.size < BOOK_DATABASE_SCAN_SIZE) return rows;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

function hasBookDatabaseCriteria() {
  return Boolean(
    bookSearch.value.trim()
    || bookCategoryFilter?.value
    || bookAvailabilityFilter?.value
    || (bookSort?.value && bookSort.value !== "accessionAsc")
  );
}

async function loadBookDatabasePage(page = 1) {
  const sequence = ++bookDatabaseLoadSequence;
  bookDatabaseSearchMode = false;
  const requestedPage = Math.max(1, Number(page || 1));
  const cursor = bookDatabasePageCursors[requestedPage - 1];
  if (requestedPage > 1 && !cursor) return;
  const constraints = [orderBy(documentId()), limit(BOOK_DATABASE_PAGE_SIZE)];
  if (cursor) constraints.splice(1, 0, startAfter(cursor));
  const snap = await getDocs(query(collection(db, "books"), ...constraints));
  if (sequence !== bookDatabaseLoadSequence) return;
  bookDatabaseRows = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
  cacheLoadedBooks(bookDatabaseRows);
  bookDatabasePage = requestedPage;
  if (snap.docs.length) bookDatabasePageCursors[requestedPage] = snap.docs[snap.docs.length - 1];
  renderBooksTable();
  renderRecentActivity();
}

async function scanBookDatabase() {
  const sequence = ++bookDatabaseLoadSequence;
  bookDatabaseSearchMode = true;
  bookDatabasePage = 1;
  renderEmpty($("#booksTable"), "Searching the complete book collection…");
  const allRows = await loadAllBooksIncrementally(sequence);
  if (!allRows) return;
  bookDatabaseRows = allRows;
  cacheLoadedBooks(allRows);
  renderBooksTable();
}

async function refreshBookDatabase() {
  if (hasBookDatabaseCriteria()) {
    const search = bookSearch.value.trim();
    if (search && !bookCategoryFilter?.value && !bookAvailabilityFilter?.value && (!bookSort?.value || bookSort.value === "accessionAsc")) {
      try {
        const direct = await findBookByLibraryCode(search);
        const directItem = { id: direct.id, data: direct };
        if (normalizeAccessionNumber(accessionNumberValue(direct)) === normalizeAccessionNumber(search)) {
          bookDatabaseSearchMode = true;
          bookDatabasePage = 1;
          bookDatabaseRows = [directItem];
          cacheLoadedBooks(bookDatabaseRows);
          renderBooksTable();
          return;
        }
      } catch {
        // Fall through to the complete-library text scan.
      }
    }
    await scanBookDatabase();
    return;
  }
  bookDatabasePageCursors = [null];
  await loadBookDatabasePage(1);
}

async function refreshBookMetrics() {
  const booksRef = collection(db, "books");
  const statuses = ["available", "issued", "lost", "damaged", "requested", "reserved", "missing"];
  const [totalSnap, ...statusSnaps] = await Promise.all([
    getCountFromServer(booksRef),
    ...statuses.map((status) => getCountFromServer(query(booksRef, where("status", "==", status))))
  ]);
  const total = totalSnap.data().count;
  const counts = Object.fromEntries(statuses.map((status, index) => [status, statusSnaps[index].data().count]));
  const booksWithoutKnownStatus = Math.max(0, total - statuses.reduce((sum, status) => sum + counts[status], 0));
  counts.available += booksWithoutKnownStatus;
  bookDatabaseTotal = total;
  const metricMap = {
    metricTotalBooks: total,
    metricIssuedBooks: counts.issued,
    metricAvailableBooks: counts.available,
    metricLostBooks: counts.lost,
    metricDamagedBooks: counts.damaged
  };
  Object.entries(metricMap).forEach(([id, value]) => {
    const target = document.getElementById(id);
    if (target) target.textContent = String(value || 0);
  });
}

async function loadDuplicateCleanupPlan() {
  if (session.profile.role !== "admin") {
    throw new Error("Only an administrator can scan and delete duplicate book records.");
  }
  const [booksSnap, issuesSnap, issueRequestsSnap, returnRequestsSnap] = await Promise.all([
    getDocs(collection(db, "books")),
    getDocs(collection(db, "bookIssues")),
    getDocs(collection(db, "issueRequests")),
    getDocs(collection(db, "returnRequests"))
  ]);
  const books = booksSnap.docs.map((item) => ({ id: item.id, data: item.data() }));
  const references = [
    ...issuesSnap.docs.map((item) => ({ collection: "bookIssues", id: item.id, data: item.data() })),
    ...issueRequestsSnap.docs.map((item) => ({ collection: "issueRequests", id: item.id, data: item.data() })),
    ...returnRequestsSnap.docs.map((item) => ({ collection: "returnRequests", id: item.id, data: item.data() }))
  ];
  return buildDuplicateCleanupPlan(books, references);
}

function duplicateCandidateLabel(candidate, group) {
  if (candidate.id === group.canonical.id) return "Keep canonical";
  if (group.manualReview) return "Manual review";
  return "Delete duplicate";
}

function renderDuplicateCleanupPreview(plan) {
  pendingDuplicateCleanupPlan = plan;
  const summary = $("#duplicateCleanupSummary");
  const preview = $("#duplicateCleanupPreview");
  const confirmButton = $("#confirmDuplicateCleanupBtn");
  summary.innerHTML = `
    <span><strong>${plan.duplicateGroupCount}</strong>Duplicate groups</span>
    <span><strong>${plan.extraDuplicateCount}</strong>Extra records</span>
    <span class="summary-ready"><strong>${plan.deletableCount}</strong>Safe to delete</span>
    <span class="summary-warning"><strong>${plan.missingAccessionCount}</strong>Missing accession number</span>
    <span class="summary-invalid"><strong>${plan.skippedGroupCount}</strong>Manual review</span>`;
  confirmButton.toggleAttribute("disabled", plan.deletableCount === 0);

  if (!plan.groups.length) {
    renderEmpty(preview, "No duplicate accession numbers were found.");
    $("#duplicateCleanupResult").innerHTML = `<strong>No duplicates found</strong><span>${plan.totalBookCount} books · ${plan.uniqueAccessionCount} unique accession numbers · ${plan.missingAccessionCount} missing accession number</span>`;
    return;
  }

  preview.innerHTML = `
    <table class="duplicate-cleanup-table">
      <thead><tr><th>Accession Number</th><th>Title / Author</th><th>Document IDs</th><th>Status</th><th>Decision</th></tr></thead>
      <tbody>${plan.groups.map((group) => `
        <tr class="${group.manualReview ? "duplicate-review-row" : ""}">
          <td><strong>${escapeHtml(group.displayAccession)}</strong><span>${group.candidates.length} records</span></td>
          <td><strong>${escapeHtml(bookTitle(group.canonical.data) || "Untitled book")}</strong><span>${escapeHtml(group.canonical.data.author || "Unknown author")}</span></td>
          <td>${group.candidates.map((candidate) => `<span class="duplicate-doc-id"><code>${escapeHtml(candidate.id)}</code> · ${escapeHtml(duplicateCandidateLabel(candidate, group))}</span>`).join("")}</td>
          <td>${group.candidates.map((candidate) => statusBadge(candidate.data.status || "available")).join(" ")}</td>
          <td>${group.manualReview
            ? `<strong class="danger-text">Manual Review Required</strong><span>${escapeHtml(group.manualReviewReason)}</span>`
            : `<strong>${group.deletions.length} record${group.deletions.length === 1 ? "" : "s"} will be deleted</strong><span>${Object.keys(group.metadataPatch).length} metadata field${Object.keys(group.metadataPatch).length === 1 ? "" : "s"} will be merged</span>`}</td>
        </tr>`).join("")}</tbody>
    </table>`;
  $("#duplicateCleanupResult").innerHTML = `<strong>Preview only</strong><span>Review the document IDs and decisions before confirming. ${plan.missingAccessionCount} record${plan.missingAccessionCount === 1 ? " has" : "s have"} no accession number and ${plan.missingAccessionCount === 1 ? "is" : "are"} excluded from duplicate deletion.</span>`;
}

async function scanDuplicateBooks() {
  const preview = $("#duplicateCleanupPreview");
  const confirmButton = $("#confirmDuplicateCleanupBtn");
  confirmButton.disabled = true;
  renderEmpty(preview, "Scanning books and circulation references…");
  $("#duplicateCleanupResult").textContent = "No records have been changed.";
  const plan = await loadDuplicateCleanupPlan();
  renderDuplicateCleanupPreview(plan);
  return plan;
}

async function commitDuplicateCleanup(plan) {
  const operations = [];
  plan.groups.filter((group) => !group.manualReview && group.deletions.length).forEach((group) => {
    operations.push({
      type: "update",
      ref: doc(db, "books", group.canonical.id),
      data: {
        ...group.metadataPatch,
        duplicateCleanupAt: serverTimestamp(),
        duplicateCleanupBy: auth.currentUser.uid,
        duplicateCleanupDeletedIds: group.deletions.map((item) => item.id),
        updatedAt: serverTimestamp()
      }
    });
    group.deletions.forEach((candidate) => operations.push({
      type: "delete",
      ref: doc(db, "books", candidate.id)
    }));
  });

  for (let start = 0; start < operations.length; start += 400) {
    const batch = writeBatch(db);
    operations.slice(start, start + 400).forEach((operation) => {
      if (operation.type === "delete") batch.delete(operation.ref);
      else batch.update(operation.ref, operation.data);
    });
    await batch.commit();
  }
}

async function executeDuplicateCleanup() {
  if (session.profile.role !== "admin") throw new Error("Only an administrator can delete duplicate book records.");
  if (!pendingDuplicateCleanupPlan?.deletableCount) throw new Error("No safe duplicate records are ready for deletion.");

  const refreshedPlan = await loadDuplicateCleanupPlan();
  if (duplicateCleanupSignature(refreshedPlan) !== duplicateCleanupSignature(pendingDuplicateCleanupPlan)) {
    renderDuplicateCleanupPreview(refreshedPlan);
    throw new Error("Duplicate records changed after the preview. Review the refreshed scan and confirm again.");
  }

  await commitDuplicateCleanup(refreshedPlan);
  const finalBookCount = refreshedPlan.totalBookCount - refreshedPlan.deletableCount;
  $("#duplicateCleanupResult").innerHTML = `
    <strong>Duplicate cleanup complete</strong>
    <span>Duplicate groups found: ${refreshedPlan.duplicateGroupCount}</span>
    <span>Duplicates deleted: ${refreshedPlan.deletableCount}</span>
    <span>Canonical records kept: ${refreshedPlan.canonicalCount}</span>
    <span>Metadata merged: ${refreshedPlan.metadataMergeCount}</span>
    <span>Groups skipped for manual review: ${refreshedPlan.skippedGroupCount}</span>
    <span>Final books: ${finalBookCount} · Unique accessions: ${refreshedPlan.uniqueAccessionCount}</span>`;
  $("#confirmDuplicateCleanupBtn").disabled = true;
  pendingDuplicateCleanupPlan = null;
  return { ...refreshedPlan, finalBookCount };
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

function parseRegisterDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
  const localMatch = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (!localMatch) return null;
  let year = Number(localMatch[3]);
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  return new Date(year, Number(localMatch[2]) - 1, Number(localMatch[1]));
}

function applyExportFilters(items) {
  const category = String($("#exportCategoryFilter")?.value || "").toLowerCase();
  const status = String($("#exportStatusFilter")?.value || "").toLowerCase();
  const accessionFrom = String($("#exportAccessionFrom")?.value || "").trim();
  const accessionTo = String($("#exportAccessionTo")?.value || "").trim();
  const dateFrom = parseRegisterDate($("#exportDateFrom")?.value);
  const dateTo = parseRegisterDate($("#exportDateTo")?.value);
  return items.filter((item) => {
    const data = item.data;
    const accession = accessionNumberOf(data);
    const accessionDate = parseRegisterDate(data.accessionDate);
    if (category && String(data.category || "").toLowerCase() !== category) return false;
    if (status && displayBookStatus(item) !== status) return false;
    if (accessionFrom && compareAccessionNumbers(accession, accessionFrom) < 0) return false;
    if (accessionTo && compareAccessionNumbers(accession, accessionTo) > 0) return false;
    if (dateFrom && (!accessionDate || accessionDate < dateFrom)) return false;
    if (dateTo && (!accessionDate || accessionDate > dateTo)) return false;
    return true;
  });
}

function bookRowsForExport() {
  const scope = $("#exportScope")?.value || "all";
  const sourceRows = scope === "filtered"
    ? filteredBookRows()
    : scope === "currentPage"
      ? currentBookDatabaseRows()
      : latestBooks;
  return applyExportFilters(sourceRows);
}

function renderBookExportSummary() {
  const target = $("#bookExportSummary");
  if (!target) return;
  const rows = bookRowsForExport();
  const format = $("#exportFormat")?.value === "csv" ? "CSV" : "Excel";
  target.innerHTML = `<span>Matching book records</span><strong>${rows.length}</strong><small>Ready for ${format} export</small>`;
}

function exportBooksExcel(items = bookRowsForExport(), format = $("#exportFormat")?.value || "xlsx") {
  if (!window.XLSX) throw new Error("XLSX export library is not loaded.");
  if (!items.length) throw new Error("No book records match the selected export filters.");
  const rows = items.map(({ id, data }) => accessionExportRow({
      ...data,
      accessionNumber: accessionNumberOf(data),
      title: bookTitle(data),
      barcodeValue: data.barcodeValue || barcodeValueFor(accessionNumberOf(data), data.b_id || id)
    }, formatDate));
  const sheet = window.XLSX.utils.json_to_sheet(rows);
  if (format === "csv") {
    const csv = window.XLSX.utils.sheet_to_csv(sheet);
    const downloadUrl = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = "accession_register_export.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(downloadUrl);
    console.log("CSV download triggered:", "accession_register_export.csv");
    return;
  }
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
  barcodeInput.addEventListener("change", () => {
    checkSavedMetadataForCurrentCode().catch((error) => {
      console.warn("[SLD] Lookup failed:", error);
    });
  });
  barcodeInput.addEventListener("blur", () => {
    checkSavedMetadataForCurrentCode().catch((error) => {
      console.warn("[SLD] Lookup failed:", error);
    });
  });
  console.log("Metadata fetch click handler attached:", true);
});
$("#scanPublisherBtn").addEventListener("click", () => startPublisherScanner().catch((error) => {
  logDetailedError(error);
  showToast(error.message, "error");
}));
$("#saveMetadataBtn").addEventListener("click", async () => {
  try {
    await saveBookMetadataForFuture("manual");
    showToast("Saved to Self Learning DB.", "success");
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
async function processBookImportFile(file) {
  if (!file) return;
  pendingBookImportRows = [];
  pendingBookImportMatrix = [];
  pendingBookImportSheetName = "";
  $("#confirmBookImportBtn").disabled = true;
  ["importTotalRows", "importReadyRows", "importDuplicateRows", "importInvalidRows"]
    .forEach((id) => { document.getElementById(id).textContent = "0"; });
  if (!/\.(xlsx|csv)$/i.test(file.name || "")) {
    throw new Error("Choose an .xlsx or .csv accession register file.");
  }
  $("#bookImportFileName").textContent = file.name;
  $("#bookImportResult").textContent = "Reading and validating file...";
  latestBooks = await loadAllBooksIncrementally();
  const workbookData = await parseAccessionWorkbook(file, window.XLSX);
  pendingBookImportMatrix = workbookData.matrix;
  pendingBookImportSheetName = workbookData.sheetName;
  const parsed = normalizeBookImportRows(pendingBookImportMatrix);
  renderBookImportPreview(parsed.rows, workbookData.sheetName, parsed.sheetHeaderRow);
}

let bookDatabaseRefreshTimer = null;
function resetBookDatabasePage() {
  bookDatabasePage = 1;
  window.clearTimeout(bookDatabaseRefreshTimer);
  bookDatabaseRefreshTimer = window.setTimeout(() => {
    refreshBookDatabase().catch((error) => {
      logDetailedError(error);
      renderEmpty($("#booksTable"), error.message || "Could not load book records.");
    });
  }, 250);
}

function switchManagementModal(fromId, toId) {
  document.getElementById(fromId)?.classList.remove("open");
  document.getElementById(toId)?.classList.add("open");
  document.body.classList.add("modal-open");
}

document.addEventListener("click", (event) => {
  const opener = event.target.closest(".management-modal [data-open-modal]");
  const current = opener?.closest(".modal-backdrop");
  if (opener && current && current.id !== opener.dataset.openModal) {
    current.classList.remove("open");
  }
});

$("#importBooksBtn").addEventListener("click", () => $("#bookImportFile").click());
$("#bookImportFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    await processBookImportFile(file);
    showToast("Book import preview ready.", "success");
  } catch (error) {
    logDetailedError(error);
    showToast(error.message || "Could not parse book import file.", "error");
  } finally {
    event.target.value = "";
  }
});
const bookImportDropZone = $("#bookImportDropZone");
bookImportDropZone?.addEventListener("click", (event) => {
  if (!event.target.closest("button")) $("#bookImportFile").click();
});
bookImportDropZone?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    $("#bookImportFile").click();
  }
});
["dragenter", "dragover"].forEach((type) => bookImportDropZone?.addEventListener(type, (event) => {
  event.preventDefault();
  bookImportDropZone.classList.add("is-dragover");
}));
["dragleave", "drop"].forEach((type) => bookImportDropZone?.addEventListener(type, (event) => {
  event.preventDefault();
  bookImportDropZone.classList.remove("is-dragover");
}));
bookImportDropZone?.addEventListener("drop", async (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  try {
    await processBookImportFile(file);
    showToast("Book import preview ready.", "success");
  } catch (error) {
    logDetailedError(error);
    showToast(error.message || "Could not parse book import file.", "error");
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
$("#skipDuplicateBooks")?.addEventListener("change", () => {
  if (pendingBookImportRows.length) {
    renderBookImportPreview(pendingBookImportRows, pendingBookImportSheetName);
  }
});
$("#confirmBookImportBtn").addEventListener("click", async () => {
  try {
    const result = await importPreviewedBooks();
    $("#bookImportFileName").textContent = "No file selected";
    $("#importTotalRows").textContent = "0";
    $("#importReadyRows").textContent = "0";
    $("#importDuplicateRows").textContent = "0";
    $("#importInvalidRows").textContent = "0";
    showToast(`Imported ${result.imported} book copy/copies.`, "success");
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
});
bookSearch.addEventListener("input", resetBookDatabasePage);
if (bookCategoryFilter) bookCategoryFilter.addEventListener("change", resetBookDatabasePage);
if (bookAvailabilityFilter) bookAvailabilityFilter.addEventListener("change", resetBookDatabasePage);
if (bookSort) bookSort.addEventListener("change", resetBookDatabasePage);
$("#bookDatabasePagination")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-book-page]");
  if (!button || button.disabled) return;
  const page = Number(button.dataset.bookPage || 1);
  if (bookDatabaseSearchMode) {
    bookDatabasePage = page;
    renderBooksTable();
    return;
  }
  loadBookDatabasePage(page).catch((error) => {
    logDetailedError(error);
    showToast(error.message || "Could not load this book page.", "error");
  });
});
["exportCategoryFilter", "exportStatusFilter", "exportAccessionFrom", "exportAccessionTo", "exportDateFrom", "exportDateTo", "exportFormat", "exportScope"]
  .forEach((id) => {
    const input = document.getElementById(id);
    input?.addEventListener(input.matches("input") ? "input" : "change", renderBookExportSummary);
  });
$("#exportBooksExcelBtn").addEventListener("click", async () => {
  try {
    latestBooks = await loadAllBooksIncrementally();
    const rows = bookRowsForExport();
    const format = $("#exportFormat").value;
    exportBooksExcel(rows, format);
    showToast(`Book records exported as ${format.toUpperCase()}.`, "success");
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
});
$("#deleteDuplicateBooksBtn")?.addEventListener("click", async () => {
  try {
    await scanDuplicateBooks();
  } catch (error) {
    logDetailedError(error);
    renderEmpty($("#duplicateCleanupPreview"), error.message || "Could not scan duplicate book records.");
    showToast(error.message || "Could not scan duplicate book records.", "error");
  }
});
$("#confirmDuplicateCleanupBtn")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Deleting…";
  try {
    const result = await executeDuplicateCleanup();
    showToast(`Deleted ${result.deletableCount} duplicate book record${result.deletableCount === 1 ? "" : "s"}.`, "success");
  } catch (error) {
    logDetailedError(error);
    showToast(error.message || "Duplicate cleanup failed.", "error");
    if (pendingDuplicateCleanupPlan?.deletableCount) button.disabled = false;
  } finally {
    button.textContent = "Delete Duplicates";
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
      switchManagementModal("bookDatabaseModal", "addBookModal");
    } else if (button.dataset.bookAction === "delete") {
      if (session.profile.role !== "admin") throw new Error("Only an administrator can delete book records.");
      if (bookHasIssueConflict(data) || await activeIssueConflictForBook(id, data.b_id)) {
        throw new Error("This book has an active issue and cannot be deleted.");
      }
      if (requestStateForBook(found)) {
        throw new Error("Resolve the active issue request before deleting this book.");
      }
      const confirmed = await confirmAction("Are you sure you want to delete this book record?");
      if (!confirmed) return;
      await deleteDoc(doc(db, "books", id));
      showToast("Book record deleted successfully.", "success");
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
  const toInputDate = (date) => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
  if (!$("#slotStartDate").value) $("#slotStartDate").value = toInputDate(tomorrow);
  if (!$("#slotEndDate").value) $("#slotEndDate").value = toInputDate(weekEnd);
  if (!$("#slotStartTime").value) $("#slotStartTime").value = "12:30";
  if (!$("#slotEndTime").value) $("#slotEndTime").value = "14:00";
}

function formatSlotDate(value) {
  if (!value) return "Until changed";
  const [year, month, day] = String(value).split("-");
  return year && month && day ? `${day}-${month}-${year}` : value;
}

function renderSlotPreview() {
  const target = $("#slotPreviewCard");
  if (!target) return;
  const startDate = $("#slotStartDate").value;
  const repeatMode = $("#slotRepeatMode").value;
  const endDate = repeatMode === "untilChanged" ? "" : $("#slotEndDate").value;
  const startTime = $("#slotStartTime").value;
  const endTime = $("#slotEndTime").value;
  const appliesTo = $("#slotAppliesTo").value;
  const maxStudents = Number($("#slotMaxStudents").value || 20);
  if (!startDate || !startTime || !endTime) {
    target.innerHTML = `<span>Schedule Preview</span><strong>Complete the fields to preview this slot.</strong><small>Saved changes appear immediately for eligible student requests.</small>`;
    return;
  }
  const dateLabel = endDate && endDate !== startDate
    ? `${formatSlotDate(startDate)} to ${formatSlotDate(endDate)}`
    : `${formatSlotDate(startDate)}${repeatMode === "untilChanged" ? " onward" : ""}`;
  target.innerHTML = `
    <span>Schedule Preview</span>
    <strong>Active slot: ${escapeHtml(dateLabel)}</strong>
    <b>${escapeHtml(startTime)}–${escapeHtml(endTime)}</b>
    <small>Applies to ${escapeHtml(appliesTo)} · Maximum ${maxStudents} students</small>`;
}

function applyScheduleToSlotForm(schedule) {
  if (!schedule) return;
  $("#slotStartDate").value = schedule.startDate || $("#slotStartDate").value;
  $("#slotEndDate").value = schedule.endDate || "";
  $("#slotStartTime").value = schedule.startTime || $("#slotStartTime").value;
  $("#slotEndTime").value = schedule.endTime || $("#slotEndTime").value;
  $("#slotAppliesTo").value = schedule.appliesTo || "both";
  $("#slotRepeatMode").value = schedule.repeatMode || "untilChanged";
  $("#slotMaxStudents").value = schedule.maxStudentsPerSlot || 20;
  $("#slotNotes").value = schedule.notes || "";
  $("#slotEndDate").required = $("#slotRepeatMode").value !== "untilChanged";
  renderSlotPreview();
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
  renderSlotPreview();
});

["slotStartDate", "slotEndDate", "slotStartTime", "slotEndTime", "slotAppliesTo", "slotMaxStudents", "slotNotes"]
  .forEach((id) => {
    const input = document.getElementById(id);
    input?.addEventListener(input.matches("select") ? "change" : "input", renderSlotPreview);
  });

$("#resetTimeSlotBtn")?.addEventListener("click", () => {
  if (latestIssueReturnSchedule) {
    applyScheduleToSlotForm(latestIssueReturnSchedule);
  } else {
    $("#timeSlotForm").reset();
    $("#slotStartDate").value = "";
    $("#slotEndDate").value = "";
    $("#slotStartTime").value = "";
    $("#slotEndTime").value = "";
    setDefaultSlotDates();
    renderSlotPreview();
  }
  showToast("Time slot form reset.", "info");
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
renderSlotPreview();

onSnapshot(
  doc(db, "librarySettings", "issueReturnSchedule"),
  (snap) => {
    const schedule = snap.exists() ? snap.data() : null;
    latestIssueReturnSchedule = schedule;
    renderActiveSchedule(schedule);
    if (!schedule) return;
    applyScheduleToSlotForm(schedule);
  },
  (error) => {
    console.error("Issue/return schedule load failed:", error);
    renderActiveSchedule(null);
  }
);

function penaltyAmountOf(penalty = {}) {
  return Number(penalty.remainingAmount ?? penalty.amount ?? penalty.penaltyAmount ?? 0);
}

function penaltyIssueIdOf(penalty = {}, fallback = "") {
  return issueIdOf(penalty, penalty.penaltyId || fallback);
}

function buildPenaltyRows() {
  const studentMap = new Map();
  const ensureStudent = (student) => {
    const uid = student.studentUid || student.userId || student.uid || "";
    const email = student.studentEmail || student.email || "";
    const rollNo = student.rollNo || student.rollNumber || "";
    const enrollmentNumber = student.enrollmentNumber || student.enrollmentNo || "";
    const key = uid || email || rollNo || enrollmentNumber;
    if (!key || studentMap.has(key)) return;
    studentMap.set(key, {
      uid,
      email,
      rollNo,
      rollNumber: rollNo,
      enrollmentNumber,
      name: student.studentName || student.issuedToName || student.name || "Unknown student",
      phone: student.studentPhone || student.phone || ""
    });
  };

  latestActiveIssues.forEach((item) => ensureStudent(item.data));
  latestPenalties.forEach((item) => ensureStudent(item.data));

  const rows = [];
  studentMap.forEach((student) => {
    const liability = getStudentPenaltyLiability({
      student,
      issues: latestActiveIssues.map((item) => ({ id: item.id, ...item.data })),
      penalties: latestPenalties.map((item) => ({ id: item.id, ...item.data })),
      now: new Date()
    });
    liability.unpaidItems.forEach((penaltyItem) => {
      rows.push({
        id: penaltyItem.issueId || penaltyItem.id,
        source: penaltyItem.source,
        data: {
          penaltyId: penaltyItem.issueId || penaltyItem.id,
          issueId: penaltyItem.issueId,
          studentUid: penaltyItem.studentUid || student.uid || "",
          studentName: penaltyItem.studentName || student.name || "Unknown student",
          studentEmail: penaltyItem.issue?.studentEmail || penaltyItem.penalty?.studentEmail || student.email || "",
          studentPhone: penaltyItem.issue?.studentPhone || penaltyItem.penalty?.studentPhone || student.phone || "",
          rollNumber: penaltyItem.rollNo || student.rollNo || "",
          enrollmentNumber: penaltyItem.enrollmentNumber || student.enrollmentNumber || "",
          bookId: penaltyItem.bookId,
          b_id: penaltyItem.bookId,
          accessionNumber: penaltyItem.accessionNumber,
          bookBarcodeValue: penaltyItem.issue?.bookBarcodeValue || penaltyItem.issue?.barcodeValue || penaltyItem.penalty?.bookBarcodeValue || "",
          bookTitle: penaltyItem.bookTitle,
          issueDate: penaltyItem.issueDate,
          dueDate: penaltyItem.dueDate,
          lateDays: penaltyItem.overdueDays,
          daysLate: penaltyItem.overdueDays,
          ratePerDay: penaltyItem.ratePerDay,
          amount: penaltyItem.amount,
          penaltyAmount: penaltyItem.amount,
          remainingAmount: penaltyItem.amount,
          paid: false,
          status: "unpaid",
          paymentStatus: "unpaid",
          penaltyStatus: "unpaid",
          calculated: penaltyItem.source !== "persisted"
        }
      });
    });
  });

  const paidRows = latestPenalties
    .filter((item) => !isUnpaidPenaltyRecord(item.data))
    .map((item) => ({ ...item, source: "persisted" }));

  return [...rows, ...paidRows];
}

function renderPenaltyDetails() {
  const statusFilter = $("#penaltyStatusFilter")?.value || "all";
  const search = String($("#penaltySearchInput")?.value || "").trim().toLowerCase();
  const allPenaltyRows = buildPenaltyRows();
  const total = allPenaltyRows.length;
  const unpaid = allPenaltyRows.filter((item) => isUnpaidPenaltyRecord(item.data));
  const paid = allPenaltyRows.filter((item) => !isUnpaidPenaltyRecord(item.data));
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

  const rows = allPenaltyRows.filter((item) => {
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
      penalty.rollNumber,
      penalty.rollNo,
      penalty.enrollmentNumber,
      penalty.enrollmentNo,
      penalty.bookTitle,
      penalty.bookId,
      penalty.b_id,
      penalty.accessionNumber,
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
        <article class="list-row penalty-row" data-penalty-id="${escapeHtml(item.id)}" data-issue-id="${escapeHtml(penaltyIssueIdOf(penalty, item.id))}">
          <div>
            <strong>${escapeHtml(penalty.studentName || "Unknown student")} - Rs.${amount.toFixed(2)}</strong>
            <span>Student UID: ${escapeHtml(shortUid(penalty.studentUid || ""))}</span>
            <span>Roll No.: ${escapeHtml(penalty.rollNumber || penalty.rollNo || "-")} | Enrollment: ${escapeHtml(penalty.enrollmentNumber || penalty.enrollmentNo || "-")}</span>
            <span>Email: ${escapeHtml(penalty.studentEmail || "")}</span>
            <span>Phone: ${escapeHtml(penalty.studentPhone || "")}</span>
            <span>Book: ${escapeHtml(penalty.bookTitle || penalty.bookId || "")}</span>
            <span>Accession: ${escapeHtml(penalty.accessionNumber || "-")} | B_ID: ${escapeHtml(penalty.b_id || penalty.bookId || "")}</span>
            <span>Issue: ${formatDate(penalty.issueDate)} | Due: ${formatDate(penalty.dueDate)} | Return: ${formatDate(penalty.returnDate)}</span>
            <span>Overdue Days: ${Number(penalty.lateDays || penalty.daysLate || 0)} | Rate: Rs.${Number(penalty.ratePerDay || 5).toFixed(0)}/day | Total: Rs.${amount.toFixed(2)}</span>
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
    const row = buildPenaltyRows().find((item) => item.id === penaltyId);
    const penalty = row?.data || {};
    const defaultAmount = Math.max(0, penaltyAmountOf(penalty));
    const amountPaid = defaultAmount;
    const confirmed = await confirmAction(`Clear dues for Rs.${amountPaid.toFixed(2)}?`);
    if (!confirmed) return;
    markPaidBtn.disabled = true;
    try {
      const issueId = penaltyIssueIdOf(penalty, penaltyId);
      await setDoc(doc(db, "penalties", penaltyId), {
        penaltyId,
        issueId,
        studentUid: penalty.studentUid || "",
        studentName: penalty.studentName || "",
        studentEmail: penalty.studentEmail || "",
        studentPhone: penalty.studentPhone || "",
        rollNumber: penalty.rollNumber || penalty.rollNo || "",
        enrollmentNumber: penalty.enrollmentNumber || penalty.enrollmentNo || "",
        bookId: penalty.bookId || penalty.b_id || "",
        b_id: penalty.b_id || penalty.bookId || "",
        accessionNumber: penalty.accessionNumber || "",
        bookBarcodeValue: penalty.bookBarcodeValue || "",
        bookTitle: penalty.bookTitle || "",
        issueDate: penalty.issueDate || null,
        dueDate: penalty.dueDate || null,
        lateDays: penalty.lateDays || penalty.daysLate || 0,
        daysLate: penalty.lateDays || penalty.daysLate || 0,
        ratePerDay: penalty.ratePerDay || 5,
        amount: penalty.amount || penalty.penaltyAmount || amountPaid,
        penaltyAmount: penalty.penaltyAmount || penalty.amount || amountPaid,
        paymentAmount: amountPaid,
        amountPaid,
        paidAmount: amountPaid,
        paid: true,
        status: "paid",
        paymentStatus: "paid",
        penaltyStatus: "cleared",
        remainingAmount: 0,
        clearedAt: serverTimestamp(),
        clearedBy: auth.currentUser.uid,
        clearedByName: session.profile?.name || auth.currentUser.displayName || auth.currentUser.email || "",
        paidAt: serverTimestamp(),
        paidBy: auth.currentUser.uid,
        paymentHistory: arrayUnion({
          amountPaid,
          clearedBy: auth.currentUser.uid,
          clearedByName: session.profile?.name || auth.currentUser.displayName || auth.currentUser.email || "",
          clearedAt: new Date().toISOString(),
          action: "clear_dues"
        }),
        updatedAt: serverTimestamp()
      }, { merge: true });
      showToast("Dues cleared and payment history saved.", "success");
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
  query(collection(db, "issueRequests"), where("status", "in", ["pending", "approved_for_pickup"])),
  (snap) => {
    latestPendingRequests = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
    const pendingMetric = $("#metricPendingRequests");
    const newRequestMetric = $("#metricNewBookRequests");
    const pendingCount = latestPendingRequests.filter((item) => item.data.status === "pending").length;
    if (pendingMetric) pendingMetric.textContent = String(latestPendingRequests.length);
    if (newRequestMetric) newRequestMetric.textContent = String(pendingCount);
    renderPendingRequests();
    renderBooksTable();
    renderRecentActivity();
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
    renderRecentActivity();
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
    renderEmpty(target, "No pending or pickup-approved issue requests.");
    return;
  }
  target.innerHTML = latestPendingRequests.sort((a, b) => timeOf(a.data.createdAt) - timeOf(b.data.createdAt)).map((item) => {
    const request = item.data;
    const book = localBookForRequest(request);
    const unavailable = book && bookHasIssueConflict(book);
    const status = request.status || "pending";
    const expired = status === "approved_for_pickup" && pickupExpired(request);
    const noDuesText = request.noDuesStatus || request.eligibilityStatus || "";
    const penaltyText = Number(request.pendingPenalty || request.totalPendingPenalty || request.penaltyAmount || 0);
    return `
      <article class="request-card" data-request-id="${item.id}">
        <img src="${escapeHtml(request.bookImage || "assets/book-placeholder.svg")}" alt="">
        <div>
          <strong>${escapeHtml(request.bookTitle || request.title || "Requested book")}</strong>
          <span>Accession: ${escapeHtml(request.accessionNumber || request.bookId || request.b_id || "-")}</span>
          <span>Student: ${escapeHtml(request.studentName || "-")} | Roll: ${escapeHtml(request.rollNumber || "-")} | Enrollment: ${escapeHtml(request.enrollmentNumber || "-")}</span>
          <span>Requested ${formatDate(request.requestedAt || request.createdAt)} | Slot ${escapeHtml(request.preferredSlot || "-")}</span>
          ${status === "approved_for_pickup" ? `<span>Pickup: ${escapeHtml(pickupWindowLabel(request))} | Expires ${formatDate(request.pickupExpiresAt)}</span>` : ""}
          ${request.pickupNotes ? `<span>Note: ${escapeHtml(request.pickupNotes)}</span>` : ""}
          ${noDuesText ? `<span>No Dues: ${escapeHtml(noDuesText)}</span>` : ""}
          ${penaltyText > 0 ? `<span>Pending penalty: Rs.${penaltyText.toFixed(2)}</span>` : ""}
          ${unavailable ? `<span class="badge badge-issued">Book already issued</span>` : ""}
          ${statusBadge(expired ? "expired" : status.replaceAll("_", " "))}
        </div>
        <div class="row-actions">
          ${status === "pending" ? `<button class="btn btn-primary approve-request-btn" data-request-id="${item.id}" type="button" ${unavailable ? "disabled" : ""}>Approve for Pickup</button>` : ""}
          ${status === "approved_for_pickup" ? `<button class="btn btn-primary mark-issued-request-btn" data-request-id="${item.id}" type="button" ${unavailable || expired ? "disabled" : ""}>Mark Issued</button>` : ""}
          <button class="btn btn-muted reject-request-btn" data-request-id="${item.id}" type="button">Reject</button>
        </div>
      </article>`;
  }).join("");
}

async function openPickupApprovalDialog(requestItem) {
  selectedPickupRequest = requestItem;
  const request = requestItem.data;
  const today = new Date();
  const schedule = await getIssueReturnSchedule().catch(() => null);
  const pickupDate = schedule?.startDate || today.toISOString().slice(0, 10);
  const startTime = schedule?.startTime || "10:00";
  const endTime = schedule?.endTime || "16:00";
  const expirationDate = schedule?.endDate || pickupDate;
  const expiration = `${expirationDate}T${endTime}`;
  $("#pickupApprovalDetails").innerHTML = `
    <article class="list-row">
      <div>
        <strong>${escapeHtml(request.bookTitle || request.title || "Requested book")}</strong>
        <span>Accession: ${escapeHtml(request.accessionNumber || request.bookId || request.b_id || "-")}</span>
        <span>Student: ${escapeHtml(request.studentName || "-")}</span>
        <span>Roll: ${escapeHtml(request.rollNumber || "-")} | Enrollment: ${escapeHtml(request.enrollmentNumber || "-")}</span>
        <span>Current issue/return slot: ${escapeHtml(scheduleLabel(schedule || {}))}</span>
      </div>
    </article>`;
  $("#pickupDateInput").value = pickupDate;
  $("#pickupStartTimeInput").value = startTime;
  $("#pickupEndTimeInput").value = endTime;
  $("#pickupExpirationInput").value = expiration;
  $("#pickupNotesInput").value = request.pickupNotes || "Bring student ID and collect during the approved library slot.";
  $("#pickupApprovalDialog").showModal();
}

$("#pendingRequests").addEventListener("click", async (event) => {
  const approveBtn = event.target.closest(".approve-request-btn");
  const markIssuedBtn = event.target.closest(".mark-issued-request-btn");
  const rejectBtn = event.target.closest(".reject-request-btn");
  if (!approveBtn && !markIssuedBtn && !rejectBtn) return;
  const button = approveBtn || markIssuedBtn || rejectBtn;
  const requestId = button.dataset.requestId;
  if (approveBtn) console.log("Approve for pickup clicked:", requestId);
  if (markIssuedBtn) console.log("Mark issued clicked:", requestId);
  if (rejectBtn) console.log("Reject clicked:", requestId);
  if (approveBtn) {
    const requestItem = latestPendingRequests.find((item) => item.id === requestId);
    if (!requestItem) return;
    openPickupApprovalDialog(requestItem);
    return;
  }
  const confirmed = await confirmAction(markIssuedBtn ? "Mark this pickup-approved request as issued now?" : "Reject this issue request?");
  if (!confirmed) return;
  button.disabled = true;
  try {
    if (markIssuedBtn) {
      const result = await markIssuedRequest(requestId);
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
    if (markIssuedBtn) {
      console.error("Mark issued failed full error:", error);
      console.error("Mark issued failed code:", error.code);
      console.error("Mark issued failed message:", error.message);
    } else {
      console.error("Reject failed full error:", error);
      console.error("Reject failed code:", error.code);
      console.error("Reject failed message:", error.message);
    }
    if (error.message === "This request was already processed.") {
      showToast("This request was already processed.", "warning");
    } else if (error.code === "penalty/unpaid" || error.code === "dues/blocked") {
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

$("#pickupApprovalDialog")?.querySelector(".dialog-close")?.addEventListener("click", () => {
  $("#pickupApprovalDialog").close();
});

$("#pickupApprovalForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedPickupRequest) return;
  setLoading(event.target, true);
  try {
    const result = await approveForPickup(selectedPickupRequest.id, {
      date: $("#pickupDateInput").value,
      startTime: $("#pickupStartTimeInput").value,
      endTime: $("#pickupEndTimeInput").value,
      expiresAt: $("#pickupExpirationInput").value,
      notes: $("#pickupNotesInput").value.trim()
    });
    if (result?.conflict) {
      showToast("This book is already issued or unavailable.", "warning");
      return;
    }
    try {
      await sendEmailNotification("Book Issue Approved", {
        ...result.notificationPayload,
        issueDate: result.notificationPayload?.pickupDate || "-",
        dueDate: `${result.notificationPayload?.pickupStartTime || ""} - ${result.notificationPayload?.pickupEndTime || ""}`.trim(),
        returnDate: "-",
        penaltyAmount: 0
      });
      showToast("Pickup approved. Email sent.", "success");
    } catch (emailError) {
      console.error("Pickup approval email failed:", emailError);
      showToast("Pickup approved, but email failed.", "warning");
    }
    $("#pickupApprovalDialog").close();
  } catch (error) {
    console.error("Pickup approval failed:", error);
    if (error.code === "penalty/unpaid" || error.code === "dues/blocked") {
      showToast(error.message, "warning");
    } else if (error.message.includes("not available")) {
      showToast("This book is already issued or unavailable.", "warning");
    } else {
      showToast(`${error.code || "error"}: ${error.message}`, "error");
    }
  } finally {
    setLoading(event.target, false);
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
    if (scanned && expected && scanned !== expected) {
      throw new Error("Scanned barcode does not match this return request.");
    }
    const lookupValue = scanned
      || selectedReturnRequest.data.bookBarcodeValue
      || selectedReturnRequest.data.barcodeValue
      || selectedReturnRequest.data.accessionNumber
      || selectedReturnRequest.data.b_id
      || selectedReturnRequest.data.bookId;
    if (!lookupValue) throw new Error("This return request is missing a book/accession reference.");
    const bookDocId = selectedReturnRequest.data.b_id || selectedReturnRequest.data.bookId;
    if (bookDocId && selectedReturnRequest.data.currentIssueId) {
      const bookSnap = await getDoc(doc(db, "books", bookDocId));
      const bookData = bookSnap.exists() ? bookSnap.data() : null;
      if (!bookData || bookData.currentIssueId !== selectedReturnRequest.data.currentIssueId) {
        throw new Error("This return request does not match the current active issue.");
      }
    }
    const data = await returnBook(lookupValue);
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

async function issueStudentDetails(issue = {}) {
  const base = {
    name: issue.studentName || issue.issuedToName || "",
    email: issue.studentEmail || issue.issuedToEmail || "",
    rollNumber: issue.rollNumber || issue.rollNo || "",
    enrollmentNumber: issue.enrollmentNumber || issue.enrollmentNo || "",
    uid: issue.studentUid || issue.userId || ""
  };
  if (!base.uid) return base;
  try {
    const studentSnap = await getDoc(doc(db, "students", base.uid));
    if (!studentSnap.exists()) return base;
    const student = studentSnap.data();
    return {
      ...base,
      name: base.name || student.name || "Unknown student",
      email: base.email || student.email || "",
      rollNumber: base.rollNumber || student.rollNumber || student.rollNo || "",
      enrollmentNumber: base.enrollmentNumber || student.enrollmentNumber || student.enrollmentNo || ""
    };
  } catch (error) {
    console.warn("Active issue student lookup failed:", error);
    return base;
  }
}

async function renderActiveIssues() {
  const target = $("#activeIssues");
  if (!target) return;
  if (!latestActiveIssues.length) {
    renderEmpty(target, "No active issues.");
    return;
  }
  const searchTerm = ($("#activeIssueSearch")?.value || "").trim().toLowerCase();
  const sortedIssues = [...latestActiveIssues].sort((a, b) => timeOf(a.data.dueDate) - timeOf(b.data.dueDate));
  const hydrated = await Promise.all(sortedIssues.map(async (item) => ({
    ...item,
    student: await issueStudentDetails(item.data)
  })));
  const filtered = hydrated.filter((item) => {
    if (!searchTerm) return true;
    const issue = item.data;
    const student = item.student;
    const haystack = [
      issue.accessionNumber,
      issue.bookBarcodeValue,
      issue.barcodeValue,
      issue.title,
      issue.bookTitle,
      issue.bookId,
      issue.b_id,
      student.name,
      student.rollNumber,
      student.enrollmentNumber,
      student.uid
    ].join(" ").toLowerCase();
    return haystack.includes(searchTerm);
  });
  if (!filtered.length) {
    renderEmpty(target, "No active issues match this search.");
    return;
  }
  const cards = filtered.slice(0, 12).map((item) => {
    const issue = item.data;
    const student = item.student;
    const accessionNumber = issue.accessionNumber || issue.bookId || issue.b_id || "";
    const lookupValue = issue.bookBarcodeValue || issue.barcodeValue || accessionNumber || issue.bookId || issue.b_id || "";
    return `
      <article class="list-row active-issue-row">
        <div>
          <strong>${escapeHtml(issue.bookTitle || issue.title || issue.bookId || issue.b_id || "Issued book")}</strong>
          <span>Accession No.: ${escapeHtml(accessionNumber || "-")}</span>
          <span>Student: ${escapeHtml(student.name || "Unknown student")} ${student.uid ? `(${escapeHtml(shortUid(student.uid))})` : ""}</span>
          <span>Roll: ${escapeHtml(student.rollNumber || "-")} | Enrollment: ${escapeHtml(student.enrollmentNumber || "-")}</span>
          <span>Issue: ${formatDate(issue.issueDate || issue.issuedAt)} | Due: ${formatDate(issue.dueDate)}</span>
        </div>
        <div class="row-actions">
          ${statusBadge(issue.status)}
          <button class="btn btn-muted return-active-issue-btn" data-issue-id="${item.id}" data-lookup="${escapeHtml(lookupValue)}" type="button">Confirm Return</button>
        </div>
      </article>`;
  });
  target.innerHTML = `${cards.join("")}${filtered.length > 12 ? `<a class="btn btn-muted dashboard-view-all" href="no-dues.html?filter=activeBook">View All Active Issues</a>` : ""}`;
}

onSnapshot(
  query(collection(db, "bookIssues"), where("status", "==", "issued")),
  async (snap) => {
    latestActiveIssues = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
    renderPenaltyDetails();
    await renderActiveIssues();
    renderRecentActivity();
  }
);

$("#activeIssueSearch")?.addEventListener("input", () => {
  renderActiveIssues();
});

$("#activeIssues")?.addEventListener("click", (event) => {
  const button = event.target.closest(".return-active-issue-btn");
  if (!button) return;
  const issueItem = latestActiveIssues.find((item) => item.id === button.dataset.issueId);
  if (!issueItem) return;
  const issue = issueItem.data;
  const lookupValue = button.dataset.lookup || issue.bookBarcodeValue || issue.barcodeValue || issue.accessionNumber || issue.bookId || issue.b_id || "";
  if (!lookupValue) {
    showToast("This active issue is missing an accession/barcode reference.", "warning");
    return;
  }
  const book = localBookForIssue(issue) || {};
  const penalty = calculatePenalty(issue, new Date());
  selectedQuickReturn = { lookupValue, book, issue };
  $("#quickReturnDetails").innerHTML = `
    <span>Accession Number</span><strong>${escapeHtml(issue.accessionNumber || accessionNumberOf(book) || "-")}</strong>
    <span>Author</span><strong>${escapeHtml(issue.author || book.author || "-")}</strong>
    <span>Title</span><strong>${escapeHtml(issue.title || issue.bookTitle || bookTitle(book) || "-")}</strong>
    <span>Student UID</span><strong>${escapeHtml(issue.studentUid || "-")}</strong>
    <span>Student Name</span><strong>${escapeHtml(issue.studentName || "-")}</strong>
    <span>Issue Date</span><strong>${escapeHtml(formatDate(issue.issueDate || issue.issuedAt))}</strong>
    <span>Due Date</span><strong>${escapeHtml(formatDate(issue.dueDate))}</strong>
    <span>Penalty</span><strong>Rs.${Number(penalty.calculatedPenalty || 0).toFixed(2)}</strong>`;
  $("#quickReturnDialog").showModal();
});

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
  query(collection(db, "books"), orderBy("updatedAt", "desc"), limit(50)),
  (snap) => {
    cacheLoadedBooks(snap.docs.map((item) => ({ id: item.id, data: item.data() })));
    refreshBookMetrics().then(() => {
      if (!bookDatabaseRows.length) return refreshBookDatabase();
      renderBooksTable();
      return null;
    }).catch((error) => {
      console.error("Book aggregate refresh failed:", error);
    });
    renderBarcodePrintManager();
    renderPendingRequests();
    renderRecentActivity();
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
    const penalty = calculatePenalty(issue, new Date());
    selectedQuickReturn = { lookupValue, book, issue };
    $("#quickReturnDetails").innerHTML = `
      <span>Accession Number</span><strong>${escapeHtml(issue.accessionNumber || accessionNumberOf(book) || "-")}</strong>
      <span>Author</span><strong>${escapeHtml(issue.author || book.author || "-")}</strong>
      <span>Title</span><strong>${escapeHtml(issue.title || issue.bookTitle || bookTitle(book) || "-")}</strong>
      <span>Student UID</span><strong>${escapeHtml(issue.studentUid || "-")}</strong>
      <span>Student Name</span><strong>${escapeHtml(issue.studentName || "-")}</strong>
      <span>Issue Date</span><strong>${escapeHtml(formatDate(issue.issueDate))}</strong>
      <span>Due Date</span><strong>${escapeHtml(formatDate(issue.dueDate))}</strong>
      <span>Penalty</span><strong>Rs.${Number(penalty.calculatedPenalty || 0).toFixed(2)}</strong>`;
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
