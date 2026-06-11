const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

const ISSUE_DAYS = 45;
const FINE_PER_DAY = 5;
const ACTIVE_STATUSES = ["active", "trialing"];
const ADMIN_ROLES = ["super_admin", "university_admin", "college_admin", "library_admin"];
const STAFF_ROLES = [...ADMIN_ROLES, "librarian"];

function clean(value) {
  return String(value || "").trim();
}

function normalizeBarcode(value) {
  return clean(value).replace(/\s+/g, "");
}

function now() {
  return FieldValue.serverTimestamp();
}

function toDate(value) {
  if (!value) return null;
  if (value.toDate) return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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

function orgCollection(orgType) {
  if (orgType === "university") return "universities";
  if (orgType === "independent_college") return "independentColleges";
  if (orgType === "private_library") return "privateLibraries";
  throw new HttpsError("invalid-argument", "Unsupported organization type.");
}

function adminRoleFor(orgType) {
  if (orgType === "university") return "university_admin";
  if (orgType === "independent_college") return "college_admin";
  if (orgType === "private_library") return "library_admin";
  throw new HttpsError("invalid-argument", "Unsupported organization type.");
}

function slug(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 50) || "org";
}

function assertFields(payload, fields) {
  fields.forEach((field) => {
    if (!clean(payload[field])) {
      throw new HttpsError("invalid-argument", `${field} is required.`);
    }
  });
}

async function writeAudit(action, actorUid, payload = {}) {
  const ref = db.collection("auditLogs").doc();
  await ref.set({
    logId: ref.id,
    action,
    actorUid: actorUid || "system",
    ...payload,
    createdAt: now(),
    updatedAt: now(),
    status: "active"
  });
}

async function logEmail(event, to, subject, payload = {}, status = "queued") {
  const ref = db.collection("emailLogs").doc();
  await ref.set({
    emailId: ref.id,
    event,
    to,
    subject,
    payload,
    provider: process.env.RESEND_API_KEY ? "resend" : process.env.SENDGRID_API_KEY ? "sendgrid" : "log_only",
    status,
    createdAt: now(),
    updatedAt: now()
  });
}

async function sendEmail(event, to, subject, text, payload = {}) {
  if (!to) return;
  try {
    if (process.env.RESEND_API_KEY) {
      const { Resend } = require("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.EMAIL_FROM || "ULC <noreply@ulc.local>",
        to,
        subject,
        text
      });
      await logEmail(event, to, subject, payload, "sent");
      return;
    }

    if (process.env.SENDGRID_API_KEY) {
      const sendgrid = require("@sendgrid/mail");
      sendgrid.setApiKey(process.env.SENDGRID_API_KEY);
      await sendgrid.send({
        from: process.env.EMAIL_FROM || "noreply@ulc.local",
        to,
        subject,
        text
      });
      await logEmail(event, to, subject, payload, "sent");
      return;
    }

    await logEmail(event, to, subject, { ...payload, text }, "logged");
  } catch (error) {
    console.error("Email failed", { event, to, error });
    await logEmail(event, to, subject, { ...payload, error: error.message }, "failed");
  }
}

async function requireUser(auth, roles = []) {
  if (!auth) throw new HttpsError("unauthenticated", "Login is required.");
  const snap = await db.doc(`users/${auth.uid}`).get();
  if (!snap.exists) throw new HttpsError("permission-denied", "User profile not found.");
  const profile = snap.data();
  const status = profile.status || (profile.active === false ? "inactive" : "active");
  if (!ACTIVE_STATUSES.includes(status) && profile.active !== true) {
    throw new HttpsError("permission-denied", "Your account is not active.");
  }
  if (roles.length && !roles.includes(profile.role)) {
    throw new HttpsError("permission-denied", "You do not have permission for this action.");
  }
  return { uid: auth.uid, ...profile, status };
}

function tenantIdsFromProfile(profile) {
  return {
    orgType: profile.orgType || "",
    universityId: profile.universityId || null,
    collegeId: profile.collegeId || null,
    libraryId: profile.libraryId || null
  };
}

function canAccessTenant(profile, data) {
  if (profile.role === "super_admin") return true;
  if (profile.orgType !== data.orgType) return false;
  if (profile.universityId && data.universityId && profile.universityId !== data.universityId) return false;
  if (profile.collegeId && data.collegeId && profile.collegeId !== data.collegeId) return false;
  if (profile.libraryId && data.libraryId && profile.libraryId !== data.libraryId) return false;
  return true;
}

