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
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

wireSignOut();
const session = await requireAuth(["librarian", "admin"]);
const addBookForm = $("#addBookForm");
const bookSearch = $("#bookSearch");
let nextBookId = "1";
let editingBookId = null;
let latestBooks = [];
let latestBarcodeDataUrl = "";
let publisherStream = null;
let publisherScanTimer = null;
let quickReturnStream = null;
let quickReturnScanTimer = null;
const showBookDebug = new URLSearchParams(window.location.search).get("debug") === "true"
  || localStorage.debugBooks === "true";
const testEmailButton = $("#sendTestEmailBtn");

if (testEmailButton && !isEmailNotificationsConfigured()) {
  testEmailButton.disabled = true;
  testEmailButton.title = EMAILJS_SETUP_MESSAGE;
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

async function approveRequest(requestId) {
  console.log("Selected requestId:", requestId);
  let notificationPayload = null;
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
      throw new Error(`Issue request is already ${requestData.status}.`);
    }

    const bookDocId = requestData.b_id || requestData.bookId;
    if (!bookDocId) {
      throw new Error("Missing book id in issue request.");
    }

    const bookRef = doc(db, "books", bookDocId);
    const bookSnap = await transaction.get(bookRef);
    if (!bookSnap.exists()) {
      throw new Error(`Book ${bookDocId} not found.`);
    }

    const bookData = bookSnap.data();
    if (bookData.status !== "available") {
      throw new Error("This book is not available.");
    }

    const issueRef = doc(collection(db, "bookIssues"));
    const issueId = issueRef.id;
    const issuePayload = {
      issueId,
      requestId,
      studentUid: requestData.studentUid,
      studentName: requestData.studentName || "",
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
      approvedBy: auth.currentUser.uid,
      approvedAt: serverTimestamp(),
      createdAt: serverTimestamp()
    };
    const bookUpdate = {
      status: "issued",
      issuedTo: requestData.studentUid,
      issuedToName: requestData.studentName || "",
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
      studentName: requestData.studentName || "",
      bookTitle: issuePayload.bookTitle,
      issueDate: requestData.issueDate,
      dueDate: requestData.dueDate
    };
  });

  if (notificationPayload?.studentUid) {
    const studentSnap = await getDoc(doc(db, "students", notificationPayload.studentUid));
    const student = studentSnap.exists() ? studentSnap.data() : {};
    notificationPayload.studentEmail = student.email || "";
    notificationPayload.studentName = notificationPayload.studentName || student.name || "Student";
  }

  return notificationPayload;
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
      throw new Error(`Issue request is already ${requestData.status}.`);
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

function cleanGoogleBookCode(rawCode) {
  return String(rawCode || "")
    .trim()
    .replace(/[-\s]/g, "")
    .replace(/[^A-Za-z0-9]/g, "");
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
    local: "Fetched from Local Database"
  };
  badge.textContent = labels[source] || "";
  badge.hidden = !source;
}

function inferCategory(title = "") {
  const normalized = title.toLowerCase();
  if (normalized.includes("pyq")) return "pyq";
  if (normalized.includes("question")) return "qna";
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
    categories: Array.isArray(info.categories) ? info.categories.join(", ") : "",
    imageUrl: info.imageLinks?.thumbnail
      ? info.imageLinks.thumbnail.replace("http://", "https://")
      : "",
    isbn13,
    isbn10,
    isbn: isbn13 || isbn10 || cleanCode,
    source: "Google Books",
    metadataSource: "google"
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
    categories: Array.isArray(data.subjects) ? data.subjects.slice(0, 3).join(", ") : "",
    imageUrl: data.covers?.[0] ? `https://covers.openlibrary.org/b/id/${data.covers[0]}-M.jpg` : "",
    isbn13: Array.isArray(data.isbn_13) ? data.isbn_13[0] : "",
    isbn10: Array.isArray(data.isbn_10) ? data.isbn_10[0] : "",
    isbn: (Array.isArray(data.isbn_13) && data.isbn_13[0]) || (Array.isArray(data.isbn_10) && data.isbn_10[0]) || cleanCode,
    source: "Open Library ISBN",
    metadataSource: "openlibrary"
  };
}

