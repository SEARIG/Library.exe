#!/usr/bin/env node

import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldPath, getFirestore } from "firebase-admin/firestore";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

const PAGE_SIZE = 250;
const REQUIRED_CONFIRMATION = "DELETE-ALL-EXCEPT-ADMINS";

const CLEAR_COLLECTION_NAMES = new Set([
  "students",
  "books",
  "issueRequests",
  "returnRequests",
  "bookIssues",
  "issues",
  "issuedBooks",
  "returns",
  "issueRecords",
  "returnRecords",
  "penalties",
  "dues",
  "noDues",
  "noDuesRequests",
  "clearance",
  "clearanceRequests",
  "lostBooks",
  "missingBooks",
  "foundBooks",
  "damagedBooks",
  "lostBookRecords",
  "bookMetadata",
  "barcodePrintBatches",
  "barcodePrintLogs",
  "reports",
  "generatedReports",
  "circulationReports",
  "penaltyReports",
  "issueReports",
  "returnReports",
  "notifications",
  "activity",
  "activities",
  "history",
  "emailLogs"
]);

const PRESERVE_COLLECTION_NAMES = new Set([
  "auditLogs",
  "librarySettings"
]);

const BOOK_COUNTER_PATTERN = /^(books?|bookcounter|lastbookid|nextbookid|accession|accessioncounter)$/i;

function usage() {
  console.log(`Usage:
  node scripts/full-prelaunch-reset.mjs --dry-run
  CONFIRM_FULL_RESET=YES node scripts/full-prelaunch-reset.mjs --execute

Execution also requires the interactive confirmation:
  ${REQUIRED_CONFIRMATION}`);
}

function parseMode(argv) {
  const dryRun = argv.includes("--dry-run");
  const execute = argv.includes("--execute");
  if (dryRun === execute) {
    usage();
    throw new Error("Choose exactly one mode: --dry-run or --execute.");
  }
  return execute ? "execute" : "dry-run";
}

async function projectIdFromRepo() {
  const firebaserc = JSON.parse(await readFile(new URL("../.firebaserc", import.meta.url), "utf8"));
  const projectId = process.env.FIREBASE_PROJECT_ID
    || process.env.GCLOUD_PROJECT
    || firebaserc?.projects?.default;
  if (!projectId) throw new Error("Firebase project ID is not configured.");
  return projectId;
}

function isoTimestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function encodeValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return { __type: "date", value: value.toISOString() };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { __type: "bytes", value: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return value.map(encodeValue);
  if (typeof value !== "object") return value;
  if (typeof value.toDate === "function") {
    return { __type: "timestamp", value: value.toDate().toISOString() };
  }
  if (typeof value.path === "string" && value.firestore) {
    return { __type: "documentReference", value: value.path };
  }
  if (Number.isFinite(value.latitude) && Number.isFinite(value.longitude)) {
    return { __type: "geoPoint", latitude: value.latitude, longitude: value.longitude };
  }
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, encodeValue(nested)]));
}

function publicAuthUser(user) {
  return {
    uid: user.uid,
    email: user.email || "",
    emailVerified: user.emailVerified === true,
    displayName: user.displayName || "",
    disabled: user.disabled === true,
    phoneNumber: user.phoneNumber || "",
    customClaims: user.customClaims || {},
    providerData: (user.providerData || []).map((provider) => ({
      uid: provider.uid || "",
      email: provider.email || "",
      displayName: provider.displayName || "",
      phoneNumber: provider.phoneNumber || "",
      providerId: provider.providerId || ""
    })),
    metadata: {
      creationTime: user.metadata?.creationTime || "",
      lastSignInTime: user.metadata?.lastSignInTime || "",
      lastRefreshTime: user.metadata?.lastRefreshTime || ""
    }
  };
}

async function listAllAuthUsers(auth) {
  const users = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    users.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

async function readCollectionPageByPage(collectionRef, onDocument) {
  let cursor = null;
  do {
    let pageQuery = collectionRef.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) pageQuery = pageQuery.startAfter(cursor);
    const page = await pageQuery.get();
    for (const document of page.docs) await onDocument(document);
    cursor = page.docs.at(-1) || null;
    if (page.size < PAGE_SIZE) break;
  } while (cursor);
}

