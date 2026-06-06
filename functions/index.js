const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;
const PENALTY_PER_DAY = 5;
const ISSUE_DAYS = 45;
const DEFAULT_USERS = {
  admin: {
    email: "admin@123.com",
    password: "1332Admin!",
    role: "admin",
    name: "System Administrator"
  },
  librarian: {
    email: "librarian@123.com",
    password: "1334Librarian!",
    role: "librarian",
    name: "Library Staff"
  }
};

async function requireRole(auth, roles) {
  if (!auth) {
    throw new HttpsError("unauthenticated", "Login is required.");
  }
  const userSnap = await db.doc(`users/${auth.uid}`).get();
  if (!userSnap.exists || userSnap.get("active") !== true) {
    throw new HttpsError("permission-denied", "Your account is not active.");
  }
  const role = userSnap.get("role");
  if (!roles.includes(role)) {
    throw new HttpsError("permission-denied", "You do not have permission for this action.");
  }
  return { uid: auth.uid, role };
}

function toDate(value) {
  if (!value) return null;
  if (value.toDate) return value.toDate();
  return new Date(value);
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function daysBetween(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((endDate - startDate) / 86400000));
}

function sendSms(phoneNumber, message) {
  console.log("SMS placeholder", { phoneNumber, message });
}

async function getAuthUserByEmail(email) {
  try {
    return await admin.auth().getUserByEmail(email);
  } catch (error) {
    if (error.code === "auth/user-not-found") return null;
    throw error;
  }
}

async function ensureDefaultUser(key) {
  const defaults = DEFAULT_USERS[key];
  if (!defaults) {
    throw new HttpsError("invalid-argument", "Unknown default user type.");
  }

  let authUser = await getAuthUserByEmail(defaults.email);
  let createdAuthUser = false;
  if (!authUser) {
    authUser = await admin.auth().createUser({
      email: defaults.email,
      password: defaults.password,
      displayName: defaults.name,
      emailVerified: true,
      disabled: false
    });
    createdAuthUser = true;
  }

  const userRef = db.doc(`users/${authUser.uid}`);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    await userRef.set({
      uid: authUser.uid,
      email: defaults.email,
      role: defaults.role,
      name: defaults.name,
      active: true,
      createdAt: FieldValue.serverTimestamp()
    });
  } else {
    await userRef.set({
      uid: authUser.uid,
      email: defaults.email,
      role: defaults.role,
      name: defaults.name,
      active: true
    }, { merge: true });
  }

  return {
    uid: authUser.uid,
    email: defaults.email,
    role: defaults.role,
    existed: !createdAuthUser && userSnap.exists,
    authCreated: createdAuthUser,
    profileCreated: !userSnap.exists
  };
}

async function getDefaultUserStatus(key) {
  const defaults = DEFAULT_USERS[key];
  const authUser = await getAuthUserByEmail(defaults.email);
  if (!authUser) {
    return {
      email: defaults.email,
      role: defaults.role,
      exists: false,
      authExists: false,
      profileExists: false
    };
  }

  const userSnap = await db.doc(`users/${authUser.uid}`).get();
  return {
    uid: authUser.uid,
    email: defaults.email,
    role: defaults.role,
    exists: userSnap.exists,
    authExists: true,
    profileExists: userSnap.exists
  };
}

exports.getDefaultUsersStatus = onCall(async () => {
  console.log("Checking default user setup status");
  return {
    admin: await getDefaultUserStatus("admin"),
    librarian: await getDefaultUserStatus("librarian")
  };
});

exports.setupDefaultUser = onCall(async (request) => {
  const type = String(request.data?.type || "").trim().toLowerCase();
  console.log("Default user setup requested", { type });
  const result = await ensureDefaultUser(type);
  console.log("Default user setup completed", result);
  return result;
});

