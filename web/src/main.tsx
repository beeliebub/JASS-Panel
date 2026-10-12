// The panel's single-page app. The daemon serves this document with the base path substituted into the meta tag.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { readPanelBasePath } from "./lib/base-path";

const container = document.getElementById("root");
if (container === null) throw new Error("The panel page has no root element.");

createRoot(container).render(
  <StrictMode>
    <App basePath={readPanelBasePath(document)} />
  </StrictMode>,
);
