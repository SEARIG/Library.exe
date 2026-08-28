import { db } from "./firebase-config.js";
import {
  $,
  escapeHtml,
  formatDate,
  logDetailedError,
  renderEmpty,
  requireAuth,
  showToast,
  statusBadge,
  wireSignOut
} from "./app.js";
import {
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  EMAILJS_SETUP_MESSAGE,
  isEmailNotificationsConfigured,
  runReminderCheck,
  sendEmailNotification
} from "./notifications.js";
import {
  calculatePenalty,
  getStudentPenaltyLiability,
  isUnpaidPenaltyRecord,
  logPenaltyDebugForStudent
} from "./penalty-utils.mjs?v=2";

wireSignOut();
const session = await requireAuth(["admin"]);

const metrics = {
  users: $("#metricUsers"),
  students: $("#metricStudents"),
  librarians: $("#metricLibrarians"),
  books: $("#metricBooks"),
  pending: $("#metricPending"),
  issued: $("#metricIssued"),
  penalties: $("#metricPenalties")
};
const testEmailButton = $("#sendTestEmailBtn");
if (testEmailButton) testEmailButton.title = EMAILJS_SETUP_MESSAGE;
let pendingStudentImportRows = [];
let latestNoDuesUsers = [];
let latestNoDuesStudents = [];
let latestNoDuesIssues = [];
let latestNoDuesPenalties = [];
let latestNoDuesBooks = [];

const noDuesControls = {
  search: $("#noDuesSearch"),
  status: $("#noDuesStatusFilter"),
  due: $("#noDuesDueFilter"),
  table: $("#noDuesTable"),
  summary: $("#noDuesSummaryList"),
  topPending: $("#noDuesTopPending")
};

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add("open");
  document.body.classList.add("modal-open");
}

function closeModal(modal) {
  modal?.classList.remove("open");
  document.body.classList.remove("modal-open");
}

document.addEventListener("click", (event) => {
  const openButton = event.target.closest("[data-open-modal]");
  if (openButton) {
    openModal(openButton.dataset.openModal);
    return;
  }

  const closeButton = event.target.closest("[data-close-modal]");
  if (closeButton) {
    closeModal(closeButton.closest(".modal-backdrop"));
    return;
  }

  const modalBackdrop = event.target.classList?.contains("modal-backdrop") ? event.target : null;
  if (modalBackdrop) closeModal(modalBackdrop);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    document.querySelectorAll(".modal-backdrop.open").forEach(closeModal);
  }
});

document.addEventListener("click", (event) => {
  const sidebarModalLink = event.target.closest('a[href^="admin-dashboard.html#"]');
  if (!sidebarModalLink) return;
  const id = sidebarModalLink.getAttribute("href").split("#")[1];
  if (document.getElementById(id)?.classList.contains("modal-backdrop")) {
    event.preventDefault();
    openModal(id);
  }
});

