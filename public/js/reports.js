import { db } from "./firebase-config.js";
import {
  $,
  escapeHtml,
  formatDate,
  renderEmpty,
  requireAuth,
  showToast,
  statusBadge
} from "./app.js";
import {
  collection,
  getDocs
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  calculatePenalty,
  isActiveIssue,
  isUnpaidPenaltyRecord
} from "./penalty-utils.mjs?v=2";
import { buildNoDuesRows } from "./no-dues-utils.mjs";

const session = await requireAuth(["admin", "librarian"]);
const REPORT_HISTORY_KEY = "mlsuReportsSessionHistory";
const categoryColors = ["#0f766e", "#f59e0b", "#2563eb", "#8b5cf6", "#14b8a6", "#ef4444", "#64748b", "#d4a017"];

let datasets = {
  books: [],
  bookIssues: [],
  issueRequests: [],
  returnRequests: [],
  penalties: [],
  students: [],
  users: []
};
let generatedRows = [];
let generatedColumns = [];
let generatedTitle = "Issued Books Summary";
let currentContext = null;

const controls = {
  heroDateRange: $("#heroDateRange"),
  reportType: $("#reportType"),
  dateRange: $("#dateRange"),
  customStartDate: $("#customStartDate"),
  customEndDate: $("#customEndDate"),
  category: $("#categoryFilter"),
  course: $("#courseFilter"),
  format: $("#reportFormat"),
  generate: $("#generateReportBtn"),
  trendBucket: $("#trendBucket"),
  table: $("#primaryReportTable"),
  tableTitle: $("#primaryTableTitle"),
  recentReports: $("#recentReportsTable")
};

await loadReportData();
populateDynamicFilters();
generateReport("Initial load", false);

