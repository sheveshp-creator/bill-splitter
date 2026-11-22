import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { WireRecord } from './merge'

export type RemoteErrorCode =
  | 'invalid_token' | 'token_revoked' | 'token_expired' | 'forbidden' | 'group_archived' | 'rate_limited'
  | 'too_large' | 'bad_request' | 'offline' | 'not_configured' | 'unknown'

export class RemoteError extends Error {
  constructor(public code: RemoteErrorCode, message?: string) { super(message ?? code) }
}
const KNOWN = new Set<string>(['invalid_token', 'token_revoked', 'token_expired', 'forbidden', 'group_archived', 'rate_limited', 'too_large', 'bad_request'])

let client: SupabaseClient | null | undefined
export function supabase(): SupabaseClient | null {
  if (client !== undefined) return client
  const url = import.meta.env?.VITE_SUPABASE_URL as string | undefined
  const key = import.meta.env?.VITE_SUPABASE_ANON_KEY as string | undefined
  client = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null
  return client
}
export const isConfigured = () => supabase() !== null

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const sb = supabase()
  if (!sb) throw new RemoteError('not_configured', 'Sync is not configured (missing Supabase env vars)')
  if (typeof navigator !== 'undefined' && !navigator.onLine) throw new RemoteError('offline')
  try {
    const { data, error } = await sb.rpc(fn, args)
    if (error) {
      const m = error.message?.trim()
      throw new RemoteError(KNOWN.has(m) ? (m as RemoteErrorCode) : 'unknown', error.message)
    }
    return data as T
  } catch (e) {
    if (e instanceof RemoteError) throw e
    throw new RemoteError('offline', (e as Error).message)   // fetch failure
  }
}

export interface PullResult { role: 'owner' | 'editor' | 'viewer'; archived: boolean; records: WireRecord[]; cursor: string; more: boolean }
export interface LinkInfo { id: string; role: 'owner' | 'editor' | 'viewer'; createdAt: string; expiresAt: string | null; revokedAt: string | null; current: boolean }

export const remote = {
  createGroup: (groupId: string, token: string, group: WireRecord) =>
    rpc<void>('sb_create_group', { p_group_id: groupId, p_token: token, p_group: group.data, p_times: group.fieldTimes }),
  redeem: (token: string) => rpc<{ group_id: string; role: 'owner' | 'editor' | 'viewer'; archived: boolean }>('sb_redeem', { p_token: token }),
  pull: (token: string, since: string) => rpc<PullResult>('sb_pull', { p_token: token, p_since: since }),
  push: (token: string, records: WireRecord[]) => rpc<{ ok: boolean; applied: number }>('sb_push', { p_token: token, p_records: records }),
  createLink: (owner: string, token: string, role: string, hours: number | null) =>
    rpc<string>('sb_create_link', { p_owner_token: owner, p_new_token: token, p_role: role, p_hours: hours }),
  revokeLink: (owner: string, id: string) => rpc<void>('sb_revoke_link', { p_owner_token: owner, p_link_id: id }),
  listLinks: (owner: string) => rpc<LinkInfo[]>('sb_list_links', { p_owner_token: owner }),
  deleteGroup: (owner: string) => rpc<void>('sb_delete_group', { p_owner_token: owner }),
}
