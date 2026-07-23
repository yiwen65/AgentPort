import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./i18n";
import App from "./App";
import { installDesktopEventGuards } from "./desktopEvents";

installDesktopEventGuards();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
