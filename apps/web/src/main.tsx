import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AudioIntakePanel } from "./components/AudioIntakePanel";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AudioIntakePanel />
  </StrictMode>,
);