function normalizeOpenLibrarySearch(doc, cleanCode) {
  return {
    title: doc.title || "",
    authors: Array.isArray(doc.author_name) ? doc.author_name.join(", ") : "",
    publisher: Array.isArray(doc.publisher) ? doc.publisher[0] || "" : "",
    categories: Array.isArray(doc.subject) ? doc.subject.slice(0, 3).join(", ") : "",
    imageUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : "",
    isbn13: Array.isArray(doc.isbn) ? doc.isbn.find((item) => String(item).length === 13) || "" : "",
    isbn10: Array.isArray(doc.isbn) ? doc.isbn.find((item) => String(item).length === 10) || "" : "",
    isbn: cleanCode,
    source: "Open Library Search",
    metadataSource: "openlibrary"
  };
}

async function fetchGoogleBookDetails(rawCode) {
  const cleanCode = cleanGoogleBookCode(rawCode);

  if (!cleanCode) {
    throw new Error("Enter or scan ISBN/publisher barcode first.");
  }

  const attempts = [];
  const lookups = [
    {
      source: "Local Database",
      url: `Firestore books where publisherBarcode/isbn/barcodeValue == ${cleanCode}`,
      getResult: async () => {
        const localMatches = latestBooks.find(({ data }) =>
          data.publisherBarcode === cleanCode
          || data.isbn === cleanCode
          || data.barcodeValue === cleanCode
        );
        return localMatches ? {
          title: localMatches.data.bname || "",
          authors: localMatches.data.author || "",
          publisher: localMatches.data.publisher || "",
          categories: localMatches.data.subject || "",
          imageUrl: localMatches.data.imageUrl || "",
          isbn: localMatches.data.isbn || cleanCode,
          source: "Local Database",
          metadataSource: "local"
        } : null;
      }
    },
    {
      source: "Google Books",
      url: `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(cleanCode)}`,
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
    }
  ];

  for (const lookup of lookups) {
    if (lookup.source === "Local Database") {
      const localResult = await lookup.getResult();
      attempts.push({
        source: lookup.source,
        url: lookup.url,
        status: "local",
        resultCount: localResult ? 1 : 0,
        error: ""
      });
      updateGoogleFetchDebug({ cleanCode, attempts });
      if (localResult) return localResult;
      continue;
    }

    console.log("Trying metadata URL:", lookup.url);

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
        error: text
      });
      updateGoogleFetchDebug({ cleanCode, attempts });
      continue;
    }

    const data = await response.json();
    console.log("Metadata data:", data);
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
      if (result && (result.title || result.publisher || result.authors)) {
        return result;
      }
    }
  }

  return null;
}

