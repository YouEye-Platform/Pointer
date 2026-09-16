import { readFile } from "node:fs/promises";
import { analyzeCatalogCorpus, stableCatalogReport } from "../src/services/catalog-health";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: bun run catalog:analyze <catalog-corpus.json>");
  process.exit(2);
}

const input = JSON.parse(await readFile(inputPath, "utf8"));
process.stdout.write(stableCatalogReport(analyzeCatalogCorpus(input)));
