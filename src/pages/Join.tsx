import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { Avatar, Banner } from '../components/ui'
import { db } from '../db/db'
import { addMember } from '../db/repo'
import { isConfigured } from '../sync/remote'
import { joinWithToken } from '../sync/engine'

const MESSAGES: Record<string, string> = {
  invalid_token: 'This invite link is not valid. Ask for a new one.',
  token_revoked: 'This invite link was revoked by the group owner.',
  token_expired: 'This invite link has expired. Ask for a new one.',
  offline: "You're offline. Connect to the internet to join a group.",
  rate_limited: 'Too many attempts. Please wait a minute and try again.',
  not_configured: 'Sharing is not set up on this deployment.',
}

export default function Join() {
  const { token = '' } = useParams()
  const nav = useNavigate()
  const [state, setState] = useState<{ groupId: string; role: string } | { error: string } | null>(null)
  const [newName, setNewName] = useState('')

  useEffect(() => { void joinWithToken(token).then(setState) }, [token])
  const groupId = state && 'groupId' in state ? state.groupId : ''
  const members = useLiveQuery(() => (groupId ? db.members.where('groupId').equals(groupId).toArray() : []), [groupId])
  const group = useLiveQuery(() => (groupId ? db.groups.get(groupId) : undefined), [groupId])

  const pick = async (id: string) => { await db.local.update(groupId, { meId: id }); nav(`/g/${groupId}`, { replace: true }) }
  const addSelf = async (e: React.FormEvent) => {
    e.preventDefault()
    if (state && 'role' in state && state.role === 'viewer') return
    const m = await addMember(groupId, newName)
    await pick(m.id)
  }

  if (!state) return <p className="p-6 muted" role="status">Joining…</p>
  if ('error' in state) return (
    <main className="p-6"><h1 className="text-xl font-bold mb-3">Can't open this link</h1>
      <Banner tone="error">{MESSAGES[state.error] ?? 'Something went wrong. Try again.'}</Banner>
      {!isConfigured() && <p className="muted">(This build has no Supabase credentials configured.)</p>}
      <Link to="/" className="btn-ghost mt-3">Back home</Link></main>
  )
  const viewer = state.role === 'viewer'
  return (
    <main className="p-4">
      <h1 className="text-2xl font-extrabold mb-1">Join {group?.name ?? '…'}</h1>
      <p className="muted mb-4">Who are you? {viewer && 'You have view-only access.'}</p>
      <ul className="space-y-2 mb-4">
        {members?.filter((m) => !m.deleted && !m.archived).map((m) => (
          <li key={m.id}><button className="card w-full flex items-center gap-3 min-h-[56px] text-left" onClick={() => void pick(m.id)}><Avatar id={m.id} name={m.name} /> <span className="font-medium">{m.name}</span></button></li>
        ))}
      </ul>
      {!viewer && (
        <form onSubmit={addSelf} className="card flex gap-2">
          <input aria-label="Your name" className="input" required maxLength={50} placeholder="I'm not in the list…" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className="btn-primary">Add me</button>
        </form>
      )}
      <button className="btn-ghost w-full mt-3" onClick={() => nav(`/g/${groupId}`, { replace: true })}>Just look around</button>
    </main>
  )
}
