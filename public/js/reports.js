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
let currentReport = null;
let activeQuickReport = "";
let activeReportMode = "";
let currentPage = 1;
let currentSort = { column: "", direction: "asc" };

const controls = {
  heroDateRange: $("#heroDateRange"),
  search: $("#reportSearch"),
  reportType: $("#reportType"),
  dateRange: $("#dateRange"),
  customStartDate: $("#customStartDate"),
  customEndDate: $("#customEndDate"),
  category: $("#categoryFilter"),
  course: $("#courseFilter"),
  status: $("#statusFilter"),
  format: $("#reportFormat"),
  pageSize: $("#reportPageSize"),
  generate: $("#generateReportBtn"),
  trendBucket: $("#trendBucket"),
  table: $("#primaryReportTable"),
  tableTitle: $("#primaryTableTitle"),
  summary: $("#reportSummary"),
  pagination: $("#reportPagination"),
  recentReports: $("#recentReportsTable")
};

await loadReportData();
populateDynamicFilters();
refreshReport("Initial load", false);

controls.generate?.addEventListener("click", () => {
  applySearchIntent();
  refreshReport("Generated", true);
});
controls.search?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    applySearchIntent();
    refreshReport("Generated", true);
  }
});
controls.trendBucket?.addEventListener("change", () => refreshReport("Generated", false));
controls.dateRange?.addEventListener("change", () => {
  activeQuickReport = "";
  activeReportMode = "";
  syncCustomRangeVisibility();
  if (controls.heroDateRange) controls.heroDateRange.value = controls.dateRange.value === "custom" ? "month" : controls.dateRange.value;
});
controls.heroDateRange?.addEventListener("change", () => {
  activeQuickReport = "";
  activeReportMode = "";
  controls.dateRange.value = controls.heroDateRange.value;
  syncCustomRangeVisibility();
  refreshReport("Generated", false);
});
controls.reportType?.addEventListener("change", () => {
  activeQuickReport = "";
  activeReportMode = "";
});
controls.status?.addEventListener("change", () => {
  activeQuickReport = "";
  activeReportMode = "";
});
controls.pageSize?.addEventListener("change", () => {
  currentPage = 1;
  renderPrimaryTable(currentReport);
});
document.querySelectorAll("[data-report-preset]").forEach((button) => {
  button.addEventListener("click", () => applyQuickReport(button.dataset.reportPreset));
});
$("#viewFullReportBtn")?.addEventListener("click", () => {
  controls.format.value = "detailed";
  refreshReport("Generated", true);
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
  refreshReport(action.dataset.reportAction === "download" ? "Downloaded" : "Viewed", false);
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

export function generateReport({
  type = "all",
  dateRange = selectedDateRange(),
  filters = {},
  search = "",
  sort = {},
  groupBy = ""
} = {}) {
  const baseContext = buildContext({ dateRange, type, filters, search, sort, groupBy });
  const report = buildReport(baseContext.reportType, baseContext);
  return {
    title: report.title,
    summary: report.summary || buildReportSummary(report.rows),
    rows: report.rows,
    chartData: buildChartData(baseContext),
    appliedFilters: {
      dateRange: baseContext.dateLabel,
      filters: baseContext.filters,
      search: baseContext.search,
      sort,
      groupBy
    },
    generatedAt: new Date().toISOString()
  };
}

function refreshReport(historyAction = "Generated", recordHistory = true) {
  currentContext = buildContext();
  const report = buildReport(currentContext.reportType, currentContext);
  currentReport = report;
  generatedRows = report.rows;
  generatedColumns = report.columns;
  generatedTitle = report.title;
  renderKpis(currentContext);
  renderQuickReports(currentContext);
  renderTrendChart(currentContext);
  renderCategoryChart(currentContext);
  renderTopIssuedBooks(currentContext);
  renderPenaltyTrendChart(currentContext);
  renderOverdueDistributionChart(currentContext);
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

function buildContext(overrides = {}) {
  const dateRange = overrides.dateRange || selectedDateRange();
  const overrideFilters = overrides.filters || {};
  const category = overrideFilters.category ?? controls.category?.value ?? "";
  const course = overrideFilters.course ?? controls.course?.value ?? "";
  const status = overrideFilters.status ?? controls.status?.value ?? "";
  const search = overrides.search ?? controls.search?.value ?? "";
  const quickReport = overrideFilters.quickReport ?? activeQuickReport;
  const reportMode = overrideFilters.reportMode ?? activeReportMode;
  const books = applyBookFilters(datasets.books, { category });
  const students = applyStudentFilters(rowStudents(), { course });
  const issues = applyIssueFilters(datasets.bookIssues, { dateRange, category, course });
  const allIssuesForLiability = applyIssueFilters(datasets.bookIssues, { category, course, ignoreDate: true });
  const penalties = applyPenaltyFilters(datasets.penalties, { dateRange, course });
  return {
    ...dateRange,
    reportType: overrides.type || controls.reportType?.value || "all",
    category,
    course,
    status,
    search,
    quickReport,
    reportMode,
    filters: { category, course, status, quickReport, reportMode },
    sort: overrides.sort || currentSort,
    groupBy: overrides.groupBy || "",
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
  if (context.quickReport) return finalizeReport(buildQuickReport(context.quickReport, context), context);
  let report;
  switch (type) {
    case "books":
    case "inventory":
      report = buildBooksReport(context, type);
      break;
    case "students":
      report = buildStudentsReport(context);
      break;
    case "issues":
      report = buildIssuesReport(context);
      break;
    case "returns":
      report = buildReturnsReport(context);
      break;
    case "penalties":
      report = buildPenaltyReport(context);
      break;
    case "requests":
      report = buildRequestsReport(context);
      break;
    case "noDues":
      report = buildNoDuesReport(context);
      break;
    case "activity":
      report = buildActivityReport(context);
      break;
    case "statistics":
      report = buildStatisticsReport(context);
      break;
    case "issueReturn":
    case "all":
    default:
      report = buildIssueSummaryReport(context);
  }
  return finalizeReport(report, context);
}

function finalizeReport(report, context) {
  const rows = (report.rows || [])
    .map((row) => {
      const { "#": _index, ...rest } = row;
      return rest;
    })
    .filter((row) => rowMatchesStatus(row, context.status))
    .filter((row) => rowMatchesSearch(row, context.search));
  const sortedRows = sortRows(rows, context.sort || currentSort);
  return {
    ...report,
    summary: report.summary || buildReportSummary(sortedRows),
    rows: addIndex(sortedRows)
  };
}

function buildQuickReport(key, context) {
  const today = startOfDay(new Date());
  const tomorrow = addCalendarDays(today, 1);
  const todayRange = { dateLabel: "Today", start: startOfDay(today), end: endOfDay(today) };
  const titleMap = {
    issuedToday: "Issued Today",
    returnedToday: "Returned Today",
    dueToday: "Due Today",
    dueTomorrow: "Due Tomorrow",
    overdueBooks: "Overdue Books",
    unpaidPenalties: "Unpaid Penalties",
    pendingIssueRequests: "Pending Issue Requests",
    pendingReturnRequests: "Pending Return Requests",
    availableBooks: "Available Books",
    lostDamagedBooks: "Lost / Damaged Books"
  };
  if (key === "issuedToday") return buildIssuesReport({ ...context, ...todayRange, issues: context.allIssuesForLiability.filter((item) => sameCalendarDay(issueDateOf(item.data), today)) }, titleMap[key]);
  if (key === "returnedToday") return buildReturnsReport({ ...context, ...todayRange, issues: context.allIssuesForLiability.filter((item) => sameCalendarDay(returnDateOf(item.data), today)) }, titleMap[key]);
  if (key === "dueToday") return buildDueReport(context, titleMap[key], (issue) => sameCalendarDay(dueDateOfIssue(issue), today));
  if (key === "dueTomorrow") return buildDueReport(context, titleMap[key], (issue) => sameCalendarDay(dueDateOfIssue(issue), tomorrow));
  if (key === "overdueBooks") return buildDueReport(context, titleMap[key], (issue) => isActiveIssue(issue) && calculatePenalty(issue, new Date()).isOverdue);
  if (key === "unpaidPenalties") return buildPenaltyReport({ ...context, noDuesRows: context.noDuesRows.map((row) => ({ ...row, paidHistory: [] })) }, titleMap[key], "unpaid");
  if (key === "pendingIssueRequests") return buildRequestsReport({ ...context, issueRequests: context.issueRequests.filter((item) => statusOf(item.data) === "pending"), returnRequests: [] }, titleMap[key]);
  if (key === "pendingReturnRequests") return buildRequestsReport({ ...context, issueRequests: [], returnRequests: context.returnRequests.filter((item) => statusOf(item.data) === "pending") }, titleMap[key]);
  if (key === "availableBooks") return buildBooksReport({ ...context, books: context.books.filter((item) => isBookAvailable(item.data)) }, titleMap[key]);
  if (key === "lostDamagedBooks") return buildBooksReport({ ...context, books: context.books.filter((item) => ["lost", "damaged"].includes(statusOf(item.data))) }, titleMap[key]);
  return buildIssueSummaryReport(context);
}

function buildIssuesReport(context, title = "Issue Report") {
  const rows = context.issues
    .filter((item) => dateInRange(issueDateOf(item.data), context))
    .map((item) => issueReportRow(item.data, item.id));
  return {
    title,
    columns: ["#", "Student", "Roll No.", "Enrollment No.", "Book Title", "Accession No.", "Issue Date", "Due Date", "Status", "Overdue Days", "Penalty"],
    rows: addIndex(limitRows(rows, context))
  };
}

function buildReturnsReport(context, title = "Return Report") {
  const rows = context.issues
    .filter((item) => isReturnedIssue(item.data))
    .filter((item) => dateInRange(returnDateOf(item.data), context))
    .map((item) => {
      const issue = item.data;
      const calculation = calculatePenalty(issue, returnDateOf(issue) || new Date());
      return {
        Student: studentNameOf(issue),
        "Book": titleOfRecord(issue) || "Issued book",
        "Accession No.": accessionOf(issue),
        "Issue Date": formatDate(issueDateOf(issue)),
        "Due Date": formatDate(dueDateOfIssue(issue)),
        "Return Date": formatDate(returnDateOf(issue)),
        "Overdue Days": calculation.overdueDays,
        Penalty: currency(issue.penaltyAmount || calculation.calculatedPenalty || 0),
        Status: issue.status || "returned"
      };
    });
  return {
    title,
    columns: ["#", "Student", "Book", "Accession No.", "Issue Date", "Due Date", "Return Date", "Overdue Days", "Penalty", "Status"],
    rows: addIndex(limitRows(rows, context))
  };
}

function buildDueReport(context, title, predicate) {
  const rows = context.allIssuesForLiability
    .filter((item) => isActiveIssue(item.data))
    .filter((item) => predicate(item.data))
    .map((item) => issueReportRow(item.data, item.id));
  return {
    title,
    columns: ["#", "Student", "Roll No.", "Enrollment No.", "Book Title", "Accession No.", "Issue Date", "Due Date", "Status", "Overdue Days", "Penalty"],
    rows: addIndex(rows)
  };
}

function buildStatisticsReport(context) {
  const quickCounts = quickReportCounts(context);
  const rows = Object.entries(quickCounts).map(([key, value]) => ({
    Metric: quickReportLabel(key),
    Count: value,
    "Date Range": context.dateLabel
  }));
  return {
    title: "Statistics Report",
    columns: ["#", "Metric", "Count", "Date Range"],
    rows: addIndex(rows)
  };
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
  if (["mostIssued", "rarelyIssued", "neverIssued", "frequentlyRequested"].includes(context.reportMode)) {
    return buildBookUsageReport(context, type);
  }
  if (context.reportMode === "recentlyAdded") return buildRecentlyAddedBooksReport(context, type);
  if (["byCategory", "byAuthor", "byPublisher"].includes(context.reportMode)) return buildBookGroupReport(context, type);
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
    title: reportTitle(type, "Books Report"),
    columns: ["#", "Book Title", "Accession Number", "Author", "Category", "Status", "Year", "Subject"],
    rows: addIndex(limitRows(rows, context))
  };
}

function buildBookUsageReport(context, type) {
  const issueCounts = countBookIssues();
  const requestCounts = countBookRequests();
  let rows = context.books.map((item) => {
    const book = item.data;
    const key = bookIdentity(item);
    return {
      "Book Title": titleOfRecord(book) || "-",
      "Accession Number": accessionOf(book),
      Author: book.author || "-",
      Category: categoryOf(book),
      Status: statusOf(book) || "available",
      "Total Issued": issueCounts.get(key) || 0,
      "Request Count": requestCounts.get(key) || 0
    };
  });
  if (context.reportMode === "neverIssued") rows = rows.filter((row) => row["Total Issued"] === 0);
  if (context.reportMode === "frequentlyRequested") rows.sort((left, right) => right["Request Count"] - left["Request Count"] || left["Book Title"].localeCompare(right["Book Title"]));
  else if (context.reportMode === "rarelyIssued" || context.reportMode === "neverIssued") rows.sort((left, right) => left["Total Issued"] - right["Total Issued"] || left["Book Title"].localeCompare(right["Book Title"]));
  else rows.sort((left, right) => right["Total Issued"] - left["Total Issued"] || left["Book Title"].localeCompare(right["Book Title"]));
  const titles = {
    mostIssued: "Most Issued Books",
    rarelyIssued: "Rarely Issued Books",
    neverIssued: "Never Issued Books",
    frequentlyRequested: "Frequently Requested Books"
  };
  return {
    title: reportTitle(type, titles[context.reportMode] || "Book Usage Report"),
    columns: ["#", "Book Title", "Accession Number", "Author", "Category", "Status", "Total Issued", "Request Count"],
    rows: addIndex(limitRows(rows, context))
  };
}

function buildRecentlyAddedBooksReport(context, type) {
  const rows = context.books.map((item) => {
    const book = item.data;
    return {
      "Book Title": titleOfRecord(book) || "-",
      "Accession Number": accessionOf(book),
      Author: book.author || "-",
      Category: categoryOf(book),
      Status: statusOf(book) || "available",
      "Added On": formatDate(bookAddedDate(book))
    };
  }).sort((left, right) => dateValue(right["Added On"]) - dateValue(left["Added On"]));
  return {
    title: reportTitle(type, "Recently Added Books"),
    columns: ["#", "Book Title", "Accession Number", "Author", "Category", "Status", "Added On"],
    rows: addIndex(limitRows(rows, context))
  };
}

function buildBookGroupReport(context, type) {
  const field = context.reportMode === "byAuthor" ? "author" : context.reportMode === "byPublisher" ? "publisher" : "category";
  const label = context.reportMode === "byAuthor" ? "Author" : context.reportMode === "byPublisher" ? "Publisher" : "Category";
  const groups = new Map();
  context.books.forEach((item) => {
    const book = item.data;
    const value = field === "category" ? categoryOf(book) : (field === "publisher" ? (book.publisher || book.placePublisher || book.publication || "Unknown") : (book.author || "Unknown"));
    const current = groups.get(value) || { [label]: value, "Total Books": 0, Available: 0, Issued: 0, "Lost / Damaged": 0 };
    current["Total Books"] += 1;
    if (isBookAvailable(book)) current.Available += 1;
    else if (["lost", "damaged"].includes(statusOf(book))) current["Lost / Damaged"] += 1;
    else current.Issued += 1;
    groups.set(value, current);
  });
  const rows = Array.from(groups.values()).sort((left, right) => right["Total Books"] - left["Total Books"] || String(left[label]).localeCompare(String(right[label])));
  return {
    title: reportTitle(type, `Books by ${label}`),
    columns: ["#", label, "Total Books", "Available", "Issued", "Lost / Damaged"],
    rows: addIndex(limitRows(rows, context))
  };
}

function buildStudentsReport(context) {
  const noDuesByUid = new Map(context.noDuesRows.map((row) => [row.uid, row]));
  const borrowCounts = countStudentIssues();
  const rows = context.students.map((student) => {
    const noDues = noDuesByUid.get(student.uid) || {};
    return {
      "Student Name": student.name || "Unknown Student",
      UID: student.uid,
      "Roll Number": student.rollNumber || student.rollNo || student.roll || "-",
      "Enrollment Number": student.enrollmentNumber || student.enrollmentNo || "-",
      Course: student.department || student.course || student.branch || "-",
      "Borrow Count": borrowCounts.get(student.uid) || 0,
      "Active Books": noDues.activeBooks || 0,
      Overdue: noDues.overdueCount || 0,
      "Pending Penalty": currency(noDues.penaltyAmount || 0),
      "No Dues": noDues.status === "blocked" ? "Blocked" : "Eligible"
    };
  }).sort((left, right) => context.reportMode === "topBorrowers"
    ? right["Borrow Count"] - left["Borrow Count"] || left["Student Name"].localeCompare(right["Student Name"])
    : left["Student Name"].localeCompare(right["Student Name"]));
  return {
    title: context.reportMode === "topBorrowers" ? "Top Borrowing Students" : "Students Report",
    columns: ["#", "Student Name", "UID", "Roll Number", "Enrollment Number", "Course", "Borrow Count", "Active Books", "Overdue", "Pending Penalty", "No Dues"],
    rows: addIndex(limitRows(rows, context))
  };
}

function buildPenaltyReport(context, title = "Penalties Report", mode = "") {
  const rows = [];
  if (mode !== "paid") context.noDuesRows.forEach((student) => {
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
  if (mode !== "unpaid") context.penalties
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
    title,
    columns: ["#", "Student Name", "UID", "Roll Number", "Book Title", "Accession Number", "Due Date", "Overdue Days", "Rate", "Amount", "Payment Status"],
    rows: addIndex(limitRows(rows, context))
  };
}

function buildRequestsReport(context, title = "Requests Report") {
  const issueRows = context.issueRequests.map((item) => requestRow(item, "Issue Request"));
  const returnRows = context.returnRequests.map((item) => requestRow(item, "Return Request"));
  return {
    title,
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
  const overdueBooks = activeIssues.filter((item) => calculatePenalty(item.data, new Date()).isOverdue).length;
  const pendingPenalty = context.noDuesRows.reduce((sum, row) => sum + Number(row.penaltyAmount || 0), 0);
  setText("#kpiTotalBooks", context.books.length);
  setText("#kpiIssuedBooks", activeIssues.length);
  setText("#kpiAvailableBooks", context.books.filter((item) => isBookAvailable(item.data)).length);
  setText("#kpiReturnedBooks", returnedInRange);
  setText("#kpiOverdueBooks", overdueBooks);
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

function renderPenaltyTrendChart(context) {
  const target = $("#penaltyTrendChart");
  if (!target) return;
  $("#penaltyTrendRange").textContent = context.dateLabel;
  const bucket = controls.trendBucket?.value || "daily";
  const collected = new Map();
  context.penalties
    .filter((item) => !isUnpaidPenaltyRecord(item.data))
    .forEach((item) => {
      const penalty = item.data;
      const date = toDate(penalty.clearedAt || penalty.paidAt || penalty.updatedAt || penalty.createdAt);
      if (!date || !dateInRange(date, context)) return;
      const amount = Number(penalty.paymentAmount || penalty.amountPaid || penalty.paidAmount || penalty.amount || penalty.penaltyAmount || 0) || 0;
      collected.set(bucketLabel(date, bucket), (collected.get(bucketLabel(date, bucket)) || 0) + amount);
    });
  const rows = Array.from(collected, ([label, amount]) => ({ label, amount })).sort((left, right) => left.label.localeCompare(right.label));
  if (!rows.length) {
    target.innerHTML = `<div class="chart-empty-state">No data for selected period</div>`;
    return;
  }
  const max = Math.max(1, ...rows.map((row) => row.amount));
  target.innerHTML = `
    <div class="mini-bar-chart">
      ${rows.slice(-8).map((row) => `
        <div title="${escapeHtml(row.label)}: ${currency(row.amount)}">
          <span style="height:${Math.max(8, (row.amount / max) * 100)}%"></span>
          <small>${escapeHtml(shortLabel(row.label, bucket))}</small>
        </div>`).join("")}
    </div>`;
}

function renderOverdueDistributionChart(context) {
  const target = $("#overdueDistributionChart");
  if (!target) return;
  const buckets = [
    { label: "1–7 Days", min: 1, max: 7, count: 0 },
    { label: "8–15 Days", min: 8, max: 15, count: 0 },
    { label: "16–30 Days", min: 16, max: 30, count: 0 },
    { label: "31–60 Days", min: 31, max: 60, count: 0 },
    { label: "60+ Days", min: 61, max: Infinity, count: 0 }
  ];
  context.allIssuesForLiability
    .filter((item) => isActiveIssue(item.data))
    .forEach((item) => {
      const days = calculatePenalty(item.data, new Date()).overdueDays;
      if (days <= 0) return;
      const bucket = buckets.find((entry) => days >= entry.min && days <= entry.max);
      if (bucket) bucket.count += 1;
    });
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  if (!buckets.some((bucket) => bucket.count > 0)) {
    target.innerHTML = `<div class="chart-empty-state">No overdue books</div>`;
    return;
  }
  target.innerHTML = buckets.map((bucket, index) => `
    <button class="bar-row distribution-row" type="button" data-overdue-bucket="${index}">
      <span class="top-book-rank">${index + 1}</span>
      <span class="top-book-title">${escapeHtml(bucket.label)}</span>
      <strong>${bucket.count}</strong>
      <i aria-hidden="true"><span style="width:${Math.max(8, (bucket.count / max) * 100)}%"></span></i>
    </button>`).join("");
}

function renderPrimaryTable(report) {
  if (!report) return;
  controls.tableTitle.textContent = report.title;
  generatedRows = report.rows;
  generatedColumns = report.columns;
  generatedTitle = report.title;
  renderReportSummary(report);
  if (!report.rows.length) {
    renderEmpty(controls.table, "No records match the selected filters.");
    controls.pagination.innerHTML = "";
    return;
  }
  const pageSize = Number(controls.pageSize?.value || 10);
  const totalPages = Math.max(1, Math.ceil(report.rows.length / pageSize));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  const pageRows = report.rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  controls.table.innerHTML = `
    <table class="reports-table">
      <thead><tr>${report.columns.map((column) => `<th><button class="table-sort-btn" data-sort-column="${escapeHtml(column)}" type="button">${escapeHtml(column)}${sortGlyph(column)}</button></th>`).join("")}</tr></thead>
      <tbody>${pageRows.map((row) => `
        <tr>${report.columns.map((column) => `<td>${cellValue(row[column], column)}</td>`).join("")}</tr>
      `).join("")}</tbody>
    </table>`;
  controls.table.querySelectorAll("[data-sort-column]").forEach((button) => {
    button.addEventListener("click", () => {
      const column = button.dataset.sortColumn;
      currentSort = {
        column,
        direction: currentSort.column === column && currentSort.direction === "asc" ? "desc" : "asc"
      };
      currentPage = 1;
      currentReport = finalizeReport({ ...report, rows: generatedRows, columns: report.columns }, currentContext);
      renderPrimaryTable(currentReport);
    });
  });
  renderPagination(report.rows.length, pageSize, totalPages);
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

function renderReportSummary(report) {
  if (!controls.summary) return;
  const summary = report.summary || buildReportSummary(report.rows);
  controls.summary.innerHTML = `
    <span><strong>${summary.totalRows}</strong> rows</span>
    <span><strong>${escapeHtml(currentContext?.dateLabel || "-")}</strong></span>
    <span>Generated ${new Date().toLocaleString()}</span>`;
}

function renderPagination(totalRows, pageSize, totalPages) {
  if (!controls.pagination) return;
  const first = totalRows ? (currentPage - 1) * pageSize + 1 : 0;
  const last = Math.min(totalRows, currentPage * pageSize);
  controls.pagination.innerHTML = `
    <span>Showing ${first}-${last} of ${totalRows}</span>
    <div>
      <button class="btn btn-muted" data-page-action="prev" type="button" ${currentPage <= 1 ? "disabled" : ""}>Previous</button>
      <strong>Page ${currentPage} / ${totalPages}</strong>
      <button class="btn btn-muted" data-page-action="next" type="button" ${currentPage >= totalPages ? "disabled" : ""}>Next</button>
    </div>`;
  controls.pagination.querySelectorAll("[data-page-action]").forEach((button) => {
    button.addEventListener("click", () => {
      currentPage += button.dataset.pageAction === "next" ? 1 : -1;
      renderPrimaryTable(currentReport);
    });
  });
}

function renderQuickReports(context) {
  const counts = quickReportCounts(context);
  document.querySelectorAll("[data-report-preset]").forEach((button) => {
    const key = button.dataset.reportPreset;
    const target = button.querySelector("strong");
    if (target) target.textContent = String(counts[key] || 0);
    button.classList.toggle("is-active", activeQuickReport === key);
  });
}

function applyQuickReport(key) {
  activeQuickReport = key;
  activeReportMode = "";
  const preset = quickReportPreset(key);
  if (preset.type && controls.reportType) controls.reportType.value = preset.type;
  if (preset.dateRange && controls.dateRange) controls.dateRange.value = preset.dateRange;
  if (controls.status) controls.status.value = preset.status || "";
  if (controls.search) controls.search.value = "";
  syncCustomRangeVisibility();
  currentPage = 1;
  refreshReport("Generated", true);
  controls.table?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function applySearchIntent() {
  const intent = detectSearchIntent(controls.search?.value || "");
  if (!intent) {
    activeQuickReport = "";
    currentPage = 1;
    return;
  }
  activeQuickReport = intent.quickReport || "";
  activeReportMode = intent.reportMode || "";
  if (intent.type && controls.reportType) controls.reportType.value = intent.type;
  if (intent.dateRange && controls.dateRange) controls.dateRange.value = intent.dateRange;
  if (intent.status && controls.status) controls.status.value = intent.status;
  if (controls.search) controls.search.value = "";
  syncCustomRangeVisibility();
  currentPage = 1;
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
  const types = ["books", "students", "issues", "returns", "penalties", "requests", "noDues"];
  types.forEach((type) => {
    const context = { ...(currentContext || buildContext()), quickReport: "", reportMode: "", reportType: type };
    const report = buildReport(type, context);
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

function quickReportCounts(context) {
  const today = startOfDay(new Date());
  const tomorrow = addCalendarDays(today, 1);
  const activeIssues = context.allIssuesForLiability.filter((item) => isActiveIssue(item.data));
  return {
    issuedToday: context.allIssuesForLiability.filter((item) => sameCalendarDay(issueDateOf(item.data), today)).length,
    returnedToday: context.allIssuesForLiability.filter((item) => sameCalendarDay(returnDateOf(item.data), today)).length,
    dueToday: activeIssues.filter((item) => sameCalendarDay(dueDateOfIssue(item.data), today)).length,
    dueTomorrow: activeIssues.filter((item) => sameCalendarDay(dueDateOfIssue(item.data), tomorrow)).length,
    overdueBooks: activeIssues.filter((item) => calculatePenalty(item.data, new Date()).isOverdue).length,
    unpaidPenalties: context.noDuesRows.reduce((sum, row) => sum + row.penaltyItems.length, 0),
    pendingIssueRequests: context.issueRequests.filter((item) => statusOf(item.data) === "pending").length,
    pendingReturnRequests: context.returnRequests.filter((item) => statusOf(item.data) === "pending").length,
    availableBooks: context.books.filter((item) => isBookAvailable(item.data)).length,
    lostDamagedBooks: context.books.filter((item) => ["lost", "damaged"].includes(statusOf(item.data))).length
  };
}

function quickReportLabel(key) {
  return {
    issuedToday: "Issued Today",
    returnedToday: "Returned Today",
    dueToday: "Due Today",
    dueTomorrow: "Due Tomorrow",
    overdueBooks: "Overdue Books",
    unpaidPenalties: "Unpaid Penalties",
    pendingIssueRequests: "Pending Issue Requests",
    pendingReturnRequests: "Pending Return Requests",
    availableBooks: "Available Books",
    lostDamagedBooks: "Lost / Damaged Books"
  }[key] || key;
}

function quickReportPreset(key) {
  const presets = {
    issuedToday: { type: "issues", dateRange: "today", status: "" },
    returnedToday: { type: "returns", dateRange: "today", status: "returned" },
    dueToday: { type: "issues", dateRange: "all", status: "issued" },
    dueTomorrow: { type: "issues", dateRange: "all", status: "issued" },
    overdueBooks: { type: "issues", dateRange: "all", status: "overdue" },
    unpaidPenalties: { type: "penalties", dateRange: "all", status: "unpaid" },
    pendingIssueRequests: { type: "requests", dateRange: "all", status: "pending" },
    pendingReturnRequests: { type: "requests", dateRange: "all", status: "pending" },
    availableBooks: { type: "books", dateRange: "all", status: "available" },
    lostDamagedBooks: { type: "books", dateRange: "all", status: "" }
  };
  return presets[key] || {};
}

function detectSearchIntent(value) {
  const text = normalize(value);
  if (!text) return null;
  if (text.includes("issued today")) return { quickReport: "issuedToday", type: "issues", dateRange: "today" };
  if (text.includes("issued yesterday")) return { type: "issues", dateRange: "yesterday" };
  if (text.includes("issued this week")) return { type: "issues", dateRange: "week" };
  if (text.includes("issued this month")) return { type: "issues", dateRange: "month" };
  if (text.includes("returned today")) return { quickReport: "returnedToday", type: "returns", dateRange: "today" };
  if (text.includes("returned this week")) return { type: "returns", dateRange: "week" };
  if (text.includes("due today")) return { quickReport: "dueToday", type: "issues", dateRange: "all", status: "issued" };
  if (text.includes("due tomorrow")) return { quickReport: "dueTomorrow", type: "issues", dateRange: "all", status: "issued" };
  if (text.includes("overdue")) return { quickReport: "overdueBooks", type: "issues", dateRange: "all", status: "overdue" };
  if (text.includes("unpaid penalt") || text.includes("pending penalt")) return { quickReport: "unpaidPenalties", type: "penalties", dateRange: "all", status: "unpaid" };
  if (text.includes("paid penalt") || text.includes("collected")) return { type: "penalties", status: "paid" };
  if (text.includes("no dues")) return { type: "noDues" };
  if (text.includes("most issued")) return { type: "books", reportMode: "mostIssued" };
  if (text.includes("frequently requested")) return { type: "books", reportMode: "frequentlyRequested" };
  if (text.includes("rarely issued")) return { type: "books", reportMode: "rarelyIssued" };
  if (text.includes("never issued")) return { type: "books", reportMode: "neverIssued" };
  if (text.includes("recently added")) return { type: "books", reportMode: "recentlyAdded" };
  if (text.includes("books by category")) return { type: "books", reportMode: "byCategory" };
  if (text.includes("books by author")) return { type: "books", reportMode: "byAuthor" };
  if (text.includes("books by publisher")) return { type: "books", reportMode: "byPublisher" };
  if (text.includes("borrow the most") || text.includes("top borrower")) return { type: "students", reportMode: "topBorrowers" };
  if (text.includes("pending issue request")) return { quickReport: "pendingIssueRequests", type: "requests", dateRange: "all", status: "pending" };
  if (text.includes("pending return request")) return { quickReport: "pendingReturnRequests", type: "requests", dateRange: "all", status: "pending" };
  if (/^acc[-\s]?\w+/i.test(value)) return { type: "activity", dateRange: "all" };
  return null;
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
  if (mode === "yesterday") {
    const yesterday = addCalendarDays(now, -1);
    return { dateLabel: "Yesterday", start: startOfDay(yesterday), end: endOfDay(yesterday) };
  }
  if (mode === "week") {
    const start = startOfDay(now);
    start.setDate(start.getDate() - start.getDay());
    return { dateLabel: "This Week", start, end: endOfDay(now) };
  }
  if (mode === "lastWeek") {
    const start = startOfDay(now);
    start.setDate(start.getDate() - start.getDay() - 7);
    const end = endOfDay(addCalendarDays(start, 6));
    return { dateLabel: "Last Week", start, end };
  }
  if (mode === "year") return { dateLabel: "This Year", start: new Date(now.getFullYear(), 0, 1), end: endOfDay(now) };
  if (mode === "lastMonth") {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = endOfDay(new Date(now.getFullYear(), now.getMonth(), 0));
    return { dateLabel: "Last Month", start, end };
  }
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

function issueReportRow(issue = {}, fallbackId = "") {
  const calculation = calculatePenalty({ ...issue, id: fallbackId }, new Date());
  return {
    Student: studentNameOf(issue),
    "Roll No.": issue.rollNo || issue.rollNumber || "-",
    "Enrollment No.": issue.enrollmentNumber || issue.enrollmentNo || "-",
    "Book Title": titleOfRecord(issue) || "Issued book",
    "Accession No.": accessionOf(issue),
    "Issue Date": formatDate(issueDateOf(issue)),
    "Due Date": formatDate(dueDateOfIssue(issue)),
    Status: calculation.isOverdue && isActiveIssue(issue) ? "overdue" : issue.status || "issued",
    "Overdue Days": calculation.overdueDays,
    Penalty: currency(calculation.calculatedPenalty || 0)
  };
}

function issueDateOf(issue = {}) {
  return toDate(issue.issueDate || issue.issuedAt || issue.createdAt);
}

function returnDateOf(issue = {}) {
  return toDate(issue.returnDate || issue.returnedAt);
}

function dueDateOfIssue(issue = {}) {
  return calculatePenalty(issue, new Date()).dueDate || toDate(issue.dueDate);
}

function studentNameOf(record = {}) {
  return record.studentName || record.issuedToName || record.name || record.studentEmail || "-";
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

function addCalendarDays(value, days) {
  const date = toDate(value);
  if (!date) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function sameCalendarDay(left, right) {
  const leftDate = toDate(left);
  const rightDate = toDate(right);
  return Boolean(leftDate && rightDate
    && leftDate.getFullYear() === rightDate.getFullYear()
    && leftDate.getMonth() === rightDate.getMonth()
    && leftDate.getDate() === rightDate.getDate());
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

function bookIdentity(item = {}) {
  const book = item.data || item;
  return book.bookId || book.b_id || item.id || accessionOf(book) || normalize(`${titleOfRecord(book)} ${book.author || ""}`);
}

function countBookIssues() {
  const counts = new Map();
  datasets.bookIssues.forEach((item) => {
    const issue = item.data;
    const book = bookForIssue(issue);
    const key = issue.bookId || issue.b_id || datasets.books.find((entry) => entry.data === book)?.id || stableBookKey(issue, book);
    if (key) increment(counts, key);
  });
  return counts;
}

function countBookRequests() {
  const counts = new Map();
  [...datasets.issueRequests, ...datasets.returnRequests].forEach((item) => {
    const request = item.data;
    const book = bookForIssue(request);
    const key = request.bookId || request.b_id || datasets.books.find((entry) => entry.data === book)?.id || stableBookKey(request, book);
    if (key) increment(counts, key);
  });
  return counts;
}

function countStudentIssues() {
  const counts = new Map();
  datasets.bookIssues.forEach((item) => {
    const issue = item.data;
    const student = studentForRecord(issue);
    const key = student.uid || issue.studentUid || issue.userId || issue.studentId || issue.issuedTo;
    if (key) increment(counts, key);
  });
  return counts;
}

function bookAddedDate(book = {}) {
  return toDate(book.createdAt || book.addedAt || book.accessionDate || book.updatedAt);
}

function reportTitle(type, fallback) {
  if (type === "inventory") return "Inventory Report";
  if (type && !["books", "inventory"].includes(type)) return type;
  return fallback;
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

function rowMatchesSearch(row = {}, search = "") {
  const clean = normalize(search);
  if (!clean) return true;
  return Object.values(row).join(" ").toLowerCase().includes(clean);
}

function rowMatchesStatus(row = {}, status = "") {
  const clean = normalize(status);
  if (!clean) return true;
  const values = [
    row.Status,
    row["Payment Status"],
    row["No Dues"],
    row["Clearance Status"]
  ].join(" ").toLowerCase();
  if (clean === "paid") return values.includes("paid") || values.includes("cleared");
  if (clean === "issued") return values.includes("issued") || values.includes("active") || values.includes("borrowed");
  if (clean === "overdue") return values.includes("overdue") || Number(row["Overdue Days"] || row.Overdue || 0) > 0;
  return values.includes(clean);
}

function sortRows(rows = [], sort = {}) {
  if (!sort.column) return rows;
  const direction = sort.direction === "desc" ? -1 : 1;
  return [...rows].sort((left, right) => {
    const leftValue = left[sort.column];
    const rightValue = right[sort.column];
    const leftNumber = numericComparable(leftValue);
    const rightNumber = numericComparable(rightValue);
    if (leftNumber !== null && rightNumber !== null) return (leftNumber - rightNumber) * direction;
    return String(leftValue ?? "").localeCompare(String(rightValue ?? ""), undefined, { numeric: true, sensitivity: "base" }) * direction;
  });
}

function numericComparable(value) {
  const clean = String(value ?? "").replace(/[₹,\s]/g, "");
  if (!clean || Number.isNaN(Number(clean))) return null;
  return Number(clean);
}

function sortGlyph(column) {
  if (currentSort.column !== column) return "";
  return currentSort.direction === "asc" ? " ▲" : " ▼";
}

function buildReportSummary(rows = []) {
  return { totalRows: rows.length };
}

function buildChartData(context) {
  return {
    quickReports: quickReportCounts(context),
    categories: Array.from(context.books.reduce((map, item) => {
      increment(map, categoryOf(item.data));
      return map;
    }, new Map()), ([category, count]) => ({ category, count }))
  };
}

function reportTypeLabel(type) {
  const labels = {
    all: "All Reports",
    books: "Books",
    students: "Students",
    issues: "Issues",
    returns: "Returns",
    issueReturn: "Issue / Return",
    penalties: "Penalties",
    requests: "Requests",
    noDues: "No Dues",
    activity: "Activity",
    inventory: "Inventory",
    statistics: "Statistics"
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
