import { auth, db } from "./firebase-config.js";
import "./push-notifications.js";
import { renderNavbar, renderNavbarSkeleton } from "./navbar.js";
import { showToast } from "./toast.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export { showToast } from "./toast.js";
export { confirmAction } from "./toast.js";

function ensureAuthLoadingScreen() {
  if (!document.body.classList.contains("protected-page")) return null;
  renderNavbarSkeleton();
  let screen = $("#authLoadingScreen");
  if (!screen) {
    screen = document.createElement("div");
    screen.id = "authLoadingScreen";
    screen.className = "auth-loading-screen";
    screen.textContent = "Loading dashboard...";
    document.body.prepend(screen);
  }
  return screen;
}

function revealProtectedContent() {
  document.body.classList.add("auth-ready");
  $("#authLoadingScreen")?.remove();
}

export function logDetailedError(error) {
  console.error({
    code: error?.code,
    message: error?.message,
    stack: error?.stack
  });
}

export function formatDate(value) {
  if (!value) return "-";
  const date = value.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString();
}

export function setLoading(form, isLoading) {
  $$("button, input, select, textarea", form).forEach((field) => {
    field.disabled = isLoading;
  });
}

export async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

export function roleHome(role) {
  if (role === "admin") return "admin-dashboard.html";
  if (role === "librarian") return "librarian-dashboard.html";
  return "student-dashboard.html";
}

export async function redirectForRole(user) {
  const profile = await getUserProfile(user.uid);
  if (!profile || profile.active === false) {
    await signOut(auth);
    throw new Error("Your account is not active. Contact the library administrator.");
  }
  window.location.href = roleHome(profile.role);
}

export function requireAuth(allowedRoles = []) {
  ensureAuthLoadingScreen();
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        window.location.href = "login.html";
        return;
      }

      let profile;
      try {
        profile = await getUserProfile(user.uid);
      } catch (error) {
        logDetailedError(error);
        await signOut(auth);
        window.location.href = "login.html";
        return;
      }
      if (!profile || profile.active === false) {
        await signOut(auth);
        window.location.href = "login.html";
        return;
      }

      if (allowedRoles.length && !allowedRoles.includes(profile.role)) {
        window.location.href = roleHome(profile.role);
        return;
      }

      const nameTarget = $("#currentUserName");
      const roleTarget = $("#currentUserRole");
      if (nameTarget) nameTarget.textContent = profile.name || user.email;
      if (roleTarget) roleTarget.textContent = profile.role;
      renderNavbar(profile.role, { ...profile, email: user.email });
      revealProtectedContent();
      resolve({ user, profile });
    });
  });
}

export function wireSignOut() {
  const button = $("#signOutBtn");
  if (!button) return;
  button.addEventListener("click", async () => {
    await signOut(auth);
    window.location.href = "login.html";
  });
}

export function statusBadge(status) {
  const clean = String(status || "unknown");
  return `<span class="badge badge-${clean}">${clean}</span>`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function renderEmpty(target, label) {
  target.innerHTML = `<div class="empty">${label}</div>`;
}
