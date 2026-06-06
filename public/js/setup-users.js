import { app } from "./firebase-config.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";

const functions = getFunctions(app);
const statusTarget = document.querySelector("#setupStatus");
const adminButton = document.querySelector("#createAdminBtn");
const librarianButton = document.querySelector("#createLibrarianBtn");

const getDefaultUsersStatus = httpsCallable(functions, "getDefaultUsersStatus");
const setupDefaultUser = httpsCallable(functions, "setupDefaultUser");

function logSetupError(error) {
  console.error({
    code: error?.code,
    message: error?.message,
    stack: error?.stack
  });
}

function setMessage(message, type = "info") {
  statusTarget.textContent = message;
  statusTarget.className = `auth-message ${type}`;
}

function setLoading(button, isLoading) {
  button.disabled = isLoading;
  button.dataset.loading = String(isLoading);
}

function updateButtons(status) {
  adminButton.disabled = Boolean(status.admin?.authExists && status.admin?.profileExists);
  librarianButton.disabled = Boolean(status.librarian?.authExists && status.librarian?.profileExists);
  adminButton.textContent = adminButton.disabled ? "Admin Already Exists" : "Create Default Admin";
  librarianButton.textContent = librarianButton.disabled ? "Librarian Already Exists" : "Create Default Librarian";
}

async function refreshStatus() {
  console.log("Loading default user setup status");
  const result = await getDefaultUsersStatus();
  console.log("Default user setup status", result.data);
  updateButtons(result.data);
  return result.data;
}

async function createDefaultUser(type, button) {
  setLoading(button, true);
  setMessage(`Creating ${type} account...`, "info");
  try {
    console.log("Creating default user", { type });
    const result = await setupDefaultUser({ type });
    console.log("Default user created", result.data);
    setMessage(`${result.data.role} setup complete for ${result.data.email}.`, "success");
    await refreshStatus();
  } catch (error) {
    logSetupError(error);
    setMessage(error.message || `Failed to create ${type}.`, "error");
    setLoading(button, false);
  }
}

adminButton.addEventListener("click", () => createDefaultUser("admin", adminButton));
librarianButton.addEventListener("click", () => createDefaultUser("librarian", librarianButton));

refreshStatus().catch((error) => {
  logSetupError(error);
  setMessage(error.message || "Could not load setup status.", "error");
});
