import { auth, db } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

const loginForm = document.querySelector("#loginForm");
const signupForm = document.querySelector("#signupForm");
const logoutButton = document.querySelector("#logoutBtn, #signOutBtn");
const messageBox = document.querySelector("#authMessage");

function showMessage(message, type = "error") {
  if (messageBox) {
    messageBox.textContent = message;
    messageBox.className = `auth-message ${type}`;
  }
}

function setLoading(form, isLoading) {
  if (!form) return;
  form.querySelectorAll("button, input, select, textarea").forEach((field) => {
    field.disabled = isLoading;
  });
}

function logError(error) {
  console.error({
    code: error?.code,
    message: error?.message,
    stack: error?.stack
  });
}

function roleRedirect(role) {
  if (role === "admin") return "admin-dashboard.html";
  if (role === "librarian") return "librarian-dashboard.html";
  return "student-dashboard.html";
}

async function getUserRole(uid) {
  const userSnap = await getDoc(doc(db, "users", uid));
  if (!userSnap.exists()) {
    throw new Error("User profile not found. Contact the library administrator.");
  }
  const userData = userSnap.data();
  if (userData.active === false) {
    throw new Error("Your account is inactive. Contact the library administrator.");
  }
  return userData.role || "student";
}

if (signupForm) {
  signupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage("");
    setLoading(signupForm, true);

    try {
      const name = document.querySelector("#name").value.trim();
      const email = document.querySelector("#email").value.trim();
      const phone = document.querySelector("#phone").value.trim();
      const password = document.querySelector("#password").value;
      const rollNumber = document.querySelector("#rollNumber").value.trim();
      const department = document.querySelector("#department").value.trim();
      const className = document.querySelector("#className").value.trim();

      const credential = await createUserWithEmailAndPassword(auth, email, password);
      const uid = credential.user.uid;

      await setDoc(doc(db, "users", uid), {
        uid,
        role: "student",
        name,
        email,
        phone,
        createdAt: serverTimestamp(),
        active: true
      });

      await setDoc(doc(db, "students", uid), {
        uid,
        rollNumber,
        name,
        email,
        phone,
        department,
        className,
        createdAt: serverTimestamp()
      });

      showMessage("Signup successful. Redirecting...", "success");
      window.location.href = "student-dashboard.html";
    } catch (error) {
      logError(error);
      showMessage(error.message || "Signup failed. Please try again.");
    } finally {
      setLoading(signupForm, false);
    }
  });
}

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage("");
    setLoading(loginForm, true);

    try {
      const email = document.querySelector("#email").value.trim();
      const password = document.querySelector("#password").value;
      const credential = await signInWithEmailAndPassword(auth, email, password);
      const role = await getUserRole(credential.user.uid);
      window.location.href = roleRedirect(role);
    } catch (error) {
      logError(error);
      showMessage(error.message || "Login failed. Please check your credentials.");
    } finally {
      setLoading(loginForm, false);
    }
  });
}

if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    try {
      await signOut(auth);
      window.location.href = "login.html";
    } catch (error) {
      logError(error);
      showMessage(error.message || "Logout failed.");
    }
  });
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    console.log("Auth state: signed in", user.uid);
  } else {
    console.log("Auth state: signed out");
  }
});
