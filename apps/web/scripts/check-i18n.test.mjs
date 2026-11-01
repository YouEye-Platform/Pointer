import assert from 'node:assert/strict';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {afterEach, test} from 'node:test';

const directories = [];
const typescriptUrl = import.meta.resolve('typescript');
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true}); });
function fixture(source = '\"use client\"; export function Screen() { return <h1>{translateInterface("Hello {name}", {name: "Owner"})}</h1>; }') {
  const root = mkdtempSync(resolve(tmpdir(), 'pointer-i18n-'));
  directories.push(root);
  mkdirSync(resolve(root, 'src/messages'), {recursive: true});
  mkdirSync(resolve(root, 'scripts'));
  for (const name of ['check-i18n.mjs', 'check-i18n-source.mjs']) copyFileSync(resolve(import.meta.dirname, name), resolve(root, 'scripts', name));
  writeFileSync(resolve(root, 'loader.mjs'), `export function resolve(specifier, context, next) { return specifier === "typescript" ? {url: ${JSON.stringify(typescriptUrl)}, shortCircuit: true} : next(specifier, context); }`);
  const messages = {'Hello {name}': 'Hello {name}', 'Rows': 'Rows'};
  for (const locale of ['en', 'ru', 'es', 'de', 'fr']) writeFileSync(resolve(root, `src/messages/${locale}.json`), JSON.stringify(messages));
  writeFileSync(resolve(root, 'src/messages/technical-literals.json'), '{}');
  writeFileSync(resolve(root, 'src/screen.tsx'), source);
  return {
    root,
    write(path, value) { writeFileSync(resolve(root, path), typeof value === 'string' ? value : JSON.stringify(value)); },
    catalogue(locale, change) { const path = `src/messages/${locale}.json`; const current = JSON.parse(readFileSync(resolve(root, path), 'utf8')); this.write(path, change(current)); },
    run(script) {
      const result = spawnSync(process.execPath, ['--no-warnings', '--loader', resolve(root, 'loader.mjs'), resolve(root, 'scripts', script)], {encoding: 'utf8', timeout: 20_000});
      assert.ifError(result.error);
      return {status: result.status, output: result.stdout + result.stderr};
    },
  };
}
function rejects(result, message) { assert.equal(result.status, 1, result.output); assert.match(result.output, message); }

test('complete catalogues and translated source pass both gates', () => {
  const check = fixture();
  assert.equal(check.run('check-i18n.mjs').status, 0);
  assert.equal(check.run('check-i18n-source.mjs').status, 0);
});
test('catalogue key drift is rejected', () => {
  const check = fixture(); check.catalogue('de', messages => ({...messages, Extra: 'Zusatz'}));
  rejects(check.run('check-i18n.mjs'), /Catalogue keys differ: de/);
});
test('placeholder drift is rejected', () => {
  const check = fixture(); check.catalogue('ru', messages => ({...messages, 'Hello {name}': 'Привет {other}'}));
  rejects(check.run('check-i18n.mjs'), /Placeholder mismatch: ru/);
});
test('blank translations are rejected', () => {
  const check = fixture(); check.catalogue('fr', messages => ({...messages, Rows: ' '}));
  rejects(check.run('check-i18n.mjs'), /Empty message: fr:Rows/);
});
test('missing literal messages are rejected', () => {
  const check = fixture('export const Screen = () => <h1>{translateInterface("Missing")}</h1>;');
  rejects(check.run('check-i18n.mjs'), /Missing message .*Missing/);
});
test('missing conditional messages are rejected', () => {
  const check = fixture('export const Screen = () => <h1>{translateInterface(ready ? "Rows" : "Missing")}</h1>;');
  rejects(check.run('check-i18n.mjs'), /Missing message .*Missing/);
});
test('missing generated navigation messages are rejected', () => {
  const check = fixture('const NAV = [{href: "/models", label: "Missing navigation"}];');
  rejects(check.run('check-i18n.mjs'), /Missing navigation message/);
});
test('ordinary TypeScript generic arrow functions are parsed as TypeScript', () => {
  const check = fixture(); check.write('src/generic.ts', 'export const identity = <T>(value: T): T => value;');
  assert.equal(check.run('check-i18n.mjs').status, 0);
});
test('invalid TSX is rejected', () => {
  const check = fixture('export const Screen = () => <h1>');
  rejects(check.run('check-i18n.mjs'), /Invalid source/);
});
test('new visible prose is rejected', () => {
  rejects(fixture('export const Screen = () => <h1>Untranslated heading</h1>;').run('check-i18n-source.mjs'), /New interface literals/);
});
test('untranslated accessible names are rejected', () => {
  rejects(fixture('export const Screen = () => <button aria-label="Untranslated action" />;').run('check-i18n-source.mjs'), /Untranslated action/);
});
test('untranslated templates and skeleton columns are rejected', () => {
  const check = fixture('export const Screen = () => <section><p title={`Requests: ${count}`} /><TableSkeleton columns={["Untranslated column"]} /></section>;');
  const result = check.run('check-i18n-source.mjs');
  rejects(result, /Requests:/); assert.match(result.output, /Untranslated column/);
});
test('client directives after imports are rejected', () => {
  rejects(fixture('import "react"; "use client"; export const Screen = () => <p />;').run('check-i18n-source.mjs'), /Client directive must precede imports/);
});
test('reviewed technical literals are count bounded', () => {
  const check = fixture('export const Screen = () => <h1>Pointer</h1>;');
  check.write('src/messages/technical-literals.json', {'["src/screen.tsx","Pointer"]': 1});
  assert.equal(check.run('check-i18n-source.mjs').status, 0);
  check.write('src/screen.tsx', 'export const Screen = () => <><h1>Pointer</h1><p>Pointer</p></>;');
  rejects(check.run('check-i18n-source.mjs'), /New interface literals/);
});
