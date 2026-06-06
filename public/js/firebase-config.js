import {
  SDK_VERSION,
  getApp,
  getApps,
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import {
  getAnalytics,
  isSupported as isAnalyticsSupported
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-analytics.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-functions.js";

export const firebaseConfig = Object.freeze({
  apiKey: "AIzaSyDESyc7y76_pSHyqbzKlT8p5zS1h8tYm_0",
  authDomain: "mlsu-library-system.firebaseapp.com",
  projectId: "mlsu-library-system",
  storageBucket: "mlsu-library-system.firebasestorage.app",
  messagingSenderId: "577510512113",
  appId: "1:577510512113:web:5e2b2f09f31b7eabe6e050",
  measurementId: "G-PM5MMMVBKX"
});

const expectedConfig = Object.freeze({
  projectId: "mlsu-library-system",
  authDomain: "mlsu-library-system.firebaseapp.com"
});

function logFirebaseError(error) {
  console.error({
    code: error?.code,
    message: error?.message,
    stack: error?.stack
  });
}

function validateFirebaseConfig(config) {
  const invalidApiKey = config.apiKey === undefined
    || config.apiKey === null
    || String(config.apiKey).trim() === "";

  if (invalidApiKey) {
    throw new Error("Firebase apiKey is missing, empty, null, or undefined.");
  }

  if (config.projectId !== expectedConfig.projectId) {
    throw new Error(`Firebase projectId mismatch. Expected ${expectedConfig.projectId}, received ${config.projectId}.`);
  }

  if (config.authDomain !== expectedConfig.authDomain) {
    throw new Error(`Firebase authDomain mismatch. Expected ${expectedConfig.authDomain}, received ${config.authDomain}.`);
  }
}

function createDiagnostics(status) {
  const activeApp = getApps().length ? getApp() : null;
  const appOptions = activeApp?.options || {};

  return {
    ...status,
    sdkVersion: SDK_VERSION,
    currentDomain: globalThis.location?.hostname || "unknown",
    currentOrigin: globalThis.location?.origin || "unknown",
    projectId: firebaseConfig.projectId,
    authDomain: firebaseConfig.authDomain,
    apiKeyPresent: typeof firebaseConfig.apiKey === "string" && firebaseConfig.apiKey.trim().length > 0,
    apiKeyType: typeof firebaseConfig.apiKey,
    appOptionsProjectId: appOptions.projectId || null,
    appOptionsAuthDomain: appOptions.authDomain || null,
    appOptionsApiKeyPresent: typeof appOptions.apiKey === "string" && appOptions.apiKey.trim().length > 0,
    appOptionsApiKeyMatchesConfig: appOptions.apiKey === firebaseConfig.apiKey,
    appCount: getApps().length
  };
}

let appInstance;
let authInstance;
let dbInstance;
let analyticsInstance = null;
let functionsInstance;
let initializationError = null;

try {
  validateFirebaseConfig(firebaseConfig);
  appInstance = getApps().length ? getApp() : initializeApp(firebaseConfig);
  authInstance = getAuth(appInstance);
  dbInstance = getFirestore(appInstance);
  functionsInstance = getFunctions(appInstance);

  try {
    analyticsInstance = await isAnalyticsSupported() ? getAnalytics(appInstance) : null;
  } catch (error) {
    logFirebaseError(error);
    analyticsInstance = null;
  }

  console.info("Firebase diagnostics", createDiagnostics({
    firebaseInitialized: true,
    authInitialized: Boolean(authInstance),
    firestoreInitialized: Boolean(dbInstance),
    analyticsInitialized: Boolean(analyticsInstance),
    appInitializationSucceeded: true
  }));
} catch (error) {
  initializationError = error;
  logFirebaseError(error);
  console.info("Firebase diagnostics", createDiagnostics({
    firebaseInitialized: false,
    authInitialized: false,
    firestoreInitialized: false,
    analyticsInitialized: false,
    appInitializationSucceeded: false
  }));
  throw error;
}

export const app = appInstance;
export const auth = authInstance;
export const db = dbInstance;
export const analytics = analyticsInstance;
export const functions = functionsInstance;
export const firebaseSdkVersion = SDK_VERSION;
export const firebaseInitializationError = initializationError;
export const firebaseDiagnostics = createDiagnostics({
  firebaseInitialized: Boolean(appInstance),
  authInitialized: Boolean(authInstance),
  firestoreInitialized: Boolean(dbInstance),
  analyticsInitialized: Boolean(analyticsInstance),
  appInitializationSucceeded: Boolean(appInstance)
});

globalThis.__MLSU_FIREBASE_DIAGNOSTICS__ = firebaseDiagnostics;
