import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import { App } from "./app/App";
import "./terminal/terminalFonts.css";
import "./app/styles.css";
import { hostAuthClient } from "./platform/tauriHostAuthClient";
import { remoteClient } from "./platform/tauriRemoteClient";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App client={remoteClient} hostAuthClient={hostAuthClient} />
  </React.StrictMode>,
);
