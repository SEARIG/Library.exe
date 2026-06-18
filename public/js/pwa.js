if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js", { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch(console.error);
  });
}

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
