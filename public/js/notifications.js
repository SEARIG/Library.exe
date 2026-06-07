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
  publicKey: "otUu_kwRgzrvjTdRJ",
  serviceId: "service_mlsu123",
  templateId: "template_592zvwg"
};

export const EMAILJS_SETUP_MESSAGE = "EmailJS is not configured. Add Public Key, Service ID, and Template ID.";
let emailJsInitialized = false;

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

function initializeEmailJs() {
  if (emailJsInitialized) return;
  window.emailjs.init({
    publicKey: EMAILJS_CONFIG.publicKey
  });
  emailJsInitialized = true;
  console.log("EmailJS initialized");
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
  console.log("Sending email:", payload);

  if (!window.emailjs) {
    const error = new Error("EmailJS SDK not loaded.");
    console.error("EmailJS failed:", error);
    throw error;
  }

  if (!isEmailJsConfigured()) {
    showToast(EMAILJS_SETUP_MESSAGE, "warning");
    const error = new Error("EmailJS is not configured.");
    console.error("EmailJS failed:", error);
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
    initializeEmailJs();

    const result = await window.emailjs.send(
      EMAILJS_CONFIG.serviceId,
      EMAILJS_CONFIG.templateId,
      params
    );

    console.log("Email sent successfully");
    return { sent: true, result };
  } catch (error) {
    console.error("EmailJS failed:", error);
    throw error;
  }
}

async function getStudent(uid) {
  if (!uid) return null;
  const snap = await getDoc(doc(db, "students", uid));
  return snap.exists() ? snap.data() : null;
}

export async function runReminderCheck() {
  try {
    const response = await fetch("/api/reminder-check", {
      method: "GET",
      headers: { "Accept": "application/json" }
    });

    if (response.ok) {
      return response.json();
    }
    console.warn("Backend reminder endpoint failed, using browser fallback.", await response.text());
  } catch (error) {
    console.warn("Backend reminder endpoint unavailable, using browser fallback.", error);
  }

  const issuesSnap = await getDocs(query(collection(db, "bookIssues"), where("status", "==", "issued")));
  const result = {
    checked: issuesSnap.size,
    sent: 0,
    skipped: 0,
    overdue: 0
  };

  for (const issueDoc of issuesSnap.docs) {
    const issue = issueDoc.data();
    const student = await getStudent(issue.studentUid);
    const studentEmail = issue.studentEmail || student?.email || "";
    if (!studentEmail) {
      result.skipped += 1;
      continue;
    }

    const dueDate = toDate(issue.dueDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (dueDate && dueDate < today) result.overdue += 1;
    let sentForIssue = 0;
    const reminders = [
      { daysLeft: 15, flag: "reminder15DaysLeftSent" },
      { daysLeft: 7, flag: "reminder7DaysLeftSent" },
      { daysLeft: 3, flag: "reminder3DaysLeftSent" },
      { daysLeft: 1, flag: "reminder1DayLeftSent" },
      { daysLeft: -1, flag: "overdueReminderSent" }
    ];

    for (const reminder of reminders) {
      const daysRemaining = dueDate ? Math.ceil((dueDate - today) / 86400000) : null;
      const shouldSend = reminder.daysLeft === -1
        ? daysRemaining !== null && daysRemaining < 0
        : daysRemaining === reminder.daysLeft;
      if (shouldSend && issue[reminder.flag] !== true) {
        await sendEmailNotification("Book Return Reminder", {
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
