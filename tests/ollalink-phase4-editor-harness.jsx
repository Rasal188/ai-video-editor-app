import { createRoot } from "react-dom/client";
import { App } from "../src/App.jsx";
import "../src/styles.css";

// No editor state, diarization callbacks, or persistence hooks are test-owned.
// The supported App import prop performs normal archive/worker/media restoration.
const response = await fetch("/__phase4_fixture.timeline");
if (!response.ok) throw new Error("Local editor acceptance archive unavailable");
const initialImportFile = new File([await response.blob()], "phase4-editor.timeline", { type: "application/zip" });
createRoot(document.getElementById("root")).render(
    <App currentUser={{ id: "local-acceptance", email: "local@example.invalid" }} initialImportFile={initialImportFile} />,
);