function tenantRootFromProfile(profile, input = {}) {
  if (profile.orgType === "university") {
    const universityId = clean(input.universityId || profile.universityId);
    const collegeId = clean(input.collegeId || profile.collegeId);
    if (!universityId || !collegeId) {
      throw new HttpsError("failed-precondition", "A university college is required for this action.");
    }
    return {
      orgType: "university",
      universityId,
      collegeId,
      libraryId: null,
      rootPath: `universities/${universityId}/colleges/${collegeId}`,
      peopleCollection: "students"
    };
  }

  if (profile.orgType === "independent_college") {
    const collegeId = clean(input.collegeId || profile.collegeId);
    if (!collegeId) throw new HttpsError("failed-precondition", "College assignment is required.");
    return {
      orgType: "independent_college",
      universityId: null,
      collegeId,
      libraryId: null,
      rootPath: `independentColleges/${collegeId}`,
      peopleCollection: "students"
    };
  }

  if (profile.orgType === "private_library") {
    const libraryId = clean(input.libraryId || profile.libraryId);
    if (!libraryId) throw new HttpsError("failed-precondition", "Library assignment is required.");
    return {
      orgType: "private_library",
      universityId: null,
      collegeId: null,
      libraryId,
      rootPath: `privateLibraries/${libraryId}`,
      peopleCollection: "members"
    };
  }

  throw new HttpsError("failed-precondition", "Your account is not assigned to an organization.");
}

function tenantFields(root) {
  return {
    orgType: root.orgType,
    universityId: root.universityId,
    collegeId: root.collegeId,
    libraryId: root.libraryId
  };
}

async function getBookByBarcode(profile, libraryBarcode) {
  let query = db.collectionGroup("books").where("libraryBarcode", "==", normalizeBarcode(libraryBarcode)).limit(5);
  const matches = await query.get();
  const match = matches.docs.find((docSnap) => canAccessTenant(profile, docSnap.data()));
  if (!match) throw new HttpsError("not-found", "Book not found in your organization.");
  return match;
}

