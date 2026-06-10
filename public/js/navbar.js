import { auth } from "./firebase-config.js";
import { signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

const roleLinks = {
  student: [
    ["Dashboard", "student-dashboard.html"],
    ["Scan Book", "scan-book.html"],
    ["Issued Books", "student-dashboard.html#issuedBooks"],
    ["Activity", "student-dashboard.html#activityTimeline"],
    ["Penalties", "student-dashboard.html#penalties"],
    ["Library", "library.html"],
  ],
  librarian: [
    ["Dashboard", "librarian-dashboard.html"],
    ["Add Book", "librarian-dashboard.html#addBookModal"],
    ["Book Database", "librarian-dashboard.html#bookDatabaseModal"],
    ["Import Books", "librarian-dashboard.html#bookDatabaseModal"],
    ["Export Books", "librarian-dashboard.html#bookDatabaseModal"],
    ["Barcode Manager", "librarian-dashboard.html#barcodeManagerModal"],
    ["Issue History", "librarian-dashboard.html#issueHistoryModal"],
    ["Return History", "librarian-dashboard.html#returnHistoryModal"],
    ["Reports", "librarian-dashboard.html#librarianReportsModal"]
  ],
  admin: [
    ["Dashboard", "admin-dashboard.html"],
    ["Users", "admin-dashboard.html#userManagementModal"],
    ["Import Students", "admin-dashboard.html#studentImportModal"],
    ["Reports", "admin-dashboard.html#reportsModal"],
    ["Email History", "admin-dashboard.html#emailHistoryModal"],
    ["No Dues", "admin-dashboard.html#noDuesModal"],
    ["Settings", "admin-dashboard.html#settingsModal"]
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
      <button class="nav-toggle" id="navToggle" type="button" aria-expanded="false" aria-controls="appSidebar" aria-label="Open menu">
        <span></span><span></span><span></span>
      </button>
      <a class="brand" href="${homeForRole(currentRole)}">
        <img class="brand-logo" src="assets/mlsu-logo.png" alt="">
        <span>MLSU Library</span>
      </a>
      <span class="current-page-label">${escapeHtml(pageLabel(currentPath))}</span>
      <span class="user-chip">
        <span class="user-name">${escapeHtml(name)}</span>
        <span class="badge">${escapeHtml(currentRole)}</span>
      </span>
      <button id="signOutBtn" type="button">Sign Out</button>
    </div>`;

  let sidebar = document.querySelector("#appSidebar");
  if (!sidebar) {
    sidebar = document.createElement("aside");
    sidebar.id = "appSidebar";
    document.body.append(sidebar);
  }
  let overlay = document.querySelector("#sidebarOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "sidebarOverlay";
    overlay.className = "sidebar-overlay";
    document.body.append(overlay);
  }
  const startsOpen = !window.matchMedia("(max-width: 768px)").matches;
  sidebar.className = startsOpen ? "app-sidebar open" : "app-sidebar";
  document.body.classList.toggle("sidebar-open", startsOpen);
  sidebar.innerHTML = `
    <div class="sidebar-brand">
      <img class="brand-logo" src="assets/mlsu-logo.png" alt="">
      <div>
        <strong>MLSU Library</strong>
        <span>${escapeHtml(currentRole)}</span>
      </div>
    </div>
    <nav class="sidebar-nav" aria-label="Dashboard navigation">
      ${links.map(([label, href]) => `
        <a href="${href}" ${isCurrentLink(currentPath, href) ? 'aria-current="page"' : ""}>${label}</a>
      `).join("")}
    </nav>`;

  const toggle = header.querySelector("#navToggle");
  toggle.addEventListener("click", () => {
    const isOpen = sidebar.classList.toggle("open");
    document.body.classList.toggle("sidebar-open", isOpen);
    toggle.setAttribute("aria-expanded", String(isOpen));
  });
  sidebar.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      sidebar.classList.remove("open");
      document.body.classList.remove("sidebar-open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });
  overlay.addEventListener("click", () => {
    sidebar.classList.remove("open");
    document.body.classList.remove("sidebar-open");
    toggle.setAttribute("aria-expanded", "false");
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
      <button class="nav-toggle" type="button" disabled aria-label="Loading menu"><span></span><span></span><span></span></button>
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

function pageLabel(currentPath) {
  const clean = currentPath.split("?")[0].split("#")[0] || "index.html";
  return clean
    .replace(".html", "")
    .split("-")
    .map((word) => word ? word[0].toUpperCase() + word.slice(1) : "")
    .join(" ");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
