import fs from "node:fs";
import path from "node:path";

const [mode, version, inputDirectory = "release"] = process.argv.slice(2);
const file = path.resolve(inputDirectory, `Pi-Forge-${version}-${mode}.sbom.cdx.json`);
const sbom = JSON.parse(fs.readFileSync(file, "utf8"));
if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.6" || sbom.metadata?.component?.version !== version) {
  throw new Error(`Invalid CycloneDX metadata: ${file}`);
}
const properties = Object.fromEntries((sbom.metadata.component.properties ?? []).map((entry) => [entry.name, entry.value]));
if (properties["pi-forge:target"] !== mode || !/^[a-f0-9]{64}$/.test(properties["pi-forge:app-asar-sha256"] ?? "")) {
  throw new Error(`SBOM target or app.asar digest mismatch: ${file}`);
}
const names = new Set((sbom.components ?? []).map((component) => component.name));
for (const required of ["node-pty", "@earendil-works/pi-coding-agent"]) {
  if (!names.has(required)) throw new Error(`SBOM is missing required component ${required}: ${file}`);
}
if (names.has("vitest")) throw new Error(`SBOM includes development-only component vitest: ${file}`);
console.log(`[release-sbom] verified ${file}`);
