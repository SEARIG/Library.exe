import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

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

console.log("Firebase loaded:", firebaseConfig.projectId, firebaseConfig.apiKey.slice(0, 8));
