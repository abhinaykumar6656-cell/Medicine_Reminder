import { auth, db, storage } from "./firebase-config.js";

import {
  collection,
  addDoc,
  setDoc,
  getDoc,
  doc,
  query,
  where,
  onSnapshot,
  orderBy,
  updateDoc,
  deleteDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const $ = (id) => document.getElementById(id);

let currentUser = null;
let chartRef = null;
let voiceRecorder = null;
let voiceChunks = [];
let recordedVoiceBlob = null;
let isVoiceFinalizing = false;

const STORAGE_UPLOAD_TIMEOUT_MS = 8000;
const FIRESTORE_ATTACHMENT_LIMIT = 750 * 1024;

/* -------------------- HELPERS -------------------- */
function toast(msg) {
  alert(msg);
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeFilePart(value = "") {
  return String(value).replace(/[^a-z0-9._-]/gi, "_");
}

function normalizeEmail(value = "") {
  return String(value).trim().toLowerCase();
}

function setChatStatus(message) {
  if ($("chatStatus")) $("chatStatus").innerText = message;
}

function voiceBlobToFile(blob) {
  const type = blob.type || "audio/webm";
  const extension = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm";
  return new File([blob], `voice-message-${Date.now()}.${extension}`, { type });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read attachment."));
    reader.readAsDataURL(file);
  });
}

function compressImageForFirestore(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);

      const maxSize = 900;
      const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));

      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Could not compress image."));
            return;
          }

          resolve(new File([blob], safeFilePart(file.name || "image.jpg"), { type: "image/jpeg" }));
        },
        "image/jpeg",
        0.68
      );
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not prepare image."));
    };

    image.src = objectUrl;
  });
}

async function makeFirestoreAttachment(file, kind) {
  const preparedFile = kind === "image" ? await compressImageForFirestore(file) : file;
  const dataUrl = await readFileAsDataUrl(preparedFile);

  if (dataUrl.length > FIRESTORE_ATTACHMENT_LIMIT) {
    throw new Error("Firebase Storage is not responding and this attachment is too large for the database fallback.");
  }

  return {
    dataUrl,
    name: file.name || (kind === "audio" ? "Voice message" : "Attachment"),
    contentType: preparedFile.type || file.type || "application/octet-stream",
    storage: "firestore"
  };
}

async function makeChatAttachment(file, doctorEmail, folder, kind) {
  try {
    return {
      url: await uploadChatFile(file, doctorEmail, folder),
      name: file.name || (kind === "audio" ? "Voice message" : "Attachment"),
      contentType: file.type || "application/octet-stream",
      storage: "firebase-storage"
    };
  } catch (error) {
    setChatStatus("Storage upload failed. Saving attachment in database...");
    return await makeFirestoreAttachment(file, kind);
  }
}

/* -------------------- UI -------------------- */
window.toggleDark = () => {
  document.body.classList.toggle("dark");
};

document.addEventListener("DOMContentLoaded", () => {
  $("sendPatientBtn")?.addEventListener("click", window.sendPatientMessage);
  $("sendDoctorBtn")?.addEventListener("click", window.sendDoctorMessage);
});

window.logoutUser = async function () {
  try {
    await signOut(auth);
    sessionStorage.clear();
    localStorage.removeItem("user");
    window.location.replace("login.html");
  } catch (error) {
    alert("Logout failed: " + error.message);
  }
};

/* -------------------- AUTH -------------------- */
window.signupUser = async () => {
  try {
    const email = $("email")?.value.trim();
    const password = $("password")?.value.trim();
    const role = $("role")?.value;

    if (!email || !password || !role) {
      if ($("authMsg")) $("authMsg").innerText = "Please fill all fields.";
      return;
    }

    const cred = await createUserWithEmailAndPassword(auth, email, password);

    await setDoc(doc(db, "users", cred.user.uid), {
      email,
      role,
      createdAt: new Date().toISOString()
    });

    location.href = "login.html";
  } catch (err) {
    if ($("authMsg")) $("authMsg").innerText = err.message;
  }
};

