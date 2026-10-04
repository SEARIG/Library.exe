import { auth, db } from "./firebase-config.js";
import {
  accessionNumberOf,
  compareAccessionNumbers,
  createCatalogIssueRequest,
  findBookByLibraryCode,
  getIssueReturnSchedule,
  getStudentProfile,
  scheduleApplies,
  scheduleLabel,
  titleOf
} from "./firestore-service.js?v=3";
import { sendEmailNotification } from "./notifications.js";
import {
  collection,
  documentId,
  getCountFromServer,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  $,
  escapeHtml,
  formatDate,
  getUserProfile,
  renderEmpty,
  showToast
} from "./app.js";
import { renderNavbar } from "./navbar.js";
import { bookCardThemeStyle, getBookCardTheme } from "./book-card-theme.mjs?v=1";

const pageSize = 24;
const scanPageSize = 100;
let allBooks = [];
let currentPage = 1;
let totalBooks = 0;
let pageCursors = [null];
let searchMode = false;
let loadSequence = 0;
let currentUser = null;
let selectedBook = null;
let selectedStudent = null;
let activeSchedule = null;

const searchInput = $("#librarySearch");
const availabilityFilter = $("#libraryAvailabilityFilter");
const booksTarget = $("#libraryBooks");
const summaryTarget = $("#librarySummary");
const paginationTarget = $("#libraryPagination");
const authDialog = $("#catalogAuthDialog");
const issueDialog = $("#catalogIssueDialog");
const issueDetails = $("#catalogIssueDetails");
const issueForm = $("#catalogIssueForm");

function bookTitle(book = {}) {
  return titleOf(book) || book.bookTitle || "Untitled book";
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
  const availability = String(availabilityFilter.value || "").toLowerCase();

  return allBooks
    .filter(({ data }) => {
      const status = String(data.status || "available").toLowerCase();
      const haystack = [
        bookTitle(data),
        data.author,
        accessionNumberOf(data),
        data.isbn,
        data.publisherBarcode,
        data.barcodeValue,
        data.bookBarcodeValue,
        data.category,
        data.subject
      ].join(" ").toLowerCase();

      if (search && !haystack.includes(search)) return false;
      if (availability && status !== availability) return false;
      return true;
    })
    .sort((left, right) =>
      compareAccessionNumbers(accessionNumberOf(left.data), accessionNumberOf(right.data))
    );
}

