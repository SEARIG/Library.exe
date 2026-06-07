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

const EMAILJS_SERVICE_ID = "EMAILJS_SERVICE_ID";
const EMAILJS_TEMPLATE_ID = "EMAILJS_TEMPLATE_ID";
const EMAILJS_PUBLIC_KEY = "EMAILJS_PUBLIC_KEY";
const EMAILJS_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js";

const templates = {
  issued: {
    subject: "Book Issued - MLSU Library",
    message: ({ studentName, bookTitle, dueDate }) => `Hello ${studentName},
Your book ${bookTitle} has been issued successfully.
Return before ${dueDate}.
- MLSU Library`
  },
  returned: {
    subject: "Book Returned - MLSU Library",
    message: ({ studentName, bookTitle, penaltyAmount }) => `Hello ${studentName},
Your book ${bookTitle} has been returned successfully.
Penalty: Rs.${penaltyAmount || 0}.
- MLSU Library`
  },
  reminder15: {
    subject: "Library Book Reminder",
    message: ({ studentName, bookTitle, dueDate }) => `Hello ${studentName},
Your issued book ${bookTitle} is still active.
Please return it before ${dueDate}.
- MLSU Library`
  },
  reminder30: {
    subject: "Library Book Due Soon",
    message: ({ studentName, bookTitle, dueDate }) => `Hello ${studentName},
Your book ${bookTitle} is due soon.
Return before ${dueDate}.
- MLSU Library`
  },
  reminder45: {
    subject: "Library Book Overdue",
    message: ({ studentName, bookTitle }) => `Hello ${studentName},
Your book ${bookTitle} is overdue.
Penalty Rs.5/day is now active.
- MLSU Library`
  }
};

function isConfigured() {
  return ![
    EMAILJS_SERVICE_ID,
    EMAILJS_TEMPLATE_ID,
    EMAILJS_PUBLIC_KEY
  ].some((value) => value.startsWith("EMAILJS_"));
}

function toDate(value) {
  if (!value) return null;
  const date = value.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = toDate(value);
  return date ? date.toLocaleDateString("en-GB") : "";
}

function daysBetween(start, end = new Date()) {
  const startDate = toDate(start);
  if (!startDate) return 0;
  const endDate = new Date(end);
  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((endDate - startDate) / 86400000));
}

function loadEmailJs() {
  if (window.emailjs) return Promise.resolve(window.emailjs);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${EMAILJS_SCRIPT_URL}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(window.emailjs), { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = EMAILJS_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve(window.emailjs);
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

export async function sendEmailNotification(type, payload = {}) {
  const template = templates[type];
  if (!template) {
    throw new Error(`Unknown notification type: ${type}`);
  }

  if (!payload.studentEmail) {
    console.warn("Email notification skipped: missing studentEmail", { type, payload });
    return { skipped: true, reason: "missing-email" };
  }

  const normalizedPayload = {
    studentName: payload.studentName || "Student",
    studentEmail: payload.studentEmail,
    bookTitle: payload.bookTitle || "your book",
    issueDate: formatDate(payload.issueDate) || payload.issueDate || "",
    dueDate: formatDate(payload.dueDate) || payload.dueDate || "",
    returnDate: formatDate(payload.returnDate) || payload.returnDate || "",
    penaltyAmount: payload.penaltyAmount ?? 0
  };

  const subject = template.subject;
  const message = template.message(normalizedPayload);

  if (!isConfigured()) {
    console.warn("EmailJS is not configured. Email notification skipped.", {
      type,
      subject,
      to: normalizedPayload.studentEmail
    });
    return { skipped: true, reason: "emailjs-not-configured" };
  }

  const emailjs = await loadEmailJs();
  emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });

  const result = await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
    to_email: normalizedPayload.studentEmail,
    studentName: normalizedPayload.studentName,
    studentEmail: normalizedPayload.studentEmail,
    bookTitle: normalizedPayload.bookTitle,
    issueDate: normalizedPayload.issueDate,
    dueDate: normalizedPayload.dueDate,
    returnDate: normalizedPayload.returnDate,
    penaltyAmount: normalizedPayload.penaltyAmount,
    subject,
    message
  });

  console.log("Email notification sent:", { type, to: normalizedPayload.studentEmail, result });
  return { sent: true, result };
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
    if (!student?.email) {
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
        const sendResult = await sendEmailNotification(reminder.type, {
          studentName: student.name || issue.studentName || "Student",
          studentEmail: student.email,
          bookTitle: issue.bookTitle || issue.bookId || "your book",
          issueDate: issue.issueDate,
          dueDate: issue.dueDate
        });

        if (sendResult.sent) {
          await updateDoc(doc(db, "bookIssues", issueDoc.id), {
            [reminder.flag]: true,
            [`${reminder.flag}At`]: serverTimestamp()
          });
          result.sent += 1;
          sentForIssue += 1;
        }
      }
    }

    if (!sentForIssue) {
      result.skipped += 1;
    }
  }

  return result;
}