window.loginUser = async () => {
  try {
    const email = $("email")?.value.trim();
    const password = $("password")?.value.trim();

    const cred = await signInWithEmailAndPassword(auth, email, password);
    const snap = await getDoc(doc(db, "users", cred.user.uid));
    const role = snap.data()?.role || "patient";

    location.href =
      role === "doctor"
        ? "doctor-dashboard.html"
        : "patient-dashboard.html";
  } catch (err) {
    if ($("authMsg")) $("authMsg").innerText = err.message;
  }
};

/* -------------------- SESSION -------------------- */
onAuthStateChanged(auth, async (user) => {
  const page = location.pathname.split("/").pop();

  const publicPages = ["", "index.html", "login.html", "signup.html"];

  if (!user) {
    if (!publicPages.includes(page)) {
      location.href = "login.html";
    }
    return;
  }

  currentUser = user;

  if (publicPages.includes(page)) return;

  const snap = await getDoc(doc(db, "users", user.uid));
  const role = snap.data()?.role || "patient";

  if (role === "doctor") {
    const allowed = ["doctor-dashboard.html", "doctor-profile.html"];

    if (!allowed.includes(page)) {
      location.href = "doctor-dashboard.html";
      return;
    }

    if ($("welcomeDoctor")) $("welcomeDoctor").innerText = user.email;

    loadDoctorStats();
    listenDoctorPrescriptions();
    loadDoctorPatientReports();
    loadDoctorHealthReports();
    loadDoctorAppointments();
    listenChats();
    loadProfile();
  } else {
    const allowed = ["patient-dashboard.html", "patient-profile.html"];

    if (!allowed.includes(page)) {
      location.href = "patient-dashboard.html";
      return;
    }

    if ($("welcomePatient")) $("welcomePatient").innerText = user.email;

    listenPatientPrescriptions();
    loadPatientDetailedReport();
    loadPatientHealthReports();
    renderCalendar();
    loadMyAppointments();
    listenChats();
    loadProfile();
  }
});

/* -------------------- PRESCRIPTIONS -------------------- */
window.addPrescription = async () => {
  try {
    const patientEmail = $("patientEmail")?.value.trim();
    const medicine = $("mname")?.value.trim();
    const dosage = $("dose")?.value.trim();
    const time = $("time")?.value;
    const days = $("days")?.value;

    if (!patientEmail || !medicine || !dosage || !time || !days) {
      toast("Fill all fields");
      return;
    }

    await addDoc(collection(db, "prescriptions"), {
      doctorEmail: currentUser.email,
      patientEmail,
      medicine,
      dosage,
      time,
      days,
      status: "Pending",
      createdAt: serverTimestamp()
    });

    toast("Prescription added");
  } catch (err) {
    toast(err.message);
  }
};

function listenPatientPrescriptions() {
  if (!$("medicineList")) return;

  const q = query(
    collection(db, "prescriptions"),
    where("patientEmail", "==", currentUser.email)
  );

  onSnapshot(q, (snap) => {
    $("medicineList").innerHTML = "";

    let total = 0;
    let taken = 0;
    let missed = 0;

    snap.forEach((d) => {
      const x = d.data();
      total++;

      if (x.status === "Taken") taken++;
      if (x.status === "Missed") missed++;

      $("medicineList").innerHTML += `
        <div class="medicineItem">
          <strong>${x.medicine}</strong><br>
          ${x.dosage} • ${x.time} • ${x.days} days
          <div class="status">${x.status}</div>

          <div class="row">
            <button onclick="markTaken('${d.id}')">Taken</button>
            <button class="danger" onclick="markMissed('${d.id}')">Missed</button>
          </div>
        </div>
      `;
    });

    if ($("patientTotalMeds")) $("patientTotalMeds").innerText = total;
    if ($("patientTaken")) $("patientTaken").innerText = taken;
    if ($("patientMissed")) $("patientMissed").innerText = missed;

    const percent = total ? Math.round((taken / total) * 100) : 0;
    if ($("reportText")) $("reportText").innerText = "Adherence: " + percent + "%";

    updateChart(taken, missed);
  });
}

