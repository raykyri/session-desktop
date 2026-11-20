import { createRoot } from "react-dom/client";

import { ClientApp } from "./shell.js";
import "./styles/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(<ClientApp />);
