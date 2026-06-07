const admin = require("firebase-admin");

const EMAILJS_CONFIG = {
  publicKey: "otUu_kwRgzrvjTdRJ",
  serviceId: "service_mlsu123",
  templateId: "template_592zvwg"
};

function initAdmin() {
  if (admin.apps.length) return;

  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey) {
    throw new Error("Firebase Admin environment variables are missing.");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey
    })
  });
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = toDate(value);
  return date ? date.toLocaleDateString("en-GB") : String(value || "");
}

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function daysRemaining(dueDate) {
  const due = toDate(dueDate);
  if (!due) return null;
  due.setHours(0, 0, 0, 0);
  return Math.ceil((due - startOfToday()) / 86400000);
}

async function sendEmail(type, payload) {
  const params = {
    notification_type: type,
    student_name: payload.studentName || "Student",
    student_email: payload.studentEmail || "",
    book_title: payload.bookTitle || "",
    issue_date: formatDate(payload.issueDate),
    due_date: formatDate(payload.dueDate),
    return_date: payload.returnDate ? formatDate(payload.returnDate) : "-",
    penalty_amount: payload.penaltyAmount || 0
  };

  console.log("Sending email:", params);

  const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: EMAILJS_CONFIG.serviceId,
      template_id: EMAILJS_CONFIG.templateId,
      user_id: EMAILJS_CONFIG.publicKey,
      template_params: params
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`EmailJS failed: ${response.status} ${text}`);
  }

  console.log("Email sent successfully");
}

async function loadStudent(db, uid) {
  if (!uid) return {};
  const snap = await db.collection("students").doc(uid).get();
  return snap.exists ? snap.data() : {};
}

async function runReminderCheck() {
  initAdmin();
  const db = admin.firestore();
  const snap = await db.collection("bookIssues").where("status", "==", "issued").get();
  const result = {
    checked: snap.size,
    sent: 0,
    skipped: 0,
    overdue: 0
  };

  const reminderRules = [
    { daysLeft: 15, flag: "reminder15DaysLeftSent" },
    { daysLeft: 7, flag: "reminder7DaysLeftSent" },
    { daysLeft: 3, flag: "reminder3DaysLeftSent" },
    { daysLeft: 1, flag: "reminder1DayLeftSent" },
    { daysLeft: -1, flag: "overdueReminderSent" }
  ];

  for (const doc of snap.docs) {
    const issue = doc.data();
    const remaining = daysRemaining(issue.dueDate);
    if (remaining === null) {
      result.skipped += 1;
      continue;
    }
    if (remaining < 0) result.overdue += 1;

    const rule = reminderRules.find((item) =>
      item.daysLeft === -1 ? remaining < 0 : remaining === item.daysLeft
    );
    if (!rule || issue[rule.flag] === true) {
      result.skipped += 1;
      continue;
    }

    const student = await loadStudent(db, issue.studentUid);
    const studentEmail = issue.studentEmail || student.email || "";
    if (!studentEmail) {
      result.skipped += 1;
      continue;
    }

    await sendEmail("Book Return Reminder", {
      studentName: issue.studentName || student.name || "Student",
      studentEmail,
      bookTitle: issue.bookTitle || issue.bookId || "Issued book",
      issueDate: issue.issueDate,
      dueDate: issue.dueDate,
      returnDate: "-",
      penaltyAmount: issue.penaltyAmount || 0
    });

    await doc.ref.update({
      [rule.flag]: true,
      [`${rule.flag}At`]: admin.firestore.FieldValue.serverTimestamp()
    });
    result.sent += 1;
  }

  return result;
}

module.exports = async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const result = await runReminderCheck();
    res.status(200).json(result);
  } catch (error) {
    console.error("Reminder check failed:", error);
    res.status(500).json({
      error: error.message || "Reminder check failed",
      checked: 0,
      sent: 0,
      skipped: 0,
      overdue: 0
    });
  }
};
