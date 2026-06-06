import { auth } from "./firebase-config.js";
import {
  $,
  escapeHtml,
  logDetailedError,
  renderEmpty,
  requireAuth,
  setLoading,
  showToast,
  wireSignOut
} from "./app.js";
import {
  addDays,
  createIssueRequest,
  findBookByBarcode,
  getStudentProfile,
  returnBook
} from "./firestore-service.js";

wireSignOut();
const session = await requireAuth(["student", "librarian", "admin"]);
const canReturn = ["librarian", "admin"].includes(session.profile.role);
const issuePanel = $("#issuePanel");
const returnPanel = $("#returnPanel");
const video = $("#scannerVideo");
const startCameraBtn = $("#startCameraBtn");
const stopCameraBtn = $("#stopCameraBtn");
const manualForm = $("#manualBarcodeForm");
const issueDialog = $("#issueDialog");
const issueForm = $("#issueForm");
const returnForm = $("#returnBookForm");
const modeSelect = $("#scanMode");
let mediaStream = null;
let detector = null;
let scanTimer = null;
let currentBook = null;
let currentStudent = null;

modeSelect.value = canReturn ? new URLSearchParams(location.search).get("mode") || "issue" : "issue";
modeSelect.disabled = !canReturn;
returnPanel.hidden = modeSelect.value !== "return";
issuePanel.hidden = modeSelect.value !== "issue";

modeSelect.addEventListener("change", () => {
  returnPanel.hidden = modeSelect.value !== "return";
  issuePanel.hidden = modeSelect.value !== "issue";
});

async function handleBarcode(value) {
  try {
    if (modeSelect.value === "return") {
      $("#returnBookId").value = value.trim();
      showToast("Barcode captured for return.", "success");
      return;
    }

    currentBook = await findBookByBarcode(value);
    renderBookPreview(currentBook);
    openIssueDialog(currentBook);
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
}

function renderBookPreview(book) {
  const target = $("#bookPreview");
  target.innerHTML = `
    <article class="book-preview">
      <img src="${escapeHtml(book.imageUrl || "assets/book-placeholder.svg")}" alt="">
      <div>
        <strong>${escapeHtml(book.title)}</strong>
        <span>${escapeHtml(book.author || "Unknown author")}</span>
        <span>${escapeHtml(book.shelfLocation || "Shelf not set")}</span>
        <span class="badge badge-${escapeHtml(book.status)}">${escapeHtml(book.status)}</span>
      </div>
    </article>`;
}

async function openIssueDialog(book) {
  if (book.status !== "available") {
    showToast("This book is not available for issue.", "error");
    return;
  }

  currentStudent = await getStudentProfile(auth.currentUser.uid);
  if (!currentStudent) throw new Error("Student profile not found.");
  const issueDate = new Date();
  const dueDate = addDays(issueDate, 45);

  $("#requestStudentUid").value = auth.currentUser.uid;
  $("#requestStudentName").value = currentStudent.name || "";
  $("#requestStudentId").value = currentStudent.studentId || "";
  $("#requestBookId").value = book.bookId || book.id;
  $("#requestBookTitle").value = book.title || "";
  $("#dialogBookTitle").textContent = book.title || book.bookId || book.id;
  $("#requestIssueDate").value = issueDate.toISOString().slice(0, 10);
  $("#requestDueDate").value = dueDate.toISOString().slice(0, 10);
  $("#confirmOwnAccount").checked = false;
  $("#issueBookImage").src = book.imageUrl || "assets/book-placeholder.svg";
  issueDialog.showModal();
}

manualForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await handleBarcode($("#manualBarcode").value);
});

issueForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentBook) return;
  if (!$("#confirmOwnAccount").checked) {
    showToast("Please confirm the request before submitting.", "error");
    return;
  }

  setLoading(issueForm, true);
  try {
    const result = await createIssueRequest({
      student: currentStudent,
      book: currentBook
    });
    issueDialog.close();
    showToast(`Issue request submitted: ${result.requestId}`, "success");
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  } finally {
    setLoading(issueForm, false);
  }
});

$(".dialog-close", issueDialog).addEventListener("click", () => issueDialog.close());

returnForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoading(returnForm, true);
  try {
    const data = await returnBook($("#returnBookId").value.trim());
    $("#returnResult").innerHTML = `
      <div class="success-box">
        <strong>Returned successfully</strong>
        <span>Days used: ${data.daysUsed}</span>
        <span>Penalty: Rs.${Number(data.penaltyAmount || 0).toFixed(2)}</span>
      </div>`;
    returnForm.reset();
  } catch (error) {
    logDetailedError(error);
    renderEmpty($("#returnResult"), error.message);
  } finally {
    setLoading(returnForm, false);
  }
});

startCameraBtn.addEventListener("click", async () => {
  try {
    if (!("BarcodeDetector" in window)) {
      showToast("Camera barcode detection is not supported here. Use manual input.", "error");
      return;
    }
    detector = new BarcodeDetector({ formats: ["code_128", "code_39", "ean_13", "qr_code"] });
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = mediaStream;
    video.hidden = false;
    startCameraBtn.hidden = true;
    stopCameraBtn.hidden = false;
    scanTimer = window.setInterval(async () => {
      const codes = await detector.detect(video);
      if (codes.length) {
        await stopCamera();
        await handleBarcode(codes[0].rawValue);
      }
    }, 800);
  } catch (error) {
    logDetailedError(error);
    showToast(error.message, "error");
  }
});

stopCameraBtn.addEventListener("click", stopCamera);

async function stopCamera() {
  window.clearInterval(scanTimer);
  scanTimer = null;
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  video.hidden = true;
  startCameraBtn.hidden = false;
  stopCameraBtn.hidden = true;
}
