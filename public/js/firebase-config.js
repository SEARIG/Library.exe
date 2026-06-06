import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-analytics.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyDESyc7y76_pSHyqbzKlT8p5zS1h8tYm_0",
  authDomain: "mlsu-library-system.firebaseapp.com",
  projectId: "mlsu-library-system",
  storageBucket: "mlsu-library-system.firebasestorage.app",
  messagingSenderId: "577510512113",
  appId: "1:577510512113:web:5e2b2f09f31b7eabe6e050",
  measurementId: "G-PM5MMMVBKX"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const analytics = getAnalytics(app);
export const functions = getFunctions(app);