function dispositionForDocument({ document, collectionName, rootCollectionName, parentWillDelete, adminUids }) {
  if (PRESERVE_COLLECTION_NAMES.has(collectionName)) {
    return { action: "preserve", reason: `${collectionName} is protected system/audit data` };
  }

  if (parentWillDelete) {
    return { action: "delete", reason: "operational descendant of a deleted document" };
  }

  if (rootCollectionName === "users" && collectionName === "users") {
    const role = String(document.data()?.role || "").trim().toLowerCase();
    if (role === "admin") return { action: "preserve", reason: "admin profile" };
    return { action: "delete", reason: `non-admin users profile (${role || "missing role"})` };
  }

  if (collectionName === "staff") {
    const role = String(document.data()?.role || "").trim().toLowerCase();
    const uid = String(document.data()?.uid || document.id);
    if (role === "admin" || adminUids.has(uid)) {
      return { action: "preserve", reason: "admin staff profile" };
    }
    return { action: "delete", reason: `non-admin staff profile (${role || "missing role"})` };
  }

  if (CLEAR_COLLECTION_NAMES.has(collectionName)) {
    return { action: "delete", reason: `pre-launch operational collection: ${collectionName}` };
  }

  if (rootCollectionName === "counters" && collectionName === "counters") {
    if (BOOK_COUNTER_PATTERN.test(document.id)) {
      return { action: "delete", reason: "book/accession counter" };
    }
    return { action: "preserve", reason: "unrelated system counter" };
  }

  return { action: "preserve", reason: "not in the approved reset target list" };
}

async function inventoryFirestore(db, adminUids) {
  const records = [];
  const collectionCounts = new Map();
  const subcollections = new Set();

  async function visitCollection(collectionRef, rootCollectionName, parentWillDelete = false) {
    const collectionPath = collectionRef.path;
    const collectionName = collectionRef.id;
    if (collectionPath.includes("/")) subcollections.add(collectionPath);

    await readCollectionPageByPage(collectionRef, async (document) => {
      const disposition = dispositionForDocument({
        document,
        collectionName,
        rootCollectionName,
        parentWillDelete,
        adminUids
      });
      records.push({
        path: document.ref.path,
        collectionPath,
        collectionName,
        rootCollectionName,
        action: disposition.action,
        reason: disposition.reason,
        data: encodeValue(document.data())
      });
      collectionCounts.set(collectionPath, (collectionCounts.get(collectionPath) || 0) + 1);

      const childCollections = await document.ref.listCollections();
      for (const childCollection of childCollections) {
        await visitCollection(childCollection, rootCollectionName, disposition.action === "delete");
      }
    });
  }

  const rootCollections = await db.listCollections();
  for (const collectionRef of rootCollections) {
    await visitCollection(collectionRef, collectionRef.id, false);
  }

  return {
    records,
    collectionCounts,
    subcollections: [...subcollections].sort(),
    rootCollections: rootCollections.map((collectionRef) => collectionRef.id).sort()
  };
}

function adminSummary(adminDocs, authByUid) {
  return adminDocs.map((document) => {
    const data = document.data();
    const authUser = authByUid.get(document.id);
    return {
      uid: document.id,
      email: authUser?.email || data.email || "",
      fullName: data.fullName || data.name || data.displayName || authUser?.displayName || "",
      role: data.role,
      active: data.active !== false,
      authAccountFound: Boolean(authUser),
      authDisabled: authUser?.disabled === true
    };
  });
}

async function findAdmins(db, authUsers) {
  const usersSnapshot = await db.collection("users").get();
  const adminDocs = usersSnapshot.docs.filter((document) => String(document.data()?.role || "").trim() === "admin");
  if (!adminDocs.length) {
    throw new Error("ABORT: ZERO users documents have role exactly 'admin'. No reset action is allowed.");
  }
  const authByUid = new Map(authUsers.map((user) => [user.uid, user]));
  const summary = adminSummary(adminDocs, authByUid);
  const adminsWithAuth = summary.filter((admin) => admin.authAccountFound);
  if (!adminsWithAuth.length) {
    throw new Error("ABORT: Admin profile documents exist, but none has a matching Firebase Authentication account.");
  }
  return {
    adminDocs,
    admins: summary,
    adminUids: new Set(adminDocs.map((document) => document.id))
  };
}

