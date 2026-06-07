export function showToast(message, type = "info") {
  const displayMessage = friendlyMessage(message);
  let container = document.querySelector("#toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.className = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span>${escapeHtml(displayMessage)}</span>
    <button class="toast-close" type="button" aria-label="Close">×</button>`;

  const close = () => {
    toast.classList.remove("show");
    window.setTimeout(() => toast.remove(), 180);
  };

  toast.querySelector(".toast-close").addEventListener("click", close);
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  window.setTimeout(close, 3000);
}

function friendlyMessage(message) {
  const text = String(message || "");
  const lower = text.toLowerCase();
  if (lower.includes("permission-denied") || lower.includes("permission denied")) {
    return "You do not have permission to perform this action.";
  }
  if (lower.includes("emailjs") && lower.includes("not configured")) {
    return "EmailJS is not configured. Add Public Key, Service ID, and Template ID.";
  }
  return text;
}

export function confirmAction(message) {
  return new Promise((resolve) => {
    let root = document.querySelector("#confirmModalRoot");
    if (!root) {
      root = document.createElement("div");
      root.id = "confirmModalRoot";
      document.body.appendChild(root);
    }

    root.innerHTML = `
      <div class="confirm-backdrop" role="presentation">
        <section class="confirm-modal" role="dialog" aria-modal="true" aria-label="Confirm action">
          <h2>Confirm action</h2>
          <p>${escapeHtml(message)}</p>
          <div class="row-actions">
            <button class="btn btn-muted" data-confirm="cancel" type="button">Cancel</button>
            <button class="btn btn-primary" data-confirm="ok" type="button">Confirm</button>
          </div>
        </section>
      </div>`;

    const finish = (value) => {
      root.innerHTML = "";
      resolve(value);
    };

    root.querySelector("[data-confirm='cancel']").addEventListener("click", () => finish(false));
    root.querySelector("[data-confirm='ok']").addEventListener("click", () => finish(true));
    root.querySelector(".confirm-backdrop").addEventListener("click", (event) => {
      if (event.target.classList.contains("confirm-backdrop")) finish(false);
    });
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
