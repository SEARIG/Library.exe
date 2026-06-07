import { auth, db } from "./firebase-config.js";
import {
  $,
  confirmAction,
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
import { sendEmailNotification } from "./notifications.js";
import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

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
    const scannedValue = String(value || "").trim().replace(/\s+/g, "");
    console.log("Scanned barcode value:", scannedValue);
    if (modeSelect.value === "return") {
      $("#returnBookId").value = scannedValue;
      showToast("Barcode captured for return.", "success");
      return;
    }

    currentBook = await findBookByBarcode(scannedValue);
    renderBookPreview(currentBook);
    await openIssueDialog(currentBook);
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
        <strong>${escapeHtml(book.bname || book.title || book.id)}</strong>
        <span>B_ID: ${escapeHtml(book.b_id || book.id)}</span>
        <span>${escapeHtml(book.subject || "Subject not set")} | ${escapeHtml(book.category || "Uncategorized")}</span>
        <span>${escapeHtml(book.barcodeValue || "")}</span>
        <span class="badge badge-${escapeHtml(book.status)}">${escapeHtml(book.status)}</span>
      </div>
    </article>`;
}

async function openIssueDialog(book) {
  if (book.status !== "available") {
    showToast("This book is not available.", "error");
    return;
  }

  currentStudent = await getStudentProfile(auth.currentUser.uid);
  if (!currentStudent) throw new Error("Student profile not found.");
  const issueDate = new Date();
  const dueDate = addDays(issueDate, 45);

  $("#requestStudentUid").value = shortUid(auth.currentUser.uid);
  $("#requestStudentName").value = currentStudent.name || "";
  $("#requestRollNumber").value = currentStudent.rollNumber || "";
  $("#requestBookId").value = book.b_id || "";
  $("#requestBookTitle").value = book.bname || "";
  $("#requestSubject").value = book.subject || "";
  $("#requestCategory").value = book.category || "";
  $("#requestBLegalNum").value = book.blegal_num || "";
  $("#requestBarcodeValue").value = book.barcodeValue || "";
  $("#dialogBookTitle").textContent = book.bname || book.b_id || book.id;
  $("#requestIssueDate").value = issueDate.toISOString().slice(0, 10);
  $("#requestDueDate").value = dueDate.toISOString().slice(0, 10);
  $("#confirmOwnAccount").checked = false;
  $("#issueBookImage").src = book.imageUrl || "assets/book-placeholder.svg";
  issueDialog.showModal();
}

function shortUid(uid = "") {
  if (uid.length <= 18) return uid;
  return `${uid.slice(0, 8)}...${uid.slice(-6)}`;
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
    showToast("Book issue request sent successfully.", "success");
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
  const confirmed = await confirmAction("Confirm book return?");
  if (!confirmed) return;
  setLoading(returnForm, true);
  try {
    const data = await returnBook($("#returnBookId").value.trim());
    if (data.studentUid) {
      const studentSnap = await getDoc(doc(db, "students", data.studentUid));
      const student = studentSnap.exists() ? studentSnap.data() : {};
      try {
        const returnPayload = {
          studentName: student.name || data.studentName || "Student",
          studentEmail: data.studentEmail || student.email || "",
          bookTitle: data.bookTitle,
          issueDate: data.issueDate,
          dueDate: data.dueDate,
          returnDate: data.returnDate,
          penaltyAmount: data.penaltyAmount
        };
        await sendEmailNotification("Book Returned", returnPayload);
        if (Number(data.penaltyAmount || 0) > 0) {
          await sendEmailNotification("Penalty Notice", returnPayload);
        }
        showToast("Return processed. Email sent.", "success");
      } catch (error) {
        console.error("Return email notification failed:", error);
        showToast("Return processed but email failed.", "warning");
      }
    }
    $("#returnResult").innerHTML = `
      <div class="success-box">
        <strong>Book returned successfully.</strong>
        <span>Days used: ${data.daysUsed}</span>
        <span>Penalty: ₹${Number(data.penaltyAmount || 0).toFixed(2)}</span>
      </div>`;
    showToast(data.penaltyAmount > 0
      ? `Book returned with ₹${Number(data.penaltyAmount).toFixed(2)} penalty.`
      : "Book returned with no penalty.", "success");
    returnForm.reset();
  } catch (error) {
    console.error("Return scan failed full error:", error);
    console.error("Return scan failed code:", error.code);
    console.error("Return scan failed message:", error.message);
    renderEmpty($("#returnResult"), `${error.code || "error"}: ${error.message}`);
    showToast(`${error.code || "error"}: ${error.message}`, "error");
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