exports.createRazorpaySubscription = onCall(async (request) => {
  const payload = request.data || {};
  assertFields(payload, ["orgType", "organizationName", "email", "phone"]);
  const pricing = payload.pricing || {};
  const planId = pricing.billingCycle === "yearly"
    ? process.env.RAZORPAY_YEARLY_PLAN_ID
    : process.env.RAZORPAY_MONTHLY_PLAN_ID;

  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET || !planId) {
    return {
      mode: "demo",
      keyId: process.env.RAZORPAY_KEY_ID || "rzp_test_demo",
      subscriptionId: `demo_sub_${Date.now()}`,
      amount: pricing.finalAmount || 0
    };
  }

  const authHeader = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
  const response = await fetch("https://api.razorpay.com/v1/subscriptions", {
    method: "POST",
    headers: {
      Authorization: `Basic ${authHeader}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      plan_id: planId,
      total_count: pricing.billingCycle === "yearly" ? 10 : 120,
      quantity: 1,
      customer_notify: 1,
      notes: {
        orgType: payload.orgType,
        organizationName: payload.organizationName,
        quotedAmount: String(pricing.finalAmount || 0)
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new HttpsError("internal", `Razorpay subscription failed: ${errorText}`);
  }

  const subscription = await response.json();
  return {
    mode: "razorpay",
    keyId: process.env.RAZORPAY_KEY_ID,
    subscriptionId: subscription.id,
    amount: pricing.finalAmount || 0
  };
});

exports.completeOrganizationRegistration = onCall(async (request) => {
  const payload = request.data || {};
  assertFields(payload, ["orgType", "organizationName", "email", "phone", "address", "authorizedPerson"]);
  assertFields(payload.admin || {}, ["name", "email", "phone", "password"]);

  const orgType = payload.orgType;
  const collectionName = orgCollection(orgType);
  const orgRef = db.collection(collectionName).doc();
  const subscriptionRef = db.collection("subscriptions").doc();
  const paymentRef = db.collection("payments").doc();
  const orgId = orgRef.id;
  const pricing = payload.pricing || {};
  const payment = payload.payment || {};
  const adminRole = adminRoleFor(orgType);
  const baseOrgData = {
    name: clean(payload.organizationName),
    email: clean(payload.email),
    phone: clean(payload.phone),
    address: clean(payload.address),
    planType: pricing.planType || "unlimited",
    subscriptionId: subscriptionRef.id,
    billingStatus: "active",
    createdBy: "registration",
    createdAt: now(),
    updatedAt: now(),
    status: "active"
  };

  let authUser;
  try {
    authUser = await admin.auth().createUser({
      email: clean(payload.admin.email),
      password: payload.admin.password,
      displayName: clean(payload.admin.name),
      phoneNumber: clean(payload.admin.phone).startsWith("+") ? clean(payload.admin.phone) : undefined,
      emailVerified: false,
      disabled: false
    });
  } catch (error) {
    if (error.code !== "auth/email-already-exists") throw error;
    authUser = await admin.auth().getUserByEmail(clean(payload.admin.email));
  }

  const userDoc = {
    uid: authUser.uid,
    firebaseAuthUid: authUser.uid,
    name: clean(payload.admin.name),
    email: clean(payload.admin.email),
    phone: clean(payload.admin.phone),
    role: adminRole,
    orgType,
    universityId: orgType === "university" ? orgId : null,
    collegeId: orgType === "independent_college" ? orgId : null,
    libraryId: orgType === "private_library" ? orgId : null,
    status: "active",
    active: true,
    billingStatus: "active",
    createdAt: now(),
    updatedAt: now()
  };

  const batch = db.batch();
  if (orgType === "university") {
    const defaultCollegeId = `${slug(payload.organizationName)}-main-college`;
    userDoc.collegeId = defaultCollegeId;
    batch.set(orgRef, {
      universityId: orgId,
      ...baseOrgData
    });
    batch.set(orgRef.collection("colleges").doc(defaultCollegeId), {
      collegeId: defaultCollegeId,
      universityId: orgId,
      name: `${clean(payload.organizationName)} Main College`,
      email: clean(payload.email),
      phone: clean(payload.phone),
      address: clean(payload.address),
      orgType,
      libraryId: null,
      status: "active",
      createdAt: now(),
      updatedAt: now()
    });
  } else if (orgType === "independent_college") {
    batch.set(orgRef, {
      collegeId: orgId,
      ...baseOrgData
    });
  } else {
    batch.set(orgRef, {
      libraryId: orgId,
      ownerName: clean(payload.authorizedPerson),
      ...baseOrgData
    });
  }

  batch.set(subscriptionRef, {
    subscriptionId: subscriptionRef.id,
    organizationId: orgId,
    orgType,
    universityId: userDoc.universityId,
    collegeId: userDoc.collegeId,
    libraryId: userDoc.libraryId,
    planType: pricing.planType || "unlimited",
    billingCycle: pricing.billingCycle || "monthly",
    monthlyAmount: pricing.monthlyAmount || 0,
    yearlyAmount: pricing.yearlyAmount || 0,
    discountPercent: pricing.discountPercent || 0,
    finalAmount: pricing.finalAmount || 0,
    razorpaySubscriptionId: payment.razorpay_subscription_id || null,
    status: "active",
    createdAt: now(),
    updatedAt: now()
  });

  batch.set(paymentRef, {
    paymentId: paymentRef.id,
    subscriptionId: subscriptionRef.id,
    organizationId: orgId,
    orgType,
    universityId: userDoc.universityId,
    collegeId: userDoc.collegeId,
    libraryId: userDoc.libraryId,
    amount: pricing.finalAmount || 0,
    currency: "INR",
    razorpayPaymentId: payment.razorpay_payment_id || null,
    razorpaySignature: payment.razorpay_signature || null,
    mode: payment.mode || "razorpay",
    status: "successful",
    createdAt: now(),
    updatedAt: now()
  });

  batch.set(db.doc(`users/${authUser.uid}`), userDoc);
  await batch.commit();

  await Promise.all([
    sendEmail("welcome", userDoc.email, "Welcome to ULC", `Welcome ${userDoc.name}. Your ULC organization is active.`, { organizationId: orgId }),
    sendEmail("subscription_activated", clean(payload.email), "ULC subscription activated", "Your ULC subscription is active.", { subscriptionId: subscriptionRef.id }),
    writeAudit("organization_registered", authUser.uid, {
      orgType,
      universityId: userDoc.universityId,
      collegeId: userDoc.collegeId,
      libraryId: userDoc.libraryId,
      organizationId: orgId,
      subscriptionId: subscriptionRef.id
    })
  ]);

  return {
    organizationId: orgId,
    subscriptionId: subscriptionRef.id,
    adminUid: authUser.uid,
    role: adminRole
  };
});

exports.addTenantBook = onCall(async (request) => {
  const profile = await requireUser(request.auth, STAFF_ROLES);
  const root = tenantRootFromProfile(profile, request.data || {});
  const payload = request.data || {};
  assertFields(payload, ["title"]);
  const totalCopies = Math.max(1, Number(payload.totalCopies || 1));
  const bookRef = db.doc(`${root.rootPath}/books/${db.collection("_").doc().id}`);
  const libraryBarcode = normalizeBarcode(payload.libraryBarcode) || `ULC-${bookRef.id}`;

  await bookRef.set({
    bookId: bookRef.id,
    libraryBarcode,
    isbn: clean(payload.isbn),
    title: clean(payload.title),
    author: clean(payload.author),
    publisher: clean(payload.publisher),
    category: clean(payload.category),
    totalCopies,
    availableCopies: totalCopies,
    issuedCopies: 0,
    lostCopies: 0,
    shelfNo: clean(payload.shelfNo),
    status: "available",
    addedBy: profile.uid,
    ...tenantFields(root),
    createdAt: now(),
    updatedAt: now()
  });

  await writeAudit("book_created", profile.uid, { bookId: bookRef.id, libraryBarcode, ...tenantFields(root) });
  return { bookId: bookRef.id, libraryBarcode };
});

exports.addTenantPerson = onCall(async (request) => {
  const profile = await requireUser(request.auth, STAFF_ROLES);
  const root = tenantRootFromProfile(profile, request.data || {});
  const payload = request.data || {};
  assertFields(payload, ["name", "email"]);
  const personRef = db.doc(`${root.rootPath}/${root.peopleCollection}/${db.collection("_").doc().id}`);

  await personRef.set({
    studentUid: personRef.id,
    name: clean(payload.name),
    email: clean(payload.email),
    phone: clean(payload.phone),
    rollNo: clean(payload.rollNo),
    course: clean(payload.course),
    year: clean(payload.year),
    totalIssuedBooks: 0,
    totalFine: 0,
    ...tenantFields(root),
    status: "active",
    createdAt: now(),
    updatedAt: now()
  });

  await Promise.all([
    sendEmail("student_account_created", clean(payload.email), "Your ULC library profile is ready", "Your library profile has been created.", { personId: personRef.id }),
    writeAudit("person_created", profile.uid, { personId: personRef.id, ...tenantFields(root) })
  ]);

  return { personId: personRef.id };
});

exports.requestBookIssue = onCall(async (request) => {
  const profile = await requireUser(request.auth, ["student"]);
  const libraryBarcode = normalizeBarcode(request.data?.libraryBarcode);
  if (!libraryBarcode) throw new HttpsError("invalid-argument", "Library barcode is required.");
  const bookSnap = await getBookByBarcode(profile, libraryBarcode);
  const book = bookSnap.data();
  if (Number(book.availableCopies || 0) <= 0 || book.status === "lost") {
    throw new HttpsError("failed-precondition", "This book is not available.");
  }

  const requestRef = db.collection("issueRequests").doc();
  await requestRef.set({
    requestId: requestRef.id,
    studentUid: profile.uid,
    studentName: profile.name || "",
    studentEmail: profile.email || "",
    bookId: bookSnap.id,
    bookPath: bookSnap.ref.path,
    libraryBarcode,
    bookTitle: book.title || "",
    status: "pending",
    ...tenantIdsFromProfile(profile),
    createdAt: now(),
    updatedAt: now(),
    reviewedBy: null,
    reviewedAt: null
  });

  await writeAudit("issue_requested", profile.uid, { requestId: requestRef.id, ...tenantIdsFromProfile(profile) });
  return { requestId: requestRef.id };
});

async function approveUlcIssue(requestId, actor) {
  const result = await db.runTransaction(async (transaction) => {
    const requestRef = db.doc(`issueRequests/${requestId}`);
    const requestSnap = await transaction.get(requestRef);
    if (!requestSnap.exists) throw new HttpsError("not-found", "Issue request not found.");
    const issueRequest = requestSnap.data();
    if (!issueRequest.bookPath) return null;
    if (!canAccessTenant(actor, issueRequest)) throw new HttpsError("permission-denied", "Request belongs to another tenant.");
    if (issueRequest.status !== "pending") throw new HttpsError("failed-precondition", "Only pending requests can be approved.");

    const bookRef = db.doc(issueRequest.bookPath);
    const bookSnap = await transaction.get(bookRef);
    if (!bookSnap.exists) throw new HttpsError("failed-precondition", "Book record does not exist.");
    const book = bookSnap.data();
    const availableCopies = Number(book.availableCopies || 0);
    if (availableCopies <= 0 || book.status === "lost") {
      throw new HttpsError("failed-precondition", "Book is not available.");
    }

    const issueDate = new Date();
    const dueDate = addDays(issueDate, ISSUE_DAYS);
    const issueRef = db.collection("issueRecords").doc();
    transaction.set(issueRef, {
      issueId: issueRef.id,
      requestId,
      studentUid: issueRequest.studentUid,
      studentName: issueRequest.studentName,
      studentEmail: issueRequest.studentEmail,
      bookId: issueRequest.bookId,
      bookPath: issueRequest.bookPath,
      libraryBarcode: issueRequest.libraryBarcode,
      bookTitle: issueRequest.bookTitle,
      issueDate: Timestamp.fromDate(issueDate),
      dueDate: Timestamp.fromDate(dueDate),
      returnDate: null,
      fineAmount: 0,
      status: "issued",
      approvedBy: actor.uid,
      ...tenantIdsFromProfile(issueRequest),
      createdAt: now(),
      updatedAt: now()
    });

    transaction.update(bookRef, {
      availableCopies: availableCopies - 1,
      issuedCopies: Number(book.issuedCopies || 0) + 1,
      status: availableCopies - 1 <= 0 ? "issued" : "available",
      currentIssueId: issueRef.id,
      updatedAt: now()
    });

    transaction.update(requestRef, {
      status: "approved",
      issueId: issueRef.id,
      reviewedBy: actor.uid,
      reviewedAt: now(),
      updatedAt: now()
    });

    return { issueId: issueRef.id, studentEmail: issueRequest.studentEmail, bookTitle: issueRequest.bookTitle };
  });

  if (!result) return null;
  await Promise.all([
    sendEmail("issue_approved", result.studentEmail, "Book issue approved", `${result.bookTitle} has been issued to you.`, result),
    writeAudit("issue_approved", actor.uid, { requestId, issueId: result.issueId })
  ]);
  return result;
}

async function approveLegacyIssue(requestId, actor) {
  return db.runTransaction(async (transaction) => {
    const requestRef = db.doc(`issueRequests/${requestId}`);
    const requestSnap = await transaction.get(requestRef);
    if (!requestSnap.exists) throw new HttpsError("not-found", "Issue request not found.");
    const issueRequest = requestSnap.data();
    if (issueRequest.status !== "pending") {
      throw new HttpsError("failed-precondition", "Only pending requests can be approved.");
    }

    const studentRef = db.doc(`students/${issueRequest.studentUid}`);
    const studentUserRef = db.doc(`users/${issueRequest.studentUid}`);
    const bookRef = db.doc(`books/${issueRequest.bookId}`);
    const [studentSnap, studentUserSnap, bookSnap] = await Promise.all([
      transaction.get(studentRef),
      transaction.get(studentUserRef),
      transaction.get(bookRef)
    ]);

    if (!studentSnap.exists || !studentUserSnap.exists || studentUserSnap.get("active") === false) {
      throw new HttpsError("failed-precondition", "Student profile is missing or inactive.");
    }
    if (!bookSnap.exists || bookSnap.get("status") !== "available") {
      throw new HttpsError("failed-precondition", "Book is not available.");
    }

    const issueDate = toDate(issueRequest.issueDate) || new Date();
    const dueDate = toDate(issueRequest.dueDate) || addDays(issueDate, ISSUE_DAYS);
    const issueRef = db.collection("bookIssues").doc();
    transaction.set(issueRef, {
      issueId: issueRef.id,
      requestId,
      studentUid: issueRequest.studentUid,
      studentName: issueRequest.studentName || studentSnap.get("name") || "",
      rollNumber: issueRequest.rollNumber || studentSnap.get("rollNumber") || "",
      b_id: issueRequest.b_id || issueRequest.bookId,
      bookId: issueRequest.b_id || issueRequest.bookId,
      bookBarcodeValue: issueRequest.bookBarcodeValue || bookSnap.get("barcodeValue") || "",
      bookTitle: issueRequest.bookTitle || bookSnap.get("bname") || bookSnap.get("title") || "",
      bookImage: issueRequest.bookImage || bookSnap.get("imageUrl") || "",
      issueDate: Timestamp.fromDate(issueDate),
      dueDate: Timestamp.fromDate(dueDate),
      returnDate: null,
      status: "issued",
      penaltyPerDay: FINE_PER_DAY,
      penaltyAmount: 0,
      approvedBy: actor.uid,
      approvedAt: now(),
      returnedBy: null,
      returnedAt: null
    });

    transaction.update(bookRef, {
      status: "issued",
      issuedTo: issueRequest.studentUid,
      issuedToName: issueRequest.studentName || studentSnap.get("name") || "",
      currentIssueId: issueRef.id,
      updatedAt: now()
    });

    transaction.update(requestRef, {
      status: "approved",
      reviewedBy: actor.uid,
      reviewedAt: now(),
      issueId: issueRef.id,
      updatedAt: now()
    });

    return { issueId: issueRef.id, legacy: true };
  });
}

exports.approveIssueRequest = onCall(async (request) => {
  const actor = await requireUser(request.auth, STAFF_ROLES.concat(["admin"]));
  const requestId = clean(request.data?.requestId);
  if (!requestId) throw new HttpsError("invalid-argument", "requestId is required.");
  const ulcResult = await approveUlcIssue(requestId, actor);
  return ulcResult || approveLegacyIssue(requestId, actor);
});

exports.rejectIssueRequest = onCall(async (request) => {
  const actor = await requireUser(request.auth, STAFF_ROLES.concat(["admin"]));
  const requestId = clean(request.data?.requestId);
  if (!requestId) throw new HttpsError("invalid-argument", "requestId is required.");
  const requestRef = db.doc(`issueRequests/${requestId}`);
  const requestSnap = await requestRef.get();
  if (!requestSnap.exists) throw new HttpsError("not-found", "Issue request not found.");
  const issueRequest = requestSnap.data();
  if (issueRequest.orgType && !canAccessTenant(actor, issueRequest)) {
    throw new HttpsError("permission-denied", "Request belongs to another tenant.");
  }
  if (issueRequest.status !== "pending") throw new HttpsError("failed-precondition", "Only pending requests can be rejected.");

  await requestRef.update({
    status: "rejected",
    rejectionReason: clean(request.data?.reason) || "Rejected by librarian",
    reviewedBy: actor.uid,
    reviewedAt: now(),
    updatedAt: now()
  });

  await Promise.all([
    sendEmail("issue_rejected", issueRequest.studentEmail, "Book issue request rejected", clean(request.data?.reason) || "Your book issue request was rejected.", { requestId }),
    writeAudit("issue_rejected", actor.uid, { requestId, ...(issueRequest.orgType ? tenantIdsFromProfile(issueRequest) : {}) })
  ]);
  return { requestId, status: "rejected" };
});

async function returnTenantBookHandler(request) {
  const actor = await requireUser(request.auth, STAFF_ROLES.concat(["admin"]));
  const scannedBarcode = request.data?.libraryBarcode || request.data?.bookId || request.data?.barcodeValue;
  let bookSnap;
  try {
    bookSnap = await getBookByBarcode(actor, scannedBarcode);
  } catch (error) {
    if (error.code === "not-found") {
      return returnLegacyBook(actor, scannedBarcode);
    }
    throw error;
  }
  const book = bookSnap.data();
  const issueMatches = await db.collection("issueRecords")
    .where("bookPath", "==", bookSnap.ref.path)
    .where("status", "==", "issued")
    .limit(1)
    .get();
  if (issueMatches.empty) throw new HttpsError("not-found", "No active issue found for this book.");

  const issueRef = issueMatches.docs[0].ref;
  const result = await db.runTransaction(async (transaction) => {
    const [freshBookSnap, issueSnap] = await Promise.all([
      transaction.get(bookSnap.ref),
      transaction.get(issueRef)
    ]);
    if (!freshBookSnap.exists || !issueSnap.exists) throw new HttpsError("not-found", "Issue or book record is missing.");
    const freshBook = freshBookSnap.data();
    const issue = issueSnap.data();
    const returnDate = new Date();
    const dueDate = toDate(issue.dueDate) || returnDate;
    const lateDays = Math.max(0, daysBetween(dueDate, returnDate));
    const fineAmount = lateDays * FINE_PER_DAY;

    transaction.update(issueRef, {
      status: "returned",
      returnDate: Timestamp.fromDate(returnDate),
      fineAmount,
      returnedBy: actor.uid,
      updatedAt: now()
    });
    transaction.update(bookSnap.ref, {
      availableCopies: Number(freshBook.availableCopies || 0) + 1,
      issuedCopies: Math.max(0, Number(freshBook.issuedCopies || 0) - 1),
      status: "available",
      currentIssueId: null,
      updatedAt: now()
    });
    const returnRef = db.collection("returnRecords").doc();
    transaction.set(returnRef, {
      returnId: returnRef.id,
      issueId: issueRef.id,
      bookId: bookSnap.id,
      libraryBarcode: freshBook.libraryBarcode,
      studentUid: issue.studentUid,
      lateDays,
      fineAmount,
      returnedBy: actor.uid,
      ...tenantIdsFromProfile(freshBook),
      status: "returned",
      createdAt: now(),
      updatedAt: now()
    });
    return { issueId: issueRef.id, returnId: returnRef.id, fineAmount, studentEmail: issue.studentEmail, bookTitle: issue.bookTitle };
  });

  await Promise.all([
    sendEmail("book_returned", result.studentEmail, "Book returned", `${result.bookTitle} has been returned. Fine: ₹${result.fineAmount}.`, result),
    result.fineAmount > 0 ? sendEmail("fine_generated", result.studentEmail, "Library fine generated", `A fine of ₹${result.fineAmount} was generated.`, result) : Promise.resolve(),
    writeAudit("book_returned", actor.uid, { bookId: bookSnap.id, issueId: result.issueId, ...tenantIdsFromProfile(book) })
  ]);
  return result;
}

exports.returnTenantBook = onCall(returnTenantBookHandler);
exports.returnBook = onCall(returnTenantBookHandler);

async function returnLegacyBook(actor, barcodeValue) {
  const scannedBarcode = normalizeBarcode(barcodeValue);
  if (!scannedBarcode) throw new HttpsError("invalid-argument", "Library barcode is required.");
  const barcodeMatches = await db.collection("books").where("barcodeValue", "==", scannedBarcode).limit(1).get();
  if (barcodeMatches.empty) throw new HttpsError("not-found", "Book record not found for this library barcode.");

  const bookRef = barcodeMatches.docs[0].ref;
  const bookData = barcodeMatches.docs[0].data();
  const issueId = bookData.currentIssueId;
  if (!issueId) throw new HttpsError("not-found", "No active issue found for this book.");
  const issueRef = db.doc(`bookIssues/${issueId}`);

  return db.runTransaction(async (transaction) => {
    const [issueSnap, bookSnap] = await Promise.all([
      transaction.get(issueRef),
      transaction.get(bookRef)
    ]);
    if (!issueSnap.exists || issueSnap.get("status") !== "issued") {
      throw new HttpsError("failed-precondition", "This issue is already closed.");
    }
    if (!bookSnap.exists) throw new HttpsError("failed-precondition", "Book record does not exist.");

    const issue = issueSnap.data();
    const issueDate = toDate(issue.issueDate) || new Date();
    const returnDate = new Date();
    const daysUsed = daysBetween(issueDate, returnDate);
    const lateDays = Math.max(0, daysUsed - ISSUE_DAYS);
    const penaltyAmount = lateDays * (issue.penaltyPerDay || FINE_PER_DAY);

    transaction.update(issueRef, {
      returnDate: Timestamp.fromDate(returnDate),
      status: "returned",
      penaltyAmount,
      returnedBy: actor.uid,
      returnedAt: now()
    });

    transaction.update(bookRef, {
      status: "available",
      issuedTo: null,
      issuedToName: null,
      currentIssueId: null,
      updatedAt: now()
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
        createdAt: now(),
        paidAt: null
      });
    }

    return { issueId: issueRef.id, daysUsed, lateDays, penaltyAmount, legacy: true };
  });
}

exports.markTenantBookLost = onCall(async (request) => {
  const actor = await requireUser(request.auth, STAFF_ROLES.concat(["admin"]));
  const bookSnap = await getBookByBarcode(actor, request.data?.libraryBarcode);
  const book = bookSnap.data();
  const lostRef = db.collection("lostBookRecords").doc();
  await db.runTransaction(async (transaction) => {
    const freshBookSnap = await transaction.get(bookSnap.ref);
    const freshBook = freshBookSnap.data();
    transaction.update(bookSnap.ref, {
      lostCopies: Number(freshBook.lostCopies || 0) + 1,
      availableCopies: Math.max(0, Number(freshBook.availableCopies || 0) - 1),
      status: "lost",
      updatedAt: now()
    });
    transaction.set(lostRef, {
      lostRecordId: lostRef.id,
      bookId: bookSnap.id,
      bookPath: bookSnap.ref.path,
      libraryBarcode: freshBook.libraryBarcode,
      markedBy: actor.uid,
      foundAt: null,
      ...tenantIdsFromProfile(freshBook),
      status: "lost",
      createdAt: now(),
      updatedAt: now()
    });
  });
  await Promise.all([
    sendEmail("book_lost", actor.email, "Book marked lost", `${book.title || bookSnap.id} was marked lost.`, { bookId: bookSnap.id }),
    writeAudit("book_lost", actor.uid, { bookId: bookSnap.id, lostRecordId: lostRef.id, ...tenantIdsFromProfile(book) })
  ]);
  return { bookId: bookSnap.id, lostRecordId: lostRef.id };
});

exports.markTenantBookFound = onCall(async (request) => {
  const actor = await requireUser(request.auth, STAFF_ROLES.concat(["admin"]));
  const bookSnap = await getBookByBarcode(actor, request.data?.libraryBarcode);
  const book = bookSnap.data();
  const lostMatches = await db.collection("lostBookRecords")
    .where("bookPath", "==", bookSnap.ref.path)
    .where("status", "==", "lost")
    .limit(1)
    .get();
  await db.runTransaction(async (transaction) => {
    const freshBookSnap = await transaction.get(bookSnap.ref);
    const freshBook = freshBookSnap.data();
    transaction.update(bookSnap.ref, {
      lostCopies: Math.max(0, Number(freshBook.lostCopies || 0) - 1),
      availableCopies: Number(freshBook.availableCopies || 0) + 1,
      status: "available",
      updatedAt: now()
    });
    if (!lostMatches.empty) {
      transaction.update(lostMatches.docs[0].ref, {
        status: "found",
        foundBy: actor.uid,
        foundAt: now(),
        updatedAt: now()
      });
    }
  });
  await writeAudit("book_found", actor.uid, { bookId: bookSnap.id, ...tenantIdsFromProfile(book) });
  return { bookId: bookSnap.id };
});

exports.sendIssueCreatedEmail = onDocumentCreated("issueRecords/{issueId}", async (event) => {
  const issue = event.data?.data();
  if (!issue || issue.status !== "issued") return;
  await sendEmail("issue_approved", issue.studentEmail, "Book issued", `${issue.bookTitle} is due on ${toDate(issue.dueDate)?.toLocaleDateString("en-IN") || "the due date"}.`, issue);
});

exports.sendIssueReminders = onSchedule("every day 09:00", async () => {
  const issuedSnap = await db.collection("issueRecords").where("status", "==", "issued").get();
  await Promise.all(issuedSnap.docs.map(async (issueDoc) => {
    const issue = issueDoc.data();
    const dueDate = toDate(issue.dueDate);
    if (!dueDate) return;
    const daysLate = daysBetween(dueDate, new Date());
    if (daysLate <= 0 || issue.overdueEmailSent) return;
    await sendEmail("fine_generated", issue.studentEmail, "Library book overdue", `${issue.bookTitle} is overdue. Fine is ₹${daysLate * FINE_PER_DAY}.`, issue);
    await issueDoc.ref.update({ overdueEmailSent: true, updatedAt: now() });
  }));
});