function listenDoctorPrescriptions() {
  if (!$("allPrescriptions")) return;

  const q = query(
    collection(db, "prescriptions"),
    where("doctorEmail", "==", currentUser.email)
  );

  onSnapshot(q, (snap) => {
    $("allPrescriptions").innerHTML = "";

    snap.forEach((d) => {
      const x = d.data();

      $("allPrescriptions").innerHTML += `
        <div class="medicineItem">
          <strong>${x.patientEmail}</strong><br>
          ${x.medicine} • ${x.dosage}<br>
          Time: ${x.time} • ${x.days} days

          <div class="row">
            <button onclick="editPrescription('${d.id}','${x.medicine}','${x.dosage}','${x.time}','${x.days}')">✏️ Edit</button>
            <button class="danger" onclick="deleteRx('${d.id}')">Delete</button>
          </div>
        </div>
      `;
    });
  });
}

window.markTaken = async (id) => {
  await updateDoc(doc(db, "prescriptions", id), { status: "Taken" });
};

window.markMissed = async (id) => {
  await updateDoc(doc(db, "prescriptions", id), { status: "Missed" });
};

/* -------------------- EDIT / DELETE -------------------- */
window.editPrescription = (id, medicine, dose, time, days) => {
  if (!$("editModal")) return;

  $("editId").value = id;
  $("editMedicine").value = medicine;
  $("editDose").value = dose;
  $("editTime").value = time;
  $("editDays").value = days;

  $("editModal").classList.add("show");
};

window.closeEditModal = () => {
  $("editModal")?.classList.remove("show");
};

window.saveEditedPrescription = async () => {
  try {
    const id = $("editId").value;

    await updateDoc(doc(db, "prescriptions", id), {
      medicine: $("editMedicine").value.trim(),
      dosage: $("editDose").value.trim(),
      time: $("editTime").value,
      days: $("editDays").value
    });

    closeEditModal();
    toast("Prescription updated");
  } catch (err) {
    toast(err.message);
  }
};

window.deleteRx = (id) => {
  $("deleteId").value = id;
  $("deleteModal").classList.add("show");
};

window.closeDeleteModal = () => {
  $("deleteModal")?.classList.remove("show");
};

window.confirmDeleteRx = async () => {
  try {
    const id = $("deleteId").value;
    await deleteDoc(doc(db, "prescriptions", id));
    closeDeleteModal();
    toast("Prescription deleted");
  } catch (err) {
    toast(err.message);
  }
};

/* -------------------- REPORTS -------------------- */
function loadPatientDetailedReport() {
  if (!$("patientReportDetails")) return;

  const q = query(
    collection(db, "prescriptions"),
    where("patientEmail", "==", currentUser.email)
  );

  onSnapshot(q, (snap) => {
    let total = 0, taken = 0, missed = 0, html = "";

    snap.forEach((d) => {
      const x = d.data();

      total++;
      if (x.status === "Taken") taken++;
      if (x.status === "Missed") missed++;

      html += `
        <div class="medicineItem">
          <strong>${x.medicine}</strong><br>
          ${x.dosage} • ${x.time}<br>
          Status: ${x.status}
        </div>
      `;
    });

    const percent = total ? Math.round((taken / total) * 100) : 0;

    $("patientReportDetails").innerHTML = `
      <p><strong>Total:</strong> ${total}</p>
      <p><strong>Taken:</strong> ${taken}</p>
      <p><strong>Missed:</strong> ${missed}</p>
      <p><strong>Adherence:</strong> ${percent}%</p>
      <hr><br>${html}
    `;
  });
}

function loadDoctorPatientReports() {
  if (!$("doctorPatientReports")) return;

  const q = query(
    collection(db, "prescriptions"),
    where("doctorEmail", "==", currentUser.email)
  );

  onSnapshot(q, (snap) => {
    const report = {};

    snap.forEach((d) => {
      const x = d.data();

      if (!report[x.patientEmail]) {
        report[x.patientEmail] = { total: 0, taken: 0, missed: 0 };
      }

      report[x.patientEmail].total++;
      if (x.status === "Taken") report[x.patientEmail].taken++;
      if (x.status === "Missed") report[x.patientEmail].missed++;
    });

    let html = "";

    for (const email in report) {
      const r = report[email];
      const percent = r.total ? Math.round((r.taken / r.total) * 100) : 0;

      html += `
        <div class="medicineItem">
          <strong>${email}</strong><br>
          Total: ${r.total}<br>
          Taken: ${r.taken}<br>
          Missed: ${r.missed}<br>
          Adherence: ${percent}%
        </div>
      `;
    }

    $("doctorPatientReports").innerHTML = html || "No reports available.";
  });
}

