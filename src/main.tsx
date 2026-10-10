import ReactDOM from "react-dom/client";
import App from "./App";
import { migrateRenamedStorageKeys } from "./lib/storageKeyMigrations";
import "./styles.css";

// Before the first render: components read their saved keys while mounting.
migrateRenamedStorageKeys();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
