import { db } from "./firebase-config.js";
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  where
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

const catalogGrid = document.getElementById("homeCatalogGrid");
const booksCount = document.getElementById("homeBooksCount");
const studentsCount = document.getElementById("homeStudentsCount");
const issuesCount = document.getElementById("homeIssuesCount");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderEmpty(target, label) {
  if (target) target.innerHTML = `<div class="empty">${escapeHtml(label)}</div>`;
}

function statusLabel(status = "") {
  const value = String(status || "available").toLowerCase();
  if (value === "available") return "Available";
  if (value === "issued") return "Issued";
  if (value === "lost") return "Lost";
  if (value === "damaged") return "Damaged";
  return value || "Available";
}

function bookTitle(book = {}) {
  return book.bname || book.title || book.bookName || "Untitled book";
}

function renderBooks(rows) {
  if (!rows.length) {
    renderEmpty(catalogGrid, "No books found.");
    return;
  }

  catalogGrid.innerHTML = rows.map((book) => {
    const status = String(book.status || "available").toLowerCase();
    return `
      <article class="home-book-card">
        <img src="${escapeHtml(book.imageUrl || "assets/book-placeholder.svg")}" alt="">
        <div>
          <h3>${escapeHtml(bookTitle(book))}</h3>
          <p>${escapeHtml(book.author || "Author not listed")}</p>
          <span class="category-badge">${escapeHtml(book.category || "General")}</span>
          <span class="availability-badge availability-${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>
        </div>
      </article>`;
  }).join("");
}

async function loadPreviewBooks() {
  try {
    const snap = await getDocs(query(collection(db, "books"), orderBy("updatedAt", "desc"), limit(6)));
    renderBooks(snap.docs.map((item) => item.data()));
  } catch (error) {
    console.error("Homepage catalog preview failed:", error);
    renderEmpty(catalogGrid, "Unable to load catalog preview.");
  }
}

async function loadStats() {
  try {
    const booksSnap = await getDocs(query(collection(db, "books"), where("status", "==", "available"), limit(1000)));
    booksCount.textContent = String(booksSnap.size);
    studentsCount.textContent = "--";
    issuesCount.textContent = "--";
  } catch (error) {
    console.error("Homepage stats failed:", error);
    booksCount.textContent = "--";
    studentsCount.textContent = "--";
    issuesCount.textContent = "--";
  }
}

loadPreviewBooks();
loadStats();
