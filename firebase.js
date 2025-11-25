// firebase.js (ES Modules por CDN Firebase v10+)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js";
import {
    getAuth,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut,
    updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import {
    getFirestore,
    collection,
    doc,
    addDoc,
    setDoc,
    getDoc,
    getDocs,
    updateDoc,
    deleteDoc,
    query,
    where,
    orderBy
} from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";

// 1) CONFIG DE TU PROYECTO
const firebaseConfig = {
    apiKey: "AIzaSyDBcCFluYQ2u1isH66reEf6rV9VeEu90uo",
    authDomain: "leja-web.firebaseapp.com",
    projectId: "leja-web",
    storageBucket: "leja-web.appspot.com",
    messagingSenderId: "564149159041",
    appId: "1:564149159041:web:5cd905b10f31a6cd02f980",
    measurementId: "G-BY5BTM0955"
};

// 2) Inicializar Firebase
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// 3) Helpers de Auth
export function onAuth(cb) {
    return onAuthStateChanged(auth, cb);
}

export async function signUpEmail(email, pass, extra = {}) {
    const res = await createUserWithEmailAndPassword(auth, email, pass);
    if (extra.displayName) {
        await updateProfile(res.user, { displayName: extra.displayName });
    }
    return res.user;
}

export async function signInEmail(email, pass) {
    const res = await signInWithEmailAndPassword(auth, email, pass);
    return res.user;
}

export async function signOutUser() {
    await signOut(auth);
}

// 4) Nombres de colecciones
const COL_JOBS = "jobs";
const COL_APPLIES = "applies";
const SUB_FAVS = "favorites";

// ================== JOBS ==================
export async function createJob(job) {
    const ref = await addDoc(collection(db, COL_JOBS), job);
    return { ...job, id: ref.id };
}

export async function updateJob(id, partial) {
    await updateDoc(doc(db, COL_JOBS, id), partial);
}

export async function getMyJobs(ownerEmail) {
    const qy = query(
        collection(db, COL_JOBS),
        where("owner", "==", ownerEmail),
        orderBy("createdAt", "desc")
    );
    const snap = await getDocs(qy);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function listJobsPublic() {
    // Publicadas + ocupadas, ordenadas por fecha
    const qy = query(
        collection(db, COL_JOBS),
        where("status", "in", ["publicada", "ocupada"]),
        orderBy("createdAt", "desc")
    );
    const snap = await getDocs(qy);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function deleteJobHard(id) {
    await deleteDoc(doc(db, COL_JOBS, id));
}

// ================== APPLIES (POSTULACIONES) ==================
export async function createApply(app) {
    const ref = await addDoc(collection(db, COL_APPLIES), app);
    return { ...app, id: ref.id };
}

// 🔹 TODAS las postulaciones de un reclutador (Panel → Postulaciones)
export async function getAppliesByOwner(ownerEmail) {
    const snap = await getDocs(collection(db, COL_APPLIES));
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return all
        .filter(a => a.owner === ownerEmail)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// 🔹 TODAS las postulaciones de un candidato (Perfil → Mis postulaciones)
export async function getAppliesByCandidate(candidateEmail) {
    const snap = await getDocs(collection(db, COL_APPLIES));
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return all
        .filter(
            a =>
                a.candidate === candidateEmail ||
                a.candidateEmail === candidateEmail
        )
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function updateApply(id, partial) {
    await updateDoc(doc(db, COL_APPLIES, id), partial);
}

// ================== FAVORITOS ==================
export async function getFavorites(userEmail) {
    const favCol = collection(db, "users", userEmail, SUB_FAVS);
    const s = await getDocs(favCol);
    return s.docs.map(d => d.id); // solo ids de jobs
}

export async function toggleFavorite(userEmail, jobId) {
    const favRef = doc(db, "users", userEmail, SUB_FAVS, jobId);
    const cur = await getDoc(favRef);
    if (cur.exists()) {
        await deleteDoc(favRef);
    } else {
        await setDoc(favRef, { createdAt: Date.now() });
    }
}
