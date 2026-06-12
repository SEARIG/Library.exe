import { auth, db } from "./firebase-config.js";
import {
  createCatalogIssueRequest,
  getIssueReturnSchedule,
  getStudentProfile,
  scheduleApplies,
  scheduleLabel
} from "./firestore-service.js";
import { sendEmailNotification } from "./notifications.js";
import {
  collection,
  onSnapshot,
  orderBy,
  query
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  $,
  escapeHtml,
  formatDate,
  renderEmpty,
  showToast
} from "./app.js";

const pageSize = 25;
let allBooks = [];
let currentPage = 1;
let currentUser = null;
let selectedBook = null;
let selectedStudent = null;
let activeSchedule = null;

const searchInput = $("#librarySearch");
const categoryFilter = $("#libraryCategoryFilter");
const availabilityFilter = $("#libraryAvailabilityFilter");
const booksTarget = $("#libraryBooks");
const summaryTarget = $("#librarySummary");
const paginationTarget = $("#libraryPagination");
const authDialog = $("#catalogAuthDialog");
const issueDialog = $("#catalogIssueDialog");
const issueDetails = $("#catalogIssueDetails");
const issueForm = $("#catalogIssueForm");

function bookTitle(book = {}) {
  return book.bname || book.title || book.bookName || "Untitled book";
}

function availabilityLabel(status = "") {
  const value = String(status || "available").toLowerCase();
  if (value === "available") return "Available";
  if (value === "issued") return "Not Available";
  if (value === "lost") return "Lost";
  if (value === "damaged") return "Damaged";
  return value || "Available";
}

function filteredBooks() {
  const search = String(searchInput.value || "").trim().toLowerCase();
  const category = String(categoryFilter.value || "").toLowerCase();
  const availability = String(availabilityFilter.value || "").toLowerCase();

  return allBooks.filter(({ data }) => {
    const status = String(data.status || "available").toLowerCase();
    const bookCategory = String(data.category || "").toLowerCase();
    const haystack = [
      data.b_id,
      data.bname,
      data.bookName,
      data.title,
      data.author,
      data.publisher,
      data.subject,
      data.isbn,
      data.publisherBarcode,
      data.blegal_num,
      data.barcodeValue
    ].join(" ").toLowerCase();

    if (search && !haystack.includes(search)) return false;
    if (category && bookCategory !== category) return false;
    if (availability && status !== availability) return false;
    return true;
  });
}

function renderLibrary() {
  const rows = filteredBooks();
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * pageSize;
  const visibleRows = rows.slice(start, start + pageSize);

  summaryTarget.innerHTML = `
    <strong>${rows.length} book(s) found</strong>
    <span>Showing ${visibleRows.length ? start + 1 : 0}-${Math.min(start + pageSize, rows.length)} of ${rows.length}</span>
  `;

  if (!visibleRows.length) {
    renderEmpty(booksTarget, "No books found.");
  } else {
    booksTarget.innerHTML = visibleRows.map(({ id, data }) => {
      const cover = data.imageUrl || "assets/book-placeholder.svg";
      const status = String(data.status || "available").toLowerCase();
      return `
        <article class="book-card">
          <div class="book-cover">
            <img src="${escapeHtml(cover)}" alt="">
          </div>
          <div>
            <h2>${escapeHtml(bookTitle(data))}</h2>
            <p>${escapeHtml(data.author || "Author not listed")}</p>
          </div>
          <div class="meta-row">
            <span class="category-badge">${escapeHtml(data.category || "other")}</span>
            <span class="availability-badge availability-${escapeHtml(status)}">${escapeHtml(availabilityLabel(status))}</span>
          </div>
          <p><strong>Subject:</strong> ${escapeHtml(data.subject || "General")}</p>
          <p><strong>ISBN:</strong> ${escapeHtml(data.isbn || data.publisherBarcode || "-")}</p>
          <details>
            <summary>View Details</summary>
            <p><strong>B_ID:</strong> ${escapeHtml(data.b_id || id)}</p>
            <p><strong>BLegal Number:</strong> ${escapeHtml(data.blegal_num || "-")}</p>
            <p><strong>Library Barcode:</strong> ${escapeHtml(data.barcodeValue || "-")}</p>
            <p><strong>Availability:</strong> ${escapeHtml(availabilityLabel(data.status))}</p>
            <p><strong>Updated:</strong> ${data.updatedAt ? escapeHtml(formatDate(data.updatedAt)) : "-"}</p>
          </details>
          <button class="btn ${status === "available" ? "btn-primary" : "btn-muted"} request-issue-btn" type="button" data-book-id="${escapeHtml(id)}" ${status === "available" ? "" : "disabled"}>
            ${status === "available" ? "Request Issue" : "Not Available"}
          </button>
        </article>`;
    }).join("");
  }

  renderPagination(totalPages);
}

