import { app } from "./firebase-config.js";
import { $, escapeHtml, formatDate, requireAuth, statusBadge, wireSignOut } from "./app.js";
import { showToast } from "./toast.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";

const functions = getFunctions(app);
const state = {
  profile: null,
  snapshot: null,
  activeTab: "books"
};

function call(name, data = {}) {
  return httpsCallable(functions, name)(data).then((result) => result.data);
}

function roleLabel(role) {
  return String(role || "").replaceAll("_", " ");
}

function metric(id, value) {
  const target = document.querySelector(id);
  if (target) target.textContent = value;
}

function tenantLabel(profile) {
  if (profile.role === "super_admin") return "All tenants";
  if (profile.orgType === "university") return profile.universityId || "University";
  if (profile.orgType === "independent_college") return profile.collegeId || "Independent college";
  if (profile.orgType === "private_library") return profile.libraryId || "Private library";
  return "Assigned organization";
}

function renderShell(profile) {
  $("#currentUserRole").textContent = roleLabel(profile.role);
  $("#dashboardTitle").textContent = profile.name || "ULC Dashboard";
  $("#dashboardSubtitle").textContent = `${tenantLabel(profile)} · ${profile.email || ""}`;
  $("#billingStatus").textContent = profile.billingStatus || profile.status || "active";
}

function renderMetrics(snapshot) {
  metric("#metricOrganizations", snapshot.counts.organizations || 0);
  metric("#metricBooks", snapshot.counts.books || 0);
  metric("#metricStudents", snapshot.counts.people || 0);
  metric("#metricPending", snapshot.counts.pendingRequests || 0);
  metric("#metricIssued", snapshot.counts.activeIssues || 0);
  metric("#metricFines", `₹${snapshot.counts.fines || 0}`);
}

function row(cells) {
  return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
}

function renderTable(headers, rows) {
  if (!rows.length) return `<div class="empty">No records yet.</div>`;
  return `<table><thead><tr>${headers.map((head) => `<th>${head}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function renderRecords() {
  const panel = $("#recordsPanel");
  const snapshot = state.snapshot || {};
  if (state.activeTab === "books") {
    panel.innerHTML = renderTable(["Barcode", "Title", "Copies", "Status"], (snapshot.books || []).map((book) => row([
      escapeHtml(book.libraryBarcode),
      escapeHtml(book.title),
      `${book.availableCopies || 0}/${book.totalCopies || 0}`,
      statusBadge(book.status)
    ])));
  }
  if (state.activeTab === "people") {
    panel.innerHTML = renderTable(["Name", "Email", "Roll / Member", "Status"], (snapshot.people || []).map((person) => row([
      escapeHtml(person.name),
      escapeHtml(person.email),
      escapeHtml(person.rollNo),
      statusBadge(person.status)
    ])));
  }
  if (state.activeTab === "issues") {
    panel.innerHTML = renderTable(["Book", "Student", "Due", "Status"], (snapshot.issues || []).map((issue) => row([
      escapeHtml(issue.bookTitle),
      escapeHtml(issue.studentName),
      formatDate(issue.dueDate),
      statusBadge(issue.status)
    ])));
  }
  if (state.activeTab === "audit") {
    panel.innerHTML = renderTable(["Action", "Actor", "Date"], (snapshot.auditLogs || []).map((log) => row([
      escapeHtml(log.action),
      escapeHtml(log.actorUid),
      formatDate(log.createdAt)
    ])));
  }
}

function renderRequests(requests = []) {
  const target = $("#issueRequests");
  if (!requests.length) {
    target.innerHTML = `<div class="empty">No pending issue requests.</div>`;
    return;
  }

  target.innerHTML = requests.map((request) => `
    <article class="list-item">
      <div>
        <strong>${escapeHtml(request.bookTitle)}</strong>
        <span>${escapeHtml(request.studentName)} · ${escapeHtml(request.libraryBarcode)}</span>
      </div>
      <div class="toolbar">
        <button class="btn btn-primary" data-approve="${escapeHtml(request.requestId)}" type="button">Approve</button>
        <button class="btn btn-danger" data-reject="${escapeHtml(request.requestId)}" type="button">Reject</button>
      </div>
    </article>
  `).join("");
}

async function refresh() {
  state.snapshot = await call("getTenantDashboard");
  renderMetrics(state.snapshot);
  renderRequests(state.snapshot.issueRequests);
  renderRecords();
}

function randomBarcode() {
  return `ULC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

async function fetchBookDetails(isbn) {
  const clean = String(isbn || "").trim();
  if (!clean) throw new Error("Enter an ISBN or publisher barcode.");

  const google = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(clean)}`);
  const googleData = await google.json();
  const item = googleData.items?.[0]?.volumeInfo;
  if (item) {
    return {
      isbn: clean,
      title: item.title || "",
      author: (item.authors || []).join(", "),
      publisher: item.publisher || "",
      category: item.categories?.[0] || "",
      source: "Google Books"
    };
  }

  const openLibrary = await fetch(`https://openlibrary.org/isbn/${encodeURIComponent(clean)}.json`);
  if (!openLibrary.ok) throw new Error("No external book metadata found.");
  const data = await openLibrary.json();
  return {
    isbn: clean,
    title: data.title || "",
    author: "",
    publisher: data.publishers?.[0] || "",
    category: data.subjects?.[0] || "",
    source: "Open Library"
  };
}