async function fetchGoogleBook(event) {
  event?.preventDefault();
  const barcodeInput = document.getElementById("publisherBarcodeInput");
  const cleanCode = cleanGoogleBookCode(barcodeInput?.value);

  try {
    const info = await fetchGoogleBookDetails(barcodeInput?.value);
    if (!info) {
      $("#bookFetchPreview").innerHTML = `<div class="empty">No online data found. Please fill manually.</div>`;
      if (!/^\d{10}(\d{3})?$/.test(cleanCode)) {
        showToast("This barcode may not be an ISBN. Google Books can only fetch details from ISBN/publisher barcode. Please type manually.", "error");
      } else {
        showToast("No online data found. Please fill manually.", "warning");
      }
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
    if (subjectEl) subjectEl.value = inferSubject(info.title || info.categories);
    $("#category").value = inferCategory(info.title);
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
    showToast("Book details fetched successfully.", "success");
  } catch (error) {
    console.error("Online metadata fetch failed:", error);
    updateGoogleFetchDebug({
      cleanCode,
      url: "-",
      status: "-",
      resultCount: "-",
      error: error.message
    });
    showToast(error.message || "Online metadata fetch failed. Please try again or fill manually.", "error");
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
    const payload = {
      bname: $("#bnameInput").value.trim(),
      subject: $("#subjectInput").value.trim(),
      category: $("#category").value,
      blegal_num: $("#blegalNum").value.trim(),
      publisherBarcode: $("#publisherBarcodeInput").value.trim(),
      isbn: ($("#isbnInput").value || $("#publisherBarcodeInput").value).trim(),
      barcodeValue,
      barcodeDataUrl: "",
      author: $("#authorInput").value.trim(),
      publisher: $("#publisherInput").value.trim(),
      imageUrl: $("#imageUrlInput").value.trim(),
      metadataSource: $("#metadataSourceInput").value.trim(),
      status: "available",
      issuedTo: null,
      currentIssueId: null,
      updatedAt: serverTimestamp()
    };

    if (!payload.bname) throw new Error("Book Name is required.");

    if (editingBookId) {
      payload.barcodeDataUrl = await ensureBarcodeDataUrl();
      await updateDoc(doc(db, "books", editingBookId), payload);
      showToast("Book saved successfully.", "success");
    } else {
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

    editingBookId = null;
    addBookForm.reset();
    $("#category").value = "pyq";
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
            <td>${statusBadge(data.status)}</td>
            <td>
              <div class="row-actions">
                <button class="btn btn-muted" data-book-action="view">View</button>
                <button class="btn btn-muted" data-book-action="edit">Edit</button>
                <button class="btn btn-muted" data-book-action="print">Print Barcode</button>
                <button class="btn btn-muted" data-book-action="lost">Mark Lost</button>
                <button class="btn btn-muted" data-book-action="damaged">Mark Damaged</button>
              </div>
            </td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

function loadBookIntoForm(id, data) {
  editingBookId = id;
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
  const fetchBtn = document.getElementById("fetchGoogleBookBtn");
  const barcodeInput = document.getElementById("publisherBarcodeInput");

  if (!fetchBtn || !barcodeInput) {
    console.error("Google fetch button/input missing", { fetchBtn, barcodeInput });
    return;
  }

  fetchBtn.addEventListener("click", fetchGoogleBook);
});
$("#scanPublisherBtn").addEventListener("click", () => startPublisherScanner().catch((error) => {
  logDetailedError(error);
  showToast(error.message, "error");
}));
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

onSnapshot(
  query(collection(db, "issueRequests"), where("status", "==", "pending")),
  (snap) => {
    const target = $("#pendingRequests");
    if (snap.empty) {
      renderEmpty(target, "No pending issue requests.");
      return;
    }
    target.innerHTML = snap.docs.sort((a, b) => timeOf(a.data().createdAt) - timeOf(b.data().createdAt)).map((item) => {
      const request = item.data();
      return `
        <article class="request-card" data-request-id="${item.id}">
          <img src="${escapeHtml(request.bookImage || "assets/book-placeholder.svg")}" alt="">
          <div>
            <strong>${escapeHtml(request.bookTitle)}</strong>
            <span>${escapeHtml(request.bookId)} requested by ${escapeHtml(request.studentName)}</span>
            <span>Issue ${formatDate(request.issueDate)} | Due ${formatDate(request.dueDate)}</span>
          </div>
          <div class="row-actions">
            <button class="btn btn-primary" data-action="approve">Approve</button>
            <button class="btn btn-muted" data-action="reject">Reject</button>
          </div>
        </article>`;
    }).join("");
  }
);

$("#pendingRequests").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const card = button.closest("[data-request-id]");
  const requestId = card.dataset.requestId;
  const confirmed = await confirmAction(button.dataset.action === "approve"
    ? "Approve this book issue?"
    : "Reject this issue request?");
  if (!confirmed) return;
  button.disabled = true;
  try {
    if (button.dataset.action === "approve") {
      const notificationPayload = await approveRequest(requestId);
      sendEmailNotification("issued", notificationPayload).catch((error) => {
        console.error("Issue email notification failed:", error);
      });
      showToast("Book issued successfully.", "success");
    } else {
      await rejectRequest(requestId);
      showToast("Issue request rejected.", "success");
    }
  } catch (error) {
    if (button.dataset.action === "approve") {
      console.error("Approve failed full error:", error);
      console.error("Approve failed code:", error.code);
      console.error("Approve failed message:", error.message);
    } else {
      console.error("Reject failed full error:", error);
      console.error("Reject failed code:", error.code);
      console.error("Reject failed message:", error.message);
    }
    showToast(`${error.code || "error"}: ${error.message}`, "error");
  } finally {
    button.disabled = false;
  }
});

onSnapshot(
  query(collection(db, "bookIssues"), where("status", "==", "issued"), limit(25)),
  (snap) => {
    const target = $("#activeIssues");
    if (snap.empty) {
      renderEmpty(target, "No active issues.");
      return;
    }
    target.innerHTML = snap.docs.sort((a, b) => timeOf(a.data().dueDate) - timeOf(b.data().dueDate)).map((item) => {
      const issue = item.data();
      return `
        <article class="list-row">
          <div>
            <strong>${escapeHtml(issue.bookTitle || issue.bookId || issue.b_id || "Issued book")}</strong>
            <span>B_ID: ${escapeHtml(issue.b_id || issue.bookId || "")} | Barcode: ${escapeHtml(issue.bookBarcodeValue || "")}</span>
            <span>Student: ${escapeHtml(issue.studentName || "Unknown student")} | UID: ${escapeHtml(shortUid(issue.studentUid))}</span>
            <span>Issued ${formatDate(issue.issueDate)} | Due ${formatDate(issue.dueDate)}</span>
          </div>
          ${statusBadge(issue.status)}
        </article>`;
    }).join("");
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
  query(collection(db, "books"), orderBy("updatedAt", "desc"), limit(50)),
  (snap) => {
    latestBooks = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
    renderBooksTable();
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
      sendEmailNotification("returned", {
        studentName: student.name || data.studentName || "Student",
        studentEmail: student.email || "",
        bookTitle: data.bookTitle,
        issueDate: data.issueDate,
        dueDate: data.dueDate,
        returnDate: data.returnDate,
        penaltyAmount: data.penaltyAmount
      }).catch((error) => {
        console.error("Return email notification failed:", error);
      });
    }
    showToast(data.penaltyAmount > 0
      ? `Book returned with ₹${Number(data.penaltyAmount).toFixed(2)} penalty.`
      : "Book returned with no penalty.", "success");
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
    const result = await sendEmailNotification("issued", {
      studentName: session.profile.name || "MLSU User",
      studentEmail: session.profile.email || session.user.email,
      bookTitle: "Test Book",
      dueDate: new Date()
    });
    $("#notificationResult").innerHTML = `
      <div class="success-box">
        <strong>Test email ${result.sent ? "sent" : "skipped"}</strong>
        <span>Checked: 1</span>
        <span>Emails sent: ${result.sent ? 1 : 0}</span>
        <span>Skipped: ${result.sent ? 0 : 1}</span>
      </div>`;
    showToast(result.sent ? "Test email sent." : EMAILJS_SETUP_MESSAGE, result.sent ? "success" : "error");
  } catch (error) {
    logDetailedError(error);
    const message = error.message?.includes("EMAILJS") ? EMAILJS_SETUP_MESSAGE : error.message;
    $("#notificationResult").innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
    showToast(message, "error");
  } finally {
    button.disabled = false;
  }
});
