import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const documents: string[] = [];

async function collect(path: string): Promise<void> {
  const entry = await stat(path);
  if (entry.isDirectory()) {
    for (const name of await readdir(path)) {
      await collect(resolve(path, name));
    }
    return;
  }
  if (extname(path) === ".md") documents.push(path);
}

for (const path of [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "docs",
  "bindings/README.md",
  "examples",
]) {
  await collect(resolve(root, path));
}

const missing: string[] = [];
const linkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

for (const document of documents) {
  const text = await readFile(document, "utf8");
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1]!;
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const path = decodeURIComponent(target.split("#", 1)[0]!);
    if (!path) continue;
    try {
      await stat(resolve(dirname(document), path));
    } catch {
      missing.push(`${document.slice(root.length + 1)} -> ${target}`);
    }
  }
}

if (missing.length > 0) {
  console.error("Broken local documentation links:");
  for (const link of missing) console.error(`- ${link}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${documents.length} Markdown files.`);
}
