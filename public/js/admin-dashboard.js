import { db } from "./firebase.js";
import {
  $,
  escapeHtml,
  renderEmpty,
  requireAuth,
  showToast,
  statusBadge,
  wireSignOut
} from "./app.js";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

wireSignOut();
await requireAuth(["admin"]);

const metrics = {
  users: $("#metricUsers"),
  books: $("#metricBooks"),
  pending: $("#metricPending"),
  issued: $("#metricIssued")
};

onSnapshot(collection(db, "users"), (snap) => metrics.users.textContent = snap.size);
onSnapshot(collection(db, "books"), (snap) => metrics.books.textContent = snap.size);
onSnapshot(collection(db, "issueRequests"), (snap) => {
  metrics.pending.textContent = snap.docs.filter((item) => item.data().status === "pending").length;
});
onSnapshot(collection(db, "bookIssues"), (snap) => {
  metrics.issued.textContent = snap.docs.filter((item) => item.data().status === "issued").length;
});

onSnapshot(query(collection(db, "users"), orderBy("createdAt", "desc"), limit(50)), (snap) => {
  const target = $("#usersTable");
  if (snap.empty) {
    renderEmpty(target, "No users found.");
    return;
  }
  target.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>User</th>
          <th>Role</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${snap.docs.map((item) => {
          const user = item.data();
          return `
            <tr data-user-id="${item.id}">
              <td><strong>${escapeHtml(user.name)}</strong><span>${escapeHtml(user.email)}</span></td>
              <td>
                <select data-field="role">
                  ${["student", "librarian", "admin"].map((role) =>
                    `<option value="${role}" ${role === user.role ? "selected" : ""}>${role}</option>`
                  ).join("")}
                </select>
              </td>
              <td>${statusBadge(user.active ? "active" : "inactive")}</td>
              <td>
                <button class="btn btn-muted" data-action="toggle">${user.active ? "Deactivate" : "Activate"}</button>
                <button class="btn btn-primary" data-action="save">Save</button>
              </td>
            </tr>`;
        }).join("")}
      </tbody>
    </table>`;
});

$("#usersTable").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const row = button.closest("[data-user-id]");
  const uid = row.dataset.userId;
  try {
    if (button.dataset.action === "save") {
      await updateDoc(doc(db, "users", uid), {
        role: row.querySelector("[data-field='role']").value
      });
      showToast("Role updated.", "success");
    } else {
      const isActive = !row.textContent.includes("Deactivate");
      await updateDoc(doc(db, "users", uid), { active: isActive });
      showToast("Account status updated.", "success");
    }
  } catch (error) {
    showToast(error.message, "error");
  }
});
