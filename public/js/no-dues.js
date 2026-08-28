import { auth, db } from "./firebase-config.js";
import {
  $,
  escapeHtml,
  formatDate,
  logDetailedError,
  renderEmpty,
  requireAuth,
  showToast,
  statusBadge
} from "./app.js";
import {
  arrayUnion,
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { buildNoDuesRows } from "./no-dues-utils.mjs";

const session = await requireAuth(["admin", "librarian"]);

let latestUsers = [];
let latestStudents = [];
let latestIssues = [];
let latestPenalties = [];
let latestBooks = [];
const initialParams = new URLSearchParams(window.location.search);
let requestedStudentUid = initialParams.get("student") || "";
let pendingClearDues = null;

const controls = {
  search: $("#noDuesSearch"),
  status: $("#noDuesStatusFilter"),
  due: $("#noDuesDueFilter"),
  table: $("#noDuesTable"),
  summary: $("#noDuesSummaryList"),
  topPending: $("#noDuesTopPending"),
  reviewPanel: $("#noDuesReviewPanel"),
  reviewContent: $("#noDuesReviewContent")
};
if (initialParams.get("filter") && controls.due) {
  controls.due.value = initialParams.get("filter");
}

function initialsFor(name = "") {
  return String(name || "Student")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "ST";
}

function penaltyAmountOf(penalty = {}) {
  return Number(penalty.remainingAmount ?? penalty.amount ?? penalty.penaltyAmount ?? penalty.fineAmount ?? 0) || 0;
}

function penaltyIssueIdOf(penalty = {}, fallback = "") {
  return penalty.issueId || penalty.currentIssueId || penalty.bookIssueId || penalty.penaltyId || penalty.id || fallback;
}

function noDuesRows() {
  return buildNoDuesRows({
    users: latestUsers,
    students: latestStudents,
    issues: latestIssues,
    penalties: latestPenalties,
    books: latestBooks,
    now: new Date(),
    formatDate
  });
}

function filteredRows() {
  const search = String(controls.search?.value || "").trim().toLowerCase();
  const status = controls.status?.value || "";
  const due = controls.due?.value || "";
  return noDuesRows().filter((row) => {
    const haystack = [
      row.name,
      row.email,
      row.phone,
      row.rollNumber,
      row.enrollmentNumber,
      row.department,
      row.year,
      row.uid,
      row.blockers.join(" ")
    ].join(" ").toLowerCase();
    if (search && !haystack.includes(search)) return false;
    if (status && row.status !== status) return false;
    if (due && !row.dueTypes.has(due)) return false;
    return true;
  });
}

function renderNoDues() {
  if (!controls.table) return;
  const rows = filteredRows();
  const allRows = noDuesRows();
  const eligible = allRows.filter((row) => row.status === "eligible").length;
  const blocked = allRows.length - eligible;
  const activeIssues = allRows.reduce((sum, row) => sum + row.activeBooks, 0);
  const pendingAmount = allRows.reduce((sum, row) => sum + row.penaltyAmount, 0);

  $("#noDuesClearStudents").textContent = String(eligible);
  $("#noDuesBlockedStudents").textContent = String(blocked);
  $("#noDuesActiveIssues").textContent = String(activeIssues);
  $("#noDuesPendingAmount").textContent = `₹ ${pendingAmount.toFixed(0)}`;

  controls.summary.innerHTML = `
    <div><span>Total Students</span><strong>${allRows.length}</strong></div>
    <div><span>Eligible for No Dues</span><strong>${eligible}</strong></div>
    <div><span>Blocked Students</span><strong>${blocked}</strong></div>
    <div><span>Active Issued Books</span><strong>${activeIssues}</strong></div>
    <div><span>Pending Penalty Amount</span><strong>₹ ${pendingAmount.toFixed(2)}</strong></div>`;

  const topRows = allRows.filter((row) => row.status === "blocked").slice(0, 5);
  controls.topPending.innerHTML = topRows.length
    ? topRows.map((row, index) => `
      <div>
        <span>${index + 1}. ${escapeHtml(row.name)}</span>
        <strong>${row.penaltyAmount ? `₹ ${row.penaltyAmount.toFixed(0)}` : `${row.activeBooks} book${row.activeBooks === 1 ? "" : "s"}`}</strong>
      </div>`).join("")
    : `<div class="empty">No pending students.</div>`;

  if (!rows.length) {
    renderEmpty(controls.table, "No students match the selected no dues filters.");
    return;
  }

  controls.table.innerHTML = `
    <table class="no-dues-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Student Details</th>
          <th>Roll No.</th>
          <th>Enrollment No.</th>
          <th>Active Books</th>
          <th>Overdue Books</th>
          <th>Pending Penalty</th>
          <th>Clearance Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row, index) => `
          <tr>
            <td>${index + 1}</td>
            <td>
              <div class="student-cell">
                <span class="student-avatar">${escapeHtml(initialsFor(row.name))}</span>
                <div>
                  <strong>${escapeHtml(row.name)}</strong>
                  <span>${escapeHtml([row.email, row.phone].filter(Boolean).join(" | ") || row.department || "Student")}</span>
                </div>
              </div>
            </td>
            <td>${escapeHtml(row.rollNumber)}</td>
            <td>${escapeHtml(row.enrollmentNumber || "-")}</td>
            <td><strong class="${row.activeBooks ? "danger-text" : "success-text"}">${row.activeBooks}</strong></td>
            <td><strong class="${row.overdueCount ? "danger-text" : "success-text"}">${row.overdueCount}</strong></td>
            <td><strong class="${row.penaltyAmount ? "danger-text" : "success-text"}">₹ ${row.penaltyAmount.toFixed(2)}</strong></td>
            <td>${row.status === "eligible" ? statusBadge("eligible") : statusBadge("blocked")}</td>
            <td><button class="btn btn-primary" data-no-dues-action="review" data-student-uid="${escapeHtml(row.uid)}" type="button">Review</button></td>
          </tr>`).join("")}
      </tbody>
    </table>
    <div class="table-footer-note">Showing ${rows.length} of ${allRows.length} student entries</div>`;

  if (requestedStudentUid) {
    const requestedRow = allRows.find((row) => row.uid === requestedStudentUid);
    if (requestedRow) {
      const uid = requestedStudentUid;
      requestedStudentUid = "";
      renderReview(requestedRow);
      history.replaceState(null, "", `no-dues.html?student=${encodeURIComponent(uid)}`);
    }
  }
}

function renderPenaltyItems(row) {
  const items = row.penaltyItems || [];
  if (!items.length) return `<div class="empty">No unpaid penalty records or live penalty items.</div>`;
  return items.map((item) => {
    const penalty = item.penalty || {};
    const penaltyId = item.id || item.issueId || penalty.penaltyId || penalty.issueId || "";
    return `
      <article class="list-row no-dues-penalty-row">
        <div>
          <strong>${escapeHtml(item.bookTitle || item.bookId || "Library penalty")}</strong>
          <span>Accession No.: ${escapeHtml(item.accessionNumber || "-")}</span>
          <span>Due: ${formatDate(item.dueDate)} | Overdue: ${Number(item.overdueDays || 0)} days</span>
          <span>Rate: ₹${Number(item.ratePerDay || 5).toFixed(0)}/day | Penalty: ₹${Number(item.amount || 0).toFixed(2)}</span>
          <span>Payment status: ${escapeHtml(penalty.paymentStatus || penalty.penaltyStatus || penalty.status || "unpaid")}</span>
        </div>
        <button class="btn btn-primary clear-dues-btn" data-penalty-id="${escapeHtml(penaltyId)}" data-student-uid="${escapeHtml(row.uid)}" type="button">Clear Dues / Record Payment</button>
      </article>`;
  }).join("");
}

function renderReview(row) {
  controls.reviewPanel.hidden = false;
  $("#noDuesReviewTitle").textContent = `${row.name} - No Dues Review`;
  controls.reviewContent.innerHTML = `
    <section class="detail-grid">
      <span>Name</span><strong>${escapeHtml(row.name)}</strong>
      <span>Roll No.</span><strong>${escapeHtml(row.rollNumber || "-")}</strong>
      <span>Enrollment No.</span><strong>${escapeHtml(row.enrollmentNumber || "-")}</strong>
      <span>Course / Department</span><strong>${escapeHtml(row.department || "-")}</strong>
      <span>Email</span><strong>${escapeHtml(row.email || "-")}</strong>
      <span>Phone</span><strong>${escapeHtml(row.phone || "-")}</strong>
      <span>Active Books</span><strong>${row.activeBooks}</strong>
      <span>Overdue Books</span><strong>${row.overdueCount}</strong>
      <span>Pending Penalty</span><strong class="${row.penaltyAmount ? "danger-text" : "success-text"}">₹ ${row.penaltyAmount.toFixed(2)}</strong>
      <span>Lost/Damaged</span><strong>${row.lostCount + row.damagedCount}</strong>
      <span>Clearance Status</span><strong>${row.status === "eligible" ? "Eligible" : "Blocked"}</strong>
    </section>

    ${row.blockers.length ? `<section class="blocked-note"><strong>NO DUES BLOCKED</strong>${row.blockers.map((blocker) => `<span>${escapeHtml(blocker)}</span>`).join("")}</section>` : `<section class="success-box">Student is eligible for No Dues clearance.</section>`}

    <h3>Active Issues</h3>
    ${row.activeIssueDetails.length ? row.activeIssueDetails.map((issue) => `
      <article class="list-row">
        <div>
          <strong>${escapeHtml(issue.bookTitle)}</strong>
          <span>Accession No.: ${escapeHtml(issue.accessionNumber)}</span>
          <span>Issue: ${formatDate(issue.issueDate)} | Due: ${formatDate(issue.dueDate)}</span>
        </div>
        ${statusBadge(issue.status || "issued")}
      </article>`).join("") : `<div class="empty">No active issued books.</div>`}

    <h3>Overdue / Penalty</h3>
    ${renderPenaltyItems(row)}

    <h3>Paid History</h3>
    ${row.paidHistory.length ? row.paidHistory.slice(0, 20).map((penalty) => `
      <article class="list-row">
        <div>
          <strong>₹${Number(penalty.paymentAmount || penalty.amountPaid || penalty.paidAmount || penalty.amount || penalty.penaltyAmount || 0).toFixed(2)}</strong>
          <span>Payment date: ${formatDate(penalty.clearedAt || penalty.paidAt || penalty.updatedAt)}</span>
          <span>Cleared by: ${escapeHtml(penalty.clearedByName || penalty.paidByName || penalty.clearedBy || penalty.paidBy || "-")}</span>
          <span>Remarks: ${escapeHtml(penalty.remarks || penalty.paymentRemarks || "-")}</span>
        </div>
        ${statusBadge(penalty.paymentStatus || penalty.penaltyStatus || penalty.status || "paid")}
      </article>`).join("") : `<div class="empty">No paid penalty history found.</div>`}`;

  controls.reviewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function openClearDuesDialog(studentUid, penaltyId) {
  const row = noDuesRows().find((item) => item.uid === studentUid);
  if (!row) throw new Error("Student row not found.");
  const item = row.penaltyItems.find((penaltyItem) => {
    const penalty = penaltyItem.penalty || {};
    return [penaltyItem.id, penaltyItem.issueId, penalty.penaltyId, penalty.issueId].filter(Boolean).includes(penaltyId);
  });
  if (!item) throw new Error("Penalty item not found.");
  const amountPaid = Math.max(0, Number(item.amount || item.penalty?.amount || item.penalty?.penaltyAmount || 0));
  pendingClearDues = { row, item, penaltyId };
  $("#clearDuesStudentUid").value = studentUid;
  $("#clearDuesPenaltyId").value = penaltyId;
  $("#clearDuesAmount").value = amountPaid.toFixed(2);
  $("#clearDuesMethod").value = "cash";
  $("#clearDuesDate").value = new Date().toISOString().slice(0, 10);
  $("#clearDuesRemarks").value = "";
  $("#clearDuesDialog").showModal();
}

async function clearDues({ row, item, penaltyId }, payment) {
  const studentUid = row.uid;
  const amountPaid = Math.max(0, Number(payment.amount || 0));
  if (amountPaid <= 0) throw new Error("Enter a valid payment amount.");
  const penalty = item.penalty || {};
  const targetPenaltyId = penaltyId || item.issueId || `${studentUid}_${Date.now()}`;
  const issueId = penaltyIssueIdOf({ ...penalty, ...item }, targetPenaltyId);
  await setDoc(doc(db, "penalties", targetPenaltyId), {
    penaltyId: targetPenaltyId,
    issueId,
    studentUid,
    studentName: row.name || "",
    studentEmail: row.email || "",
    studentPhone: row.phone || "",
    rollNumber: row.rollNumber || "",
    enrollmentNumber: row.enrollmentNumber || "",
    bookId: item.bookId || penalty.bookId || penalty.b_id || "",
    b_id: item.bookId || penalty.b_id || penalty.bookId || "",
    accessionNumber: item.accessionNumber || penalty.accessionNumber || "",
    bookBarcodeValue: item.bookBarcodeValue || penalty.bookBarcodeValue || "",
    bookTitle: item.bookTitle || penalty.bookTitle || "",
    issueDate: item.issueDate || penalty.issueDate || null,
    dueDate: item.dueDate || penalty.dueDate || null,
    lateDays: item.overdueDays || penalty.lateDays || penalty.daysLate || 0,
    daysLate: item.overdueDays || penalty.lateDays || penalty.daysLate || 0,
    ratePerDay: item.ratePerDay || penalty.ratePerDay || 5,
    amount: penalty.amount || penalty.penaltyAmount || amountPaid,
    penaltyAmount: penalty.penaltyAmount || penalty.amount || amountPaid,
    paymentAmount: amountPaid,
    amountPaid,
    paidAmount: amountPaid,
    paymentMethod: payment.method,
    paymentDate: payment.paymentDate,
    remarks: payment.remarks,
    paid: true,
    status: "paid",
    paymentStatus: "paid",
    penaltyStatus: "cleared",
    remainingAmount: 0,
    clearedAt: serverTimestamp(),
    clearedBy: auth.currentUser.uid,
    clearedByName: session.profile?.name || auth.currentUser.displayName || auth.currentUser.email || "",
    paidAt: serverTimestamp(),
    paidBy: auth.currentUser.uid,
    paymentHistory: arrayUnion({
      amountPaid,
      method: payment.method,
      paymentDate: payment.paymentDate,
      remarks: payment.remarks,
      clearedBy: auth.currentUser.uid,
      clearedByName: session.profile?.name || auth.currentUser.displayName || auth.currentUser.email || "",
      clearedAt: new Date().toISOString(),
      action: "clear_dues"
    }),
    updatedAt: serverTimestamp()
  }, { merge: true });
  showToast("Dues cleared and payment history saved.", "success");
}

function exportReport() {
  if (!window.XLSX) throw new Error("XLSX library is not loaded.");
  const rows = filteredRows().map((row) => ({
    Student: row.name,
    "Roll No.": row.rollNumber,
    Enrollment: row.enrollmentNumber,
    Email: row.email,
    Phone: row.phone,
    "Active Books": row.activeBooks,
    "Overdue Books": row.overdueCount,
    "Pending Penalty": row.penaltyAmount,
    "Clearance Status": row.status === "eligible" ? "Eligible" : "Blocked"
  }));
  const sheet = window.XLSX.utils.json_to_sheet(rows);
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, sheet, "No Dues");
  window.XLSX.writeFile(workbook, "no_dues_report.xlsx");
}

controls.search?.addEventListener("input", renderNoDues);
controls.status?.addEventListener("change", renderNoDues);
controls.due?.addEventListener("change", renderNoDues);
document.querySelectorAll(".no-dues-quick-filter").forEach((button) => {
  button.addEventListener("click", () => {
    if (controls.status) controls.status.value = button.dataset.noDuesFilter || "";
    renderNoDues();
  });
});
$("#exportNoDuesBtn")?.addEventListener("click", () => {
  try {
    exportReport();
    showToast("No dues report exported.", "success");
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
});
$("#noDuesTable")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-no-dues-action='review']");
  if (!button) return;
  const row = noDuesRows().find((item) => item.uid === button.dataset.studentUid);
  if (!row) return;
  history.replaceState(null, "", `no-dues.html?student=${encodeURIComponent(row.uid)}`);
  renderReview(row);
});
$("#noDuesReviewContent")?.addEventListener("click", async (event) => {
  const button = event.target.closest(".clear-dues-btn");
  if (!button) return;
  try {
    openClearDuesDialog(button.dataset.studentUid, button.dataset.penaltyId);
  } catch (error) {
    logDetailedError(error);
    showToast(`${error.code || "error"}: ${error.message}`, "error");
  }
});
$("#clearDuesDialog")?.querySelector(".dialog-close")?.addEventListener("click", () => {
  $("#clearDuesDialog").close();
});
$("#clearDuesForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!pendingClearDues) return;
  const submitButton = event.target.querySelector("button[type='submit']");
  submitButton.disabled = true;
  try {
    await clearDues(pendingClearDues, {
      amount: $("#clearDuesAmount").value,
      method: $("#clearDuesMethod").value,
      paymentDate: $("#clearDuesDate").value,
      remarks: $("#clearDuesRemarks").value.trim()
    });
    $("#clearDuesDialog").close();
    const row = noDuesRows().find((item) => item.uid === pendingClearDues.row.uid);
    if (row) renderReview(row);
    renderNoDues();
    pendingClearDues = null;
  } catch (error) {
    logDetailedError(error);
    showToast(`${error.code || "error"}: ${error.message}`, "error");
  } finally {
    submitButton.disabled = false;
  }
});
$("#closeNoDuesReviewBtn")?.addEventListener("click", () => {
  controls.reviewPanel.hidden = true;
  history.replaceState(null, "", "no-dues.html");
});

onSnapshot(collection(db, "users"), (snap) => {
  latestUsers = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
  renderNoDues();
});
onSnapshot(collection(db, "students"), (snap) => {
  latestStudents = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
  renderNoDues();
});
onSnapshot(collection(db, "bookIssues"), (snap) => {
  latestIssues = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
  renderNoDues();
});
onSnapshot(collection(db, "penalties"), (snap) => {
  latestPenalties = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
  renderNoDues();
});
onSnapshot(collection(db, "books"), (snap) => {
  latestBooks = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
  renderNoDues();
});