function wireEvents() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("is-active"));
      button.classList.add("is-active");
      state.activeTab = button.dataset.tab;
      renderRecords();
    });
  });

  $("#generateBarcodeBtn")?.addEventListener("click", () => {
    $("#libraryBarcode").value = randomBarcode();
  });

  $("#fetchBookBtn")?.addEventListener("click", async () => {
    try {
      const book = await fetchBookDetails($("#isbn").value);
      $("#bookTitle").value = book.title;
      $("#author").value = book.author;
      $("#publisher").value = book.publisher;
      $("#category").value = book.category;
      $("#bookPreview").innerHTML = `<strong>${escapeHtml(book.title)}</strong><span>${escapeHtml(book.source)}</span>`;
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  $("#bookForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await call("addTenantBook", {
        isbn: $("#isbn").value.trim(),
        title: $("#bookTitle").value.trim(),
        author: $("#author").value.trim(),
        publisher: $("#publisher").value.trim(),
        category: $("#category").value.trim(),
        totalCopies: Number($("#totalCopies").value || 1),
        shelfNo: $("#shelfNo").value.trim(),
        libraryBarcode: $("#libraryBarcode").value.trim() || randomBarcode()
      });
      event.target.reset();
      showToast("Book saved.", "success");
      await refresh();
    } catch (error) {
      showToast(error.message || "Book save failed.", "error");
    }
  });

  $("#personForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await call("addTenantPerson", {
        name: $("#personName").value.trim(),
        email: $("#personEmail").value.trim(),
        phone: $("#personPhone").value.trim(),
        rollNo: $("#rollNo").value.trim(),
        course: $("#course").value.trim(),
        year: $("#year").value.trim()
      });
      event.target.reset();
      showToast("Person saved.", "success");
      await refresh();
    } catch (error) {
      showToast(error.message || "Save failed.", "error");
    }
  });

  $("#issueRequests")?.addEventListener("click", async (event) => {
    const approveId = event.target.dataset.approve;
    const rejectId = event.target.dataset.reject;
    if (!approveId && !rejectId) return;
    try {
      if (approveId) await call("approveIssueRequest", { requestId: approveId });
      if (rejectId) await call("rejectIssueRequest", { requestId: rejectId, reason: "Rejected by librarian" });
      showToast("Request updated.", "success");
      await refresh();
    } catch (error) {
      showToast(error.message || "Request update failed.", "error");
    }
  });

  $("#returnForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await call("returnTenantBook", { libraryBarcode: $("#returnBarcode").value.trim() });
      $("#returnResult").innerHTML = `Returned. Fine: ₹${result.fineAmount || 0}`;
      showToast("Book returned.", "success");
      await refresh();
    } catch (error) {
      showToast(error.message || "Return failed.", "error");
    }
  });

  $("#markLostBtn")?.addEventListener("click", async () => {
    await call("markTenantBookLost", { libraryBarcode: $("#returnBarcode").value.trim() });
    showToast("Book marked lost.", "success");
    await refresh();
  });

  $("#markFoundBtn")?.addEventListener("click", async () => {
    await call("markTenantBookFound", { libraryBarcode: $("#returnBarcode").value.trim() });
    showToast("Book marked found.", "success");
    await refresh();
  });
}

wireSignOut();
wireEvents();

requireAuth().then(async ({ profile }) => {
  state.profile = profile;
  renderShell(profile);
  await refresh();
}).catch((error) => {
  showToast(error.message || "Unable to load dashboard.", "error");
});
