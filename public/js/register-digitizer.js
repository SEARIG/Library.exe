import { app, db } from "./firebase-config.js";
import {
  $,
  confirmAction,
  escapeHtml,
  renderEmpty,
  requireAuth,
  showToast
} from "./app.js";
import {
  collection,
  doc,
  getDocs,
  limit,
  query,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";
import {
  REGISTER_EXPORT_HEADERS,
  REGISTER_FIELD_LABELS,
  REGISTER_FIELDS,
  createEmptyRegisterRow,
  createMockOcrResult,
  digitizedRowToExportRow,
  digitizedRowsToMatrix,
  parseOcrLikeRows,
  resolveDittoValues,
  rowsReadyForImport,
  summarizeDigitizedRows,
  validateDigitizedRows
} from "./register-digitizer.mjs?v=2";
import {
  accessionBookData,
  parseAccessionRegister
} from "./accession-register.mjs";

const session = await requireAuth(["admin", "librarian"]);
const functions = getFunctions(app);
const extractRegisterOcr = httpsCallable(functions, "extractRegisterOcr");

let digitizerFiles = [];
let digitizerRows = [];
let zoom = 1;
let searchText = "";
let statusFilter = "all";

const fileInput = $("#digitizerFileInput");
const dropzone = $("#digitizerDropzone");

$("#chooseDigitizerFilesBtn")?.addEventListener("click", () => fileInput.click());
fileInput?.addEventListener("change", () => addFiles([...fileInput.files]));
$("#clearDigitizerFilesBtn")?.addEventListener("click", () => {
  digitizerFiles.forEach((item) => item.objectUrl && URL.revokeObjectURL(item.objectUrl));
  digitizerFiles = [];
  digitizerRows = [];
  fileInput.value = "";
  searchText = "";
  statusFilter = "all";
  if ($("#digitizerSearchInput")) $("#digitizerSearchInput").value = "";
  if ($("#digitizerStatusFilter")) $("#digitizerStatusFilter").value = "all";
  $("#digitizerConfigMessage").textContent = "OCR provider status will appear here.";
  $("#digitizerImportProgress").textContent = "No import started.";
  renderFiles();
  renderRows();
});
$("#startDigitizerExtractionBtn")?.addEventListener("click", () => startExtraction().catch(handleError));
$("#validateDigitizerRowsBtn")?.addEventListener("click", () => validateRowsFromGrid().catch(handleError));
$("#exportDigitizerExcelBtn")?.addEventListener("click", () => exportReviewedExcel().catch(handleError));
$("#importDigitizerRowsBtn")?.addEventListener("click", () => importReviewedRows().catch(handleError));
$("#downloadDigitizerTemplateBtn")?.addEventListener("click", () => downloadSampleTemplate().catch(handleError));
$("#addDigitizerRowBtn")?.addEventListener("click", () => addManualRow());
$("#digitizerSearchInput")?.addEventListener("input", (event) => {
  persistVisibleGridEdits();
  searchText = event.target.value.trim().toLowerCase();
  renderRows();
});
$("#digitizerStatusFilter")?.addEventListener("change", (event) => {
  persistVisibleGridEdits();
  statusFilter = event.target.value;
  renderRows();
});
$("#zoomInDigitizerBtn")?.addEventListener("click", () => {
  zoom = Math.min(2, zoom + 0.1);
  renderPreview();
});
$("#zoomOutDigitizerBtn")?.addEventListener("click", () => {
  zoom = Math.max(0.5, zoom - 0.1);
  renderPreview();
});

dropzone?.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("drag-over");
});
dropzone?.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
dropzone?.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("drag-over");
  addFiles([...event.dataTransfer.files]);
});
dropzone?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") fileInput.click();
});

function addFiles(files = []) {
  const accepted = files.filter((file) => /(\.jpe?g|\.png|\.pdf)$/i.test(file.name) || ["image/jpeg", "image/png", "application/pdf"].includes(file.type));
  const startIndex = digitizerFiles.length;
  digitizerFiles.push(...accepted.map((file, index) => ({
    id: `page-${Date.now()}-${startIndex + index}`,
    file,
    name: file.name,
    type: file.type || "",
    size: file.size || 0,
    rotation: 0,
    objectUrl: URL.createObjectURL(file)
  })));
  if (accepted.length !== files.length) showToast("Unsupported files skipped. Use JPG, JPEG, PNG, or PDF.", "warning");
  renderFiles();
}

