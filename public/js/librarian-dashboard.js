import { db } from "./firebase-config.js";
import {
  $,
  escapeHtml,
  formatDate,
  renderEmpty,
  requireAuth,
  setLoading,
  showToast,
  statusBadge,
  wireSignOut
} from "./app.js";
import {
  approveIssue,
  rejectIssue,
  returnBook
} from "./firestore-service.js";
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

wireSignOut();
await requireAuth(["librarian", "admin"]);

function timeOf(value) {
  if (!value) return 0;
  const date = value.toDate ? value.toDate() : new Date(value);
  return date.getTime();
}

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
      await approveIssue(requestId);
      showToast("Issue request approved.", "success");
    } else {
      await rejectIssue(requestId, "Rejected by librarian");
      showToast("Issue request rejected.", "success");
    }
  } catch (error) {
    showToast(error.message, "error");
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
            <span>${escapeHtml(student.studentId)} | ${escapeHtml(student.department)}</span>
          </div>
          ${statusBadge(student.active ? "active" : "inactive")}
        </article>`;
    }).join("");
  }
);

onSnapshot(
  query(collection(db, "books"), orderBy("updatedAt", "desc"), limit(20)),
  (snap) => {
    const target = $("#recentBooks");
    if (snap.empty) {
      renderEmpty(target, "No books found.");
      return;
    }
    target.innerHTML = snap.docs.map((item) => {
      const book = item.data();
      return `
        <article class="list-row">
          <div>
            <strong>${escapeHtml(book.title)}</strong>
            <span>${escapeHtml(book.bookId)} | ${escapeHtml(book.shelfLocation)}</span>
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
    showToast(error.message, "error");
  } finally {
    setLoading(event.target, false);
  }
});
