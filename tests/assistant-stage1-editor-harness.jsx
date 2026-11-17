import { createRoot } from "react-dom/client";
import { App } from "../src/App.jsx";
import "../src/styles.css";

const response = await fetch("/__stage1_fixture.timeline");
if (!response.ok) throw new Error("Local safety fixture unavailable");
const initialImportFile = new File([await response.blob()], "assistant-safety.timeline", { type: "application/zip" });
createRoot(document.getElementById("root")).render(
    <App currentUser={{ id: "local-safety", email: "safety@example.invalid" }} initialImportFile={initialImportFile} />
);