controls.generate?.addEventListener("click", () => generateReport("Generated", true));
controls.trendBucket?.addEventListener("change", () => generateReport("Generated", false));
controls.dateRange?.addEventListener("change", () => {
  syncCustomRangeVisibility();
  if (controls.heroDateRange) controls.heroDateRange.value = controls.dateRange.value === "custom" ? "month" : controls.dateRange.value;
});
controls.heroDateRange?.addEventListener("change", () => {
  controls.dateRange.value = controls.heroDateRange.value;
  syncCustomRangeVisibility();
  generateReport("Generated", false);
});
$("#viewFullReportBtn")?.addEventListener("click", () => {
  controls.format.value = "detailed";
  generateReport("Generated", true);
  controls.table?.scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#exportExcelBtn")?.addEventListener("click", () => exportCurrentExcel());
$("#exportPdfBtn")?.addEventListener("click", () => exportCurrentPdf());
$("#exportAllReportsBtn")?.addEventListener("click", () => exportAllReports());
$("#clearSessionReportsBtn")?.addEventListener("click", () => {
  sessionStorage.removeItem(REPORT_HISTORY_KEY);
  renderRecentReports();
});
controls.recentReports?.addEventListener("click", (event) => {
  const action = event.target.closest("[data-report-action]");
  if (!action) return;
  const history = readReportHistory();
  const item = history[Number(action.dataset.reportIndex)];
  if (!item) return;
  applyHistoryItem(item);
  generateReport(action.dataset.reportAction === "download" ? "Downloaded" : "Viewed", false);
  if (action.dataset.reportAction === "download") exportCurrentPdf(false);
});

async function loadReportData() {
  const targets = ["books", "bookIssues", "issueRequests", "returnRequests", "penalties", "students", "users"];
  const results = await Promise.all(targets.map((name) => readCollection(name)));
  datasets = Object.fromEntries(targets.map((name, index) => [name, results[index]]));
}

async function readCollection(name) {
  try {
    const snap = await getDocs(collection(db, name));
    return snap.docs.map((item) => ({ id: item.id, data: item.data() }));
  } catch (error) {
    console.warn(`[REPORTS] Could not read ${name}`, error);
    showToast(`Could not load ${name} for reports.`, "warning");
    return [];
  }
}

function generateReport(historyAction = "Generated", recordHistory = true) {
  currentContext = buildContext();
  const report = buildReport(currentContext.reportType, currentContext);
  generatedRows = report.rows;
  generatedColumns = report.columns;
  generatedTitle = report.title;
  renderKpis(currentContext);
  renderTrendChart(currentContext);
  renderCategoryChart(currentContext);
  renderTopIssuedBooks(currentContext);
  renderPrimaryTable(report);
  if (recordHistory) {
    writeReportHistory({
      reportName: generatedTitle,
      reportType: currentContext.reportType,
      generatedByName: session.profile?.name || session.user?.email || "Staff",
      generatedOn: new Date().toISOString(),
      dateRange: currentContext.dateLabel,
      filters: {
        category: currentContext.category || "All Categories",
        course: currentContext.course || "All Courses",
        format: currentContext.format
      },
      action: historyAction
    });
  }
  renderRecentReports();
}

function buildContext() {
  const dateRange = selectedDateRange();
  const category = controls.category?.value || "";
  const course = controls.course?.value || "";
  const books = applyBookFilters(datasets.books, { category });
  const students = applyStudentFilters(rowStudents(), { course });
  const issues = applyIssueFilters(datasets.bookIssues, { dateRange, category, course });
  const allIssuesForLiability = applyIssueFilters(datasets.bookIssues, { category, course, ignoreDate: true });
  const penalties = applyPenaltyFilters(datasets.penalties, { dateRange, course });
  return {
    ...dateRange,
    reportType: controls.reportType?.value || "all",
    category,
    course,
    format: controls.format?.value || "summary",
    books,
    students,
    issues,
    allIssuesForLiability,
    penalties,
    issueRequests: applyRequestFilters(datasets.issueRequests, { dateRange, course }),
    returnRequests: applyRequestFilters(datasets.returnRequests, { dateRange, course }),
    noDuesRows: buildNoDuesRows({
      users: datasets.users,
      students: datasets.students,
      issues: allIssuesForLiability,
      penalties: datasets.penalties,
      books: datasets.books,
      now: new Date(),
      formatDate
    }).filter((row) => !course || normalize(row.department) === normalize(course))
  };
}

function buildReport(type, context) {
  switch (type) {
    case "books":
    case "inventory":
      return buildBooksReport(context, type);
    case "students":
      return buildStudentsReport(context);
    case "penalties":
      return buildPenaltyReport(context);
    case "requests":
      return buildRequestsReport(context);
    case "noDues":
      return buildNoDuesReport(context);
    case "activity":
      return buildActivityReport(context);
    case "issueReturn":
    case "all":
    default:
      return buildIssueSummaryReport(context);
  }
}

function buildIssueSummaryReport(context) {
  const groups = new Map();
  context.issues.forEach((item) => {
    const issue = item.data;
    const book = bookForIssue(issue);
    const key = stableBookKey(issue, book);
    const row = groups.get(key) || {
      "Book Title": titleOfRecord(book) || titleOfRecord(issue) || "Issued book",
      "Total Issued": 0,
      "Currently Issued": 0,
      Returned: 0,
      Overdue: 0,
      "Lost / Damaged": 0
    };
    row["Total Issued"] += 1;
    if (isActiveIssue(issue)) {
      row["Currently Issued"] += 1;
      if (calculatePenalty(issue, new Date()).isOverdue) row.Overdue += 1;
    }
    if (isReturnedIssue(issue)) row.Returned += 1;
    groups.set(key, row);
  });
  context.books.forEach((item) => {
    const book = item.data;
    if (!["lost", "damaged"].includes(statusOf(book))) return;
    const key = stableBookKey(book, book);
    const row = groups.get(key) || {
      "Book Title": titleOfRecord(book) || "Library book",
      "Total Issued": 0,
      "Currently Issued": 0,
      Returned: 0,
      Overdue: 0,
      "Lost / Damaged": 0
    };
    row["Lost / Damaged"] += 1;
    groups.set(key, row);
  });
  const rows = Array.from(groups.values()).sort((left, right) => right["Total Issued"] - left["Total Issued"]);
  return {
    title: "Issued Books Summary",
    columns: ["#", "Book Title", "Total Issued", "Currently Issued", "Returned", "Overdue", "Lost / Damaged"],
    rows: addIndex(limitRows(rows, context))
  };
}

function buildBooksReport(context, type) {
  const rows = context.books.map((item) => {
    const book = item.data;
    return {
      "Book Title": titleOfRecord(book) || "-",
      "Accession Number": accessionOf(book),
      Author: book.author || "-",
      Category: categoryOf(book),
      Status: statusOf(book) || "available",
      Year: book.year || "-",
      Subject: book.subject || "-"
    };
  }).sort((left, right) => left["Book Title"].localeCompare(right["Book Title"]));
  return {
    title: type === "inventory" ? "Inventory Report" : "Books Report",
    columns: ["#", "Book Title", "Accession Number", "Author", "Category", "Status", "Year", "Subject"],
    rows: addIndex(limitRows(rows, context))
  };
}

function buildStudentsReport(context) {
  const noDuesByUid = new Map(context.noDuesRows.map((row) => [row.uid, row]));
  const rows = context.students.map((student) => {
    const noDues = noDuesByUid.get(student.uid) || {};
    return {
      "Student Name": student.name || "Unknown Student",
      UID: student.uid,
      "Roll Number": student.rollNumber || student.rollNo || student.roll || "-",
      "Enrollment Number": student.enrollmentNumber || student.enrollmentNo || "-",
      Course: student.department || student.course || student.branch || "-",
      "Active Books": noDues.activeBooks || 0,
      Overdue: noDues.overdueCount || 0,
      "Pending Penalty": currency(noDues.penaltyAmount || 0),
      "No Dues": noDues.status === "blocked" ? "Blocked" : "Eligible"
    };
  }).sort((left, right) => left["Student Name"].localeCompare(right["Student Name"]));
  return {
    title: "Students Report",
    columns: ["#", "Student Name", "UID", "Roll Number", "Enrollment Number", "Course", "Active Books", "Overdue", "Pending Penalty", "No Dues"],
    rows: addIndex(limitRows(rows, context))
  };
}

function buildPenaltyReport(context) {
  const rows = [];
  context.noDuesRows.forEach((student) => {
    student.penaltyItems.forEach((item) => {
      rows.push({
        "Student Name": student.name,
        UID: student.uid,
        "Roll Number": student.rollNumber || "-",
        "Book Title": item.bookTitle || item.bookId || "Library item",
        "Accession Number": item.accessionNumber || "-",
        "Due Date": formatDate(item.dueDate),
        "Overdue Days": item.overdueDays || 0,
        "Rate": `₹${item.ratePerDay || 5}/day`,
        "Amount": currency(item.amount || 0),
        "Payment Status": item.status || "unpaid"
      });
    });
  });
  context.penalties
    .filter((item) => !isUnpaidPenaltyRecord(item.data))
    .forEach((item) => {
      const penalty = item.data;
      rows.push({
        "Student Name": penalty.studentName || "-",
        UID: penalty.studentUid || penalty.userId || "-",
        "Roll Number": penalty.rollNo || penalty.rollNumber || "-",
        "Book Title": penalty.bookTitle || penalty.title || "Penalty",
        "Accession Number": penalty.accessionNumber || "-",
        "Due Date": formatDate(penalty.dueDate),
        "Overdue Days": penalty.lateDays || penalty.daysLate || 0,
        "Rate": `₹${penalty.ratePerDay || 5}/day`,
        "Amount": currency(penalty.amount || penalty.penaltyAmount || 0),
        "Payment Status": penalty.paymentStatus || penalty.penaltyStatus || penalty.status || "paid"
      });
    });
  return {
    title: "Penalties Report",
    columns: ["#", "Student Name", "UID", "Roll Number", "Book Title", "Accession Number", "Due Date", "Overdue Days", "Rate", "Amount", "Payment Status"],
    rows: addIndex(limitRows(rows, context))
  };
}

function buildRequestsReport(context) {
  const issueRows = context.issueRequests.map((item) => requestRow(item, "Issue Request"));
  const returnRows = context.returnRequests.map((item) => requestRow(item, "Return Request"));
  return {
    title: "Requests Report",
    columns: ["#", "Request Type", "Student Name", "Book Title", "Accession Number", "Status", "Created On"],
    rows: addIndex(limitRows([...issueRows, ...returnRows].sort((left, right) => dateValue(right["Created On"]) - dateValue(left["Created On"])), context))
  };
}

function buildNoDuesReport(context) {
  const rows = context.noDuesRows.map((row) => ({
    "Student Name": row.name,
    UID: row.uid,
    "Roll Number": row.rollNumber || "-",
    "Enrollment Number": row.enrollmentNumber || "-",
    "Active Books": row.activeBooks,
    Overdue: row.overdueCount,
    "Pending Penalty": currency(row.penaltyAmount || 0),
    Status: row.status === "blocked" ? "Blocked" : "Eligible",
    Blocker: row.blockers[0] || "-"
  }));
  return {
    title: "No Dues Report",
    columns: ["#", "Student Name", "UID", "Roll Number", "Enrollment Number", "Active Books", "Overdue", "Pending Penalty", "Status", "Blocker"],
    rows: addIndex(limitRows(rows, context))
  };
}

function buildActivityReport(context) {
  const rows = [
    ...context.issues.map((item) => ({
      Type: isReturnedIssue(item.data) ? "Returned Book" : "Issued Book",
      "Student Name": item.data.studentName || item.data.issuedToName || "-",
      "Book Title": titleOfRecord(item.data),
      "Accession Number": accessionOf(item.data),
      Status: item.data.status || "-",
      Date: formatDate(item.data.returnDate || item.data.returnedAt || item.data.issueDate || item.data.issuedAt)
    })),
    ...context.issueRequests.map((item) => ({ ...requestRow(item, "Issue Request"), Type: "Issue Request", Date: requestRow(item, "Issue Request")["Created On"] })),
    ...context.returnRequests.map((item) => ({ ...requestRow(item, "Return Request"), Type: "Return Request", Date: requestRow(item, "Return Request")["Created On"] }))
  ];
  return {
    title: "Activity Report",
    columns: ["#", "Type", "Student Name", "Book Title", "Accession Number", "Status", "Date"],
    rows: addIndex(limitRows(rows, context))
  };
}

function renderKpis(context) {
  const activeIssues = context.allIssuesForLiability.filter((item) => isActiveIssue(item.data));
  const returnedInRange = context.issues.filter((item) => isReturnedIssue(item.data)).length;
  const lostDamaged = context.books.filter((item) => ["lost", "damaged"].includes(statusOf(item.data))).length;
  const pendingPenalty = context.noDuesRows.reduce((sum, row) => sum + Number(row.penaltyAmount || 0), 0);
  setText("#kpiTotalBooks", context.books.length);
  setText("#kpiIssuedBooks", activeIssues.length);
  setText("#kpiAvailableBooks", context.books.filter((item) => isBookAvailable(item.data)).length);
  setText("#kpiReturnedBooks", returnedInRange);
  setText("#kpiLostDamaged", lostDamaged);
  setText("#kpiPendingPenalty", currency(pendingPenalty));
}

function renderTrendChart(context) {
  const bucket = controls.trendBucket?.value || "daily";
  const issued = new Map();
  const returned = new Map();
  context.issues.forEach((item) => {
    const issue = item.data;
    const issueDate = toDate(issue.issueDate || issue.issuedAt || issue.createdAt);
    const returnDate = toDate(issue.returnDate || issue.returnedAt);
    if (issueDate && dateInRange(issueDate, context)) increment(issued, bucketLabel(issueDate, bucket));
    if (returnDate && dateInRange(returnDate, context)) increment(returned, bucketLabel(returnDate, bucket));
  });
  const labels = Array.from(new Set([...issued.keys(), ...returned.keys()])).sort();
  const totalActivity = labels.reduce((sum, label) => sum + (issued.get(label) || 0) + (returned.get(label) || 0), 0);
  const max = Math.max(1, ...labels.map((label) => Math.max(issued.get(label) || 0, returned.get(label) || 0)));
  if (!labels.length || totalActivity === 0) {
    $("#issueReturnTrendChart").innerHTML = `<div class="chart-empty-state">No activity for selected period</div>`;
    return;
  }
  const width = 560;
  const height = 190;
  const padLeft = 42;
  const padRight = 18;
  const padTop = 16;
  const padBottom = 34;
  const y = (value) => height - padBottom - (value / max) * (height - padTop - padBottom);
  const xFor = (index) => labels.length === 1 ? width / 2 : padLeft + (index * (width - padLeft - padRight)) / (labels.length - 1);
  const yTicks = [...new Set([0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(max * ratio)))];
  const labelEvery = Math.max(1, Math.ceil(labels.length / 6));
  const issuePoints = labels.map((label, index) => `${xFor(index)},${y(issued.get(label) || 0)}`).join(" ");
  const returnPoints = labels.map((label, index) => `${xFor(index)},${y(returned.get(label) || 0)}`).join(" ");
  $("#issueReturnTrendChart").innerHTML = `
    <div class="chart-key"><span><i class="dot issued"></i>Issued</span><span><i class="dot returned"></i>Returned</span></div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Issued and returned book trend">
      ${yTicks.map((tick) => `<g>
        <line x1="${padLeft}" y1="${y(tick)}" x2="${width - padRight}" y2="${y(tick)}" class="grid-line"></line>
        <text x="${padLeft - 10}" y="${y(tick) + 4}" text-anchor="end">${tick}</text>
      </g>`).join("")}
      <line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${height - padBottom}" class="axis"></line>
      <line x1="${padLeft}" y1="${height - padBottom}" x2="${width - padRight}" y2="${height - padBottom}" class="axis"></line>
      <polyline points="${issuePoints}" class="trend-line issued-line"></polyline>
      <polyline points="${returnPoints}" class="trend-line returned-line"></polyline>
      ${labels.map((label, index) => index % labelEvery === 0 || index === labels.length - 1
        ? `<text x="${xFor(index)}" y="${height - 10}" text-anchor="middle">${escapeHtml(shortLabel(label, bucket))}</text>`
        : "").join("")}
    </svg>`;
}

function renderCategoryChart(context) {
  const counts = new Map();
  context.books.forEach((item) => increment(counts, categoryOf(item.data)));
  const rows = Array.from(counts, ([category, count]) => ({ category, count }))
    .sort((left, right) => right.count - left.count);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  $("#categoryChartRange").textContent = context.dateLabel;
  if (!total) {
    $("#booksCategoryDonut").style.background = "rgba(100, 116, 139, 0.15)";
    $("#booksCategoryLegend").innerHTML = `<div class="empty">No books found.</div>`;
    return;
  }
  let cursor = 0;
  const segments = rows.map((row, index) => {
    const start = cursor;
    cursor += (row.count / total) * 100;
    return `${categoryColors[index % categoryColors.length]} ${start}% ${cursor}%`;
  }).join(", ");
  $("#booksCategoryDonut").style.background = `conic-gradient(${segments})`;
  $("#booksCategoryLegend").innerHTML = rows.map((row, index) => `
    <div><span class="legend-dot" style="background:${categoryColors[index % categoryColors.length]}"></span>
      <span>${escapeHtml(row.category)}</span><strong>${row.count} (${Math.round((row.count / total) * 100)}%)</strong>
    </div>`).join("");
}

function renderTopIssuedBooks(context) {
  const counts = new Map();
  context.issues.forEach((item) => {
    const issue = item.data;
    const book = bookForIssue(issue);
    const key = stableBookKey(issue, book);
    const current = counts.get(key) || { title: titleOfRecord(book) || titleOfRecord(issue) || "Issued book", count: 0 };
    current.count += 1;
    counts.set(key, current);
  });
  const rows = Array.from(counts.values())
    .sort((left, right) => right.count - left.count || left.title.localeCompare(right.title))
    .slice(0, 5);
  const max = Math.max(1, ...rows.map((row) => row.count));
  $("#topBooksRange").textContent = context.dateLabel;
  $("#topIssuedBooks").innerHTML = rows.length ? rows.map((row, index) => `
    <button class="bar-row" type="button" title="${escapeHtml(row.title)}" aria-label="${escapeHtml(row.title)} issued ${row.count} time${row.count === 1 ? "" : "s"}">
      <span class="top-book-rank">${index + 1}</span>
      <span class="top-book-title">${escapeHtml(row.title)}</span>
      <strong>${row.count}</strong>
      <i aria-hidden="true"><span style="width:${Math.max(8, (row.count / max) * 100)}%"></span></i>
    </button>`).join("") : `<div class="empty">No issue history in this date range.</div>`;
}

function renderPrimaryTable(report) {
  controls.tableTitle.textContent = report.title;
  if (!report.rows.length) {
    renderEmpty(controls.table, "No records match the selected filters.");
    return;
  }
  controls.table.innerHTML = `
    <table class="reports-table">
      <thead><tr>${report.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>
      <tbody>${report.rows.map((row) => `
        <tr>${report.columns.map((column) => `<td>${cellValue(row[column], column)}</td>`).join("")}</tr>
      `).join("")}</tbody>
    </table>`;
}

function renderRecentReports() {
  const history = readReportHistory();
  if (!history.length) {
    renderEmpty(controls.recentReports, "No report generated in this browser session yet.");
    return;
  }
  controls.recentReports.innerHTML = `
    <table class="reports-table compact">
      <thead><tr><th>Report Name</th><th>Type</th><th>Generated On</th><th>Generated By</th><th>Action</th></tr></thead>
      <tbody>${history.map((item, index) => `
        <tr>
          <td>${escapeHtml(item.reportName)}</td>
          <td>${escapeHtml(reportTypeLabel(item.reportType))}</td>
          <td>${escapeHtml(new Date(item.generatedOn).toLocaleString())}</td>
          <td>${escapeHtml(item.generatedByName)}</td>
          <td>
            <button class="icon-btn" data-report-action="view" data-report-index="${index}" type="button">👁</button>
            <button class="icon-btn" data-report-action="download" data-report-index="${index}" type="button">⇩</button>
          </td>
        </tr>`).join("")}</tbody>
    </table>`;
}

function exportCurrentExcel(recordHistory = true) {
  if (!window.XLSX) {
    showToast("Excel export library is still loading. Try again.", "warning");
    return;
  }
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.json_to_sheet(generatedRows), safeSheetName(generatedTitle));
  window.XLSX.writeFile(workbook, `${safeFileName(generatedTitle)}.xlsx`);
  if (recordHistory) showToast("Excel report exported.", "success");
}

function exportCurrentPdf(recordHistory = true) {
  const jsPdf = window.jspdf?.jsPDF;
  if (!jsPdf) {
    showToast("PDF export library is still loading. Try again.", "warning");
    return;
  }
  const doc = new jsPdf({ orientation: "landscape", unit: "pt", format: "a4" });
  let y = 42;
  doc.setFontSize(16);
  doc.text("Mohanlal Sukhadia University LMS", 40, y);
  y += 24;
  doc.setFontSize(13);
  doc.text(generatedTitle, 40, y);
  y += 20;
  doc.setFontSize(9);
  doc.text(`Generated: ${new Date().toLocaleString()} | By: ${session.profile?.name || session.user?.email || "Staff"}`, 40, y);
  y += 14;
  doc.text(`Date Range: ${currentContext?.dateLabel || "-"} | Category: ${currentContext?.category || "All"} | Course: ${currentContext?.course || "All"}`, 40, y);
  y += 24;
  const columns = generatedColumns.slice(0, 8);
  const rows = generatedRows.slice(0, 24);
  doc.setFontSize(8);
  doc.text(columns.join(" | "), 40, y);
  y += 14;
  rows.forEach((row) => {
    const line = columns.map((column) => String(row[column] ?? "-").slice(0, 24)).join(" | ");
    doc.text(line, 40, y);
    y += 12;
    if (y > 560) {
      doc.addPage();
      y = 42;
    }
  });
  doc.save(`${safeFileName(generatedTitle)}.pdf`);
  if (recordHistory) showToast("PDF report exported.", "success");
}

function exportAllReports() {
  if (!window.XLSX) {
    showToast("Excel export library is still loading. Try again.", "warning");
    return;
  }
  const workbook = window.XLSX.utils.book_new();
  const types = ["books", "students", "issueReturn", "penalties", "requests", "noDues"];
  types.forEach((type) => {
    const report = buildReport(type, currentContext || buildContext());
    window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.json_to_sheet(report.rows), safeSheetName(report.title));
  });
  window.XLSX.writeFile(workbook, `mlsu_all_reports_${todayStamp()}.xlsx`);
  writeReportHistory({
    reportName: "All Reports Export",
    reportType: "all",
    generatedByName: session.profile?.name || session.user?.email || "Staff",
    generatedOn: new Date().toISOString(),
    dateRange: currentContext?.dateLabel || selectedDateRange().dateLabel,
    filters: {},
    action: "Exported"
  });
  renderRecentReports();
  showToast("All reports exported as one Excel workbook.", "success");
}

