import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import {resolveInterfaceLocale} from './locale';
import {
  configureHostRuntime, getHostRuntime, getInterfaceLocale, navigatePointer,
  pointerStorage, setInterfaceLocale, subscribeInterfaceLocale, type HostRuntime,
} from './host-runtime';

afterEach(() => configureHostRuntime(null));
function runtime(locale = 'en'): HostRuntime {
  return {
    locale, user: {id: 'test-owner', email: 'owner@example.test', name: 'Owner', role: 'user'},
    request: async () => Response.json({}), assetBase: 'https://example.test/pointer/',
    element: {} as HTMLElement, navigate: () => {}, onSignOut: () => {}, onUnauthorized: () => {},
    signal: new AbortController().signal, navigation: 'host',
  };
}

test('supported regional locales normalize without trusting browser identities', () => {
  for (const [input, expected] of [['ru-RU', 'ru'], ['es_MX', 'es'], [' DE-de ', 'de'], ['fr-CA', 'fr'], ['en-US', 'en']]) assert.equal(resolveInterfaceLocale(input), expected);
  for (const input of [null, undefined, 123, {}, '', 'unsupported', '__proto__', '<script>']) assert.equal(resolveInterfaceLocale(input), 'en');
});
test('live locale changes retain drafts, host callbacks, navigation and abort signal', () => {
  const host = runtime('ru-RU'); const paths: string[] = []; host.navigate = path => paths.push(path);
  configureHostRuntime(host); pointerStorage.setItem('draft', 'Private <script> & draft');
  const changes: string[] = []; const unsubscribe = subscribeInterfaceLocale(() => changes.push(getInterfaceLocale()));
  assert.equal(getInterfaceLocale(), 'ru'); setInterfaceLocale('de-DE');
  assert.equal(getInterfaceLocale(), 'de'); assert.equal(pointerStorage.getItem('draft'), 'Private <script> & draft');
  for (const key of ['user', 'request', 'assetBase', 'element', 'navigate', 'onSignOut', 'onUnauthorized', 'signal', 'navigation'] as const) assert.equal(getHostRuntime()?.[key], host[key]);
  navigatePointer('/instances'); assert.deepEqual(paths, ['/instances']);
  setInterfaceLocale('unsupported'); assert.equal(getInterfaceLocale(), 'en');
  unsubscribe(); setInterfaceLocale('fr-FR'); assert.deepEqual(changes, ['de', 'en']);
});
test('changing the configured host clears temporary storage and resets the locale', () => {
  configureHostRuntime(runtime('es-MX')); pointerStorage.setItem('draft', 'first host only');
  configureHostRuntime(runtime('fr-FR')); assert.equal(pointerStorage.getItem('draft'), null); assert.equal(getInterfaceLocale(), 'fr');
  configureHostRuntime(null); assert.equal(getInterfaceLocale(), 'en'); setInterfaceLocale('ru-RU'); assert.equal(getInterfaceLocale(), 'en');
});
