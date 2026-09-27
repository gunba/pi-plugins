import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./style.css";

createRoot(document.getElementById("root")!).render(<App />);
if ("serviceWorker" in navigator)
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
