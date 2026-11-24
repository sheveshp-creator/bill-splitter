import { Icon } from './icons'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

export const AVATAR_COLORS = ['#7c3f2a', '#2f5d50', '#4a4e8c', '#8a6a1c', '#6b2f4d', '#3b5b2a', '#8c4a1f', '#1f4e6b']
export const colorFor = (id: string) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return AVATAR_COLORS[h % AVATAR_COLORS.length] }

export function Avatar({ id, name, size = 36 }: { id: string; name: string; size?: number }) {
  return (
    <span aria-hidden className="inline-flex items-center justify-center rounded text-[#f6f1e7] font-mono font-medium shrink-0"
      style={{ width: size, height: size, background: colorFor(id), fontSize: size * 0.44 }}>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

/** Tap-to-toggle avatar used for assigning items / participants. */
export function AvatarToggle({ id, name, on, onToggle, disabled }: { id: string; name: string; on: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-label={name} disabled={disabled} onClick={onToggle}
      className={`flex flex-col items-center gap-1 p-1.5 rounded min-w-[60px] border-2 ${on ? 'border-ink bg-mark/40' : 'border-transparent opacity-50'}`}>
      <Avatar id={id} name={name} size={38} />
      <span className="text-xs max-w-[64px] truncate font-medium">{name}</span>
    </button>
  )
}

export function Field({ label, children, hint, error, htmlFor }: { label: string; children: ReactNode; hint?: string; error?: string; htmlFor?: string }) {
  return (
    <div className="mb-3">
      <label className="label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && !error && <p className="muted mt-1">{hint}</p>}
      {error && <p role="alert" className="err mt-1">{error}</p>}
    </div>
  )
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); prev?.focus() }
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-ink/55" onClick={onClose}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md max-h-[92vh] overflow-y-auto rounded-t-lg sm:rounded-lg bg-card border-2 border-ink p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-semibold">{title}</h2>
          <button className="btn-ghost !min-h-[36px] !px-2" onClick={onClose} aria-label="Close"><Icon name="close" size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

/* ---- toast ---- */
const ToastCtx = createContext<(m: string) => void>(() => {})
export const useToast = () => useContext(ToastCtx)
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null)
  const show = useCallback((m: string) => { setMsg(m); setTimeout(() => setMsg(null), 2600) }, [])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div role="status" aria-live="polite" className="fixed bottom-24 inset-x-0 flex justify-center pointer-events-none z-[60]">
        {msg && <div className="bg-ink text-on-ink px-4 py-2 rounded text-sm font-medium border-2 border-ink" style={{ boxShadow: '3px 3px 0 0 rgb(var(--mark))' }}>{msg}</div>}
      </div>
    </ToastCtx.Provider>
  )
}

export function Banner({ tone = 'info', children, onClose }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode; onClose?: () => void }) {
  // a left "tab" in the tone colour on a paper note, instead of a tinted alert box
  const bar = { info: 'border-l-ink', warn: 'border-l-mark', error: 'border-l-owe' }[tone]
  return (
    <div role={tone === 'info' ? 'status' : 'alert'} className={`rounded border border-rule border-l-[6px] ${bar} bg-card p-3 text-sm mb-3 flex gap-3`}>
      <div className="flex-1">{children}</div>
      {onClose && <button onClick={onClose} aria-label="Dismiss" className="px-1 text-muted hover:text-ink"><Icon name="close" size={16} /></button>}
    </div>
  )
}

export async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}
