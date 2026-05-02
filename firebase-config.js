import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import {
  getAuth
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  getFirestore
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import {
  getStorage
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

/* ===========================================
   REPLACE BELOW WITH YOUR FIREBASE CONFIG
   =========================================== */

const firebaseConfig = {
  apiKey: "AIzaSyCq7vna8a7rMU8xD9lC73q8z-J4rvukqC4",
  authDomain: "medicare-app-94faa.firebaseapp.com",
  databaseURL: "https://medicare-app-94faa-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "medicare-app-94faa",
  storageBucket: "medicare-app-94faa.firebasestorage.app",
  messagingSenderId: "863064484800",
  appId: "1:863064484800:web:01f8ce88bec0a1a8887625",
  measurementId: "G-QEPYVM8ENC"
};

/* =========================================== */

const app = initializeApp(firebaseConfig);

const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

export { auth, db, storage };