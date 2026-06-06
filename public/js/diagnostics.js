const target = document.querySelector("#diagnosticsTable");

function logDetailedError(error) {
  console.error({
    code: error?.code,
    message: error?.message,
    stack: error?.stack
  });
}

function row(label, value) {
  return `
    <tr>
      <th>${label}</th>
      <td>${String(value ?? "-")}</td>
    </tr>`;
}

function render(data) {
  target.innerHTML = `
    <table>
      <tbody>
        ${row("Firebase initialized", data.firebaseInitialized ? "Yes" : "No")}
        ${row("Auth initialized", data.authInitialized ? "Yes" : "No")}
        ${row("Firestore initialized", data.firestoreInitialized ? "Yes" : "No")}
        ${row("Current domain", data.currentDomain)}
        ${row("Current origin", data.currentOrigin)}
        ${row("Current Firebase project ID", data.projectId)}
        ${row("Current auth domain", data.authDomain)}
        ${row("Current Firebase SDK version", data.sdkVersion)}
        ${row("API key present", data.apiKeyPresent ? "Yes" : "No")}
        ${row("API key type", data.apiKeyType)}
        ${row("Initialized app project ID", data.appOptionsProjectId)}
        ${row("Initialized app auth domain", data.appOptionsAuthDomain)}
        ${row("Initialized app API key present", data.appOptionsApiKeyPresent ? "Yes" : "No")}
        ${row("Initialized app API key matches config", data.appOptionsApiKeyMatchesConfig ? "Yes" : "No")}
        ${row("Firebase app count", data.appCount)}
        ${row("Analytics initialized", data.analyticsInitialized ? "Yes" : "No")}
        ${row("Initialization error", data.errorMessage || "-")}
      </tbody>
    </table>`;
}

try {
  const module = await import("./firebase-config.js");
  render(module.firebaseDiagnostics);
} catch (error) {
  logDetailedError(error);
  render({
    firebaseInitialized: false,
    authInitialized: false,
    firestoreInitialized: false,
    currentDomain: window.location.hostname,
    currentOrigin: window.location.origin,
    projectId: "unknown",
    authDomain: "unknown",
    sdkVersion: "unknown",
    apiKeyPresent: false,
    apiKeyType: "unknown",
    appCount: 0,
    analyticsInitialized: false,
    errorMessage: error.message
  });
}
