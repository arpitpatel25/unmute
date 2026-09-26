import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const routes = [
  "concepts/index.html",
  "concepts/product-theatre/index.html",
  "concepts/mac-native/index.html",
  "concepts/voice-material/index.html",
  "concepts/spatial-desktop/index.html",
  "concepts/quiet-editorial/index.html",
  "concepts/guided-film/index.html",
];

const failures = [];
for (const route of routes) {
  const path = resolve(route);
  try {
    const [html, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    if (info.size < 2_000 && route !== "concepts/index.html") failures.push(`${route}: unexpectedly small`);
    if (!/<title>[^<]+<\/title>/i.test(html)) failures.push(`${route}: missing title`);
    if (!/<meta[^>]+name=["']viewport["']/i.test(html)) failures.push(`${route}: missing viewport`);
    if (!/<h1[ >]/i.test(html)) failures.push(`${route}: missing h1`);
    if (!/prefers-reduced-motion/i.test(html)) failures.push(`${route}: missing reduced-motion handling`);
  } catch (error) {
    failures.push(`${route}: ${error.code ?? error.message}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${routes.length} concept routes.`);
}
