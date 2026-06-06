const path = require("path");

let admin;
try {
  admin = require("firebase-admin");
} catch (error) {
  admin = require(path.join(__dirname, "functions", "node_modules", "firebase-admin"));
}

const DEFAULT_USERS = [
  {
    email: "admin@123.com",
    password: "1332Admin!",
    role: "admin",
    name: "System Administrator"
  },
  {
    email: "librarian@123.com",
    password: "1334Librarian!",
    role: "librarian",
    name: "Library Staff"
  }
];

function initializeAdmin() {
  if (admin.apps.length) return;

  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (serviceAccountPath) {
    const serviceAccount = require(path.resolve(serviceAccountPath));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: "mlsu-library-system"
    });
    return;
  }

  admin.initializeApp({
    projectId: "mlsu-library-system"
  });
}

async function getUserByEmail(email) {
  try {
    return await admin.auth().getUserByEmail(email);
  } catch (error) {
    if (error.code === "auth/user-not-found") return null;
    throw error;
  }
}

async function ensureUser(defaultUser) {
  let authUser = await getUserByEmail(defaultUser.email);
  let authCreated = false;

  if (!authUser) {
    authUser = await admin.auth().createUser({
      email: defaultUser.email,
      password: defaultUser.password,
      displayName: defaultUser.name,
      emailVerified: true,
      disabled: false
    });
    authCreated = true;
  }

  const userRef = admin.firestore().doc(`users/${authUser.uid}`);
  const userSnap = await userRef.get();
  const profile = {
    uid: authUser.uid,
    email: defaultUser.email,
    role: defaultUser.role,
    name: defaultUser.name,
    active: true
  };

  if (userSnap.exists) {
    await userRef.set(profile, { merge: true });
  } else {
    await userRef.set({
      ...profile,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  return {
    email: defaultUser.email,
    role: defaultUser.role,
    uid: authUser.uid,
    authCreated,
    profileCreated: !userSnap.exists
  };
}

async function main() {
  initializeAdmin();
  console.log("Creating default MLSU Library users...");
  const results = [];
  for (const user of DEFAULT_USERS) {
    results.push(await ensureUser(user));
  }
  console.table(results);
}

main()
  .catch((error) => {
    console.error({
      code: error.code,
      message: error.message,
      stack: error.stack
    });
    process.exitCode = 1;
  });
