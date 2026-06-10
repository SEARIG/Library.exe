import { auth } from "./firebase-config.js";
import { signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

const roleLinks = {
  student: [
    ["Dashboard", "student-dashboard.html"],
    ["Library", "library.html"],
    ["Scan Book", "scan-book.html"],
    ["Books", "books.html"],
    ["My Issued Books", "student-dashboard.html#issuedBooks"]
  ],
  librarian: [
    ["Dashboard", "librarian-dashboard.html"],
    ["Library", "library.html"],
    ["Add/Manage Books", "librarian-dashboard.html#addBookForm"],
    ["Pending Requests", "librarian-dashboard.html#pendingRequests"],
    ["Active Issues", "librarian-dashboard.html#activeIssues"],
    ["Return Scan", "scan-book.html?mode=return"],
    ["Books", "books.html"]
  ],
  admin: [
    ["Admin Dashboard", "admin-dashboard.html"],
    ["Librarian Dashboard", "librarian-dashboard.html"],
    ["Library", "library.html"],
    ["Books", "books.html"],
    ["Users", "admin-dashboard.html#usersTable"],
    ["Reports", "admin-dashboard.html#recentActivity"]
  ]
};

export function renderNavbar(currentRole, currentUserData = {}) {
  const header = document.querySelector(".app-header");
  if (!header) return;

  const links = roleLinks[currentRole] || [];
  const name = currentUserData.name || currentUserData.email || "Library User";
  const currentPath = `${location.pathname.split("/").pop() || "index.html"}${location.search}`;

  header.innerHTML = `
    <div class="header-inner">
      <a class="brand" href="${homeForRole(currentRole)}">
        <img class="brand-logo" src="assets/mlsu-logo.png" alt="">
        <span>MLSU Library</span>
      </a>
      <button class="nav-toggle" id="navToggle" type="button" aria-expanded="false" aria-controls="mainNav">
        <span></span><span></span><span></span>
      </button>
      <nav class="nav" id="mainNav">
        <div class="nav-links">
          ${links.map(([label, href]) => `
            <a href="${href}" ${isCurrentLink(currentPath, href) ? 'aria-current="page"' : ""}>${label}</a>
          `).join("")}
        </div>
        <span class="user-chip">
          <span class="user-name">${escapeHtml(name)}</span>
          <span class="badge">${escapeHtml(currentRole)}</span>
        </span>
        <button id="signOutBtn" type="button">Sign Out</button>
      </nav>
    </div>`;

  const toggle = header.querySelector("#navToggle");
  const nav = header.querySelector("#mainNav");
  toggle.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(isOpen));
  });
  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      nav.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });
  header.querySelector("#signOutBtn").addEventListener("click", async () => {
    await signOut(auth);
    window.location.href = "login.html";
  });
}

export function renderNavbarSkeleton() {
  const header = document.querySelector(".app-header");
  if (!header) return;
  header.innerHTML = `
    <div class="header-inner">
      <a class="brand" href="index.html">
        <img class="brand-logo" src="assets/mlsu-logo.png" alt="">
        <span>MLSU Library</span>
      </a>
      <div class="nav-skeleton"><span></span><span></span><span></span></div>
    </div>`;
}

function homeForRole(role) {
  if (role === "admin") return "admin-dashboard.html";
  if (role === "librarian") return "librarian-dashboard.html";
  return "student-dashboard.html";
}

function isCurrentLink(currentPath, href) {
  return href.split("#")[0] === currentPath || href.split("?")[0] === currentPath.split("?")[0];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
