import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

export const AVATAR_COLORS = ['#0f766e', '#b45309', '#7c3aed', '#be123c', '#1d4ed8', '#4d7c0f', '#c2410c', '#0e7490']
export const colorFor = (id: string) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return AVATAR_COLORS[h % AVATAR_COLORS.length] }

export function Avatar({ id, name, size = 36 }: { id: string; name: string; size?: number }) {
  return (
    <span aria-hidden className="inline-flex items-center justify-center rounded-full text-white font-semibold shrink-0"
      style={{ width: size, height: size, background: colorFor(id), fontSize: size * 0.42 }}>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

/** Tap-to-toggle avatar used for assigning items / participants. */
export function AvatarToggle({ id, name, on, onToggle, disabled }: { id: string; name: string; on: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-label={name} disabled={disabled} onClick={onToggle}
      className={`flex flex-col items-center gap-1 p-1 rounded-xl min-w-[56px] ${on ? '' : 'opacity-45'}`}>
      <span className={`rounded-full ${on ? 'ring-4 ring-teal-500' : ''}`}><Avatar id={id} name={name} size={40} /></span>
      <span className="text-xs max-w-[64px] truncate">{name}</span>
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
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50" onClick={onClose}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-white dark:bg-slate-900 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold">{title}</h2>
          <button className="btn-ghost !min-h-[36px] !px-3" onClick={onClose} aria-label="Close">✕</button>
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
        {msg && <div className="bg-slate-900 text-white dark:bg-white dark:text-slate-900 px-4 py-2 rounded-full text-sm shadow-lg">{msg}</div>}
      </div>
    </ToastCtx.Provider>
  )
}

export function Banner({ tone = 'info', children, onClose }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode; onClose?: () => void }) {
  const c = { info: 'bg-sky-50 border-sky-200 text-sky-900 dark:bg-sky-950 dark:border-sky-800 dark:text-sky-100',
    warn: 'bg-amber-50 border-amber-300 text-amber-900 dark:bg-amber-950 dark:border-amber-700 dark:text-amber-100',
    error: 'bg-red-50 border-red-300 text-red-900 dark:bg-red-950 dark:border-red-700 dark:text-red-100' }[tone]
  return (
    <div role={tone === 'info' ? 'status' : 'alert'} className={`rounded-xl border p-3 text-sm mb-3 flex gap-3 ${c}`}>
      <div className="flex-1">{children}</div>
      {onClose && <button onClick={onClose} aria-label="Dismiss" className="font-bold px-1">✕</button>}
    </div>
  )
}

export async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}
