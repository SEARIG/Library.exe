import { auth, db } from "./firebase-config.js";
import {
  $,
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

function timeOf(value) {
  if (!value) return 0;
  const date = value.toDate ? value.toDate() : new Date(value);
  return date.getTime();
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
      approvedBy: auth.currentUser.uid,
      approvedAt: serverTimestamp(),
      createdAt: serverTimestamp()
    };
    const bookUpdate = {
      status: "issued",
      issuedTo: requestData.studentUid,
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
  });
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

async function fetchGoogleBookDetails(code) {
  const cleanCode = code.trim().replace(/[-\s]/g, "");
  const isbnUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(cleanCode)}`;

  console.log("Fetching Google Books details for:", cleanCode);
  console.log("Google Books API URL:", isbnUrl);
  let response = await fetch(isbnUrl);
  let data = await response.json();
  console.log("Google Books result:", data);

  if (!data.items || data.items.length === 0) {
    const generalUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(cleanCode)}`;
    console.log("Google Books API URL:", generalUrl);
    response = await fetch(generalUrl);
    data = await response.json();
    console.log("Google Books result:", data);
  }

  if (!data.items || data.items.length === 0) {
    return null;
  }

  return data.items[0].volumeInfo;
}

function getPreferredIsbn(volumeInfo, fallback) {
  const identifiers = volumeInfo.industryIdentifiers || [];
  return identifiers.find((item) => item.type === "ISBN_13")?.identifier
    || identifiers.find((item) => item.type === "ISBN_10")?.identifier
    || fallback;
}

async function fetchGoogleBook() {
  const rawCode = $("#publisherBarcode").value;
  const cleanCode = rawCode.trim().replace(/[-\s]/g, "");
  if (!cleanCode) {
    showToast("Enter or scan publisher barcode/ISBN first.", "error");
    return;
  }

  try {
    const info = await fetchGoogleBookDetails(cleanCode);
    if (!info) {
      $("#bookFetchPreview").innerHTML = `<div class="empty">No Google Books result found. Please fill details manually.</div>`;
      showToast("No Google Books result found. Please fill details manually.", "error");
      return;
    }

    const imageUrl = (info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || "").replace(/^http:\/\//, "https://");
    const author = (info.authors || []).join(", ");
    const publisher = info.publisher || "";
    const title = info.title || "";
    const isbn = getPreferredIsbn(info, cleanCode);

    $("#publisherBarcode").value = cleanCode;
    $("#isbn").value = isbn;
    $("#bname").value = title;
    $("#author").value = author;
    $("#publisher").value = publisher;
    $("#imageUrl").value = imageUrl;
    if (info.categories?.length) {
      $("#subject").value = info.categories[0];
    }

    $("#bookFetchPreview").innerHTML = `
      <article class="book-preview">
        <img src="${escapeHtml(imageUrl || "assets/book-placeholder.svg")}" alt="">
        <div>
          <strong>${escapeHtml(title || "Untitled book")}</strong>
          <span>${escapeHtml(author || "Unknown author")}</span>
          <span>${escapeHtml(publisher || "Publisher not found")}</span>
        </div>
      </article>`;
    showToast("Book details fetched successfully.", "success");
  } catch (error) {
    console.error("Google Books fetch failed:", error);
    showToast("Google Books fetch failed. Please try again or fill manually.", "error");
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
    $("#publisherBarcode").value = codes[0].rawValue;
    await stopPublisherScanner();
    showToast("Publisher barcode scanned.", "success");
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
      bname: $("#bname").value.trim(),
      subject: $("#subject").value.trim(),
      category: $("#category").value,
      blegal_num: $("#blegalNum").value.trim(),
      publisherBarcode: $("#publisherBarcode").value.trim(),
      isbn: ($("#isbn").value || $("#publisherBarcode").value).trim(),
      barcodeValue,
      barcodeDataUrl: "",
      author: $("#author").value.trim(),
      publisher: $("#publisher").value.trim(),
      imageUrl: $("#imageUrl").value.trim(),
      status: "available",
      issuedTo: null,
      currentIssueId: null,
      updatedAt: serverTimestamp()
    };

    if (!payload.bname) throw new Error("Book Name is required.");

    if (editingBookId) {
      payload.barcodeDataUrl = await ensureBarcodeDataUrl();
      await updateDoc(doc(db, "books", editingBookId), payload);
      showToast("Book updated.", "success");
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
      showToast("Book saved with library barcode.", "success");
    }

    editingBookId = null;
    addBookForm.reset();
    $("#category").value = "pyq";
    $("#bookFetchPreview").innerHTML = `<div class="empty">Fetch details or fill the book manually.</div>`;
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
  $("#bname").value = bookTitle(data);
  $("#subject").value = data.subject || "";
  $("#category").value = data.category || "other";
  $("#blegalNum").value = data.blegal_num || "";
  $("#publisherBarcode").value = data.publisherBarcode || data.isbn || "";
  $("#isbn").value = data.isbn || data.publisherBarcode || "";
  $("#author").value = data.author || "";
  $("#publisher").value = data.publisher || "";
  $("#imageUrl").value = data.imageUrl || "";
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
  printWindow.document.write(`<html><head><title>Barcode</title><link rel="stylesheet" href="css/styles.css"></head><body>${html}<script>window.print(); window.close();</script></body></html>`);
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
  $("#fetchGoogleBookBtn").addEventListener("click", fetchGoogleBook);
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
  button.disabled = true;
  try {
    if (button.dataset.action === "approve") {
      await approveRequest(requestId);
      showToast("Issue request approved.", "success");
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
            <strong>${escapeHtml(issue.bookId)}</strong>
            <span>Student ${escapeHtml(issue.studentUid)} | Due ${formatDate(issue.dueDate)}</span>
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
  setLoading(event.target, true);
  try {
    const data = await returnBook($("#quickReturnBookId").value.trim());
    showToast(`Returned. Penalty Rs.${Number(data.penaltyAmount || 0).toFixed(2)}.`, "success");
    event.target.reset();
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  } finally {
    setLoading(event.target, false);
  }
});