/* -------------------- HEALTH REPORTS -------------------- */
window.submitHealthReport = async () => {
  try {
    const issue = $("issue")?.value.trim();
    const symptoms = $("symptoms")?.value.trim();
    const sufferingDays = $("sufferingDays")?.value;
    const painLevel = $("painLevel")?.value;
    const notes = $("notes")?.value.trim();

    if (!issue || !symptoms || !sufferingDays) {
      toast("Please fill required fields.");
      return;
    }

    await addDoc(collection(db, "healthReports"), {
      patientEmail: currentUser.email,
      issue,
      symptoms,
      sufferingDays,
      painLevel,
      notes,
      diagnosis: "",
      medication: "",
      createdAt: serverTimestamp()
    });

    toast("Health report submitted");
  } catch (err) {
    toast(err.message);
  }
};

function loadPatientHealthReports() {
  if (!$("myHealthReports")) return;

  const q = query(
    collection(db, "healthReports"),
    where("patientEmail", "==", currentUser.email)
  );

  onSnapshot(q, (snap) => {
    $("myHealthReports").innerHTML = "";

    snap.forEach((d) => {
      const x = d.data();

      $("myHealthReports").innerHTML += `
        <div class="medicineItem">
          <strong>${x.issue}</strong><br>
          Symptoms: ${x.symptoms}<br>
          Since: ${x.sufferingDays} days<br>
          Diagnosis: ${x.diagnosis || "Pending"}<br>
          Medication: ${x.medication || "Pending"}
        </div>
      `;
    });
  });
}

function loadDoctorHealthReports() {
  if (!$("doctorHealthReports")) return;

  onSnapshot(collection(db, "healthReports"), (snap) => {
    $("doctorHealthReports").innerHTML = "";

    snap.forEach((d) => {
      const x = d.data();

      $("doctorHealthReports").innerHTML += `
        <div class="medicineItem">
          <strong>${x.patientEmail}</strong><br>
          Issue: ${x.issue}<br>
          Symptoms: ${x.symptoms}<br>
          Since: ${x.sufferingDays} days<br>

          <input id="diag-${d.id}" placeholder="Diagnosis">
          <input id="med-${d.id}" placeholder="Medication">

          <button onclick="saveDoctorAdvice('${d.id}')">Save Advice</button>
        </div>
      `;
    });
  });
}

window.saveDoctorAdvice = async (id) => {
  try {
    await updateDoc(doc(db, "healthReports", id), {
      diagnosis: $("diag-" + id).value.trim(),
      medication: $("med-" + id).value.trim()
    });

    toast("Advice saved");
  } catch (err) {
    toast(err.message);
  }
};

/* -------------------- PROFILE -------------------- */
window.saveProfile = async () => {
  try {
    await setDoc(doc(db, "profiles", currentUser.uid), {
      name: $("profileName")?.value || "",
      age: $("profileAge")?.value || "",
      gender: $("profileGender")?.value || "",
      phone: $("profilePhone")?.value || "",
      specialization: $("specialization")?.value || "",
      hospital: $("hospital")?.value || ""
    });

    if ($("profileMsg")) $("profileMsg").innerText = "✅ Profile Saved";
  } catch (err) {
    toast(err.message);
  }
};

async function loadProfile() {
  try {
    if (!currentUser || !$("profileName")) return;

    const snap = await getDoc(doc(db, "profiles", currentUser.uid));
    if (!snap.exists()) return;

    const data = snap.data();

    if ($("profileName")) $("profileName").value = data.name || "";
    if ($("profileAge")) $("profileAge").value = data.age || "";
    if ($("profileGender")) $("profileGender").value = data.gender || "";
    if ($("profilePhone")) $("profilePhone").value = data.phone || "";
    if ($("specialization")) $("specialization").value = data.specialization || "";
    if ($("hospital")) $("hospital").value = data.hospital || "";
  } catch (err) {
    console.log(err);
  }
}

