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
  createMockOcrResult,
  digitizedRowToExportRow,
  digitizedRowsToMatrix,
  rowsReadyForImport,
  summarizeDigitizedRows,
  validateDigitizedRows
} from "./register-digitizer.mjs";
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

const fileInput = $("#digitizerFileInput");
const dropzone = $("#digitizerDropzone");

$("#chooseDigitizerFilesBtn")?.addEventListener("click", () => fileInput.click());
fileInput?.addEventListener("change", () => addFiles([...fileInput.files]));
$("#clearDigitizerFilesBtn")?.addEventListener("click", () => {
  digitizerFiles = [];
  digitizerRows = [];
  renderFiles();
  renderRows();
});
$("#startDigitizerExtractionBtn")?.addEventListener("click", () => startExtraction().catch(handleError));
$("#validateDigitizerRowsBtn")?.addEventListener("click", () => validateRowsFromGrid().catch(handleError));
$("#exportDigitizerExcelBtn")?.addEventListener("click", () => exportReviewedExcel());
$("#importDigitizerRowsBtn")?.addEventListener("click", () => importReviewedRows().catch(handleError));
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
    objectUrl: file.type?.startsWith("image/") ? URL.createObjectURL(file) : ""
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
      <div class="digitizer-thumb">${item.objectUrl
        ? `<img src="${escapeHtml(item.objectUrl)}" alt="">`
        : `<span>PDF</span>`}</div>
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
  if (action === "remove") digitizerFiles.splice(index, 1);
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
      ${item.objectUrl
        ? `<img src="${escapeHtml(item.objectUrl)}" alt="Page ${index + 1}" style="rotate:${item.rotation}deg">`
        : `<div class="pdf-preview-box">PDF page placeholder<br>${escapeHtml(item.name)}<br>Rotation ${item.rotation}°</div>`}
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
  digitizerRows = validateDigitizedRows(result.rows || [], existing);
  $("#digitizerConfigMessage").innerHTML = `
    <div class="${result.configured ? "success-box" : "empty"}">
      <strong>Provider: ${escapeHtml(result.provider || "mock")}</strong>
      <span>${escapeHtml(result.message || "")}</span>
      <span>Pages processed: ${Number(result.pages || digitizerFiles.length)}</span>
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
    renderEmpty(target, "Run extraction to review structured rows.");
    return;
  }
  const fields = [
    "accessionNumber", "accessionDate", "author", "title", "placePublisher", "year", "pages", "volume",
    "source", "billNoDate", "cost", "classNo", "bookNo", "withdrawalRemarks", "imageUrl", "notes"
  ];
  target.innerHTML = `
    <table class="digitizer-table">
      <thead>
        <tr>
          <th>Status</th><th>Confidence</th><th>Page</th><th>Row</th>
          ${fields.map((field) => `<th>${escapeHtml(field)}</th>`).join("")}
          <th>Errors</th>
        </tr>
      </thead>
      <tbody>
        ${digitizerRows.map((row, rowIndex) => `
          <tr class="digitizer-row status-${row.status.toLowerCase().replace(/\s+/g, "-")} confidence-${row.confidenceStatus}">
            <td>${escapeHtml(row.status)}</td>
            <td>${Number(row.confidence || 0)}%</td>
            <td>${escapeHtml(row.pageNumber || "")}</td>
            <td>${escapeHtml(row.rowNumber || "")}</td>
            ${fields.map((field) => `<td><input data-row-index="${rowIndex}" data-field="${field}" value="${escapeHtml(row[field] || "")}"></td>`).join("")}
            <td>${escapeHtml((row.errors || []).join("; "))}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

function renderSummary() {
  const summary = summarizeDigitizedRows(digitizerRows);
  $("#digitizerSummary").innerHTML = `
    <span>Total: <strong>${summary.total}</strong></span>
    <span>Ready: <strong>${summary.ready}</strong></span>
    <span>Needs Review: <strong>${summary.needsReview}</strong></span>
    <span>Duplicates: <strong>${summary.duplicates}</strong></span>
    <span>Invalid: <strong>${summary.invalid}</strong></span>`;
}

function readRowsFromGrid() {
  if (!digitizerRows.length) return [];
  const rows = digitizerRows.map((row) => ({ ...row }));
  document.querySelectorAll("#digitizerReviewGrid [data-row-index][data-field]").forEach((input) => {
    rows[Number(input.dataset.rowIndex)][input.dataset.field] = input.value;
  });
  return rows;
}

function exportReviewedExcel() {
  digitizerRows = readRowsFromGrid();
  if (!digitizerRows.length) throw new Error("No reviewed rows to export.");
  const sheetRows = digitizerRows.map(digitizedRowToExportRow);
  const sheet = window.XLSX.utils.json_to_sheet(sheetRows, { header: REGISTER_EXPORT_HEADERS });
  sheet["!cols"] = REGISTER_EXPORT_HEADERS.map(() => ({ wch: 20 }));
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, sheet, "Register Data");
  window.XLSX.writeFile(workbook, `mlsu-reviewed-register-${new Date().toISOString().slice(0, 10)}.xlsx`);
  showToast("Reviewed Excel exported.", "success");
}

async function importReviewedRows() {
  digitizerRows = validateDigitizedRows(readRowsFromGrid(), await existingAccessionSet());
  renderRows();
  const readyRows = rowsReadyForImport(digitizerRows);
  if (!readyRows.length) throw new Error("No Ready rows available for import.");
  const confirmed = await confirmAction(`Import ${readyRows.length} ready rows into LMS in safe chunks?`);
  if (!confirmed) return;

  const parsed = parseAccessionRegister(digitizedRowsToMatrix(readyRows), await existingBookMap(), false);
  const validRows = parsed.rows.filter((row) => !row.errors.length);
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
