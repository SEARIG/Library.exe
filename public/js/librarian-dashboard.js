import { db, functions } from "./firebase.js";
import {
  $,
  escapeHtml,
  formatDate,
  renderEmpty,
  requireAuth,
  showToast,
  statusBadge,
  wireSignOut
} from "./app.js";
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

wireSignOut();
await requireAuth(["librarian", "admin"]);

const approveIssueRequest = httpsCallable(functions, "approveIssueRequest");
const rejectIssueRequest = httpsCallable(functions, "rejectIssueRequest");
const returnBook = httpsCallable(functions, "returnBook");

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
      await approveIssueRequest({ requestId });
      showToast("Issue request approved.", "success");
    } else {
      await rejectIssueRequest({ requestId, reason: "Rejected by librarian" });
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

$("#quickReturnForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await returnBook({ bookId: $("#quickReturnBookId").value.trim() });
    const data = result.data;
    showToast(`Returned. Penalty Rs.${Number(data.penaltyAmount || 0).toFixed(2)}.`, "success");
    event.target.reset();
  } catch (error) {
    showToast(error.message, "error");
  }
});