/* -------------------- CALENDAR -------------------- */
function renderCalendar() {
  if (!$("calendar")) return;

  $("calendar").innerHTML = "";

  for (let i = 1; i <= 30; i++) {
    $("calendar").innerHTML += `<div class="day">${i}</div>`;
  }
}

/* -------------------- CHART -------------------- */
function updateChart(taken, missed) {
  if (!$("reportChart") || typeof Chart === "undefined") return;

  if (chartRef) chartRef.destroy();

  chartRef = new Chart($("reportChart"), {
    type: "doughnut",
    data: {
      labels: ["Taken", "Missed"],
      datasets: [
        {
          data: [taken, missed]
        }
      ]
    }
  });
}

/* -------------------- CHAT -------------------- */
window.startVoiceRecording = async () => {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    toast("Voice recording is not supported in this browser.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceChunks = [];
    recordedVoiceBlob = null;
    voiceRecorder = new MediaRecorder(stream);

    voiceRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) voiceChunks.push(event.data);
    };

    voiceRecorder.onstop = () => {
      recordedVoiceBlob = new Blob(voiceChunks, { type: voiceRecorder.mimeType || "audio/webm" });
      isVoiceFinalizing = false;
      stream.getTracks().forEach((track) => track.stop());

      if (!recordedVoiceBlob.size) {
        recordedVoiceBlob = null;
        if ($("voiceStatus")) $("voiceStatus").innerText = "Voice message was empty. Please record again.";
        if ($("recordVoiceBtn")) $("recordVoiceBtn").disabled = false;
        if ($("stopVoiceBtn")) $("stopVoiceBtn").disabled = true;
        if ($("removeVoiceBtn")) $("removeVoiceBtn").disabled = true;
        return;
      }

      if ($("voiceStatus")) $("voiceStatus").innerText = "Voice message ready to send.";
      if ($("recordVoiceBtn")) $("recordVoiceBtn").disabled = false;
      if ($("stopVoiceBtn")) $("stopVoiceBtn").disabled = true;
      if ($("removeVoiceBtn")) $("removeVoiceBtn").disabled = false;
    };

    voiceRecorder.start();

    if ($("voiceStatus")) $("voiceStatus").innerText = "Recording voice message...";
    if ($("recordVoiceBtn")) $("recordVoiceBtn").disabled = true;
    if ($("stopVoiceBtn")) $("stopVoiceBtn").disabled = false;
    if ($("removeVoiceBtn")) $("removeVoiceBtn").disabled = true;
  } catch (error) {
    toast("Microphone permission is needed to record a voice message.");
  }
};

window.stopVoiceRecording = () => {
  if (voiceRecorder?.state === "recording") {
    isVoiceFinalizing = true;
    if ($("voiceStatus")) $("voiceStatus").innerText = "Preparing voice message...";
    if ($("stopVoiceBtn")) $("stopVoiceBtn").disabled = true;
    voiceRecorder.stop();
  }
};

window.removeVoiceRecording = () => {
  recordedVoiceBlob = null;
  voiceChunks = [];
  isVoiceFinalizing = false;

  if ($("voiceStatus")) $("voiceStatus").innerText = "No voice message recorded.";
  if ($("removeVoiceBtn")) $("removeVoiceBtn").disabled = true;
};