function renderIssueDialog(book) {
  const scheduleText = scheduleLabel(activeSchedule);
  issueDetails.innerHTML = `
    <article class="list-row">
      <div>
        <strong>${escapeHtml(bookTitle(book.data))}</strong>
        <span>Author: ${escapeHtml(book.data.author || "Author not listed")}</span>
        <span>B_ID: ${escapeHtml(book.data.b_id || book.id)}</span>
        <span>Barcode: ${escapeHtml(book.data.barcodeValue || "-")}</span>
        <span>Availability: ${escapeHtml(availabilityLabel(book.data.status))}</span>
        <span>Library time: ${escapeHtml(scheduleText)}</span>
        <span>Student: ${escapeHtml(selectedStudent?.name || currentUser?.email || "")}</span>
        <span>Email: ${escapeHtml(selectedStudent?.email || currentUser?.email || "")}</span>
      </div>
    </article>`;
  $("#catalogIssueConfirm").checked = false;
}

async function openIssueRequest(bookId) {
  const book = allBooks.find((item) => item.id === bookId);
  if (!book) return;
  if (!currentUser) {
    authDialog.showModal();
    return;
  }
  activeSchedule = await getIssueReturnSchedule();
  if (!scheduleApplies(activeSchedule, "issue")) {
    showToast("Issue request time is not active. Please contact the librarian.", "warning");
    return;
  }
  selectedStudent = await getStudentProfile(currentUser.uid);
  if (!selectedStudent) {
    showToast("Student profile not found. Complete signup before requesting books.", "error");
    return;
  }
  selectedBook = book;
  renderIssueDialog(book);
  issueDialog.showModal();
}

function renderPagination(totalPages) {
  if (totalPages <= 1) {
    paginationTarget.innerHTML = "";
    return;
  }
  const pages = Array.from({ length: totalPages }, (_, index) => index + 1)
    .filter((page) => page === 1 || page === totalPages || Math.abs(page - currentPage) <= 1);
  paginationTarget.innerHTML = `
    <button class="btn btn-muted" type="button" data-page="${currentPage - 1}" ${currentPage === 1 ? "disabled" : ""}>Previous</button>
    ${pages.map((page, index) => {
      const previous = pages[index - 1];
      const spacer = previous && page - previous > 1 ? `<span class="badge">...</span>` : "";
      return `${spacer}<button class="btn ${page === currentPage ? "btn-primary" : "btn-muted"}" type="button" data-page="${page}">${page}</button>`;
    }).join("")}
    <button class="btn btn-muted" type="button" data-page="${currentPage + 1}" ${currentPage === totalPages ? "disabled" : ""}>Next</button>
  `;
}

function resetAndRender() {
  currentPage = 1;
  renderLibrary();
}

searchInput.addEventListener("input", resetAndRender);
categoryFilter.addEventListener("change", resetAndRender);
availabilityFilter.addEventListener("change", resetAndRender);
paginationTarget.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-page]");
  if (!button || button.disabled) return;
  currentPage = Number(button.dataset.page);
  renderLibrary();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

booksTarget.addEventListener("click", (event) => {
  const button = event.target.closest(".request-issue-btn");
  if (!button || button.disabled) return;
  openIssueRequest(button.dataset.bookId).catch((error) => {
    console.error("Open catalog issue request failed:", error);
    showToast(error.message || "Could not open issue request.", "error");
  });
});

document.querySelectorAll("dialog .dialog-close").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog")?.close());
});

issueForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedBook) return;
  const button = issueForm.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    const result = await createCatalogIssueRequest({
      student: selectedStudent,
      book: { id: selectedBook.id, ...selectedBook.data },
      confirmationChecked: $("#catalogIssueConfirm").checked
    });
    try {
      await sendEmailNotification("Issue Request Submitted", {
        studentName: selectedStudent.name || currentUser.email,
        studentEmail: selectedStudent.email || currentUser.email,
        bookTitle: result.payload.bookTitle,
        issueDate: result.payload.issueDate,
        dueDate: result.payload.dueDate,
        returnDate: "-",
        penaltyAmount: 0
      });
    } catch (emailError) {
      console.error("Issue request submitted email failed:", emailError);
    }
    issueDialog.close();
    showToast("Issue request submitted.", "success");
  } catch (error) {
    console.error("Catalog issue request failed:", {
      code: error?.code,
      message: error?.message,
      stack: error?.stack
    });
    showToast(error.message || "Issue request failed.", error.code === "penalty/unpaid" ? "warning" : "error");
  } finally {
    button.disabled = false;
  }
});

onAuthStateChanged(auth, (user) => {
  currentUser = user;
});

onSnapshot(
  query(collection(db, "books"), orderBy("updatedAt", "desc")),
  (snap) => {
    allBooks = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
    renderLibrary();
  },
  (error) => {
    console.error("Public library load failed:", error);
    renderEmpty(summaryTarget, "Unable to load catalog. Check internet connection.");
  }
);
