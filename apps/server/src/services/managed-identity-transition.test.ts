import { expect, test } from 'bun:test';
import { validateIdentityTransition } from './managed-identity-transition';

const valid = { integrationId: 'youeye-native', oldIssuer: 'https://id.old.test', newIssuer: 'https://id.new.test', audience: 'pointer', subject: 'server' };
test('identity transition rejects ambiguous or insecure authority inputs', () => {
  expect(validateIdentityTransition(valid)).toEqual(valid);
  for (const patch of [
    { newIssuer: 'http://id.new.test' }, { oldIssuer: 'https://user:password@id.old.test' },
    { newIssuer: 'https://id.new.test/#fragment' }, { newIssuer: valid.oldIssuer },
    { subject: '' }, { audience: 'has space' }, { integrationId: 'x\n' }, { force: true },
  ]) expect(() => validateIdentityTransition({ ...valid, ...patch })).toThrow();
});