window.sendPatientMessage = async () => {
  const text = $("patientMessage")?.value.trim();
  const doctorEmail = normalizeEmail($("doctorEmail")?.value);
  const patientEmail = normalizeEmail(currentUser.email);
  const photos = Array.from($("patientPhotos")?.files || []);

  if (!doctorEmail) {
    toast("Please enter the doctor's email.");
    setChatStatus("Doctor email is required.");
    return;
  }

  if (isVoiceFinalizing) {
    toast("Voice message is still getting ready. Please wait a second and send again.");
    setChatStatus("Voice message is still getting ready.");
    return;
  }

  if (!text && photos.length === 0 && !recordedVoiceBlob) {
    toast("Please type a message, attach an image, or record a voice message.");
    setChatStatus("Add text, image, or voice before sending.");
    return;
  }

  if (voiceRecorder?.state === "recording") {
    toast("Please stop recording before sending.");
    return;
  }

  if (photos.some((photo) => !photo.type.startsWith("image/"))) {
    toast("Please upload image files only.");
    return;
  }

  if (photos.some((photo) => photo.size > 5 * 1024 * 1024)) {
    toast("Each image must be smaller than 5 MB.");
    return;
  }

  if (recordedVoiceBlob && recordedVoiceBlob.size > 10 * 1024 * 1024) {
    toast("Voice message must be smaller than 10 MB.");
    return;
  }

  try {
    setChatStatus("Sending message...");
    if ($("sendPatientBtn")) $("sendPatientBtn").disabled = true;

    const patientPhotos = await Promise.all(
      photos.map((photo) => makeChatAttachment(photo, doctorEmail, "chat-photos", "image"))
    );

    let voiceMessage = null;

    if (recordedVoiceBlob) {
      const voiceFile = voiceBlobToFile(recordedVoiceBlob);
      voiceMessage = await makeChatAttachment(voiceFile, doctorEmail, "chat-voices", "audio");
      voiceMessage.name = "Voice message";
    }

    await addDoc(collection(db, "messages"), {
      doctorEmail,
      patientEmail,
      doctorEmailLower: doctorEmail,
      patientEmailLower: patientEmail,
      sender: "patient",
      text,
      patientPhotos,
      voiceMessage,
      createdAt: serverTimestamp()
    });

    $("patientMessage").value = "";
    if ($("patientPhotos")) $("patientPhotos").value = "";
    removeVoiceRecording();
    setChatStatus("Message sent.");
  } catch (error) {
    setChatStatus("Message failed: " + error.message);
    toast("Message could not be sent: " + error.message);
  } finally {
    if ($("sendPatientBtn")) $("sendPatientBtn").disabled = false;
  }
};

window.sendDoctorMessage = async () => {
  const text = $("doctorMessage")?.value.trim();
  const patientEmail = normalizeEmail($("chatPatientEmail")?.value);
  const doctorEmail = normalizeEmail(currentUser.email);
  const photos = Array.from($("doctorPhotos")?.files || []);

  if (!patientEmail) {
    toast("Please enter the patient's email.");
    setChatStatus("Patient email is required.");
    return;
  }

  if (isVoiceFinalizing) {
    toast("Voice message is still getting ready. Please wait a second and send again.");
    setChatStatus("Voice message is still getting ready.");
    return;
  }

  if (!text && photos.length === 0 && !recordedVoiceBlob) {
    toast("Please type a reply, attach an image, or record a voice message.");
    setChatStatus("Add text, image, or voice before sending.");
    return;
  }

  if (voiceRecorder?.state === "recording") {
    toast("Please stop recording before sending.");
    return;
  }

  if (photos.some((photo) => !photo.type.startsWith("image/"))) {
    toast("Please upload image files only.");
    return;
  }

  if (photos.some((photo) => photo.size > 5 * 1024 * 1024)) {
    toast("Each image must be smaller than 5 MB.");
    return;
  }

  if (recordedVoiceBlob && recordedVoiceBlob.size > 10 * 1024 * 1024) {
    toast("Voice message must be smaller than 10 MB.");
    return;
  }

  try {
    setChatStatus("Sending message...");
    if ($("sendDoctorBtn")) $("sendDoctorBtn").disabled = true;

    const patientPhotos = await Promise.all(
      photos.map((photo) => makeChatAttachment(photo, doctorEmail, "chat-photos", "image"))
    );

    let voiceMessage = null;

    if (recordedVoiceBlob) {
      const voiceFile = voiceBlobToFile(recordedVoiceBlob);
      voiceMessage = await makeChatAttachment(voiceFile, doctorEmail, "chat-voices", "audio");
      voiceMessage.name = "Voice message";
    }

    await addDoc(collection(db, "messages"), {
      doctorEmail,
      patientEmail,
      doctorEmailLower: doctorEmail,
      patientEmailLower: patientEmail,
      sender: "doctor",
      text,
      patientPhotos,
      voiceMessage,
      createdAt: serverTimestamp()
    });

    $("doctorMessage").value = "";
    if ($("doctorPhotos")) $("doctorPhotos").value = "";
    removeVoiceRecording();
    setChatStatus("Message sent.");
  } catch (error) {
    setChatStatus("Message failed: " + error.message);
    toast("Message could not be sent: " + error.message);
  } finally {
    if ($("sendDoctorBtn")) $("sendDoctorBtn").disabled = false;
  }
};