function readWorkbookRows(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const workbook = window.XLSX.read(event.target.result, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        resolve(window.XLSX.utils.sheet_to_json(sheet, { defval: "" }));
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function valueFor(row, ...names) {
  const entries = Object.entries(row || {});
  for (const name of names) {
    const found = entries.find(([key]) => key.trim().toLowerCase() === name.toLowerCase());
    if (found) return String(found[1] ?? "").trim();
  }
  return "";
}

function downloadWorkbookTemplate(filename, rows) {
  if (!window.XLSX) throw new Error("XLSX library is not loaded.");
  const sheet = window.XLSX.utils.json_to_sheet(rows);
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, sheet, "Template");
  window.XLSX.writeFile(workbook, filename);
}

function studentUidOf(record = {}, fallback = "") {
  return record.uid || record.studentUid || record.firebaseAuthUid || fallback;
}

function initialsFor(name = "") {
  return String(name || "Student")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "ST";
}

function noDuesRows() {
  const usersByUid = new Map(latestNoDuesUsers.map((item) => [item.id, item.data]));
  const studentMap = new Map();

  latestNoDuesStudents.forEach((item) => {
    const uid = studentUidOf(item.data, item.id);
    if (uid) studentMap.set(uid, { id: item.id, ...item.data, uid });
  });
  latestNoDuesUsers
    .filter((item) => item.data.role === "student")
    .forEach((item) => {
      if (studentMap.has(item.id)) {
        studentMap.set(item.id, { ...item.data, ...studentMap.get(item.id), uid: item.id });
      } else {
        studentMap.set(item.id, { id: item.id, ...item.data, uid: item.id });
      }
    });

  return Array.from(studentMap.values()).map((student) => {
    const uid = student.uid || student.id;
    const user = usersByUid.get(uid) || {};
    const studentRecord = { ...user, ...student, uid };
    const liability = getStudentPenaltyLiability({
      student: studentRecord,
      issues: latestNoDuesIssues.map((item) => ({ id: item.id, ...item.data })),
      penalties: latestNoDuesPenalties.map((item) => ({ id: item.id, ...item.data })),
      now: new Date()
    });
    const issues = liability.activeIssues;
    const overdueBooks = liability.overdueIssues.map((item) => ({
      issueId: item.id,
      bookTitle: item.data.bookTitle || item.data.title || item.data.bookId || "Issued book",
      accessionNumber: item.data.accessionNumber || item.data.b_id || item.data.bookId || "-",
      issueDate: item.data.issueDate || item.data.issuedAt || null,
      dueDate: item.data.dueDate || item.calculation.dueDate || null,
      overdueDays: item.calculation.overdueDays,
      ratePerDay: item.calculation.ratePerDay,
      currentPenalty: item.calculation.calculatedAmount
    }));
    const unresolvedCopyLiabilities = latestNoDuesBooks.filter((item) => {
      const book = item.data;
      const status = String(book.status || "").toLowerCase();
      const holderUid = book.issuedStudentUid || book.issuedTo || book.studentUid || "";
      return ["lost", "damaged"].includes(status) && holderUid === uid;
    });
    const penaltyAmount = liability.totalUnpaid;
    const hasActiveBooks = issues.length > 0;
    const hasPenalty = penaltyAmount > 0;
    const hasCopyLiability = unresolvedCopyLiabilities.length > 0;
    const blocked = hasActiveBooks || hasPenalty || hasCopyLiability;
    const name = student.name || user.name || "Unknown Student";
    const overdueBlockers = liability.unpaidItems.map((item) =>
      `NO DUES BLOCKED - Book: ${item.bookTitle}; Accession: ${item.accessionNumber || "-"}; Due: ${formatDate(item.dueDate)}; Overdue: ${item.overdueDays} days; Outstanding Penalty: ₹${item.amount.toFixed(0)}`
    );
    const activeBookBlockers = issues.map((item) => {
      const issue = item.data;
      return `Book not returned: ${issue.bookTitle || issue.title || issue.bookId || "Issued book"} (${issue.accessionNumber || issue.b_id || issue.bookId || "-"})`;
    });
    const copyLiabilityBlockers = unresolvedCopyLiabilities.map((item) => {
      const book = item.data;
      return `Unresolved ${String(book.status || "copy").toLowerCase()} liability: ${book.title || book.bname || book.bookTitle || item.id}`;
    });
    const blockers = [...overdueBlockers, ...activeBookBlockers, ...copyLiabilityBlockers];

    return {
      uid,
      name,
      email: student.email || user.email || "",
      phone: student.phone || user.phone || "",
      rollNumber: student.rollNumber || student.rollNo || student.roll || "-",
      enrollmentNumber: student.enrollmentNumber || student.enrollmentNo || "",
      department: student.department || student.branch || student.course || "",
      activeBooks: issues.length,
      activeBookTitles: issues.map((item) => item.data.bookTitle || item.data.title || item.data.bookId || "Book"),
      activeIssueDetails: issues.map((item) => ({
        issueId: item.id,
        bookTitle: item.data.bookTitle || item.data.title || item.data.bookId || "Issued book",
        accessionNumber: item.data.accessionNumber || item.data.b_id || item.data.bookId || "-",
        issueDate: item.data.issueDate || item.data.issuedAt || null,
        dueDate: item.data.dueDate || calculatePenalty(item.data, new Date()).dueDate || null
      })),
      overdueBooks,
      unpaidPenalties: liability.unpaidItems.length,
      penaltyAmount,
      status: blocked ? "blocked" : "eligible",
      dueType: hasPenalty ? "penalty" : (hasActiveBooks || hasCopyLiability) ? "books" : "clear",
      blockers,
      liability,
      active: student.active !== false && user.active !== false
    };
  }).sort((left, right) => {
    if (left.status !== right.status) return left.status === "blocked" ? -1 : 1;
    return right.penaltyAmount - left.penaltyAmount || right.activeBooks - left.activeBooks || left.name.localeCompare(right.name);
  });
}

function filteredNoDuesRows() {
  const search = String(noDuesControls.search?.value || "").trim().toLowerCase();
  const status = noDuesControls.status?.value || "";
  const due = noDuesControls.due?.value || "";
  return noDuesRows().filter((row) => {
    const haystack = [
      row.name,
      row.email,
      row.phone,
      row.rollNumber,
      row.enrollmentNumber,
      row.department,
      row.uid,
      row.activeBookTitles.join(" "),
      row.blockers.join(" ")
    ].join(" ").toLowerCase();
    if (search && !haystack.includes(search)) return false;
    if (status && row.status !== status) return false;
    if (due && row.dueType !== due) return false;
    return true;
  });
}

function renderNoDues() {
  if (!noDuesControls.table) return;
  const rows = filteredNoDuesRows();
  const allRows = noDuesRows();
  const eligible = allRows.filter((row) => row.status === "eligible").length;
  const blocked = allRows.filter((row) => row.status === "blocked").length;
  const activeIssues = allRows.reduce((sum, row) => sum + row.activeBooks, 0);
  const pendingAmount = allRows.reduce((sum, row) => sum + row.penaltyAmount, 0);

  $("#noDuesClearStudents").textContent = String(eligible);
  $("#noDuesBlockedStudents").textContent = String(blocked);
  $("#noDuesActiveIssues").textContent = String(activeIssues);
  $("#noDuesPendingAmount").textContent = `₹ ${pendingAmount.toFixed(0)}`;
  if (metrics.penalties) {
    metrics.penalties.textContent = String(allRows.reduce((sum, row) => sum + row.unpaidPenalties, 0));
  }

  noDuesControls.summary.innerHTML = `
    <div><span>Total Students</span><strong>${allRows.length}</strong></div>
    <div><span>Eligible for No Dues</span><strong>${eligible}</strong></div>
    <div><span>Blocked Students</span><strong>${blocked}</strong></div>
    <div><span>Active Issued Books</span><strong>${activeIssues}</strong></div>
    <div><span>Pending Penalty Amount</span><strong>₹ ${pendingAmount.toFixed(2)}</strong></div>`;

  const topRows = allRows
    .filter((row) => row.status === "blocked")
    .slice(0, 5);
  noDuesControls.topPending.innerHTML = topRows.length
    ? topRows.map((row, index) => `
      <div>
        <span>${index + 1}. ${escapeHtml(row.name)}</span>
        <strong>${row.activeBooks ? `${row.activeBooks} book${row.activeBooks === 1 ? "" : "s"}` : `₹ ${row.penaltyAmount.toFixed(0)}`}</strong>
      </div>`).join("")
    : `<div class="empty">No pending students.</div>`;

  if (!rows.length) {
    renderEmpty(noDuesControls.table, "No students match the selected no dues filters.");
    return;
  }

  noDuesControls.table.innerHTML = `
    <table class="no-dues-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Student Details</th>
          <th>Roll No.</th>
          <th>Enrollment</th>
          <th>Active Books</th>
          <th>Pending Penalty</th>
          <th>Blocker</th>
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
            <td><strong class="${row.activeBooks ? "danger-text" : "success-text"}">${row.activeBooks}</strong><span>${escapeHtml(row.activeBookTitles.slice(0, 2).join(", ") || "No books pending")}</span></td>
            <td><strong class="${row.penaltyAmount ? "danger-text" : "success-text"}">₹ ${row.penaltyAmount.toFixed(2)}</strong><span>${row.unpaidPenalties} unpaid record${row.unpaidPenalties === 1 ? "" : "s"}</span></td>
            <td><span>${escapeHtml(row.blockers[0] || "No blockers")}</span></td>
            <td>${row.status === "eligible" ? statusBadge("eligible") : statusBadge("blocked")}</td>
            <td>
              <button class="btn ${row.status === "eligible" ? "btn-primary" : "btn-muted"}" data-no-dues-action="review" data-student-uid="${escapeHtml(row.uid)}" type="button">
                ${row.status === "eligible" ? "Ready" : "Review"}
              </button>
              <button class="btn btn-muted" data-no-dues-action="debug" data-student-uid="${escapeHtml(row.uid)}" type="button">Debug</button>
            </td>
          </tr>`).join("")}
      </tbody>
    </table>
    <div class="table-footer-note">Showing ${rows.length} of ${allRows.length} student entries</div>`;
}

function renderNoDuesReview(row) {
  const target = $("#noDuesReviewContent");
  if (!target) {
    const message = row.status === "eligible"
      ? `${row.name} is eligible for no dues clearance.`
      : `${row.name} is blocked: ${row.blockers.join("; ")}.`;
    showToast(message, row.status === "eligible" ? "success" : "warning");
    return;
  }

  const activeBooks = row.activeIssueDetails || [];
  const overdueBooks = row.overdueBooks || [];
  target.innerHTML = `
    <section class="detail-grid">
      <span>Student</span><strong>${escapeHtml(row.name)}</strong>
      <span>Roll No.</span><strong>${escapeHtml(row.rollNumber || "-")}</strong>
      <span>Enrollment No.</span><strong>${escapeHtml(row.enrollmentNumber || "-")}</strong>
      <span>Student UID</span><strong>${escapeHtml(row.uid)}</strong>
      <span>Active Books</span><strong>${row.activeBooks}</strong>
      <span>Total Pending Penalty</span><strong class="${row.penaltyAmount ? "danger-text" : "success-text"}">₹ ${row.penaltyAmount.toFixed(2)}</strong>
      <span>Status</span><strong>${row.status === "eligible" ? "Eligible" : "Blocked"}</strong>
    </section>
    <h3>Active books</h3>
    ${activeBooks.length ? activeBooks.map((book) => `
      <article class="list-row">
        <div>
          <strong>${escapeHtml(book.bookTitle)}</strong>
          <span>Accession: ${escapeHtml(book.accessionNumber)}</span>
          <span>Issue: ${formatDate(book.issueDate)} | Due: ${formatDate(book.dueDate)}</span>
        </div>
      </article>`).join("") : `<div class="empty">No active issued books.</div>`}
    <h3>Overdue penalty details</h3>
    ${overdueBooks.length ? overdueBooks.map((book) => `
      <article class="list-row">
        <div>
          <strong>${escapeHtml(book.bookTitle)}</strong>
          <span>Accession number: ${escapeHtml(book.accessionNumber)}</span>
          <span>Issue date: ${formatDate(book.issueDate)}</span>
          <span>Due date: ${formatDate(book.dueDate)}</span>
          <span>Overdue days: ${book.overdueDays}</span>
          <span>Rate: ₹${book.ratePerDay}/day</span>
          <span>Current penalty: ₹${book.currentPenalty.toFixed(2)}</span>
        </div>
        ${statusBadge("unpaid")}
      </article>`).join("") : `<div class="empty">No overdue penalty on active books.</div>`}
    ${row.blockers.length ? `<h3>Blockers</h3><ul class="rules-list">${row.blockers.map((blocker) => `<li>${escapeHtml(blocker)}</li>`).join("")}</ul>` : ""}`;
  window.location.href = `no-dues.html?student=${encodeURIComponent(row.uid)}`;
}

function exportNoDuesReport() {
  if (!window.XLSX) throw new Error("XLSX library is not loaded.");
  const rows = filteredNoDuesRows().map((row) => ({
    "Student Name": row.name,
    "Roll No.": row.rollNumber,
    "Enrollment Number": row.enrollmentNumber,
    Email: row.email,
    Phone: row.phone,
    Department: row.department,
    "Active Books": row.activeBooks,
    "Pending Penalty": row.penaltyAmount,
    "Clearance Status": row.status === "eligible" ? "Eligible" : "Blocked",
    "Blocking Reason": row.status === "eligible"
      ? "No active books or unpaid dues"
      : row.blockers.join("; ")
  }));
  const sheet = window.XLSX.utils.json_to_sheet(rows);
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, sheet, "No Dues");
  window.XLSX.writeFile(workbook, "no_dues_report.xlsx");
}

function normalizeStudentImportRows(rows) {
  return rows.map((row, index) => {
    const normalized = {
      rowNumber: index + 2,
      name: valueFor(row, "Name"),
      email: valueFor(row, "Email").toLowerCase(),
      phone: valueFor(row, "Phone"),
      year: valueFor(row, "Year"),
      department: valueFor(row, "Department"),
      rollNumber: valueFor(row, "RollNumber", "Roll Number")
    };
    const errors = [];
    if (!normalized.name) errors.push("Name is required");
    if (!normalized.email) errors.push("Email is required");
    if (normalized.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email)) errors.push("Email is invalid");
    if (!normalized.department) errors.push("Department is required");
    return { ...normalized, errors };
  });
}

function renderStudentImportPreview(rows) {
  pendingStudentImportRows = rows;
  $("#confirmStudentImportBtn").disabled = !rows.length || rows.some((row) => row.errors.length);
  const errorCount = rows.filter((row) => row.errors.length).length;
  $("#studentImportResult").innerHTML = `
    <div class="${errorCount ? "empty" : "success-box"}">
      <strong>${rows.length} student row(s) parsed</strong>
      <span>Validation errors: ${errorCount}</span>
    </div>`;
  if (!rows.length) {
    renderEmpty($("#studentImportPreview"), "No rows found.");
    return;
  }
  $("#studentImportPreview").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Row</th>
          <th>Name</th>
          <th>Email</th>
          <th>Phone</th>
          <th>Year</th>
          <th>Department</th>
          <th>Roll Number</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td>${row.rowNumber}</td>
            <td>${escapeHtml(row.name)}</td>
            <td>${escapeHtml(row.email)}</td>
            <td>${escapeHtml(row.phone)}</td>
            <td>${escapeHtml(row.year)}</td>
            <td>${escapeHtml(row.department)}</td>
            <td>${escapeHtml(row.rollNumber)}</td>
            <td>${row.errors.length ? escapeHtml(row.errors.join("; ")) : "Ready"}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

async function importPreviewedStudents() {
  const validRows = pendingStudentImportRows.filter((row) => !row.errors.length);
  if (!validRows.length) throw new Error("No valid student rows to import.");
  const importBatchId = `students_import_${Date.now()}`;
  let imported = 0;
  let skipped = pendingStudentImportRows.length - validRows.length;

  for (let index = 0; index < validRows.length; index += 450) {
    const chunk = validRows.slice(index, index + 450);
    const batch = writeBatch(db);
    chunk.forEach((row) => {
      const ref = doc(collection(db, "students"));
      batch.set(ref, {
        uid: ref.id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        year: row.year,
        department: row.department,
        rollNumber: row.rollNumber,
        role: "student",
        active: true,
        imported: true,
        importBatchId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      imported += 1;
    });
    await batch.commit();
  }

  $("#studentImportResult").innerHTML = `
    <div class="success-box">
      <strong>Students imported successfully</strong>
      <span>Imported count: ${imported}</span>
      <span>Skipped count: ${skipped}</span>
      <span>Import batch: ${escapeHtml(importBatchId)}</span>
    </div>`;
  $("#confirmStudentImportBtn").disabled = true;
  pendingStudentImportRows = [];
  return { imported, skipped, importBatchId };
}

onSnapshot(collection(db, "users"), (snap) => {
  latestNoDuesUsers = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
  metrics.users.textContent = snap.size;
  metrics.students.textContent = snap.docs.filter((item) => item.data().role === "student").length;
  metrics.librarians.textContent = snap.docs.filter((item) => item.data().role === "librarian").length;
  renderNoDues();
});
onSnapshot(collection(db, "books"), (snap) => {
  latestNoDuesBooks = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
  metrics.books.textContent = snap.size;
  renderNoDues();
});
onSnapshot(collection(db, "issueRequests"), (snap) => {
  metrics.pending.textContent = snap.docs.filter((item) => item.data().status === "pending").length;
});
onSnapshot(collection(db, "bookIssues"), (snap) => {
  latestNoDuesIssues = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
  metrics.issued.textContent = snap.size;
  renderNoDues();
});
onSnapshot(collection(db, "students"), (snap) => {
  latestNoDuesStudents = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
  renderNoDues();
});
onSnapshot(collection(db, "penalties"), (snap) => {
  latestNoDuesPenalties = snap.docs.map((item) => ({ id: item.id, data: item.data() }));
  if (metrics.penalties) {
    metrics.penalties.textContent = String(snap.docs.filter((item) => isUnpaidPenaltyRecord(item.data())).length);
  }
  renderNoDues();
});

onSnapshot(query(collection(db, "users"), orderBy("createdAt", "desc"), limit(50)), (snap) => {
  const target = $("#usersTable");
  if (snap.empty) {
    renderEmpty(target, "No users found.");
    return;
  }
  target.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>User</th>
          <th>Role</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${snap.docs.map((item) => {
          const user = item.data();
          return `
            <tr data-user-id="${item.id}">
              <td><strong>${escapeHtml(user.name)}</strong><span>${escapeHtml(user.email)}</span></td>
              <td>
                <select data-field="role">
                  ${["student", "librarian", "admin"].map((role) =>
                    `<option value="${role}" ${role === user.role ? "selected" : ""}>${role}</option>`
                  ).join("")}
                </select>
              </td>
              <td>${statusBadge(user.active ? "active" : "inactive")}</td>
              <td>
                <button class="btn btn-muted" data-action="toggle">${user.active ? "Deactivate" : "Activate"}</button>
                <button class="btn btn-primary" data-action="save">Save</button>
              </td>
            </tr>`;
        }).join("")}
      </tbody>
    </table>`;
});

