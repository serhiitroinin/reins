import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

interface PackageExport {
  types?: string;
}

interface PackageFile {
  exports: Record<string, PackageExport | string>;
}

interface ApiManifest {
  version: 1;
  subpaths: Record<string, readonly string[]>;
}

const root = resolve(import.meta.dirname, "..");
const packageFile = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
) as PackageFile;
const configPath = resolve(root, "tsconfig.json");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const subpaths: Record<string, readonly string[]> = {};

for (const [subpath, target] of Object.entries(packageFile.exports).sort(([a], [b]) => a.localeCompare(b))) {
  if (subpath.includes("*") || typeof target === "string" || !target.types) continue;
  const sourcePath = resolve(root, target.types);
  const source = program.getSourceFile(sourcePath);
  if (!source) throw new Error(`Public API source is not in the TypeScript program: ${target.types}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`Public API source has no module symbol: ${target.types}`);
  subpaths[subpath] = checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => symbol.getName())
    .sort((a, b) => a.localeCompare(b));
}

const manifest: ApiManifest = { version: 1, subpaths };
const rendered = `${JSON.stringify(manifest, null, 2)}\n`;
const manifestPath = resolve(root, "api/public-api.json");

if (process.argv.includes("--write")) {
  await writeFile(manifestPath, rendered);
  console.log(`Wrote ${manifestPath}`);
} else {
  const existing = await readFile(manifestPath, "utf8");
  if (existing !== rendered) {
    throw new Error("The public API changed. Review the change, then run bun run generate:public-api.");
  }
  console.log(`Public API matches ${manifestPath}`);
}
