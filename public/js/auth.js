import { auth } from "./firebase-config.js";
import { $, logDetailedError, redirectForRole, setLoading, showToast } from "./app.js";
import { createStudentProfile } from "./firestore-service.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";

const loginForm = $("#loginForm");
if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setLoading(loginForm, true);
    try {
      const email = $("#email").value.trim();
      const password = $("#password").value;
      const credential = await signInWithEmailAndPassword(auth, email, password);
      await redirectForRole(credential.user);
    } catch (error) {
      logDetailedError(error);
      showToast(error.message, "error");
      setLoading(loginForm, false);
    }
  });
}

const signupForm = $("#signupForm");
if (signupForm) {
  signupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setLoading(signupForm, true);
    try {
      const email = $("#email").value.trim();
      const password = $("#password").value;
      const name = $("#name").value.trim();
      const phone = $("#phone").value.trim();
      const studentId = $("#studentId").value.trim();
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      await createStudentProfile(credential.user.uid, {
        name,
        email,
        phone,
        studentId,
        department: $("#department").value.trim(),
        course: $("#course").value.trim()
      });

      window.location.href = "student-dashboard.html";
    } catch (error) {
      logDetailedError(error);
      showToast(error.message, "error");
      setLoading(signupForm, false);
    }
  });
}