function printAdmins(admins) {
  console.log("\nADMIN ACCOUNTS TO PRESERVE");
  console.table(admins.map((admin) => ({
    UID: admin.uid,
    Email: admin.email,
    "Full name": admin.fullName,
    Role: admin.role,
    Active: admin.active,
    "Auth account": admin.authAccountFound,
    "Auth disabled": admin.authDisabled
  })));
}

function plannedAuthDeletes(authUsers, adminUids) {
  return authUsers.filter((user) => !adminUids.has(user.uid));
}

function printInventory(inventory, authDeletes) {
  const deleteCounts = new Map();
  const preserveCounts = new Map();
  for (const record of inventory.records) {
    const target = record.action === "delete" ? deleteCounts : preserveCounts;
    target.set(record.collectionPath, (target.get(record.collectionPath) || 0) + 1);
  }

  console.log("\nAUTH USERS TO DELETE");
  console.table(authDeletes.map((user) => ({
    UID: user.uid,
    Email: user.email || "",
    "Display name": user.displayName || "",
    Disabled: user.disabled === true
  })));

  console.log("\nFIRESTORE COLLECTIONS FOUND");
  console.table([...inventory.collectionCounts.entries()].map(([path, count]) => ({
    Collection: path,
    Documents: count,
    "Delete planned": deleteCounts.get(path) || 0,
    Preserved: preserveCounts.get(path) || 0
  })));

  console.log("\nSUBCOLLECTIONS DETECTED");
  if (inventory.subcollections.length) console.table(inventory.subcollections.map((path) => ({ Path: path })));
  else console.log("None detected.");

  const counterRecords = inventory.records.filter((record) => record.rootCollectionName === "counters");
  console.log("\nCOUNTERS");
  if (counterRecords.length) {
    console.table(counterRecords.map((record) => ({
      Path: record.path,
      Action: record.action,
      Reason: record.reason
    })));
  } else {
    console.log("No counter documents found.");
  }

  const preservedUnknown = inventory.records.filter((record) =>
    record.action === "preserve"
    && record.reason === "not in the approved reset target list"
  );
  console.log("\nPRESERVED / REVIEW REQUIRED");
  if (preservedUnknown.length) {
    console.table([...new Set(preservedUnknown.map((record) => record.collectionPath))]
      .map((path) => ({ Collection: path, Reason: "Not an approved reset target" })));
  } else {
    console.log("No unknown collections found.");
  }

  return { deleteCounts, preserveCounts };
}