function listenChats() {
  const q = query(collection(db, "messages"), orderBy("createdAt"));

  onSnapshot(q, (snap) => {
    if ($("chatBox")) $("chatBox").innerHTML = "";
    if ($("doctorChatBox")) $("doctorChatBox").innerHTML = "";

    snap.forEach((d) => {
      const m = d.data();
      const currentEmail = normalizeEmail(currentUser.email);
      const messageDoctorEmail = normalizeEmail(m.doctorEmailLower || m.doctorEmail);
      const messagePatientEmail = normalizeEmail(m.patientEmailLower || m.patientEmail);

      const allowed =
        messageDoctorEmail === currentEmail ||
        messagePatientEmail === currentEmail;

      if (!allowed) return;

      const safeText = escapeHtml(m.text || "");
      const safeSender = escapeHtml(m.sender || "message");
      const patientPhotos = Array.isArray(m.patientPhotos) ? m.patientPhotos : [];
      if (m.photoUrl) {
        patientPhotos.push({ url: m.photoUrl, name: m.photoName });
      }

      const photoHtml = patientPhotos.length
        ? `
          <div class="chatPhotoGrid">
            ${patientPhotos.map((photo) => `
              <a href="${escapeHtml(photo.url || photo.dataUrl)}" target="_blank" rel="noopener">
                <img class="chatPhoto" src="${escapeHtml(photo.url || photo.dataUrl)}" alt="${escapeHtml(photo.name || "Uploaded medicine photo")}">
              </a>
            `).join("")}
          </div>
        `
        : "";
      const voiceSrc = m.voiceMessage?.url || m.voiceMessage?.dataUrl;
      const voiceHtml = voiceSrc
        ? `
          <audio class="chatVoice" controls src="${escapeHtml(voiceSrc)}">
            Your browser does not support audio playback.
          </audio>
        `
        : "";
      const html = `
        <div class="chatMsg">
          <strong>${safeSender}:</strong> ${safeText}
          ${photoHtml}
          ${voiceHtml}
        </div>
      `;

      if ($("chatBox")) $("chatBox").innerHTML += html;
      if ($("doctorChatBox")) $("doctorChatBox").innerHTML += html;
    });
  });
}


/* -------------------- APPOINTMENTS -------------------- */

// ✅ BOOK APPOINTMENT (PATIENT)
window.bookAppointment = async () => {
  const doctorEmail = $("appointDoctor")?.value.trim().toLowerCase();
  const date = $("appointDate")?.value;
  const time = $("appointTime")?.value;

  if (!doctorEmail || !date || !time) {
    toast("Fill all fields");
    return;
  }

  await addDoc(collection(db, "appointments"), {
    patientEmail: currentUser.email.toLowerCase(),
    doctorEmail: doctorEmail,
    date,
    time,
    status: "Pending",
    createdAt: serverTimestamp()
  });

  toast("Appointment booked");
};

// ✅ PATIENT VIEW
function loadMyAppointments() {
  const box = $("myAppointments");
  if (!box || !currentUser) return;

  const q = query(
    collection(db, "appointments"),
    where("patientEmail", "==", currentUser.email.toLowerCase())
  );

  onSnapshot(q, (snap) => {
    box.innerHTML = "";

    snap.forEach((d) => {
      const a = d.data();

      box.innerHTML += `
        <div class="medicineItem">
          <strong>${a.doctorEmail}</strong><br>
          📅 ${a.date} | ⏰ ${a.time}<br>
          <div class="status ${a.status?.toLowerCase()}">${a.status}</div>
        </div>
      `;
    });
  });
}

