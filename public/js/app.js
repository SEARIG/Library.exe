import { auth, db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function showToast(message, type = "info") {
  const toast = $("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.className = "toast";
  }, 4200);
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
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        window.location.href = "login.html";
        return;
      }

      const profile = await getUserProfile(user.uid);
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
