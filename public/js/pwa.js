let deferredInstallPrompt = null;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js", { updateViaCache: "none" })
      .then((registration) => {
        console.log("PWA service worker registered");
        return registration.update();
      })
      .catch((error) => console.error("PWA service worker registration failed:", error));
  });
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  const installButton = document.getElementById("installAppBtn");
  if (installButton) installButton.style.display = "inline-flex";
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  const installButton = document.getElementById("installAppBtn");
  if (installButton) installButton.style.display = "none";
});

async function installPWA() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  const installButton = document.getElementById("installAppBtn");
  if (installButton) installButton.style.display = "none";
}

window.installPWA = installPWA;

document.querySelectorAll("[data-mobile-menu-toggle]").forEach((button) => {
  const menuId = button.getAttribute("aria-controls");
  const menu = menuId ? document.getElementById(menuId) : null;
  if (!menu) return;

  const closeMenu = () => {
    menu.classList.remove("open");
    button.setAttribute("aria-expanded", "false");
  };

  button.addEventListener("click", () => {
    const isOpen = menu.classList.toggle("open");
    button.setAttribute("aria-expanded", String(isOpen));
  });
  menu.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));
  window.addEventListener("resize", () => {
    if (window.innerWidth > 640) closeMenu();
  });
});
