import type { GroupData } from '../../components/hooks'
import { useToast } from '../../components/ui'
import { undoActivity } from '../../db/repo'

export default function Activity({ data }: { data: GroupData }) {
  const toast = useToast()
  const list = [...data.activity].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200)
  const latestFor = new Map<string, string>()
  for (const a of list) if (!latestFor.has(a.entityId)) latestFor.set(a.entityId, a.id)
  return (
    <section aria-label="Activity log">
      {list.length === 0 && <p className="card muted">Nothing yet.</p>}
      <ol className="space-y-2">
        {list.map((a) => (
          <li key={a.id} className="card flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="truncate">{a.summary}</div>
              <div className="muted">{a.actor && data.names[a.actor] ? `${data.names[a.actor]} · ` : ''}{new Date(a.at).toLocaleString()}</div>
            </div>
            {data.canEdit && ['expense', 'settlement', 'member'].includes(a.entity) && latestFor.get(a.entityId) === a.id && a.action !== 'member' && (
              <button className="btn-ghost !px-3" onClick={async () => { await undoActivity(a); toast('Undone') }}>Undo</button>
            )}
          </li>
        ))}
      </ol>
      <p className="muted mt-3">Every change keeps a snapshot of what it replaced, so you can undo it. Deleted items are only hidden, never erased.</p>
    </section>
  )
}