// ✅ DOCTOR VIEW (FIXED)
function loadDoctorAppointments() {
  const box = document.getElementById("doctorAppointments");
  if (!box || !currentUser) return;

  const doctorEmail = currentUser.email.toLowerCase();

  const q = query(
    collection(db, "appointments"),
    where("doctorEmail", "==", doctorEmail)
  );

  onSnapshot(q, (snap) => {
    box.innerHTML = "";

    if (snap.empty) {
      box.innerHTML = "<p>No appointments found</p>";
      return;
    }

    snap.forEach((d) => {
      const a = d.data();

      box.innerHTML += `
        <div class="medicineItem">
          <strong>${a.patientEmail}</strong><br>
          📅 ${a.date} | ⏰ ${a.time}<br>

          <div class="status ${a.status?.toLowerCase()}">
            ${a.status}
          </div>

          ${
            a.status === "Pending"
              ? `
              <div class="row">
                <button onclick="updateAppointmentStatus('${d.id}','Accepted')">
                  ✅ Accept
                </button>
                <button class="danger" onclick="updateAppointmentStatus('${d.id}','Rejected')">
                  ❌ Reject
                </button>
              </div>
              `
              : ""
          }
        </div>
      `;
    });
  });
}

// ✅ UPDATE STATUS
window.updateAppointmentStatus = async (id, status) => {
  await updateDoc(doc(db, "appointments", id), { status });
};


window.updateAppointmentStatus = async (id, status) => {
  await updateDoc(doc(db, "appointments", id), { status });
};

/* -------------------- PAYMENT -------------------- */
window.makePayment = () => {
  if ($("paymentStatus")) {
    $("paymentStatus").innerText = "✅ Payment Successful";
  }
};

/* -------------------- DOCTOR STATS -------------------- */
function loadDoctorStats() {
  onSnapshot(
    query(
      collection(db, "prescriptions"),
      where("doctorEmail", "==", currentUser.email)
    ),
    (snap) => {
      if ($("totalRx")) $("totalRx").innerText = snap.size;

      const patients = new Set();

      snap.forEach((d) => patients.add(d.data().patientEmail));

      if ($("totalPatients")) {
        $("totalPatients").innerText = patients.size;
      }
    }
  );

  onSnapshot(
    query(
      collection(db, "messages"),
      where("doctorEmail", "==", currentUser.email)
    ),
    (snap) => {
      if ($("totalMsgs")) $("totalMsgs").innerText = snap.size;
    }
  );
}

/* -------------------- AI -------------------- */
window.askAI = async () => {
  const q = $("aiQuestion")?.value.trim().toLowerCase();

  if (!q) {
    if ($("aiAnswer")) $("aiAnswer").innerText = "Please enter a question.";
    return;
  }

  $("aiAnswer").innerText = "Thinking...";

  setTimeout(() => {
    let ans = "Please consult your doctor for accurate medical advice.";

    if (q.includes("miss")) {
      ans = "If you miss a dose, take it when remembered unless near next dose.";
    } else if (q.includes("fever")) {
      ans = "Stay hydrated, rest, and seek care if fever is high.";
    } else if (q.includes("cold")) {
      ans = "Rest well, drink warm fluids, and monitor symptoms.";
    }

    $("aiAnswer").innerText = ans;
  }, 700);
};

/* -------------------- EMERGENCY -------------------- */
window.sendEmergency = () => {
  alert("Emergency alert sent.");
};

window.findHospitals = () => {
  window.open("https://www.google.com/maps/search/hospitals", "_blank");
};

/* -------------------- FILE UPLOAD -------------------- */
window.uploadPrescription = async (file) => {
  const fileRef = ref(storage, "files/" + Date.now());
  await uploadBytes(fileRef, file);
  return await getDownloadURL(fileRef);
};

async function uploadChatFile(file, doctorEmail, folder, fallbackName = "") {
  const patient = safeFilePart(currentUser.email);
  const doctor = safeFilePart(doctorEmail);
  const filename = safeFilePart(file.name || fallbackName || "upload");
  const fileRef = ref(
    storage,
    `${folder}/${doctor}/${patient}/${Date.now()}-${filename}`
  );

  await Promise.race([
    uploadBytes(fileRef, file, { contentType: file.type || "application/octet-stream" }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Firebase Storage upload timed out.")), STORAGE_UPLOAD_TIMEOUT_MS)
    )
  ]);

  return await Promise.race([
    getDownloadURL(fileRef),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Firebase Storage download URL timed out.")), STORAGE_UPLOAD_TIMEOUT_MS)
    )
  ]);
}
