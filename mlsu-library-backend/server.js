require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");
const cron = require("node-cron");

const PORT = process.env.PORT || 3000;
const ISSUE_REMINDER_DAYS = [15, 30, 45];
const MSG91_FLOW_URL = "https://api.msg91.com/api/v5/flow/";

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL || "*"
}));
app.use(express.json());

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function initializeFirebaseAdmin() {
  if (admin.apps.length) return;

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: requiredEnv("FIREBASE_PROJECT_ID"),
      clientEmail: requiredEnv("FIREBASE_CLIENT_EMAIL"),
      privateKey: requiredEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n")
    })
  });
}

initializeFirebaseAdmin();
const db = admin.firestore();

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) {
    throw new Error("Phone number is required.");
  }
  return digits.startsWith("91") ? digits : `91${digits}`;
}

function toDate(value) {
  if (!value) return null;
  if (value.toDate) return value.toDate();
  if (value._seconds) return new Date(value._seconds * 1000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = toDate(value);
  if (!date) return "";
  return date.toLocaleDateString("en-GB");
}

function daysBetween(start, end) {
  const startDate = toDate(start);
  if (!startDate) return 0;
  const endDate = new Date(end);
  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((endDate - startDate) / 86400000));
}

function reminderFlowEnvName(day) {
  if (Number(day) === 15) return "MSG91_REMINDER15_FLOW_ID";
  if (Number(day) === 30) return "MSG91_REMINDER30_FLOW_ID";
  if (Number(day) === 45) return "MSG91_REMINDER45_FLOW_ID";
  throw new Error("reminderDay must be 15, 30, or 45.");
}

async function sendSms(flowId, phone, variables) {
  const payload = {
    flow_id: flowId,
    sender: requiredEnv("MSG91_SENDER_ID"),
    mobiles: normalizePhone(phone),
    ...variables
  };

  const response = await axios.post(MSG91_FLOW_URL, payload, {
    headers: {
      authkey: requiredEnv("MSG91_AUTH_KEY"),
      "Content-Type": "application/json"
    }
  });

  return response.data;
}

async function sendIssueSms({ phone, name, book, dueDate }) {
  return sendSms(requiredEnv("MSG91_ISSUE_FLOW_ID"), phone, {
    name,
    book,
    dueDate
  });
}

async function sendReturnSms({ phone, name, book, returnDate, penalty }) {
  return sendSms(requiredEnv("MSG91_RETURN_FLOW_ID"), phone, {
    name,
    book,
    returnDate,
    penalty
  });
}

async function sendReminderSms({ reminderDay, phone, name, book, dueDate }) {
  return sendSms(requiredEnv(reminderFlowEnvName(reminderDay)), phone, {
    name,
    book,
    dueDate
  });
}

async function runReminderCheck() {
  const snapshot = await db.collection("bookIssues")
    .where("status", "==", "issued")
    .get();

  const result = {
    checked: snapshot.size,
    sent: 0,
    skipped: 0
  };

  const today = new Date();

  for (const issueDoc of snapshot.docs) {
    const issue = issueDoc.data();
    const studentUid = issue.studentUid;

    if (!studentUid) {
      result.skipped += 1;
      continue;
    }

    const studentSnap = await db.collection("students").doc(studentUid).get();
    if (!studentSnap.exists) {
      result.skipped += 1;
      continue;
    }

    const student = studentSnap.data();
    if (!student.phone) {
      result.skipped += 1;
      continue;
    }

    const daysPassed = daysBetween(issue.issueDate, today);
    let sentCountForIssue = 0;

    for (const day of ISSUE_REMINDER_DAYS) {
      const flag = `reminder${day}Sent`;
      if (daysPassed >= day && issue[flag] !== true) {
        await sendReminderSms({
          reminderDay: day,
          phone: student.phone,
          name: student.name || issue.studentName || "Student",
          book: issue.bookTitle || issue.bookId || "your book",
          dueDate: formatDate(issue.dueDate)
        });

        await issueDoc.ref.update({
          [flag]: true,
          [`reminder${day}SentAt`]: admin.firestore.FieldValue.serverTimestamp()
        });

        result.sent += 1;
        sentCountForIssue += 1;
      }
    }

    if (!sentCountForIssue) {
      result.skipped += 1;
    }
  }

  return result;
}

app.get("/", (req, res) => {
  res.send("MLSU Library SMS Backend Running");
});

app.post("/send-issue-sms", async (req, res) => {
  try {
    const { phone, name, book, dueDate } = req.body || {};
    if (!phone || !name || !book || !dueDate) {
      return res.status(400).json({
        error: "phone, name, book, and dueDate are required."
      });
    }

    const data = await sendIssueSms({ phone, name, book, dueDate });
    return res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error("Issue SMS failed:", {
      message: error.message,
      response: error.response?.data
    });
    return res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data || null
    });
  }
});

app.post("/send-return-sms", async (req, res) => {
  try {
    const { phone, name, book, returnDate, penalty } = req.body || {};
    if (!phone || !name || !book || !returnDate || penalty === undefined) {
      return res.status(400).json({
        error: "phone, name, book, returnDate, and penalty are required."
      });
    }

    const data = await sendReturnSms({ phone, name, book, returnDate, penalty });
    return res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error("Return SMS failed:", {
      message: error.message,
      response: error.response?.data
    });
    return res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data || null
    });
  }
});

app.post("/send-reminder-sms", async (req, res) => {
  try {
    const { reminderDay, phone, name, book, dueDate } = req.body || {};
    if (!reminderDay || !phone || !name || !book || !dueDate) {
      return res.status(400).json({
        error: "reminderDay, phone, name, book, and dueDate are required."
      });
    }

    const data = await sendReminderSms({ reminderDay, phone, name, book, dueDate });
    return res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error("Reminder SMS failed:", {
      message: error.message,
      response: error.response?.data
    });
    return res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data || null
    });
  }
});

app.post("/test-reminders", async (req, res) => {
  try {
    const result = await runReminderCheck();
    return res.json(result);
  } catch (error) {
    console.error("Reminder check failed:", {
      message: error.message,
      stack: error.stack
    });
    return res.status(500).json({
      checked: 0,
      sent: 0,
      skipped: 0,
      error: error.message
    });
  }
});

cron.schedule("0 9 * * *", async () => {
  try {
    const result = await runReminderCheck();
    console.log("Daily reminder check complete:", result);
  } catch (error) {
    console.error("Daily reminder check failed:", {
      message: error.message,
      stack: error.stack
    });
  }
});

app.listen(PORT, () => {
  console.log(`MLSU Library SMS Backend running on port ${PORT}`);
});
