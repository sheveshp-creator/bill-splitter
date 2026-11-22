import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

// Runs the real migration against in-process Postgres (PGlite) and attacks it as the anon role.
const T = 'a'.repeat(32), E = 'b'.repeat(32), V = 'c'.repeat(32), X = 'd'.repeat(32)
let db: PGlite
const call = async (sql: string, ...p: unknown[]) => { try { return { v: (await db.query<Record<string, never>>(sql, p)).rows[0] } } catch (e) { return { err: (e as Error).message } } }
const rec = (id: string, amount: number, t: string, group = 'group-12345') =>
  JSON.stringify([{ kind: 'expense', id, data: { groupId: group, amount, deleted: false }, fieldTimes: { groupId: t, amount: t, deleted: t } }])
const pull = async (tok: string, since = '') => (await call('select sb_pull($1,$2) as r', tok, since)).v?.r as unknown as { records: { kind: string; data: { amount?: number } }[]; cursor: string; archived: boolean }

beforeAll(async () => {
  db = new PGlite()
  await db.exec('create role anon; create role authenticated;')
  await db.exec(readFileSync('supabase/migrations/0001_init.sql', 'utf8'))
  await call("select sb_create_group('group-12345',$1,$2::jsonb,$3::jsonb)", T, JSON.stringify({ name: 'Trip', archived: false }), JSON.stringify({ name: '2025-01-01T00:00:00.000Z~a', archived: '2025-01-01T00:00:00.000Z~a' }))
  await call("select sb_create_link($1,$2,'editor',null)", T, E)
  await call("select sb_create_link($1,$2,'viewer',null)", T, V)
})

