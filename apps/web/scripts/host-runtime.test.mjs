import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {test} from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function evaluateModule(relativePath, imports = {}) {
  const filename = resolve(import.meta.dirname, '../src/lib', relativePath);
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  }).outputText;
  const exports = {};
  const require = name => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected runtime dependency: ${name}`);
    return imports[name];
  };
  // Execute real source in separate module graphs, as createPointerUI does per invocation.
  const initialize = new vm.Script(`(function(exports, require) { ${source}\n})`, {filename}).runInNewContext({URL});
  initialize(exports, require);
  return exports;
}
const freshRuntime = () => evaluateModule('host-runtime.ts', {'./locale': evaluateModule('locale.ts')});

test('separate factory module graphs isolate locales, subscriptions and draft storage', () => {
  const first = freshRuntime(), second = freshRuntime();
  first.configureHostRuntime({locale: 'ru-RU'}); second.configureHostRuntime({locale: 'en-US'});
  first.pointerStorage.setItem('draft', 'first private draft'); second.pointerStorage.setItem('draft', 'second private draft');
  const firstChanges = [], secondChanges = [];
  const offFirst = first.subscribeInterfaceLocale(() => firstChanges.push(first.getInterfaceLocale()));
  const offSecond = second.subscribeInterfaceLocale(() => secondChanges.push(second.getInterfaceLocale()));
  first.setInterfaceLocale('fr-CA');
  assert.equal(first.getInterfaceLocale(), 'fr'); assert.equal(second.getInterfaceLocale(), 'en');
  assert.deepEqual(firstChanges, ['fr']); assert.deepEqual(secondChanges, []);
  assert.equal(first.pointerStorage.getItem('draft'), 'first private draft');
  assert.equal(second.pointerStorage.getItem('draft'), 'second private draft');
  first.configureHostRuntime(null);
  assert.equal(second.getInterfaceLocale(), 'en'); assert.equal(second.pointerStorage.getItem('draft'), 'second private draft');
  offFirst(); offSecond();
});