exports.approveIssueRequest = onCall(async (request) => {
  const actor = await requireRole(request.auth, ["librarian", "admin"]);
  const requestId = String(request.data.requestId || "").trim();
  if (!requestId) {
    throw new HttpsError("invalid-argument", "requestId is required.");
  }

  const result = await db.runTransaction(async (transaction) => {
    const requestRef = db.doc(`issueRequests/${requestId}`);
    const requestSnap = await transaction.get(requestRef);
    if (!requestSnap.exists) {
      throw new HttpsError("not-found", "Issue request not found.");
    }

    const issueRequest = requestSnap.data();
    if (issueRequest.status !== "pending") {
      throw new HttpsError("failed-precondition", "Only pending requests can be approved.");
    }
    if (issueRequest.confirmationChecked !== true) {
      throw new HttpsError("failed-precondition", "Student confirmation is missing.");
    }

    const studentRef = db.doc(`students/${issueRequest.studentUid}`);
    const studentUserRef = db.doc(`users/${issueRequest.studentUid}`);
    const bookRef = db.doc(`books/${issueRequest.bookId}`);
    const [studentSnap, studentUserSnap, bookSnap] = await Promise.all([
      transaction.get(studentRef),
      transaction.get(studentUserRef),
      transaction.get(bookRef)
    ]);

    if (!studentSnap.exists || !studentUserSnap.exists || studentUserSnap.get("active") !== true) {
      throw new HttpsError("failed-precondition", "Student profile is missing or inactive.");
    }
    if (!bookSnap.exists) {
      throw new HttpsError("failed-precondition", "Book record does not exist.");
    }
    if (bookSnap.get("status") !== "available") {
      throw new HttpsError("failed-precondition", "Book is not available.");
    }

    const issueDate = toDate(issueRequest.issueDate) || new Date();
    const dueDate = toDate(issueRequest.dueDate) || addDays(issueDate, ISSUE_DAYS);
    const issueRef = db.collection("bookIssues").doc();
    const now = FieldValue.serverTimestamp();

    transaction.set(issueRef, {
      issueId: issueRef.id,
      requestId,
      studentUid: issueRequest.studentUid,
      studentId: issueRequest.studentId || studentSnap.get("studentId") || "",
      bookId: issueRequest.bookId,
      bookTitle: issueRequest.bookTitle || bookSnap.get("title") || "",
      bookImage: issueRequest.bookImage || bookSnap.get("imageUrl") || "",
      issueDate: Timestamp.fromDate(issueDate),
      dueDate: Timestamp.fromDate(dueDate),
      returnDate: null,
      status: "issued",
      penaltyPerDay: PENALTY_PER_DAY,
      penaltyAmount: 0,
      approvedBy: actor.uid,
      approvedAt: now,
      returnedBy: null,
      returnedAt: null
    });

    transaction.update(bookRef, {
      status: "issued",
      issuedTo: issueRequest.studentUid,
      currentIssueId: issueRef.id,
      updatedAt: now
    });

    transaction.update(requestRef, {
      status: "approved",
      reviewedBy: actor.uid,
      reviewedAt: now
    });

    return { issueId: issueRef.id };
  });

  return result;
});

exports.rejectIssueRequest = onCall(async (request) => {
  const actor = await requireRole(request.auth, ["librarian", "admin"]);
  const requestId = String(request.data.requestId || "").trim();
  if (!requestId) {
    throw new HttpsError("invalid-argument", "requestId is required.");
  }

  const requestRef = db.doc(`issueRequests/${requestId}`);
  const requestSnap = await requestRef.get();
  if (!requestSnap.exists) {
    throw new HttpsError("not-found", "Issue request not found.");
  }
  if (requestSnap.get("status") !== "pending") {
    throw new HttpsError("failed-precondition", "Only pending requests can be rejected.");
  }

  await requestRef.update({
    status: "rejected",
    reviewedBy: actor.uid,
    reviewedAt: FieldValue.serverTimestamp(),
    rejectionReason: String(request.data.reason || "")
  });

  return { requestId, status: "rejected" };
});

