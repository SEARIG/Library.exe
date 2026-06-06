import { auth, db } from "./firebase.js";
import { $, redirectForRole, setLoading, showToast } from "./app.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  doc,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

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
      const uid = credential.user.uid;
      const common = {
        uid,
        name,
        email,
        phone,
        active: true,
        createdAt: serverTimestamp()
      };

      await setDoc(doc(db, "users", uid), {
        ...common,
        role: "student"
      });

      await setDoc(doc(db, "students", uid), {
        ...common,
        studentId,
        className: $("#className").value.trim(),
        department: $("#department").value.trim(),
        rollNumber: $("#rollNumber").value.trim(),
        idCardBarcode: $("#idCardBarcode").value.trim()
      });

      window.location.href = "student-dashboard.html";
    } catch (error) {
      showToast(error.message, "error");
      setLoading(signupForm, false);
    }
  });
}
