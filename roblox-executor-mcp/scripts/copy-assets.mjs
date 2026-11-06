import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const src = path.join(root, "src", "http", "assets");
const dest = path.join(root, "dist", "http", "assets");
const sharedSrc = path.join(root, "src", "shared");
const sharedDest = path.join(root, "dist", "shared");

if (!fs.existsSync(src)) {
  console.error(`[copy-assets] Source not found: ${src}`);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`[copy-assets] ${src} → ${dest}`);

if (fs.existsSync(sharedSrc)) {
  fs.mkdirSync(sharedDest, { recursive: true });
  for (const entry of fs.readdirSync(sharedSrc)) {
    if (!entry.endsWith(".mjs") && !entry.endsWith(".d.mts")) continue;
    fs.copyFileSync(path.join(sharedSrc, entry), path.join(sharedDest, entry));
  }
  console.log(`[copy-assets] runtime modules from ${sharedSrc} → ${sharedDest}`);
}