$("#usersTable").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const row = button.closest("[data-user-id]");
  const uid = row.dataset.userId;
  try {
    if (button.dataset.action === "save") {
      await updateDoc(doc(db, "users", uid), {
        role: row.querySelector("[data-field='role']").value
      });
      showToast("Role updated.", "success");
    } else {
      const isActive = !row.textContent.includes("Deactivate");
      await updateDoc(doc(db, "users", uid), { active: isActive });
      showToast("Account status updated.", "success");
    }
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
});

$("#downloadStudentsTemplateBtn").addEventListener("click", () => {
  try {
    downloadWorkbookTemplate("students_template.xlsx", [{
      Name: "Student Name",
      Email: "student@example.com",
      Phone: "9876543210",
      Year: "1",
      Department: "Computer Science",
      RollNumber: "MLSU-2026-001"
    }]);
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
});

$("#importStudentsBtn").addEventListener("click", () => $("#studentImportFile").click());

$("#studentImportFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const rows = await readWorkbookRows(file);
    renderStudentImportPreview(normalizeStudentImportRows(rows));
    showToast("Student import preview ready.", "success");
  } catch (error) {
    logDetailedError(error);
    showToast("Could not parse student import file.", "error");
  } finally {
    event.target.value = "";
  }
});

$("#confirmStudentImportBtn").addEventListener("click", async () => {
  try {
    const result = await importPreviewedStudents();
    showToast(`Imported ${result.imported} student(s).`, "success");
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
});

noDuesControls.search?.addEventListener("input", renderNoDues);
noDuesControls.status?.addEventListener("change", renderNoDues);
noDuesControls.due?.addEventListener("change", renderNoDues);
document.querySelectorAll(".no-dues-quick-filter").forEach((button) => {
  button.addEventListener("click", () => {
    if (noDuesControls.status) noDuesControls.status.value = button.dataset.noDuesFilter || "";
    renderNoDues();
  });
});
$("#exportNoDuesBtn")?.addEventListener("click", () => {
  try {
    exportNoDuesReport();
    showToast("No dues report exported.", "success");
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
});
$("#noDuesTable")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-no-dues-action]");
  if (!button) return;
  const row = noDuesRows().find((item) => item.uid === button.dataset.studentUid);
  if (!row) return;
  if (button.dataset.noDuesAction === "debug") {
    logPenaltyDebugForStudent({
      student: row,
      activeIssues: row.liability?.activeIssues || [],
      persistedPenalties: latestNoDuesPenalties,
      liability: row.liability,
      now: new Date()
    });
    showToast("Penalty debug data printed to console.", "info");
    return;
  }
  renderNoDuesReview(row);
});

