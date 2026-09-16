import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Also works on the credential-free archive used by the release builder.
const root = fileURLToPath(new URL('../', import.meta.url));
const ignored = new Set(['.git', '.staging', '.artifacts', 'out', 'node_modules', '.next', 'dist', 'coverage', 'test-results', 'playwright-report']);
const violations = [];
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name === '.env' || entry.name.startsWith('.env.') && !entry.name.endsWith('.example')) continue;
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory()) { await scan(filename); continue; }
    if (!entry.isFile()) continue;
    const bytes = await readFile(filename);
    if (bytes.includes(0)) continue;
    const lines = bytes.toString('utf8').split('\n');
    lines.forEach((line, index) => {
      // Forgejo checkout links are projected by Infra; service addresses are not.
      const text = line.replace(/git[.]potemk[.]in\/potemsla\/[\w.-]+/g, 'repository');
      if (/\b(?:[\w-]+\.)*potemk[.]in\b/i.test(text)) violations.push(`${path.relative(root, filename)}:${index + 1}: deployment-specific hostname`);
    });
  }
}
await scan(root);
if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else console.log('Public source hostname check passed');