function fileToPayload(item, pageNumber) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      resolve({
        name: item.name,
        type: item.type || (item.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream"),
        size: item.size,
        pageNumber,
        rotation: item.rotation,
        dataUrl,
        base64: dataUrl.includes(",") ? dataUrl.split(",").pop() : dataUrl
      });
    };
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${item.name}`));
    reader.readAsDataURL(item.file);
  });
}

function renderFiles() {
  const target = $("#digitizerPageList");
  if (!target) return;
  if (!digitizerFiles.length) {
    renderEmpty(target, "No pages selected.");
    renderPreview();
    return;
  }
  target.innerHTML = digitizerFiles.map((item, index) => `
    <article class="digitizer-page-card" data-page-id="${escapeHtml(item.id)}">
      <div class="digitizer-thumb">${item.type === "application/pdf" || item.name.toLowerCase().endsWith(".pdf")
        ? `<span>PDF</span>`
        : `<img src="${escapeHtml(item.objectUrl)}" alt="">`}</div>
      <div>
        <strong>Page ${index + 1}</strong>
        <span>${escapeHtml(item.name)}</span>
        <small>Rotation: ${item.rotation}°</small>
      </div>
      <div class="row-actions">
        <button class="btn btn-muted" data-page-action="up" type="button" ${index === 0 ? "disabled" : ""}>↑</button>
        <button class="btn btn-muted" data-page-action="down" type="button" ${index === digitizerFiles.length - 1 ? "disabled" : ""}>↓</button>
        <button class="btn btn-muted" data-page-action="rotate" type="button">Rotate</button>
        <button class="btn btn-danger" data-page-action="remove" type="button">Remove</button>
      </div>
    </article>`).join("");
  target.querySelectorAll("[data-page-action]").forEach((button) => {
    button.addEventListener("click", () => updatePage(button.closest("[data-page-id]").dataset.pageId, button.dataset.pageAction));
  });
  renderPreview();
}

function updatePage(id, action) {
  const index = digitizerFiles.findIndex((item) => item.id === id);
  if (index < 0) return;
  if (action === "remove") {
    if (digitizerFiles[index].objectUrl) URL.revokeObjectURL(digitizerFiles[index].objectUrl);
    digitizerFiles.splice(index, 1);
  }
  if (action === "rotate") digitizerFiles[index].rotation = (digitizerFiles[index].rotation + 90) % 360;
  if (action === "up" && index > 0) [digitizerFiles[index - 1], digitizerFiles[index]] = [digitizerFiles[index], digitizerFiles[index - 1]];
  if (action === "down" && index < digitizerFiles.length - 1) [digitizerFiles[index + 1], digitizerFiles[index]] = [digitizerFiles[index], digitizerFiles[index + 1]];
  renderFiles();
}

function renderPreview() {
  const target = $("#digitizerPreview");
  if (!target) return;
  if (!digitizerFiles.length) {
    target.textContent = "Upload pages to preview them here.";
    return;
  }
  target.innerHTML = digitizerFiles.map((item, index) => `
    <div class="digitizer-preview-page" style="transform:scale(${zoom}); transform-origin: top left;">
      ${item.type === "application/pdf" || item.name.toLowerCase().endsWith(".pdf")
        ? `<embed class="digitizer-pdf-preview" src="${escapeHtml(item.objectUrl)}" type="application/pdf" aria-label="PDF preview for ${escapeHtml(item.name)}">`
        : `<img src="${escapeHtml(item.objectUrl)}" alt="Page ${index + 1}" style="rotate:${item.rotation}deg">`}
    </div>`).join("");
}

async function existingAccessionSet() {
  const snap = await getDocs(query(collection(db, "books"), limit(10000)));
  return new Set(snap.docs
    .map((item) => String(item.data().accessionNumber || item.data().blegal_num || item.data().b_id || "").trim().toLowerCase())
    .filter(Boolean));
}

async function startExtraction() {
  if (!digitizerFiles.length) throw new Error("Choose register images or PDFs first.");
  $("#digitizerConfigMessage").innerHTML = `<div class="empty">Extracting rows...</div>`;
  const filePayload = await Promise.all(digitizerFiles.map((item, index) => fileToPayload(item, index + 1)));
  let result;
  try {
    result = (await extractRegisterOcr({ files: filePayload })).data;
  } catch (error) {
    console.warn("Backend OCR unavailable; using deterministic mock provider.", error);
    result = createMockOcrResult(filePayload);
  }
  const existing = await existingAccessionSet();
  const parsedRows = parseOcrLikeRows(result.rows || []);
  const resolvedRows = resolveDittoValues(parsedRows);
  digitizerRows = validateDigitizedRows(resolvedRows, existing);
  const dittoCount = digitizerRows.reduce((total, row) => total + (row.dittoResolvedFields?.length || 0), 0);
  $("#digitizerConfigMessage").innerHTML = `
    <div class="${result.configured ? "success-box" : "empty"}">
      <strong>Provider: ${escapeHtml(result.provider || "mock")}</strong>
      <span>${escapeHtml(result.message || "")}</span>
      <span>Pages processed: ${Number(result.pages || digitizerFiles.length)} · Rows: ${digitizerRows.length} · Ditto cells resolved: ${dittoCount}</span>
    </div>`;
  renderRows();
}

async function validateRowsFromGrid() {
  digitizerRows = readRowsFromGrid();
  digitizerRows = validateDigitizedRows(digitizerRows, await existingAccessionSet());
  renderRows();
  showToast("Rows validated.", "success");
}

function renderRows() {
  renderSummary();
  const target = $("#digitizerReviewGrid");
  if (!target) return;
  if (!digitizerRows.length) {
    if ($("#digitizerVisibleCount")) $("#digitizerVisibleCount").textContent = "Showing 0 of 0 rows";
    renderEmpty(target, "Run extraction to review structured rows.");
    return;
  }
  const visibleRows = digitizerRows
    .map((row, rowIndex) => ({ row, rowIndex }))
    .filter(({ row }) => statusFilter === "all" || row.status === statusFilter)
    .filter(({ row }) => !searchText || REGISTER_FIELDS.some((field) => String(row[field] || "").toLowerCase().includes(searchText)));
  $("#digitizerVisibleCount").textContent = `Showing ${visibleRows.length} of ${digitizerRows.length} rows`;
  if (!visibleRows.length) {
    renderEmpty(target, "No rows match the current search and status filter.");
    return;
  }
  target.innerHTML = `
    <table class="digitizer-table">
      <thead>
        <tr>
          <th>Status</th><th>Confidence</th><th>Page</th><th>Side</th><th>Row</th>
          ${REGISTER_FIELDS.map((field) => `<th>${escapeHtml(REGISTER_FIELD_LABELS[field])}</th>`).join("")}
          <th>Validation</th><th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${visibleRows.map(({ row, rowIndex }) => `
          <tr class="digitizer-row status-${row.status.toLowerCase().replace(/\s+/g, "-")} confidence-${row.confidenceStatus}">
            <td><span class="digitizer-status-badge">${escapeHtml(row.status)}</span></td>
            <td>${Number(row.confidence || 0)}%</td>
            <td>${escapeHtml(row.pageNumber || "")}</td>
            <td>${escapeHtml(row.pageSide || "")}</td>
            <td>${escapeHtml(row.rowNumber || "")}</td>
            ${REGISTER_FIELDS.map((field) => `<td><input data-row-index="${rowIndex}" data-field="${field}" value="${escapeHtml(row[field] || "")}" aria-label="${escapeHtml(REGISTER_FIELD_LABELS[field])} row ${rowIndex + 1}"></td>`).join("")}
            <td><span class="digitizer-validation-text">${escapeHtml((row.errors || []).join("; ") || "Valid")}</span></td>
            <td><button class="btn btn-danger digitizer-delete-row" data-delete-row="${rowIndex}" type="button">Delete</button></td>
          </tr>`).join("")}
      </tbody>
    </table>`;
  target.querySelectorAll("[data-row-index][data-field]").forEach((input) => {
    input.addEventListener("input", () => {
      digitizerRows[Number(input.dataset.rowIndex)][input.dataset.field] = input.value;
      digitizerRows[Number(input.dataset.rowIndex)].origin = "reviewed";
    });
  });
  target.querySelectorAll("[data-delete-row]").forEach((button) => {
    button.addEventListener("click", () => {
      digitizerRows.splice(Number(button.dataset.deleteRow), 1);
      renderRows();
      showToast("Row deleted from this review session.", "success");
    });
  });
}

function renderSummary() {
  const summary = summarizeDigitizedRows(digitizerRows);
  $("#digitizerSummary").innerHTML = `
    <span class="metric">Total <strong>${summary.total}</strong></span>
    <span class="metric metric-ready">Ready <strong>${summary.ready}</strong></span>
    <span class="metric metric-review">Needs Review <strong>${summary.needsReview}</strong></span>
    <span class="metric metric-duplicate">Duplicates <strong>${summary.duplicates}</strong></span>
    <span class="metric metric-invalid">Invalid <strong>${summary.invalid}</strong></span>`;
}

function readRowsFromGrid() {
  persistVisibleGridEdits();
  return digitizerRows.map((row) => ({ ...row }));
}

function persistVisibleGridEdits() {
  document.querySelectorAll("#digitizerReviewGrid [data-row-index][data-field]").forEach((input) => {
    const row = digitizerRows[Number(input.dataset.rowIndex)];
    if (row) row[input.dataset.field] = input.value;
  });
}

function addManualRow() {
  persistVisibleGridEdits();
  digitizerRows.push(createEmptyRegisterRow({
    id: `manual-row-${Date.now()}`,
    pageNumber: "",
    pageSide: "",
    rowNumber: digitizerRows.length + 1,
    confidence: 100,
    confidenceStatus: "high",
    origin: "manual",
    status: "Invalid",
    errors: ["missing accession number", "missing title", "missing author"],
    rawText: ""
  }));
  searchText = "";
  statusFilter = "all";
  if ($("#digitizerSearchInput")) $("#digitizerSearchInput").value = "";
  if ($("#digitizerStatusFilter")) $("#digitizerStatusFilter").value = "all";
  renderRows();
}

async function validatedRowsForOutput() {
  digitizerRows = validateDigitizedRows(readRowsFromGrid(), await existingAccessionSet());
  renderRows();
  const blocked = digitizerRows.filter((row) => row.status !== "Ready");
  if (blocked.length) throw new Error(`Resolve ${blocked.length} row(s) marked Needs Review, Duplicate, or Invalid before export/import.`);
  return digitizerRows;
}

async function exportReviewedExcel() {
  const rows = await validatedRowsForOutput();
  if (!digitizerRows.length) throw new Error("No reviewed rows to export.");
  const sheetRows = rows.map(digitizedRowToExportRow);
  const sheet = window.XLSX.utils.json_to_sheet(sheetRows, { header: REGISTER_EXPORT_HEADERS });
  sheet["!cols"] = REGISTER_EXPORT_HEADERS.map(() => ({ wch: 20 }));
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, sheet, "Register Data");
  window.XLSX.writeFile(workbook, `mlsu-reviewed-register-${new Date().toISOString().slice(0, 10)}.xlsx`);
  showToast("Reviewed Excel exported.", "success");
}

async function downloadSampleTemplate() {
  const sample = [digitizedRowToExportRow(createEmptyRegisterRow({
    accessionNumber: "0001", author: "Author name", title: "Book title", placePublisher: "Place: Publisher",
    year: "2026", pages: "250", source: "Purchase", billNoDate: "B-001 / 01-01-2026", cost: "500",
    classNo: "000", bookNo: "AUT", callNo: "000 AUT", remarks: ""
  }))];
  const sheet = window.XLSX.utils.json_to_sheet(sample, { header: REGISTER_EXPORT_HEADERS });
  sheet["!cols"] = REGISTER_EXPORT_HEADERS.map(() => ({ wch: 20 }));
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, sheet, "Accession Register");
  window.XLSX.writeFile(workbook, "mlsu-accession-register-digitizer-template.xlsx");
  showToast("Sample template downloaded.", "success");
}

async function importReviewedRows() {
  const validatedRows = await validatedRowsForOutput();
  const readyRows = rowsReadyForImport(validatedRows);
  if (!readyRows.length) throw new Error("No Ready rows available for import.");
  const confirmed = await confirmAction(`Import ${readyRows.length} ready rows into LMS in safe chunks?`);
  if (!confirmed) return;

  const parsed = parseAccessionRegister(digitizedRowsToMatrix(readyRows), await existingBookMap(), false);
  const sourceByAccession = new Map(readyRows.map((row) => [String(row.accessionNumber).trim().toLowerCase(), row]));
  const validRows = parsed.rows.filter((row) => !row.errors.length).map((row) => ({
    ...row,
    callNo: sourceByAccession.get(String(row.accessionNumber).trim().toLowerCase())?.callNo || "",
    remarks: sourceByAccession.get(String(row.accessionNumber).trim().toLowerCase())?.remarks || row.withdrawalRemarks || ""
  }));
  const failedRows = parsed.rows.filter((row) => row.errors.length);
  const chunkSize = 50;
  let imported = 0;
  let failed = failedRows.length;
  let duplicates = parsed.rows.filter((row) => row.duplicateType).length;
  const importBatchId = `digitizer_${Date.now()}`;
  for (let index = 0; index < validRows.length; index += chunkSize) {
    const chunk = validRows.slice(index, index + chunkSize);
    $("#digitizerImportProgress").innerHTML = `<div class="empty">Importing ${imported}/${validRows.length}...</div>`;
    for (const row of chunk) {
      try {
        await createBookFromRegisterRow(row, importBatchId);
        imported += 1;
      } catch (error) {
        console.error("Digitizer row import failed", { row, error });
        failed += 1;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  $("#digitizerImportProgress").innerHTML = `
    <div class="${failed ? "empty" : "success-box"}">
      <strong>Import summary</strong>
      <span>Imported: ${imported}</span>
      <span>Skipped: ${readyRows.length - validRows.length}</span>
      <span>Duplicates: ${duplicates}</span>
      <span>Failed: ${failed}</span>
      <span>Batch: ${escapeHtml(importBatchId)}</span>
    </div>`;
}

async function existingBookMap() {
  const snap = await getDocs(query(collection(db, "books"), limit(10000)));
  return new Map(snap.docs
    .map((item) => [String(item.data().accessionNumber || item.data().blegal_num || item.data().b_id || "").trim().toLowerCase(), { id: item.id, data: item.data() }])
    .filter(([accession]) => accession));
}

async function createBookFromRegisterRow(row, importBatchId) {
  const registerData = accessionBookData(row);
  await runTransaction(db, async (transaction) => {
    const counterRef = doc(db, "counters", "books");
    const counterSnap = await transaction.get(counterRef);
    const bId = String((counterSnap.exists() ? Number(counterSnap.data().lastId || 0) : 0) + 1);
    const bookRef = doc(db, "books", bId);
    transaction.set(bookRef, {
      ...registerData,
      callNo: String(row.callNo || "").trim(),
      remarks: String(row.remarks || row.withdrawalRemarks || "").trim(),
      b_id: bId,
      bname: registerData.title,
      publisher: registerData.placePublisher,
      metadataSource: "register_digitizer_review",
      importBatchId,
      status: "available",
      barcodePrinted: false,
      issuedStudentUid: null,
      issuedTo: null,
      issuedToName: null,
      issuedToEmail: null,
      currentIssueId: null,
      createdBy: session.user.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    transaction.set(counterRef, { lastId: Number(bId) }, { merge: true });
  });
}

function handleError(error) {
  console.error("Register digitizer error:", error);
  showToast(`${error.code || "error"}: ${error.message}`, "error");
}

renderFiles();
renderRows();
