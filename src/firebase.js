import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDFaCA2lLAT0G2RCtq23GbqCGFNJc6Cu2A",
  authDomain: "badminton-app-8c115.firebaseapp.com",
  projectId: "badminton-app-8c115",
  storageBucket: "badminton-app-8c115.firebasestorage.app",
  messagingSenderId: "699185296595",
  appId: "1:699185296595:web:35238331a50e451a56d026",
  measurementId: "G-Q02RRK4F23"
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);

export default app;