function populateDynamicFilters() {
  const categories = unique(datasets.books.map((item) => categoryOf(item.data)).filter(Boolean));
  controls.category.innerHTML = `<option value="">All Categories</option>${categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}`;
  const courses = unique(rowStudents().map((student) => student.department || student.course || student.branch || "").filter(Boolean));
  controls.course.innerHTML = `<option value="">All Courses</option>${courses.map((course) => `<option value="${escapeHtml(course)}">${escapeHtml(course)}</option>`).join("")}`;
  syncCustomRangeVisibility();
}

function syncCustomRangeVisibility() {
  const show = controls.dateRange?.value === "custom";
  document.querySelectorAll(".custom-range-field").forEach((field) => {
    field.hidden = !show;
  });
}

function selectedDateRange() {
  const now = new Date();
  const mode = controls.dateRange?.value || "month";
  if (mode === "all") return { dateLabel: "All Time", start: null, end: null };
  if (mode === "custom") {
    return {
      dateLabel: `${controls.customStartDate.value || "Start"} - ${controls.customEndDate.value || "End"}`,
      start: controls.customStartDate.value ? startOfDay(new Date(controls.customStartDate.value)) : null,
      end: controls.customEndDate.value ? endOfDay(new Date(controls.customEndDate.value)) : null
    };
  }
  if (mode === "today") return { dateLabel: "Today", start: startOfDay(now), end: endOfDay(now) };
  if (mode === "week") {
    const start = startOfDay(now);
    start.setDate(start.getDate() - start.getDay());
    return { dateLabel: "This Week", start, end: endOfDay(now) };
  }
  if (mode === "year") return { dateLabel: "This Year", start: new Date(now.getFullYear(), 0, 1), end: endOfDay(now) };
  return { dateLabel: "This Month", start: new Date(now.getFullYear(), now.getMonth(), 1), end: endOfDay(now) };
}

