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
  metrics.users.textContent = snap.size;
  metrics.students.textContent = snap.docs.filter((item) => item.data().role === "student").length;
  metrics.librarians.textContent = snap.docs.filter((item) => item.data().role === "librarian").length;
});
onSnapshot(collection(db, "books"), (snap) => metrics.books.textContent = snap.size);
onSnapshot(collection(db, "issueRequests"), (snap) => {
  metrics.pending.textContent = snap.docs.filter((item) => item.data().status === "pending").length;
});
onSnapshot(collection(db, "bookIssues"), (snap) => {
  metrics.issued.textContent = snap.size;
});
onSnapshot(collection(db, "penalties"), (snap) => metrics.penalties.textContent = snap.size);

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