describe('token gate', () => {
  it('rejects malformed / unknown / tampered tokens', async () => {
    expect((await call("select sb_redeem('zzz')")).err).toBe('invalid_token')
    expect((await call('select sb_redeem($1)', 'f'.repeat(32))).err).toBe('invalid_token')
    expect((await call('select sb_pull($1)', E.slice(0, 31) + '0')).err).toBe('invalid_token')
  })
  it('redeem returns role', async () => expect((await call('select sb_redeem($1) as r', E)).v?.r).toMatchObject({ role: 'editor' }))
  it('anon cannot touch tables or helpers directly', async () => {
    await db.exec('set role anon')
    expect((await call('select * from sb_records')).err).toMatch(/permission denied/)
    expect((await call('select * from sb_links')).err).toMatch(/permission denied/)
    expect((await call('select _sb_auth($1)', T)).err).toMatch(/permission denied/)
    expect((await call('select sb_redeem($1) as r', T)).v?.r).toMatchObject({ role: 'owner' })
    await db.exec('reset role')
  })
})
describe('roles', () => {
  it('viewer cannot write; editor cannot manage links; writes into another group refused', async () => {
    expect((await call('select sb_push($1,$2::jsonb)', V, rec('e1', 1, '2025-01-02T00:00:00.000Z~b'))).err).toBe('forbidden')
    expect((await call("select sb_create_link($1,$2,'editor',null)", E, X)).err).toBe('forbidden')
    expect((await call('select sb_push($1,$2::jsonb)', E, rec('e1', 1, '2025-01-02T00:00:00.000Z~b', 'other-group'))).err).toBe('bad_request')
  })
  it('editor cannot overwrite group settings (silently ignored)', async () => {
    await call('select sb_push($1,$2::jsonb)', E, JSON.stringify([{ kind: 'group', id: 'group-12345', data: { name: 'HACK', archived: true }, fieldTimes: { name: '2099-01-01T00:00:00.000Z~b', archived: '2099-01-01T00:00:00.000Z~b' } }]))
    expect((await pull(V)).archived).toBe(false)
  })
})
describe('sync semantics', () => {
  it('per-field LWW: newer wins regardless of arrival order; retries are idempotent and do not bump cursor', async () => {
    await call('select sb_push($1,$2::jsonb)', E, rec('e1', 100, '2025-01-02T00:00:00.000Z~b'))
    await call('select sb_push($1,$2::jsonb)', T, rec('e1', 50, '2025-01-01T00:00:00.000Z~a')) // older, arrives later
    expect((await pull(V)).records.find((r) => r.kind === 'expense')?.data.amount).toBe(100)
    await call('select sb_push($1,$2::jsonb)', T, rec('e1', 999, '2025-01-03T00:00:00.000Z~a'))
    const p = await pull(V)
    expect(p.records.filter((r) => r.kind === 'expense')).toHaveLength(1)
    expect(p.records.find((r) => r.kind === 'expense')?.data.amount).toBe(999)
    await call('select sb_push($1,$2::jsonb)', T, rec('e1', 999, '2025-01-03T00:00:00.000Z~a'))
    expect((await pull(V, p.cursor)).records).toHaveLength(0)
  })
  it('different fields from two devices both survive', async () => {
    const mk = (f: string, v: unknown, t: string) => JSON.stringify([{ kind: 'expense', id: 'e2', data: { groupId: 'group-12345', [f]: v }, fieldTimes: { groupId: t, [f]: t } }])
    await call('select sb_push($1,$2::jsonb)', E, mk('title', 'Dinner', '2025-02-01T00:00:00.000Z~b'))
    await call('select sb_push($1,$2::jsonb)', T, mk('notes', 'cash', '2025-02-01T00:00:01.000Z~a'))
    const r = (await pull(V)).records.find((x) => (x as never as { id: string }).id === 'e2') as unknown as { data: Record<string, string> }
    expect(r.data).toMatchObject({ title: 'Dinner', notes: 'cash' })
  })
})
describe('revocation / expiry / archive (mid-session)', () => {
  it('revoked link stops working immediately; others keep working', async () => {
    const links = (await call('select sb_list_links($1) as r', T)).v?.r as unknown as { id: string; role: string }[]
    await call('select sb_revoke_link($1,$2::uuid)', T, links.find((l) => l.role === 'viewer')!.id)
    expect((await call('select sb_pull($1)', V)).err).toBe('token_revoked')
    expect((await call('select sb_pull($1)', E)).err).toBeUndefined()
  })
  it('expired link rejected', async () => {
    await call("select sb_create_link($1,$2,'viewer',1)", T, X)
    await db.query("update sb_links set expires_at = now() - interval '1 minute' where token_hash = sha256(convert_to($1,'UTF8'))", [X])
    expect((await call('select sb_pull($1)', X)).err).toBe('token_expired')
  })
  it('archived group: reads allowed, editor writes blocked, owner may still write', async () => {
    await call('select sb_push($1,$2::jsonb)', T, JSON.stringify([{ kind: 'group', id: 'group-12345', data: { name: 'Trip', archived: true }, fieldTimes: { name: '2025-03-01T00:00:00.000Z~a', archived: '2025-03-01T00:00:00.000Z~a' } }]))
    expect((await pull(E)).archived).toBe(true)
    expect((await call('select sb_push($1,$2::jsonb)', E, rec('e3', 1, '2025-03-02T00:00:00.000Z~b'))).err).toBe('group_archived')
    expect((await call('select sb_push($1,$2::jsonb)', T, rec('e3', 1, '2025-03-02T00:00:00.000Z~a'))).err).toBeUndefined()
  })
})
describe('abuse limits', () => {
  it('oversized records and batches refused; pull is rate limited', async () => {
    const big = JSON.stringify([{ kind: 'expense', id: 'big', data: { groupId: 'group-12345', notes: 'x'.repeat(70000) }, fieldTimes: { notes: 't' } }])
    expect((await call('select sb_push($1,$2::jsonb)', T, big)).err).toBe('too_large')
    expect((await call('select sb_push($1,$2::jsonb)', T, JSON.stringify(Array(101).fill({})))).err).toBe('bad_request')
    let err: string | undefined
    for (let i = 0; i < 250 && !err; i++) err = (await call('select sb_pull($1)', T)).err
    expect(err).toBe('rate_limited')
  })
})