function applyBookFilters(rows, { category }) {
  return rows.filter((item) => !category || normalize(categoryOf(item.data)) === normalize(category));
}

function applyStudentFilters(rows, { course }) {
  return rows.filter((student) => !course || normalize(student.department || student.course || student.branch || "") === normalize(course));
}

function applyIssueFilters(rows, { dateRange, category = "", course = "", ignoreDate = false }) {
  return rows.filter((item) => {
    const issue = item.data;
    if (!ignoreDate && !recordHasDateInRange(issue, dateRange, ["issueDate", "issuedAt", "createdAt", "returnDate", "returnedAt"])) return false;
    if (category && normalize(recordCategory(issue, bookForIssue(issue))) !== normalize(category)) return false;
    if (course && normalize(studentForRecord(issue)?.department || studentForRecord(issue)?.course || studentForRecord(issue)?.branch || "") !== normalize(course)) return false;
    return true;
  });
}

function applyPenaltyFilters(rows, { dateRange, course = "" }) {
  return rows.filter((item) => {
    const penalty = item.data;
    const created = toDate(penalty.createdAt || penalty.updatedAt || penalty.clearedAt || penalty.paidAt || penalty.dueDate);
    if (!dateInRange(created, dateRange)) return false;
    if (course && normalize(studentForRecord(penalty)?.department || studentForRecord(penalty)?.course || studentForRecord(penalty)?.branch || "") !== normalize(course)) return false;
    return true;
  });
}