function renderLibrary() {
  const rows = filteredBooks();
  const matchingTotal = searchMode ? rows.length : totalBooks;
  const totalPages = Math.max(1, Math.ceil(matchingTotal / pageSize));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * pageSize;
  const visibleRows = searchMode ? rows.slice(start, start + pageSize) : rows;

  summaryTarget.innerHTML = `
    <strong>${matchingTotal} book(s) found</strong>
    <span>Showing ${visibleRows.length ? start + 1 : 0}-${Math.min(start + visibleRows.length, matchingTotal)} of ${matchingTotal}${searchMode ? " · complete-library search" : ""}</span>
  `;

  if (!visibleRows.length) {
    renderEmpty(
      booksTarget,
      totalBooks === 0 ? "No books have been added yet." : "No books match the selected search and filters."
    );
  } else {
    booksTarget.innerHTML = visibleRows.map(({ id, data }) => {
      const cover = String(data.imageUrl || "").trim();
      const status = String(data.status || "available").toLowerCase();
      const theme = getBookCardTheme(data);
      const themeStyle = bookCardThemeStyle(theme);
      const coverMarkup = `
        ${cover ? `<img class="catalog-cover-image" src="${escapeHtml(cover)}" alt="Cover of ${escapeHtml(bookTitle(data))}">` : ""}
        <div class="catalog-cover-placeholder" role="img" aria-label="Color-themed placeholder cover for ${escapeHtml(bookTitle(data))}">
          <span class="placeholder-book" aria-hidden="true">
            <span class="placeholder-spine"></span>
            <span class="placeholder-line placeholder-line-one"></span>
            <span class="placeholder-line placeholder-line-two"></span>
            <span class="placeholder-line placeholder-line-three"></span>
          </span>
        </div>`;
      return `
        <article class="book-card" data-book-theme="${theme.name}" style="${themeStyle}">
          <div class="book-cover ${cover ? "has-real-cover" : "uses-placeholder"}">
            ${coverMarkup}
          </div>
          <div class="book-card-heading">
            <h2 title="${escapeHtml(bookTitle(data))}">${escapeHtml(bookTitle(data))}</h2>
            <p title="${escapeHtml(data.author || "Author not listed")}">${escapeHtml(data.author || "Author not listed")}</p>
          </div>
          <div class="meta-row">
            <span class="availability-badge availability-${escapeHtml(status)}">${escapeHtml(availabilityLabel(status))}</span>
          </div>
          <p class="book-accession"><span class="book-accession-icon" aria-hidden="true">#</span><strong>Accession No.:</strong> ${escapeHtml(accessionNumberOf(data) || "-")}</p>
          <p><strong>Place &amp; Publisher:</strong> ${escapeHtml(data.placePublisher || data.publisher || "-")}</p>
          <p><strong>Year:</strong> ${escapeHtml(data.year || "-")}</p>
          <p><strong>Pages:</strong> ${escapeHtml(data.pages || "-")}</p>
          <details>
            <summary>View Details</summary>
            <p><strong>Vol.:</strong> ${escapeHtml(data.volume || "-")}</p>
            <p><strong>Availability:</strong> ${escapeHtml(availabilityLabel(data.status))}</p>
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
        <span>Accession No.: ${escapeHtml(accessionNumberOf(book.data) || "-")}</span>
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
  paginationTarget.innerHTML = `
    <button class="btn btn-muted" type="button" data-page="${currentPage - 1}" ${currentPage === 1 ? "disabled" : ""}>Previous</button>
    <span class="badge">Page ${currentPage} of ${totalPages}</span>
    <button class="btn btn-muted" type="button" data-page="${currentPage + 1}" ${currentPage === totalPages ? "disabled" : ""}>Next</button>
  `;
}

async function loadCatalogPage(page = 1) {
  const sequence = ++loadSequence;
  searchMode = false;
  const requestedPage = Math.max(1, Number(page || 1));
  const cursor = pageCursors[requestedPage - 1];
  if (requestedPage > 1 && !cursor) return;
  const constraints = [orderBy(documentId()), limit(pageSize)];
  if (cursor) constraints.splice(1, 0, startAfter(cursor));
  const snap = await getDocs(query(collection(db, "books"), ...constraints));
  if (sequence !== loadSequence) return;
  allBooks = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
  currentPage = requestedPage;
  if (snap.docs.length) pageCursors[requestedPage] = snap.docs[snap.docs.length - 1];
  renderLibrary();
}

async function scanCatalog() {
  const sequence = ++loadSequence;
  searchMode = true;
  currentPage = 1;
  renderEmpty(booksTarget, "Searching the complete library catalog…");
  const rows = [];
  let cursor = null;
  while (true) {
    const constraints = [orderBy(documentId()), limit(scanPageSize)];
    if (cursor) constraints.splice(1, 0, startAfter(cursor));
    const snap = await getDocs(query(collection(db, "books"), ...constraints));
    rows.push(...snap.docs.map((item) => ({ id: item.id, data: item.data() })));
    if (sequence !== loadSequence) return;
    if (snap.size < scanPageSize) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  allBooks = rows;
  renderLibrary();
}

async function refreshCatalog() {
  const search = searchInput.value.trim();
  const availability = availabilityFilter.value;
  if (search || availability) {
    if (search && !availability) {
      try {
        const direct = await findBookByLibraryCode(search);
        const directAccession = String(accessionNumberOf(direct)).replace(/^0+/, "") || "0";
        const searchedAccession = String(search).replace(/^ACC-/i, "").replace(/^0+/, "") || "0";
        if (directAccession.toUpperCase() === searchedAccession.toUpperCase()) {
          searchMode = true;
          currentPage = 1;
          allBooks = [{ id: direct.id, data: direct }];
          renderLibrary();
          return;
        }
      } catch {
        // Non-accession searches use the incremental complete-catalog scan.
      }
    }
    await scanCatalog();
    return;
  }
  pageCursors = [null];
  await loadCatalogPage(1);
}

let catalogRefreshTimer = null;
function scheduleCatalogRefresh() {
  window.clearTimeout(catalogRefreshTimer);
  catalogRefreshTimer = window.setTimeout(() => {
    refreshCatalog().catch((error) => {
      console.error("Catalog search failed:", error);
      renderEmpty(booksTarget, error.message || "Unable to search the catalog.");
    });
  }, 250);
}

searchInput.addEventListener("input", scheduleCatalogRefresh);
availabilityFilter.addEventListener("change", scheduleCatalogRefresh);
paginationTarget.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-page]");
  if (!button || button.disabled) return;
  const page = Number(button.dataset.page);
  if (searchMode) {
    currentPage = page;
    renderLibrary();
  } else {
    loadCatalogPage(page).catch((error) => {
      console.error("Catalog page load failed:", error);
      showToast("Could not load this catalog page.", "error");
    });
  }
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
booksTarget.addEventListener("error", (event) => {
  if (!event.target.matches(".catalog-cover-image")) return;
  event.target.closest(".book-cover")?.classList.add("cover-failed");
}, true);

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
      currentUserUid: currentUser?.uid || "",
      code: error?.code,
      message: error?.message,
      stack: error?.stack
    });
    const isPermissionError = error.code === "permission-denied" || /permission/i.test(error.message || "");
    showToast(
      isPermissionError ? "Could not send issue request. Please refresh and try again." : error.message || "Issue request failed.",
      error.code === "penalty/unpaid" || error.code === "dues/blocked" ? "warning" : "error"
    );
  } finally {
    button.disabled = false;
  }
});

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) {
    getUserProfile(user.uid)
      .then((profile) => {
        if (!["admin", "librarian"].includes(profile?.role)) return;
        const header = document.querySelector(".library-nav");
        if (header) header.className = "app-header";
        document.body.classList.add("protected-page", "auth-ready", "staff-catalog-page");
        document.querySelector(".library-page")?.classList.add("app-main");
        renderNavbar(profile.role, { ...profile, email: user.email });
      })
      .catch((error) => console.warn("Could not render staff library navigation:", error));
  }
});

try {
  totalBooks = (await getCountFromServer(collection(db, "books"))).data().count;
  await loadCatalogPage(1);
} catch (error) {
  console.error("Public library load failed:", error);
  renderEmpty(summaryTarget, "Unable to load catalog. Check internet connection.");
}