async function writeBackup({ projectId, mode, authUsers, admins, inventory }) {
  const backupDirectory = resolve("backups", `pre-launch-reset-${isoTimestampForPath()}`);
  await mkdir(backupDirectory, { recursive: true });

  const firestoreLines = inventory.records
    .map((record) => JSON.stringify(record))
    .join("\n");
  await writeFile(resolve(backupDirectory, "firestore.ndjson"), firestoreLines ? `${firestoreLines}\n` : "", "utf8");
  await writeFile(
    resolve(backupDirectory, "auth-users.json"),
    `${JSON.stringify(authUsers.map(publicAuthUser), null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    resolve(backupDirectory, "manifest.json"),
    `${JSON.stringify({
      projectId,
      createdAt: new Date().toISOString(),
      mode,
      adminUids: admins.map((admin) => admin.uid),
      authUserCount: authUsers.length,
      firestoreDocumentCount: inventory.records.length,
      rootCollections: inventory.rootCollections,
      subcollections: inventory.subcollections,
      note: "Auth export contains account metadata only; password hashes and provider secrets are intentionally excluded."
    }, null, 2)}\n`,
    "utf8"
  );

  return backupDirectory;
}

async function requireExecutionConfirmation() {
  if (process.env.CONFIRM_FULL_RESET !== "YES") {
    throw new Error("ABORT: Set CONFIRM_FULL_RESET=YES before --execute.");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("ABORT: --execute requires an interactive terminal.");
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`Type ${REQUIRED_CONFIRMATION} to continue: `);
    if (answer !== REQUIRED_CONFIRMATION) throw new Error("ABORT: Confirmation text did not match.");
  } finally {
    prompt.close();
  }
}

async function deleteFirestoreDocuments(db, inventory) {
  const paths = [...new Set(inventory.records
    .filter((record) => record.action === "delete")
    .map((record) => record.path))]
    .sort((left, right) => right.split("/").length - left.split("/").length);

  const bulkWriter = db.bulkWriter();
  bulkWriter.onWriteError((error) => {
    if (error.failedAttempts < 5) return true;
    console.error(`[RESET] Firestore delete failed after retries: ${error.documentRef.path}`, error.message);
    return false;
  });
  for (const path of paths) bulkWriter.delete(db.doc(path));
  await bulkWriter.close();
  return paths.length;
}

async function deleteAuthUsers(auth, authDeletes) {
  let deleted = 0;
  for (let index = 0; index < authDeletes.length; index += 1000) {
    const batch = authDeletes.slice(index, index + 1000);
    const result = await auth.deleteUsers(batch.map((user) => user.uid));
    if (result.failureCount) {
      const failures = result.errors.map((item) => ({
        uid: batch[item.index]?.uid || "unknown",
        code: item.error?.code || "unknown",
        message: item.error?.message || "unknown error"
      }));
      console.error("Auth deletion failures:", failures);
      throw new Error(`Firebase Auth deletion failed for ${result.failureCount} user(s).`);
    }
    deleted += result.successCount;
  }
  return deleted;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const mode = parseMode(args);
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error("ABORT: Emulator environment variables are set. This utility requires an explicit production project context.");
  }

  const projectId = await projectIdFromRepo();
  const expectedProjectId = process.env.RESET_EXPECTED_PROJECT || "mlsu-library-system";
  if (projectId !== expectedProjectId) {
    throw new Error(`ABORT: Refusing project '${projectId}'. Expected '${expectedProjectId}'.`);
  }

  console.log(`[RESET] Mode: ${mode}`);
  console.log(`[RESET] Firebase project: ${projectId}`);
  const app = initializeApp({ credential: applicationDefault(), projectId });
  const auth = getAuth(app);
  const db = getFirestore(app);

  const authUsers = await listAllAuthUsers(auth);
  const { admins, adminUids } = await findAdmins(db, authUsers);
  printAdmins(admins);

  const authDeletes = plannedAuthDeletes(authUsers, adminUids);
  const inventory = await inventoryFirestore(db, adminUids);
  printInventory(inventory, authDeletes);

  const backupDirectory = await writeBackup({ projectId, mode, authUsers, admins, inventory });
  console.log(`\n[RESET] Local backup created: ${backupDirectory}`);
  console.log(`[RESET] Planned Firestore deletes: ${inventory.records.filter((record) => record.action === "delete").length}`);
  console.log(`[RESET] Planned Auth deletes: ${authDeletes.length}`);

  if (mode === "dry-run") {
    console.log("\n[RESET] DRY RUN COMPLETE. No Firebase writes or deletes were performed.");
    return;
  }

  await requireExecutionConfirmation();
  console.log("\n[RESET] Confirmation accepted. Starting destructive reset...");
  const firestoreDeleted = await deleteFirestoreDocuments(db, inventory);
  const authDeleted = await deleteAuthUsers(auth, authDeletes);

  const remainingAuthUsers = await listAllAuthUsers(auth);
  const postResetAdmins = await findAdmins(db, remainingAuthUsers);
  const postResetInventory = await inventoryFirestore(db, postResetAdmins.adminUids);
  const remainingPlannedDeletes = postResetInventory.records.filter((record) => record.action === "delete");
  const unexpectedAuthUsers = remainingAuthUsers.filter((user) => !postResetAdmins.adminUids.has(user.uid));

  console.log("\nPOST-RESET VERIFICATION");
  console.log(`[RESET] Firestore documents deleted: ${firestoreDeleted}`);
  console.log(`[RESET] Auth users deleted: ${authDeleted}`);
  console.log(`[RESET] Remaining Auth users: ${remainingAuthUsers.length}`);
  console.log(`[RESET] Remaining admin profiles: ${postResetAdmins.admins.length}`);
  console.log(`[RESET] Remaining reset-target documents: ${remainingPlannedDeletes.length}`);
  console.log(`[RESET] Unexpected non-admin Auth users: ${unexpectedAuthUsers.length}`);
  printAdmins(postResetAdmins.admins);

  if (remainingPlannedDeletes.length || unexpectedAuthUsers.length) {
    throw new Error("RESET INCOMPLETE: One or more targeted records remain. Review the post-reset output.");
  }
  console.log("\n[RESET] COMPLETE: Only protected Admin Auth accounts/profiles remain among reset-target identity data.");
}

main().catch((error) => {
  console.error(`\n[RESET] ${error.message}`);
  process.exitCode = 1;
});