function applyRequestFilters(rows, { dateRange, course = "" }) {
  return rows.filter((item) => {
    const request = item.data;
    const created = toDate(request.createdAt || request.requestedAt || request.updatedAt);
    if (!dateInRange(created, dateRange)) return false;
    if (course && normalize(studentForRecord(request)?.department || studentForRecord(request)?.course || studentForRecord(request)?.branch || "") !== normalize(course)) return false;
    return true;
  });
}

function rowStudents() {
  const studentsByUid = new Map();
  datasets.students.forEach((item) => {
    const data = item.data;
    const uid = data.uid || data.studentUid || data.firebaseAuthUid || item.id;
    studentsByUid.set(uid, { id: item.id, ...data, uid });
  });
  datasets.users
    .filter((item) => item.data.role === "student")
    .forEach((item) => {
      const existing = studentsByUid.get(item.id) || {};
      studentsByUid.set(item.id, { ...item.data, ...existing, uid: item.id });
    });
  return Array.from(studentsByUid.values());
}

function requestRow(item, type) {
  const request = item.data;
  return {
    "Request Type": type,
    "Student Name": request.studentName || request.name || "-",
    "Book Title": titleOfRecord(request),
    "Accession Number": accessionOf(request),
    Status: request.status || "-",
    "Created On": formatDate(request.createdAt || request.requestedAt || request.updatedAt)
  };
}

