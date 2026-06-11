import { db } from "./firebase-config.js";
import { $, escapeHtml, formatDate, renderEmpty, requireAuth, showToast, statusBadge, wireSignOut } from "./app.js";
import { isUnpaidPenaltyRecord } from "./firestore-service.js";
import {
  collection,
  doc,
  onSnapshot,
  query,
  where
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

wireSignOut();

let session;
try {
  session = await requireAuth(["student"]);
} catch (error) {
  console.error("Student dashboard load failed:", error);
  showToast("Unable to load student dashboard. Please refresh or contact librarian.", "error");
}

const user = session?.user;
const userProfile = session?.profile || {};

function timeOf(value) {
  if (!value) return 0;
  const date = value.toDate ? value.toDate() : new Date(value);
  return date.getTime();
}

function dateFrom(value) {
  if (!value) return null;
  const date = value.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysRemaining(value) {
  const dueDate = dateFrom(value);
  if (!dueDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  dueDate.setHours(0, 0, 0, 0);
  return Math.ceil((dueDate - today) / 86400000);
}

function shortUid(uid = "") {
  const value = String(uid || "");
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function setMetric(id, value) {
  const target = $(id);
  if (target) target.textContent = String(value);
}

function safeRenderEmpty(id, message) {
  const target = $(id);
  if (target) renderEmpty(target, message);
}

function setText(id, value) {
  const target = $(id);
  if (target) target.textContent = String(value);
}

function openHashModal() {
  const id = window.location.hash?.slice(1);
  if (!id) return;
  const modal = document.getElementById(id);
  if (!modal?.classList.contains("modal-backdrop")) return;
  modal.classList.add("open");
  document.body.classList.add("modal-open");
}

function logSectionError(section, error, targetId, message) {
  console.error(`Student dashboard ${section} failed:`, {
    code: error?.code,
    message: error?.message,
    stack: error?.stack
  });
  safeRenderEmpty(targetId, message);
}

function renderProfile(student = {}) {
  const fallback = {
    uid: user?.uid || "",
    name: userProfile.name || user?.displayName || user?.email || "Student",
    email: userProfile.email || user?.email || "",
    phone: userProfile.phone || "",
    rollNumber: userProfile.rollNumber || "",
    department: userProfile.department || "",
    year: userProfile.year || ""
  };
  const profile = { ...fallback, ...student };
  const target = $("#profilePanel");
  if (!target) return;
  target.innerHTML = `
    <div class="detail-grid">
      <span>Name</span><strong>${escapeHtml(profile.name || "Student")}</strong>
      <span>Email</span><strong>${escapeHtml(profile.email || user?.email || "")}</strong>
      <span>Phone</span><strong>${escapeHtml(profile.phone || "")}</strong>
      <span>Roll Number</span><strong>${escapeHtml(profile.rollNumber || "")}</strong>
      <span>Department</span><strong>${escapeHtml(profile.department || "")}</strong>
      <span>Year</span><strong>${escapeHtml(profile.year || "")}</strong>
      <span>Student UID</span>
      <strong class="uid-box">
        <span>${escapeHtml(shortUid(profile.uid || user?.uid || ""))}</span>
        <button class="btn btn-muted uid-copy" id="copyUidBtn" type="button">Copy UID</button>
      </strong>
    </div>`;
  $("#copyUidBtn")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(profile.uid || user?.uid || "");
      showToast("Student UID copied.", "success");
    } catch {
      showToast("Copy is unavailable in this browser. Select the UID manually.", "error");
    }
  });
}

function listenToQuery(section, firestoreQuery, onData, targetId, emptyMessage) {
  return onSnapshot(
    firestoreQuery,
    onData,
    (error) => logSectionError(section, error, targetId, emptyMessage)
  );
}

function renderIssuedBooks(docs) {
  const target = $("#issuedBooks");
  const dueTarget = $("#dueCountdown");
  const issued = docs.sort((a, b) => timeOf(b.data().issueDate) - timeOf(a.data().issueDate));
  setMetric("#metricStudentIssued", issued.length);

  if (!issued.length) {
    renderEmpty(target, "No active issued books.");
    renderEmpty(dueTarget, "No active due dates.");
    setMetric("#metricStudentDaysLeft", "-");
    setText("#issuedSummary", "No active issued books.");
    return;
  }

  const remainingValues = issued
    .map((item) => daysRemaining(item.data().dueDate))
    .filter((value) => value !== null);
  const nearestDays = remainingValues.length ? Math.min(...remainingValues) : null;
  setMetric("#metricStudentDaysLeft", nearestDays === null ? "-" : nearestDays);
  setText("#issuedSummary", `${issued.length} active issued book${issued.length === 1 ? "" : "s"}.`);

  dueTarget.innerHTML = issued.map((item) => {
    const issue = item.data();
    const remaining = daysRemaining(issue.dueDate);
    const isOverdue = remaining !== null && remaining < 0;
    return `
      <article class="list-row">
        <div>
          <strong>${escapeHtml(issue.bookTitle || issue.bookId || "Issued book")}</strong>
          <span>Due ${formatDate(issue.dueDate)}</span>
          <span>${isOverdue ? `${Math.abs(remaining)} day(s) overdue` : `${remaining ?? "-"} day(s) left`}</span>
        </div>
        ${isOverdue ? statusBadge("overdue") : statusBadge("active")}
      </article>`;
  }).join("");

  target.innerHTML = issued.map((item) => {
    const issue = item.data();
    const remaining = daysRemaining(issue.dueDate);
    const isOverdue = remaining !== null && remaining < 0;
    return `
      <article class="list-row">
        <div>
          <strong>${escapeHtml(issue.bookTitle || issue.bookId || "Issued book")}</strong>
          <span>Barcode: ${escapeHtml(issue.bookBarcodeValue || "")}</span>
          <span>Issue Date: ${formatDate(issue.issueDate)}</span>
          <span>Due Date: ${formatDate(issue.dueDate)}</span>
          <span>${isOverdue ? `${Math.abs(remaining)} day(s) overdue` : `${remaining ?? "-"} day(s) remaining`}</span>
        </div>
        ${isOverdue ? statusBadge("overdue") : statusBadge(issue.status)}
      </article>`;
  }).join("");
}

function renderPendingRequests(docs) {
  const target = $("#issueHistory");
  setMetric("#metricStudentRequests", docs.length);
  setText("#pendingRequestsSummary", docs.length
    ? `${docs.length} request${docs.length === 1 ? "" : "s"} waiting for librarian review.`
    : "No pending requests.");
  if (!docs.length) {
    renderEmpty(target, "No pending issue requests.");
    return;
  }
  target.innerHTML = docs
    .sort((a, b) => timeOf(b.data().createdAt) - timeOf(a.data().createdAt))
    .map((item) => {
      const request = item.data();
      return `
        <article class="list-row">
          <div>
            <strong>${escapeHtml(request.bookTitle || request.bookId || "Issue request")}</strong>
            <span>Requested ${formatDate(request.createdAt)} | Due ${formatDate(request.dueDate)}</span>
          </div>
          ${statusBadge(request.status)}
        </article>`;
    }).join("");
}

function renderReturnedBooks(docs) {
  const returnTarget = $("#returnHistory");
  const activityTarget = $("#activityTimeline");
  setMetric("#metricStudentReturned", docs.length);
  if (!docs.length) {
    renderEmpty(returnTarget, "No returned books yet.");
    renderEmpty(activityTarget, "No activity yet.");
    renderEmpty($("#activitySummary"), "No recent activity.");
    return;
  }
  const rows = docs
    .sort((a, b) => timeOf(b.data().returnDate) - timeOf(a.data().returnDate))
    .map((item) => {
      const issue = item.data();
      return `
        <article class="list-row">
          <div>
            <strong>${escapeHtml(issue.bookTitle || issue.bookId || "Returned book")}</strong>
            <span>Returned ${formatDate(issue.returnDate)}</span>
          </div>
          ${statusBadge("returned")}
        </article>`;
    }).join("");
  returnTarget.innerHTML = rows;
  activityTarget.innerHTML = rows;
  $("#activitySummary").innerHTML = rows;
}

function renderPenalties(docs) {
  const target = $("#penalties");
  const unpaidDocs = docs.filter((item) => isUnpaidPenaltyRecord(item.data()));
  const totalPenalty = unpaidDocs.reduce((sum, item) => {
    const penalty = item.data();
    return sum + Number(penalty.remainingAmount ?? penalty.amount ?? penalty.penaltyAmount ?? 0);
  }, 0);
  setMetric("#metricStudentPenalty", totalPenalty.toFixed(0));
  setText("#penaltySummary", totalPenalty > 0
    ? `Pending penalty due: Rs.${totalPenalty.toFixed(2)}`
    : "No pending penalties.");
  if (!docs.length) {
    renderEmpty(target, "No pending penalties.");
    return;
  }
  target.innerHTML = docs
    .sort((a, b) => timeOf(b.data().createdAt) - timeOf(a.data().createdAt))
    .map((item) => {
      const penalty = item.data();
      return `
        <article class="list-row">
          <div>
            <strong>${escapeHtml(penalty.bookTitle || penalty.bookId || "Penalty")}</strong>
            <span>Penalty amount: Rs.${Number(penalty.remainingAmount ?? penalty.amount ?? penalty.penaltyAmount ?? 0).toFixed(2)}</span>
            <span>Late days: ${penalty.lateDays || penalty.daysLate || 0}</span>
            <span>Return date: ${formatDate(penalty.returnDate)}</span>
            <span>Please contact the librarian to clear dues.</span>
          </div>
          ${statusBadge(isUnpaidPenaltyRecord(penalty) ? "unpaid" : "paid")}
        </article>`;
    }).join("");
}

if (user) {
  try {
    renderProfile();

    onSnapshot(
      doc(db, "students", user.uid),
      (snap) => renderProfile(snap.exists() ? snap.data() : {}),
      (error) => {
        logSectionError("profile", error, "#profilePanel", "Could not load student profile.");
        renderProfile();
      }
    );

    listenToQuery(
      "issued books query",
      query(collection(db, "bookIssues"), where("studentUid", "==", user.uid), where("status", "==", "issued")),
      (snap) => renderIssuedBooks(snap.docs),
      "#issuedBooks",
      "Could not load issued books."
    );

    listenToQuery(
      "pending requests query",
      query(collection(db, "issueRequests"), where("studentUid", "==", user.uid), where("status", "==", "pending")),
      (snap) => renderPendingRequests(snap.docs),
      "#issueHistory",
      "Could not load pending requests."
    );

    listenToQuery(
      "return history query",
      query(collection(db, "bookIssues"), where("studentUid", "==", user.uid), where("status", "==", "returned")),
      (snap) => renderReturnedBooks(snap.docs),
      "#returnHistory",
      "Could not load return history."
    );

    listenToQuery(
      "penalty history query",
      query(collection(db, "penalties"), where("studentUid", "==", user.uid)),
      (snap) => renderPenalties(snap.docs),
      "#penalties",
      "Could not load penalty history."
    );

    openHashModal();
  } catch (error) {
    console.error("Student dashboard load failed:", error);
    showToast("Unable to load student dashboard. Please refresh or contact librarian.", "error");
  }
}