exports.returnBook = onCall(async (request) => {
  const actor = await requireRole(request.auth, ["librarian", "admin"]);
  const scannedBookId = String(request.data.bookId || "").trim();
  if (!scannedBookId) {
    throw new HttpsError("invalid-argument", "bookId is required.");
  }

  let bookId = scannedBookId;
  const directBookSnap = await db.doc(`books/${scannedBookId}`).get();
  if (!directBookSnap.exists) {
    const barcodeMatches = await db.collection("books")
      .where("barcodeValue", "==", scannedBookId)
      .limit(1)
      .get();
    if (barcodeMatches.empty) {
      throw new HttpsError("not-found", "Book record not found for this barcode.");
    }
    bookId = barcodeMatches.docs[0].id;
  }

  const activeIssues = await db.collection("bookIssues")
    .where("bookId", "==", bookId)
    .where("status", "==", "issued")
    .limit(1)
    .get();

  if (activeIssues.empty) {
    throw new HttpsError("not-found", "No active issue found for this book.");
  }

  const issueRef = activeIssues.docs[0].ref;
  const bookRef = db.doc(`books/${bookId}`);
  const returnDate = new Date();

  const result = await db.runTransaction(async (transaction) => {
    const [issueSnap, bookSnap] = await Promise.all([
      transaction.get(issueRef),
      transaction.get(bookRef)
    ]);

    if (!issueSnap.exists || issueSnap.get("status") !== "issued") {
      throw new HttpsError("failed-precondition", "This issue is already closed.");
    }
    if (!bookSnap.exists) {
      throw new HttpsError("failed-precondition", "Book record does not exist.");
    }

    const issue = issueSnap.data();
    const issueDate = toDate(issue.issueDate);
    const daysUsed = daysBetween(issueDate, returnDate);
    const lateDays = Math.max(0, daysUsed - ISSUE_DAYS);
    const penaltyAmount = lateDays * (issue.penaltyPerDay || PENALTY_PER_DAY);
    const now = FieldValue.serverTimestamp();

    transaction.update(issueRef, {
      returnDate: Timestamp.fromDate(returnDate),
      status: "returned",
      penaltyAmount,
      returnedBy: actor.uid,
      returnedAt: now
    });

    transaction.update(bookRef, {
      status: "available",
      issuedTo: null,
      currentIssueId: null,
      updatedAt: now
    });

    if (penaltyAmount > 0) {
      const penaltyRef = db.collection("penalties").doc();
      transaction.set(penaltyRef, {
        penaltyId: penaltyRef.id,
        issueId: issueRef.id,
        studentUid: issue.studentUid,
        bookId: issue.bookId,
        amount: penaltyAmount,
        daysLate: lateDays,
        status: "unpaid",
        createdAt: now,
        paidAt: null
      });
    }

    return { issueId: issueRef.id, daysUsed, lateDays, penaltyAmount };
  });

  return result;
});

exports.sendIssueReminders = onSchedule("every day 09:00", async () => {
  const issuedSnap = await db.collection("bookIssues").where("status", "==", "issued").get();
  const today = new Date();

  await Promise.all(issuedSnap.docs.map(async (issueDoc) => {
    const issue = issueDoc.data();
    const issueDate = toDate(issue.issueDate);
    const day = daysBetween(issueDate, today);
    if (![15, 30, 45].includes(day)) return;

    const studentSnap = await db.doc(`students/${issue.studentUid}`).get();
    if (!studentSnap.exists) return;

    const label = day === 45 ? "final reminder" : `day ${day} reminder`;
    sendSms(
      studentSnap.get("phone"),
      `MLSU Library ${label}: book ${issue.bookId} is due on ${toDate(issue.dueDate).toDateString()}. Penalty starts after 45 days at Rs.5/day.`
    );
  }));
});
