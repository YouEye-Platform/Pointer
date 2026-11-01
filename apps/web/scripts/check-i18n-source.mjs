import ts from 'typescript';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = resolve(root, 'src/messages/technical-literals.json');
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(resolve(dir, entry.name)) : entry.name.endsWith('.tsx') ? [resolve(dir, entry.name)] : []);
}
const attributes = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label', 'description', 'columns']);
function visible(node) {
  const parent = node.parent;
  if (ts.isJsxAttribute(parent)) return attributes.has(parent.name.text);
  if (ts.isJsxExpression(parent)) return !ts.isJsxAttribute(parent.parent) || attributes.has(parent.parent.name.text);
  if (ts.isConditionalExpression(parent) && node !== parent.condition) return visible(parent);
  if (ts.isArrayLiteralExpression(parent)) return visible(parent);
  if (ts.isParenthesizedExpression(parent)) return visible(parent);
  if (ts.isBinaryExpression(parent) && ['||', '??'].includes(parent.operatorToken.getText()) && parent.right === node) return visible(parent);
  if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && /^set(Error|Status|Message)$/.test(parent.expression.text)) return true;
  if (ts.isPropertyAssignment(parent) && parent.name.getText() === 'label') {
    for(let ancestor=parent.parent;ancestor;ancestor=ancestor.parent) if(ts.isVariableDeclaration(ancestor) && ancestor.name.getText() === 'NAV') return false;
  }
  if (ts.isPropertyAssignment(parent) && attributes.has(parent.name.getText().replaceAll('"', '').replaceAll("'", ''))) return true;
  return false;
}
const found = new Map();
for (const file of files(resolve(root, 'src'))) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const directive = source.statements.findIndex(statement => ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression) && statement.expression.text === "use client");
  if (directive > 0) throw new Error(`Client directive must precede imports: ${relative(root, file)}`);
  function visit(node) {
    let text;
    if (ts.isJsxText(node)) text = node.text.replace(/\s+/g, ' ').trim();
    else if (ts.isStringLiteral(node) && visible(node)) text = node.text;
    else if (ts.isTemplateExpression(node) && visible(node)) text = [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join('{…}');
    if (text && /[A-Za-z]{2}/.test(text)) {
      const id = JSON.stringify([relative(root, file), text]);
      found.set(id, (found.get(id) || 0) + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const inventory = Object.fromEntries([...found].sort(([a], [b]) => a.localeCompare(b)));
if (process.argv.includes('--write-baseline')) {
  writeFileSync(baselinePath, JSON.stringify(inventory, null, 2) + '\n');
  console.log(`Recorded ${found.size} reviewed technical and brand literal entries.`);
} else {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const added = [...found].filter(([id, count]) => count > (baseline[id] || 0));
  if (added.length) {
    console.error('New interface literals must use translated messages:');
    for (const [id] of added) console.error(JSON.parse(id).join(': '));
    process.exitCode = 1;
  } else console.log(`No new interface literals; ${found.size} reviewed technical and brand entries.`);
}
