import { db } from "./firebase-config.js";
import { $, escapeHtml, formatDate, renderEmpty, requireAuth, statusBadge, wireSignOut } from "./app.js";
import {
  collection,
  doc,
  onSnapshot,
  query,
  where
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

wireSignOut();
const { user } = await requireAuth(["student"]);

function timeOf(value) {
  if (!value) return 0;
  const date = value.toDate ? value.toDate() : new Date(value);
  return date.getTime();
}

onSnapshot(doc(db, "students", user.uid), (snap) => {
  const target = $("#profilePanel");
  const student = snap.data();
  if (!student) {
    renderEmpty(target, "Profile not found.");
    return;
  }
  target.innerHTML = `
    <div class="detail-grid">
      <span>Name</span><strong>${escapeHtml(student.name)}</strong>
      <span>Email</span><strong>${escapeHtml(student.email)}</strong>
      <span>Student UID</span><strong>${escapeHtml(student.uid)}</strong>
      <span>Student ID</span><strong>${escapeHtml(student.studentId)}</strong>
      <span>Department</span><strong>${escapeHtml(student.department)}</strong>
      <span>Course</span><strong>${escapeHtml(student.course)}</strong>
      <span>Phone</span><strong>${escapeHtml(student.phone)}</strong>
    </div>`;
});

onSnapshot(
  query(collection(db, "bookIssues"), where("studentUid", "==", user.uid)),
  (snap) => {
    const issued = snap.docs
      .filter((item) => item.data().status === "issued")
      .sort((a, b) => timeOf(b.data().issueDate) - timeOf(a.data().issueDate));
    const target = $("#issuedBooks");
    if (!issued.length) {
      renderEmpty(target, "No active issued books.");
      return;
    }
    target.innerHTML = issued.map((item) => {
      const issue = item.data();
      return `
        <article class="list-row">
          <div>
            <strong>${escapeHtml(issue.bookTitle || issue.bookId)}</strong>
            <span>Issued ${formatDate(issue.issueDate)} | Due ${formatDate(issue.dueDate)}</span>
          </div>
          ${statusBadge(issue.status)}
        </article>`;
    }).join("");
  }
);

onSnapshot(
  query(collection(db, "issueRequests"), where("studentUid", "==", user.uid)),
  (snap) => {
    const target = $("#issueHistory");
    if (snap.empty) {
      renderEmpty(target, "No issue requests yet.");
      return;
    }
    target.innerHTML = snap.docs.sort((a, b) => timeOf(b.data().createdAt) - timeOf(a.data().createdAt)).map((item) => {
      const request = item.data();
      return `
        <article class="list-row">
          <div>
            <strong>${escapeHtml(request.bookTitle || request.bookId)}</strong>
            <span>Requested ${formatDate(request.createdAt)} | Due ${formatDate(request.dueDate)}</span>
          </div>
          ${statusBadge(request.status)}
        </article>`;
    }).join("");
  }
);

onSnapshot(
  query(collection(db, "penalties"), where("studentUid", "==", user.uid)),
  (snap) => {
    const target = $("#penalties");
    if (snap.empty) {
      renderEmpty(target, "No penalties.");
      return;
    }
    target.innerHTML = snap.docs.sort((a, b) => timeOf(b.data().createdAt) - timeOf(a.data().createdAt)).map((item) => {
      const penalty = item.data();
      return `
        <article class="list-row">
          <div>
            <strong>Rs.${Number(penalty.amount || 0).toFixed(2)}</strong>
            <span>${penalty.daysLate || 0} late day(s) for ${escapeHtml(penalty.bookId)}</span>
          </div>
          ${statusBadge(penalty.status)}
        </article>`;
    }).join("");
  }
);
