/**
 * Where the bridge's own sources are. In a checkout they are ../src; a packaged app carries a copy
 * (sync-src.mjs) at bridge/src, unpacked from app.asar (electron-builder asarUnpack) so the utility process
 * and agy see real files. A relative `import "../src/..."` would only ever work in the checkout.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function bridgeSrcDir({ resourcesPath = process.resourcesPath } = {}) {
  const candidates = [
    path.resolve(here, "..", "src"),
    resourcesPath ? path.join(resourcesPath, "app.asar.unpacked", "bridge", "src") : null,
    path.join(here, "bridge", "src"),
  ].filter(Boolean);
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, "index.mjs")));
  if (!found) throw new Error(`Antigravity Bridge sources not found (looked in ${candidates.join(", ")})`);
  return found;
}

/** The utility-process entry, outside app.asar when packaged. */
export function bootstrapEntry({ resourcesPath = process.resourcesPath } = {}) {
  const unpacked = resourcesPath ? path.join(resourcesPath, "app.asar.unpacked", "bridge-bootstrap.mjs") : null;
  return unpacked && fs.existsSync(unpacked) ? unpacked : path.join(here, "bridge-bootstrap.mjs");
}

/** import() a module of the bridge, e.g. importBridge("core/profile-login.mjs"). */
export function importBridge(relPath) {
  return import(pathToFileURL(path.join(bridgeSrcDir(), relPath)).href);
}
