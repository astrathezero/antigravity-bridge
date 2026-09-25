/**
 * Pre-build script for desktop edition:
 * Copies src/ to desktop/bridge/src/ so electron-builder can package the bridge files.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, "..", "src");
const dstDir = path.resolve(__dirname, "bridge", "src");

if (fs.existsSync(srcDir)) {
  // A fresh copy: files removed from src/ must not live on in the package.
  fs.rmSync(dstDir, { recursive: true, force: true });
  fs.mkdirSync(dstDir, { recursive: true });
  fs.cpSync(srcDir, dstDir, { recursive: true });
  console.log(`[sync-src] Synchronized src/ -> desktop/bridge/src/`);
} else {
  console.error(`[sync-src] Source directory not found: ${srcDir}`);
  process.exit(1);
}
