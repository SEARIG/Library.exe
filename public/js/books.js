import { db } from "./firebase-config.js";
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
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

wireSignOut();
await requireAuth(["librarian", "admin"]);

const form = $("#bookForm");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const bookId = $("#bookId").value.trim();
  if (!bookId) {
    showToast("Book ID is required.", "error");
    return;
  }
  setLoading(form, true);
  try {
    await setDoc(doc(db, "books", bookId), {
      bookId,
      serialNo: $("#serialNo").value.trim(),
      barcodeValue: $("#barcodeValue").value.trim() || bookId,
      title: $("#title").value.trim(),
      author: $("#author").value.trim(),
      category: $("#category").value.trim(),
      imageUrl: $("#imageUrl").value.trim(),
      shelfLocation: $("#shelfLocation").value.trim(),
      status: $("#status").value,
      issuedTo: null,
      currentIssueId: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
    showToast("Book saved.", "success");
    form.reset();
    $("#status").value = "available";
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  } finally {
    setLoading(form, false);
  }
});

onSnapshot(query(collection(db, "books"), orderBy("updatedAt", "desc")), (snap) => {
  const target = $("#booksTable");
  if (snap.empty) {
    renderEmpty(target, "No books yet.");
    return;
  }
  target.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Book</th>
          <th>Barcode</th>
          <th>Shelf</th>
          <th>Status</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        ${snap.docs.map((item) => {
          const book = item.data();
          return `
            <tr>
              <td><strong>${escapeHtml(book.title)}</strong><span>${escapeHtml(book.author)}</span></td>
              <td>${escapeHtml(book.barcodeValue || book.bookId)}</td>
              <td>${escapeHtml(book.shelfLocation)}</td>
              <td>${statusBadge(book.status)}</td>
              <td>${formatDate(book.updatedAt)}</td>
            </tr>`;
        }).join("")}
      </tbody>
    </table>`;
});