onSnapshot(query(collection(db, "issueRequests"), orderBy("createdAt", "desc"), limit(8)), (snap) => {
  const target = $("#recentActivity");
  if (snap.empty) {
    renderEmpty(target, "No recent activity yet.");
    return;
  }
  target.innerHTML = snap.docs.map((item) => {
    const request = item.data();
    return `
      <article class="list-row">
        <div>
          <strong>${escapeHtml(request.bookTitle || request.bookId || "Issue request")}</strong>
          <span>${escapeHtml(request.studentName || "Student")} | ${formatDate(request.createdAt)}</span>
        </div>
        ${statusBadge(request.status)}
      </article>`;
  }).join("");
});

function renderNotificationResult(result) {
  $("#notificationResult").innerHTML = `
    <div class="success-box">
      <strong>Reminder check complete</strong>
      <span>Checked: ${result.checked}</span>
      <span>Emails sent: ${result.sent}</span>
      <span>Overdue books: ${result.overdue || 0}</span>
      <span>Skipped: ${result.skipped}</span>
    </div>`;
}

$("#runReminderCheckBtn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await runReminderCheck();
    renderNotificationResult(result);
    showToast("Reminder check complete.", "success");
  } catch (error) {
    logDetailedError(error);
    $("#notificationResult").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#sendTestEmailBtn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    if (!isEmailNotificationsConfigured()) {
      $("#notificationResult").innerHTML = `<div class="empty">${escapeHtml(EMAILJS_SETUP_MESSAGE)}</div>`;
      showToast(EMAILJS_SETUP_MESSAGE, "warning");
      return;
    }
    const profileSnap = await getDoc(doc(db, "users", session.user.uid));
    const profile = profileSnap.exists() ? profileSnap.data() : session.profile;
    const today = new Date();
    const result = await sendEmailNotification("Test Notification", {
      studentName: profile.name || "MLSU User",
      studentEmail: profile.email || session.user.email,
      bookTitle: "EmailJS Test",
      issueDate: today,
      dueDate: today,
      returnDate: "-",
      penaltyAmount: 0
    });
    $("#notificationResult").innerHTML = `
      <div class="success-box">
        <strong>Test email ${result.sent ? "sent" : "skipped"}</strong>
        <span>Checked: 1</span>
        <span>Emails sent: ${result.sent ? 1 : 0}</span>
        <span>Skipped: ${result.sent ? 0 : 1}</span>
      </div>`;
    showToast("Test email sent successfully.", "success");
  } catch (error) {
    logDetailedError(error);
    const message = error.message?.toLowerCase().includes("emailjs") ? EMAILJS_SETUP_MESSAGE : error.message;
    $("#notificationResult").innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
    showToast(message, "error");
  } finally {
    button.disabled = false;
  }
});
