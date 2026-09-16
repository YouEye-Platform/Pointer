import { readFile } from "node:fs/promises";

const schema = JSON.parse(
  await readFile(new URL("../specs/capabilities.v1.schema.json", import.meta.url))
);

const expectedRequired = [
  "contractVersion",
  "deploymentMode",
  "localAuthAvailable",
  "surface",
  "managementContractVersion",
  "inferenceContractVersion",
];

const failures = [];
if (schema.properties?.contractVersion?.const !== "1") {
  failures.push("contractVersion must be the literal 1");
}
if (
  JSON.stringify(schema.properties?.deploymentMode?.enum)
  !== JSON.stringify(["standalone", "managed"])
) {
  failures.push("deploymentMode enum drifted");
}
if (
  JSON.stringify(schema.properties?.surface?.enum)
  !== JSON.stringify(["combined", "management", "inference"])
) {
  failures.push("surface enum drifted");
}
if (JSON.stringify(schema.required) !== JSON.stringify(expectedRequired)) {
  failures.push("required capability fields drifted");
}
if (schema.additionalProperties !== false) {
  failures.push("capability schema must reject unknown fields");
}

if (failures.length > 0) {
  throw new Error(`Capability contract check failed: ${failures.join("; ")}`);
}

console.log("Pointer capability contract is aligned");
