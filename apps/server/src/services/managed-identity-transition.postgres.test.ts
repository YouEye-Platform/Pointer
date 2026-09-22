import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createPostgresClient } from '../db/postgres-client';
import { transitionManagedIdentity } from './managed-identity-transition';

const enabled = process.env.IDENTITY_TRANSITION_POSTGRES_TEST === '1';
const url = process.env.DATABASE_URL || '';
const database = process.env.IDENTITY_TRANSITION_TEST_DATABASE || '';
const sql = enabled ? createPostgresClient(url, 4) : null!;
const fixtures: string[] = [];
const change = { oldIssuer: 'https://id.old.test', newIssuer: 'https://id.new.test', audience: 'pointer-test', subject: 'server-test' };

async function fixture() {
  const id = 'rename-test-' + randomUUID();
  await sql`INSERT INTO users (id, kind, name, role, state) VALUES (${id}, 'service', 'Preserve owner', 'admin', 'active')`;
  await sql`INSERT INTO platform_integrations
    (id, kind, external_server_id, owner_user_id, expected_issuer, expected_audience, expected_subject)
    VALUES (${id}, 'youeye', ${id}, ${id}, ${change.oldIssuer}, ${change.audience}, ${change.subject})`;
  await sql`INSERT INTO model_groups (id, user_id, name) VALUES (${id}, ${id}, 'Preserve group')`;
  fixtures.push(id);
  return { ...change, integrationId: id };
}

describe.skipIf(!enabled)('database-owner managed identity transitions', () => {
  beforeAll(async () => {
    if (!/(?:^|_)test(?:_|$)/.test(database) || decodeURIComponent(new URL(url).pathname.slice(1)) !== database) {
      throw new Error('Explicit isolated test database required');
    }
    const [row] = await sql`SELECT current_database() AS name`;
    if (row.name !== database) throw new Error('Unexpected test database');
  });
  afterAll(async () => {
    for (const id of fixtures) {
      await sql`DELETE FROM management_audit WHERE integration_id = ${id}`;
      await sql`DELETE FROM platform_integrations WHERE id = ${id}`;
      await sql`DELETE FROM users WHERE id = ${id}`;
    }
    await sql.end();
  });
  test('check is read-only; apply preserves owner/group and creates one audit receipt across retry', async () => {
    const request = await fixture();
    const before = await sql`SELECT * FROM model_groups WHERE id = ${request.integrationId}`;
    expect(await transitionManagedIdentity(sql, database, request, true)).toBe('ready');
    const [old] = await sql`SELECT expected_issuer FROM platform_integrations WHERE id = ${request.integrationId}`;
    expect(old.expected_issuer).toBe(change.oldIssuer);
    expect(await transitionManagedIdentity(sql, database, request, false)).toBe('changed');
    expect(await transitionManagedIdentity(sql, database, request, false)).toBe('already-applied');
    const [row] = await sql`SELECT * FROM platform_integrations WHERE id = ${request.integrationId}`;
    expect(row.expected_issuer).toBe(change.newIssuer);
    expect(row.owner_user_id).toBe(request.integrationId);
    expect([...(await sql`SELECT * FROM model_groups WHERE id = ${request.integrationId}`)]).toEqual([...before]);
    expect((await sql`SELECT * FROM management_audit WHERE integration_id = ${request.integrationId}`).length).toBe(1);
    await expect(transitionManagedIdentity(sql, database, { ...request, oldIssuer: 'https://wrong.test' }, false)).rejects.toThrow();
  });
  test('unknown, disabled, wrong old issuer, audience, subject and database are rejected without rewriting trust', async () => {
    const request = await fixture();
    for (const patch of [
      { integrationId: 'unknown' }, { oldIssuer: 'https://wrong.test' }, { audience: 'wrong' }, { subject: 'wrong' },
    ]) await expect(transitionManagedIdentity(sql, database, { ...request, ...patch }, false)).rejects.toThrow();
    await expect(transitionManagedIdentity(sql, database + '_wrong', request, false)).rejects.toThrow();
    await sql`UPDATE platform_integrations SET state = 'disabled' WHERE id = ${request.integrationId}`;
    await expect(transitionManagedIdentity(sql, database, request, false)).rejects.toThrow();
    const [row] = await sql`SELECT expected_issuer FROM platform_integrations WHERE id = ${request.integrationId}`;
    expect(row.expected_issuer).toBe(change.oldIssuer);
  });
  test('disabled owner is rejected and concurrent identical requests commit once', async () => {
    const request = await fixture();
    await sql`UPDATE users SET state = 'disabled' WHERE id = ${request.integrationId}`;
    await expect(transitionManagedIdentity(sql, database, request, false)).rejects.toThrow();
    await sql`UPDATE users SET state = 'active' WHERE id = ${request.integrationId}`;
    const results = await Promise.all([transitionManagedIdentity(sql, database, request, false), transitionManagedIdentity(sql, database, request, false)]);
    expect(results.sort()).toEqual(['already-applied', 'changed']);
  });
  test('competing destinations cannot both rebind; exact reverse restores the original integration', async () => {
    const request = await fixture();
    const other = { ...request, newIssuer: 'https://id.other.test' };
    const results = await Promise.allSettled([transitionManagedIdentity(sql, database, request, false), transitionManagedIdentity(sql, database, other, false)]);
    expect(results.filter(r => r.status === 'fulfilled').length).toBe(1);
    const [row] = await sql`SELECT expected_issuer FROM platform_integrations WHERE id = ${request.integrationId}`;
    expect(await transitionManagedIdentity(sql, database, { ...request, oldIssuer: row.expected_issuer, newIssuer: change.oldIssuer }, false)).toBe('changed');
    const [restored] = await sql`SELECT expected_issuer FROM platform_integrations WHERE id = ${request.integrationId}`;
    expect(restored.expected_issuer).toBe(change.oldIssuer);
  });
  test('a runtime role without database ownership cannot authorize a transition', async () => {
    const request = await fixture();
    const role = 'rename_role_' + randomUUID().replaceAll('-', '');
    await sql.unsafe(`CREATE ROLE ${role}`);
    const restricted = createPostgresClient(url, 1);
    try {
      await restricted.unsafe(`SET ROLE ${role}`);
      await expect(transitionManagedIdentity(restricted, database, request, false)).rejects.toThrow('database owner');
    } finally {
      await restricted.end();
      await sql.unsafe(`DROP ROLE ${role}`);
    }
  });
});
