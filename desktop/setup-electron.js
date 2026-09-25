/**
 * Pre-launch verification for desktop edition.
 * Ensures Electron binary is unzipped and path.txt is properly configured
 * even if npm install skipped postinstall scripts.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.join(__dirname, "node_modules", "electron");
const pathFile = path.join(electronDir, "path.txt");

if (!fs.existsSync(pathFile)) {
  console.log("[desktop] Verifying Electron binary...");
  try {
    execSync(`node "${path.join(electronDir, "install.js")}"`, { stdio: "inherit" });
  } catch (err) {
    // If unzip/install script failed or needs manual intervention
    console.warn("[desktop] install.js notice:", err.message);
  }
}