function limitRows(rows, context) {
  return context.format === "detailed" ? rows : rows.slice(0, 8);
}

function addIndex(rows) {
  return rows.map((row, index) => ({ "#": index + 1, ...row }));
}

function dateInRange(date, range) {
  if (!range?.start && !range?.end) return true;
  if (!date) return false;
  if (range.start && date < range.start) return false;
  if (range.end && date > range.end) return false;
  return true;
}

function recordHasDateInRange(record, range, fields) {
  if (!range?.start && !range?.end) return true;
  return fields.some((field) => dateInRange(toDate(record[field]), range));
}

function toDate(value) {
  if (!value) return null;
  const date = value.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function isReturnedIssue(issue = {}) {
  const status = String(issue.status || "").toLowerCase();
  return Boolean(issue.returnDate || issue.returnedAt || ["returned", "completed", "closed"].includes(status));
}

function isBookAvailable(book = {}) {
  const status = statusOf(book);
  return !status || ["available", "in-library", "in_library"].includes(status);
}

function statusOf(record = {}) {
  return String(record.status || record.bookStatus || "").trim().toLowerCase();
}

function titleOfRecord(record = {}) {
  return record.title || record.bname || record.bookTitle || record.bookName || record.name || record.bookId || record.b_id || "";
}

function accessionOf(record = {}) {
  return record.accessionNumber || record.blegal_num || record.blegalNumber || record.BLegalNumber || record.bookBarcodeValue || record.barcodeValue || record.bookId || record.b_id || "-";
}

function categoryOf(book = {}) {
  return normalizeCategoryName(book.category || book.bookCategory || book.subjectCategory);
}

function recordCategory(record = {}, book = {}) {
  return normalizeCategoryName(record.category || record.bookCategory || book.category || book.bookCategory || book.subjectCategory);
}

function normalizeCategoryName(value) {
  const clean = String(value || "").trim();
  if (!clean) return "Uncategorized";
  const key = clean.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
  const aliases = {
    textbook: "Textbook",
    textbooks: "Textbook",
    text: "Textbook",
    qna: "Q&A",
    qa: "Q&A",
    qanda: "Q&A",
    questionanswer: "Q&A",
    questionanswers: "Q&A",
    pyq: "PYQ",
    previousyearquestion: "PYQ",
    previousyearquestions: "PYQ",
    reference: "Reference",
    references: "Reference",
    journal: "Journal",
    journals: "Journal",
    notes: "Notes",
    note: "Notes",
    general: "General",
    engineering: "Engineering",
    other: "Other",
    uncategorized: "Uncategorized"
  };
  if (aliases[key]) return aliases[key];
  return clean
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function stableBookKey(record = {}, book = {}) {
  const accession = accessionOf(record) !== "-" ? accessionOf(record) : accessionOf(book);
  return record.bookId || record.b_id || book.id || book.bookId || accession || normalize(`${titleOfRecord(record)} ${record.author || book.author || ""}`);
}

function bookForIssue(issue = {}) {
  const bookId = issue.bookId || issue.b_id;
  const accession = accessionOf(issue);
  return datasets.books.find((item) => item.id === bookId || item.data.bookId === bookId || item.data.b_id === bookId || accessionOf(item.data) === accession)?.data || {};
}

function studentForRecord(record = {}) {
  const uid = record.studentUid || record.userId || record.studentId || record.issuedTo || "";
  const email = String(record.studentEmail || record.email || "").toLowerCase();
  return rowStudents().find((student) => student.uid === uid || (email && String(student.email || "").toLowerCase() === email)) || {};
}

function bucketLabel(date, bucket) {
  if (bucket === "monthly") return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  if (bucket === "weekly") {
    const first = startOfDay(date);
    first.setDate(first.getDate() - first.getDay());
    return `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}-${String(first.getDate()).padStart(2, "0")}`;
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function shortLabel(label, bucket) {
  if (bucket === "monthly") return label.slice(5);
  return label.slice(5);
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function normalize(value = "") {
  return String(value || "").trim().toLowerCase();
}

function currency(value) {
  return `₹ ${Number(value || 0).toFixed(0)}`;
}

function setText(selector, value) {
  const target = $(selector);
  if (target) target.textContent = String(value);
}

function cellValue(value, column) {
  if (column === "Status" || column === "Payment Status" || column === "No Dues") {
    return statusBadge(String(value || "").toLowerCase().replace(/\s+/g, "-"));
  }
  return escapeHtml(value);
}

function reportTypeLabel(type) {
  const labels = {
    all: "All Reports",
    books: "Books",
    students: "Students",
    issueReturn: "Issue / Return",
    penalties: "Penalties",
    requests: "Requests",
    noDues: "No Dues",
    activity: "Activity",
    inventory: "Inventory"
  };
  return labels[type] || type;
}

function readReportHistory() {
  try {
    return JSON.parse(sessionStorage.getItem(REPORT_HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function writeReportHistory(item) {
  const history = readReportHistory();
  history.unshift(item);
  sessionStorage.setItem(REPORT_HISTORY_KEY, JSON.stringify(history.slice(0, 8)));
}

function applyHistoryItem(item) {
  if (!item) return;
  if (controls.reportType) controls.reportType.value = item.reportType || "all";
  if (controls.category) controls.category.value = item.filters?.category === "All Categories" ? "" : item.filters?.category || "";
  if (controls.course) controls.course.value = item.filters?.course === "All Courses" ? "" : item.filters?.course || "";
  if (controls.format) controls.format.value = item.filters?.format || "summary";
}

function safeSheetName(name) {
  return String(name || "Report").replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
}

function safeFileName(name) {
  return String(name || "report").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "report";
}

function todayStamp() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
}

function dateValue(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}
