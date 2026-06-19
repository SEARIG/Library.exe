import { auth, authPersistenceReady, db } from "./firebase-config.js";
import { showToast } from "./toast.js";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
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
const forgotPasswordButton = document.querySelector("#forgotPasswordBtn");

await authPersistenceReady;

document.querySelectorAll(".password-toggle").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.target);
    if (!input) return;
    const shouldShow = input.type === "password";
    input.type = shouldShow ? "text" : "password";
    button.textContent = shouldShow ? "Hide" : "Show";
  });
});

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
  if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"].includes(error?.code)) {
    console.warn("Authentication rejected. Check the email/password or reset the password.");
    return;
  }
  console.error({
    code: error?.code,
    message: error?.message,
    stack: error?.stack
  });
}

function authErrorMessage(error, context = "login") {
  const code = String(error?.code || "");
  const messages = {
    "auth/invalid-credential": "The email or password is incorrect. Use Forgot Password if this account was recently reset.",
    "auth/wrong-password": "The email or password is incorrect. Use Forgot Password to create a new password.",
    "auth/user-not-found": "No account exists for this email address.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/too-many-requests": "Too many attempts. Wait a few minutes or reset your password.",
    "auth/network-request-failed": "Unable to reach Firebase. Check your internet connection and try again.",
    "auth/email-already-in-use": "An account already exists for this email address.",
    "auth/weak-password": "Use a password with at least 6 characters."
  };
  return messages[code] || error?.message || `${context === "signup" ? "Signup" : "Login"} failed. Please try again.`;
}

function roleRedirect(role) {
  if (role === "admin") return "admin-dashboard.html";
  if (role === "librarian") return "librarian-dashboard.html";
  if (role === "student") return "student-dashboard.html";
  return "login.html";
}

async function getUserRole(uid) {
  const userSnap = await getDoc(doc(db, "users", uid));
  if (!userSnap.exists()) {
    throw new Error("User profile not found. Contact the library administrator.");
  }
  const userData = userSnap.data();
  if (userData.active === false || userData.status === "suspended" || userData.status === "inactive") {
    throw new Error("Your account is inactive. Contact the library administrator.");
  }
  if (!["student", "librarian", "admin"].includes(userData.role)) {
    throw new Error("Your account does not have a supported library role. Contact the library administrator.");
  }
  return userData.role;
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
      const year = document.querySelector("#year").value.trim();

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
        year,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      showMessage("Signup successful. Redirecting...", "success");
      showToast("Signup successful. Redirecting...", "success");
      window.location.href = "student-dashboard.html";
    } catch (error) {
      logError(error);
      const message = authErrorMessage(error, "signup");
      showMessage(message);
      showToast(message, "error");
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
      await authPersistenceReady;
      const credential = await signInWithEmailAndPassword(auth, email, password);
      const role = await getUserRole(credential.user.uid);
      window.location.href = roleRedirect(role);
    } catch (error) {
      logError(error);
      const message = authErrorMessage(error);
      showMessage(message);
      showToast(message, "error");
    } finally {
      setLoading(loginForm, false);
    }
  });
}

if (forgotPasswordButton) {
  forgotPasswordButton.addEventListener("click", async () => {
    const emailInput = document.querySelector("#email");
    const email = emailInput?.value.trim() || "";
    if (!email) {
      showMessage("Enter your email address, then select Forgot Password.");
      emailInput?.focus();
      return;
    }

    forgotPasswordButton.disabled = true;
    try {
      await sendPasswordResetEmail(auth, email);
      const message = "Password reset email sent. Check your inbox and spam folder.";
      showMessage(message, "success");
      showToast(message, "success");
    } catch (error) {
      logError(error);
      const message = authErrorMessage(error);
      showMessage(message);
      showToast(message, "error");
    } finally {
      forgotPasswordButton.disabled = false;
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
      showToast(error.message || "Logout failed.", "error");
    }
  });
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    console.log("Auth state: signed in", user.uid);
    if (loginForm) {
      try {
        const role = await getUserRole(user.uid);
        window.location.href = roleRedirect(role);
      } catch (error) {
        logError(error);
        const message = authErrorMessage(error);
        showMessage(message);
      }
    }
  } else {
    console.log("Auth state: signed out");
  }
});
