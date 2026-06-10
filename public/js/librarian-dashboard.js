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
  returnBook
} from "./firestore-service.js";
import {
  EMAILJS_SETUP_MESSAGE,
  isEmailNotificationsConfigured,
  runReminderCheck,
  sendEmailNotification
} from "./notifications.js";
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
let nextBookId = "1";
let editingBookId = null;
let editingExistingBook = null;
let latestBooks = [];
let latestPendingRequests = [];
let latestBarcodeDataUrl = "";
let pendingBookImportRows = [];
let publisherStream = null;
let publisherScanTimer = null;
let quickReturnStream = null;
let quickReturnScanTimer = null;
const showBookDebug = new URLSearchParams(window.location.search).get("debug") === "true"
  || localStorage.debugBooks === "true";
const testEmailButton = $("#sendTestEmailBtn");
if (testEmailButton) testEmailButton.title = EMAILJS_SETUP_MESSAGE;
const INDCAT_CONFIG = {
  enabled: false,
  apiUrl: ""
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
  return book.bname || book.title || book.bookName || "";
}

function bookIdOf(book, fallbackId = "") {
  return book.b_id || book.bookId || fallbackId;
}

function barcodeValueFor(bid) {
  return `BOOK-${bid}`;
}

function readWorkbookRows(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const workbook = window.XLSX.read(event.target.result, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        resolve(window.XLSX.utils.sheet_to_json(sheet, { defval: "" }));
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function valueFor(row, ...names) {
  const entries = Object.entries(row || {});
  for (const name of names) {
    const found = entries.find(([key]) => key.trim().toLowerCase() === name.toLowerCase());
    if (found) return String(found[1] ?? "").trim();
  }
  return "";
}

function numberValue(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function downloadWorkbookTemplate(filename, rows) {
  if (!window.XLSX) throw new Error("XLSX library is not loaded.");
  const sheet = window.XLSX.utils.json_to_sheet(rows);
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, sheet, "Template");
  window.XLSX.writeFile(workbook, filename);
}

function normalizeBookImportRows(rows) {
  return rows.map((row, index) => {
    const normalized = {
      rowNumber: index + 2,
      isbn: valueFor(row, "ISBN"),
      bname: valueFor(row, "Book Name", "BookName", "Title"),
      author: valueFor(row, "Author"),
      publisher: valueFor(row, "Publisher"),
      subject: valueFor(row, "Subject"),
      category: valueFor(row, "Category") || "textbook",
      copies: numberValue(valueFor(row, "Copies"), 1),
      blegal_num: valueFor(row, "BLegalNumber", "BLegal Number", "Inside Book Number")
    };
    const errors = [];
    if (!normalized.bname) errors.push("Book Name is required");
    if (!normalized.subject) errors.push("Subject is required");
    if (!normalized.category) errors.push("Category is required");
    if (normalized.copies < 1) errors.push("Copies must be at least 1");
    return { ...normalized, errors };
  });
}

function renderBookImportPreview(rows) {
  pendingBookImportRows = rows;
  $("#confirmBookImportBtn").disabled = !rows.length || rows.some((row) => row.errors.length);
  const totalCopies = rows.reduce((sum, row) => sum + row.copies, 0);
  const errorCount = rows.filter((row) => row.errors.length).length;
  $("#bookImportResult").innerHTML = `
    <div class="${errorCount ? "empty" : "success-box"}">
      <strong>${rows.length} row(s) parsed</strong>
      <span>Total copies to create: ${totalCopies}</span>
      <span>Validation errors: ${errorCount}</span>
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
          <th>ISBN</th>
          <th>Book Name</th>
          <th>Author</th>
          <th>Publisher</th>
          <th>Subject</th>
          <th>Category</th>
          <th>Copies</th>
          <th>BLegalNumber</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td>${row.rowNumber}</td>
            <td>${escapeHtml(row.isbn)}</td>
            <td>${escapeHtml(row.bname)}</td>
            <td>${escapeHtml(row.author)}</td>
            <td>${escapeHtml(row.publisher)}</td>
            <td>${escapeHtml(row.subject)}</td>
            <td>${escapeHtml(row.category)}</td>
            <td>${row.copies}</td>
            <td>${escapeHtml(row.blegal_num)}</td>
            <td>${row.errors.length ? escapeHtml(row.errors.join("; ")) : "Ready"}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

async function importPreviewedBooks() {
  const validRows = pendingBookImportRows.filter((row) => !row.errors.length);
  if (!validRows.length) throw new Error("No valid book rows to import.");
  const totalCopies = validRows.reduce((sum, row) => sum + row.copies, 0);
  const importBatchId = `books_import_${Date.now()}`;
  const result = await runTransaction(db, async (transaction) => {
    const counterRef = doc(db, "counters", "books");
    const counterSnap = await transaction.get(counterRef);
    let nextId = (counterSnap.exists() ? Number(counterSnap.data().lastId || 0) : 0) + 1;
    const createdIds = [];

    validRows.forEach((row) => {
      for (let copy = 0; copy < row.copies; copy += 1) {
        const bId = String(nextId);
        const bookRef = doc(db, "books", bId);
        transaction.set(bookRef, {
          b_id: bId,
          bname: row.bname,
          author: row.author,
          publisher: row.publisher,
          subject: row.subject,
          category: row.category,
          blegal_num: row.blegal_num,
          publisherBarcode: row.isbn,
          isbn: row.isbn,
          imageUrl: "",
          metadataSource: "import",
          barcodeValue: barcodeValueFor(bId),
          barcodeDataUrl: "",
          barcodePrinted: false,
          barcodePrintedAt: null,
          barcodePrintedBy: null,
          barcodePrintBatchId: null,
          importBatchId,
          status: "available",
          issuedTo: null,
          issuedToName: null,
          currentIssueId: null,
          createdBy: session.user.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
        createdIds.push(bId);
        nextId += 1;
      }
    });

    transaction.set(counterRef, { lastId: nextId - 1 }, { merge: true });
    return { createdIds, importBatchId };
  });

  const skipped = pendingBookImportRows.length - validRows.length;
  $("#barcodeImportBatchFilter").value = result.importBatchId;
  renderBarcodePrintManager();
  $("#bookImportResult").innerHTML = `
    <div class="success-box">
      <strong>Books imported successfully</strong>
      <span>Imported count: ${result.createdIds.length}</span>
      <span>Skipped count: ${skipped}</span>
      <span>Import batch: ${escapeHtml(result.importBatchId)}</span>
    </div>`;
  $("#confirmBookImportBtn").disabled = true;
  pendingBookImportRows = [];
  return { imported: totalCopies, skipped, importBatchId: result.importBatchId };
}

function collectBookMetadata() {
  return {
    bname: $("#bnameInput").value.trim(),
    subject: $("#subjectInput").value.trim(),
    category: $("#category").value,
    blegal_num: $("#blegalNum").value.trim(),
    publisherBarcode: $("#publisherBarcodeInput").value.trim(),
    isbn: ($("#isbnInput").value || $("#publisherBarcodeInput").value).trim(),
    author: $("#authorInput").value.trim(),
    publisher: $("#publisherInput").value.trim(),
    imageUrl: $("#imageUrlInput").value.trim(),
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
  let notificationPayload = null;
  const transactionResult = await runTransaction(db, async (transaction) => {
    const requestRef = doc(db, "issueRequests", requestId);
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
      bookBarcodeValue: requestData.bookBarcodeValue || bookData.barcodeValue || "",
      bookTitle: requestData.bookTitle || requestData.bname || bookData.bname || "",
      subject: requestData.subject || bookData.subject || "",
      category: requestData.category || bookData.category || "",
      blegal_num: requestData.blegal_num || bookData.blegal_num || "",
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
  await runTransaction(db, async (transaction) => {
    const requestRef = doc(db, "issueRequests", requestId);
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

    const requestUpdate = {
      status: "rejected",
      reviewedBy: auth.currentUser.uid,
      reviewedAt: serverTimestamp()
    };
    console.log("Updating issue request:", { requestId, requestUpdate });
    transaction.update(requestRef, requestUpdate);
  });
}

function setNextBookId(lastId = 0) {
  nextBookId = String(Number(lastId || 0) + 1);
  if (!editingBookId) {
    $("#autoBId").value = nextBookId;
    renderBarcode(barcodeValueFor(nextBookId), nextBookId);
  }
}

onSnapshot(doc(db, "counters", "books"), (snap) => {
  setNextBookId(snap.exists() ? snap.data().lastId : 0);
});

function renderBarcode(value, bid = $("#autoBId").value || nextBookId) {
  $("#stickerBId").textContent = `B_ID: ${bid || "-"}`;
  $("#stickerBarcodeValue").textContent = value || "BOOK-";
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
      const fallbackUrl = info?.indcatFallback?.fallbackUrl;
      $("#bookFetchPreview").innerHTML = `
        <div class="empty">
          <span>Online metadata not found. Enter details once and this system will remember it.</span>
          ${fallbackUrl ? `<button class="btn btn-muted" id="openIndcatFallbackBtn" type="button">Search INDCAT Manually</button>` : ""}
        </div>`;
      const indcatButton = document.getElementById("openIndcatFallbackBtn");
      if (indcatButton && fallbackUrl) {
        indcatButton.addEventListener("click", () => window.open(fallbackUrl, "_blank", "noopener,noreferrer"));
      }
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
    const selectedBid = editingBookId || nextBookId;
    const barcodeValue = barcodeValueFor(selectedBid);
    renderBarcode(barcodeValue, selectedBid);
    const metadataUpdate = collectBookMetadata();

    if (!metadataUpdate.bname) throw new Error("Book Name is required.");

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
      await updateDoc(doc(db, "books", editingBookId), metadataUpdate);
      showToast("Book details saved. Availability was not changed.", "success");
    } else {
      const payload = {
        ...metadataUpdate,
        metadataSource: $("#metadataSourceInput").value.trim(),
        barcodeValue,
        barcodeDataUrl: "",
        status: "available",
        issuedTo: null,
        issuedToName: null,
        currentIssueId: null,
        barcodePrinted: false,
        barcodePrintedAt: null,
        barcodePrintedBy: null,
        barcodePrintBatchId: null
      };
      const createdBookId = await runTransaction(db, async (transaction) => {
        const counterRef = doc(db, "counters", "books");
        const counterSnap = await transaction.get(counterRef);
        const lastId = counterSnap.exists() ? Number(counterSnap.data().lastId || 0) : 0;
        const newId = lastId + 1;
        const bId = String(newId);
        const bookRef = doc(db, "books", bId);
        transaction.set(bookRef, {
          ...payload,
          b_id: bId,
          barcodeValue: barcodeValueFor(bId),
          createdBy: session.user.uid,
          createdAt: serverTimestamp()
        });
        transaction.set(counterRef, { lastId: newId }, { merge: true });
        return bId;
      });
      renderBarcode(barcodeValueFor(createdBookId), createdBookId);
      await updateDoc(doc(db, "books", createdBookId), {
        barcodeDataUrl: await ensureBarcodeDataUrl(),
        updatedAt: serverTimestamp()
      });
      showToast("Book saved successfully.", "success");
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
  const rows = latestBooks.filter(({ data }) => {
    const haystack = [
      data.b_id,
      data.bname,
      data.subject,
      data.category,
      data.blegal_num,
      data.publisherBarcode,
      data.barcodeValue
    ].join(" ").toLowerCase();
    return !search || haystack.includes(search);
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
          <th>B_ID</th>
          <th>Book Name</th>
          <th>Subject</th>
          <th>Category</th>
          <th>BLegal Number</th>
          <th>Publisher Barcode / ISBN</th>
          <th>Library Barcode</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(({ id, data }) => `
          <tr data-book-id="${escapeHtml(id)}">
            <td>${escapeHtml(data.b_id || id)}</td>
            <td><strong>${escapeHtml(bookTitle(data))}</strong><span>${escapeHtml(data.author || "")}</span></td>
            <td>${escapeHtml(data.subject || "")}</td>
            <td>${escapeHtml(data.category || "")}</td>
            <td>${escapeHtml(data.blegal_num || "")}</td>
            <td>${escapeHtml(data.publisherBarcode || data.isbn || "")}</td>
            <td>${escapeHtml(data.barcodeValue || "")}</td>
            <td>
              ${statusBadge(data.status)}
              ${data.status === "issued" ? `
                <span>Issued to: ${escapeHtml(data.issuedToName || "Unknown student")}</span>
                <span>Email: ${escapeHtml(data.issuedToEmail || "")}</span>
              ` : ""}
            </td>
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

function barcodeBookId(item) {
  return item.data.b_id || item.id;
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
  const rangeFrom = Number($("#barcodeRangeFrom")?.value || 0);
  const rangeTo = Number($("#barcodeRangeTo")?.value || 0);
  const category = barcodeFilterValue("barcodeCategoryFilter");
  const importBatch = barcodeFilterValue("barcodeImportBatchFilter");
  const status = barcodeFilterValue("barcodeBookStatusFilter");

  return latestBooks.filter((item) => {
    const data = item.data;
    const bid = Number(data.b_id || item.id || 0);
    const printed = data.barcodePrinted === true;
    if (printStatus === "notPrinted" && printed) return false;
    if (printStatus === "printed" && !printed) return false;
    if (rangeFrom && bid < rangeFrom) return false;
    if (rangeTo && bid > rangeTo) return false;
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
          <th>B_ID</th>
          <th>Book Name</th>
          <th>BLegal Number</th>
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
              <td>${escapeHtml(data.blegal_num || "")}</td>
              <td>${escapeHtml(data.barcodeValue || barcodeValueFor(bid))}</td>
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
    const bid = barcodeBookId(items[index]);
    const barcodeValue = data.barcodeValue || barcodeValueFor(bid);
    const barcodeImage = await barcodeImageDataUrl(barcodeValue);
    console.log("Barcode image generated:", { bookId: items[index].id, bid, barcodeValue });

    pdf.setDrawColor(210, 216, 224);
    pdf.roundedRect(x, y, stickerWidth - 1.5, stickerHeight - 1.5, 1.5, 1.5);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(7);
    pdf.text("MLSU Library", x + 3, y + 4.5);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(6);
    pdf.text(`B_ID: ${bid}`, x + 3, y + 8);
    pdf.text(`Legal No: ${data.blegal_num || "-"}`, x + 3, y + 11);
    pdf.text(`Book: ${shortBookName(barcodeBookTitle(data))}`, x + 3, y + 14);
    pdf.addImage(barcodeImage, "PNG", x + 5, y + 15.5, stickerWidth - 12, 11);
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
      B_ID: data.b_id || item.id,
      "Book Name": barcodeBookTitle(data),
      "BLegal Number": data.blegal_num || "",
      "Barcode Value": data.barcodeValue || barcodeValueFor(data.b_id || item.id),
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

function loadBookIntoForm(id, data) {
  editingBookId = id;
  editingExistingBook = { id, ...data };
  $("#autoBId").value = data.b_id || id;
  $("#bnameInput").value = bookTitle(data);
  $("#subjectInput").value = data.subject || "";
  $("#category").value = data.category || "other";
  $("#blegalNum").value = data.blegal_num || "";
  $("#publisherBarcodeInput").value = data.publisherBarcode || data.isbn || "";
  $("#isbnInput").value = data.isbn || data.publisherBarcode || "";
  $("#authorInput").value = data.author || "";
  $("#publisherInput").value = data.publisher || "";
  $("#imageUrlInput").value = data.imageUrl || "";
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
  renderBarcode(data.barcodeValue || barcodeValueFor(data.b_id || id), data.b_id || id);
  $("#saveBookBtn").textContent = "Save Book Details";
  $("#bookSaveModeHelp").textContent = "Availability is controlled only by issue, return, lost, and found actions.";
  showToast("Book loaded for editing.", "success");
}

async function printStickerFor(data) {
  renderBarcode(data.barcodeValue || barcodeValueFor(data.b_id), data.b_id);
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
  const bid = $("#autoBId").value || nextBookId;
  renderBarcode(barcodeValueFor(bid), bid);
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
  b_id: $("#autoBId").value,
  barcodeValue: $("#stickerBarcodeValue").textContent
}));
$("#downloadBooksTemplateBtn").addEventListener("click", () => {
  try {
    downloadWorkbookTemplate("books_template.xlsx", [{
      ISBN: "9780132350884",
      "Book Name": "Clean Code",
      Author: "Robert C. Martin",
      Publisher: "Prentice Hall",
      Subject: "Computer Science",
      Category: "textbook",
      Copies: 2,
      BLegalNumber: "CS-001"
    }]);
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
    const rows = await readWorkbookRows(file);
    renderBookImportPreview(normalizeBookImportRows(rows));
    showToast("Book import preview ready.", "success");
  } catch (error) {
    logDetailedError(error);
    showToast("Could not parse book import file.", "error");
  } finally {
    event.target.value = "";
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

$("#booksTable").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-book-action]");
  if (!button) return;
  const id = button.closest("[data-book-id]").dataset.bookId;
  const found = latestBooks.find((item) => item.id === id);
  if (!found) return;
  const data = found.data;

  try {
    if (button.dataset.bookAction === "view" || button.dataset.bookAction === "edit") {
      loadBookIntoForm(id, data);
    } else if (button.dataset.bookAction === "print") {
      await printStickerFor(data);
    } else if (button.dataset.bookAction === "found") {
      await updateDoc(doc(db, "books", id), {
        status: "available",
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

onSnapshot(
  query(collection(db, "issueRequests"), where("status", "==", "pending")),
  (snap) => {
    latestPendingRequests = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
    renderPendingRequests();
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
        await sendEmailNotification("Book Issued", {
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
      await rejectRequest(requestId);
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
    } else if (error.message.includes("not available")) {
      showToast("This book is already issued or unavailable.", "warning");
    } else {
      showToast(`${error.code || "error"}: ${error.message}`, "error");
    }
  } finally {
    button.disabled = false;
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
  const confirmed = await confirmAction("Confirm book return?");
  if (!confirmed) return;
  setLoading(event.target, true);
  try {
    const data = await returnBook($("#quickReturnBookId").value.trim());
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
    event.target.reset();
  } catch (error) {
    console.error("Quick return failed full error:", error);
    console.error("Quick return failed code:", error.code);
    console.error("Quick return failed message:", error.message);
    showToast(`${error.code || "error"}: ${error.message}`, "error");
  } finally {
    setLoading(event.target, false);
  }
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

