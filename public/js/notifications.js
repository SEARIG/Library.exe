import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { showToast } from "./toast.js";

const EMAILJS_CONFIG = {
  publicKey: "PASTE_EMAILJS_PUBLIC_KEY_HERE",
  serviceId: "PASTE_EMAILJS_SERVICE_ID_HERE",
  templateId: "PASTE_EMAILJS_TEMPLATE_ID_HERE"
};

export const EMAILJS_SETUP_MESSAGE = "EmailJS is not configured. Add Public Key, Service ID, and Template ID.";

export function isEmailJsConfigured() {
  return Boolean(
    EMAILJS_CONFIG.publicKey
    && EMAILJS_CONFIG.serviceId
    && EMAILJS_CONFIG.templateId
    && !EMAILJS_CONFIG.publicKey.includes("PASTE_")
    && !EMAILJS_CONFIG.serviceId.includes("PASTE_")
    && !EMAILJS_CONFIG.templateId.includes("PASTE_")
  );
}

export function isEmailNotificationsConfigured() {
  return isEmailJsConfigured();
}

function toDate(value) {
  if (!value) return null;
  const date = value.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = toDate(value);
  return date ? date.toLocaleDateString("en-GB") : String(value || "");
}

function daysBetween(start, end = new Date()) {
  const startDate = toDate(start);
  if (!startDate) return 0;
  const endDate = new Date(end);
  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((endDate - startDate) / 86400000));
}

export async function sendEmailNotification(type, payload = {}) {
  console.log("EmailJS config valid:", isEmailJsConfigured());

  if (!window.emailjs) {
    const error = new Error("EmailJS SDK not loaded.");
    console.error("EmailJS error:", error);
    throw error;
  }

  if (!isEmailJsConfigured()) {
    showToast(EMAILJS_SETUP_MESSAGE, "warning");
    const error = new Error("EmailJS is not configured.");
    console.error("EmailJS error:", error);
    throw error;
  }

  const params = {
    notification_type: type,
    student_name: payload.studentName || "Student",
    student_email: payload.studentEmail || payload.email || "",
    book_title: payload.bookTitle || payload.book || "",
    issue_date: formatDate(payload.issueDate),
    due_date: formatDate(payload.dueDate),
    return_date: formatDate(payload.returnDate),
    penalty_amount: payload.penaltyAmount || 0
  };

  console.log("Sending EmailJS params:", params);

  try {
    window.emailjs.init({
      publicKey: EMAILJS_CONFIG.publicKey
    });

    const result = await window.emailjs.send(
      EMAILJS_CONFIG.serviceId,
      EMAILJS_CONFIG.templateId,
      params
    );

    return { sent: true, result };
  } catch (error) {
    console.error("EmailJS error:", error);
    throw error;
  }
}

async function getStudent(uid) {
  if (!uid) return null;
  const snap = await getDoc(doc(db, "students", uid));
  return snap.exists() ? snap.data() : null;
}

export async function runReminderCheck() {
  const issuesSnap = await getDocs(query(collection(db, "bookIssues"), where("status", "==", "issued")));
  const result = {
    checked: issuesSnap.size,
    sent: 0,
    skipped: 0
  };

  for (const issueDoc of issuesSnap.docs) {
    const issue = issueDoc.data();
    const student = await getStudent(issue.studentUid);
    const studentEmail = issue.studentEmail || student?.email || "";
    if (!studentEmail) {
      result.skipped += 1;
      continue;
    }

    const daysPassed = daysBetween(issue.issueDate);
    let sentForIssue = 0;
    const reminders = [
      { day: 15, flag: "reminder15Sent", type: "reminder15" },
      { day: 30, flag: "reminder30Sent", type: "reminder30" },
      { day: 45, flag: "reminder45Sent", type: "reminder45" }
    ];

    for (const reminder of reminders) {
      if (daysPassed >= reminder.day && issue[reminder.flag] !== true) {
        await sendEmailNotification(reminder.type, {
          studentName: issue.studentName || student?.name || "Student",
          studentEmail,
          bookTitle: issue.bookTitle || issue.bookId || "your book",
          issueDate: issue.issueDate,
          dueDate: issue.dueDate
        });

        await updateDoc(doc(db, "bookIssues", issueDoc.id), {
          [reminder.flag]: true,
          [`${reminder.flag}At`]: serverTimestamp()
        });
        result.sent += 1;
        sentForIssue += 1;
      }
    }

    if (!sentForIssue) {
      result.skipped += 1;
    }
  }

  return result;
}
