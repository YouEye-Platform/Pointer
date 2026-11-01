import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPointerFormats, translatePointer} from './i18n';
import {interfaceLocales} from './locale';

test('messages interpolate user content as plain text and preserve unknown keys', () => {
  const content = '<script> & {other}';
  assert.equal(translatePointer('en', 'Revoke {name}?', {name: content}), `Revoke ${content}?`);
  assert.equal(translatePointer('ru', 'Revoke {name}?'), 'Отозвать {name}?');
  for (const key of ['Unknown diagnostic key', '__proto__', 'constructor']) assert.equal(translatePointer('de', key), key);
});
test('counts and quantities use the resolved locale while zero stays a measurement', () => {
  for (const locale of interfaceLocales) {
    const format = createPointerFormats(locale);
    assert.equal(format.number(12345.6), new Intl.NumberFormat(locale).format(12345.6));
    assert.equal(format.metric(null), translatePointer(locale, 'Unknown'));
    assert.equal(format.metric(undefined), translatePointer(locale, 'Unknown'));
    assert.equal(format.metric(0, '%'), `${new Intl.NumberFormat(locale, {minimumFractionDigits: 1, maximumFractionDigits: 1}).format(0)}%`);
    assert.equal(format.tokens(12345), new Intl.NumberFormat(locale, {notation: 'compact'}).format(12345));
  }
});
test('currency formatting preserves estimate precision and unknown prices', () => {
  for (const locale of interfaceLocales) {
    const format = createPointerFormats(locale);
    assert.equal(format.price(null), translatePointer(locale, 'Unknown'));
    assert.equal(format.price(0.00012, 5), new Intl.NumberFormat(locale, {style: 'currency', currency: 'USD', minimumFractionDigits: 5, maximumFractionDigits: 5}).format(0.00012));
  }
});
test('unavailable dates remain localized rather than reporting a fabricated time', () => {
  for (const locale of interfaceLocales) assert.equal(createPointerFormats(locale).date('not-a-date'), translatePointer(locale, 'Not reported'));
});
