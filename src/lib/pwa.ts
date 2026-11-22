import { useEffect, useState } from 'react'

interface BIPEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
let deferred: BIPEvent | null = null
const listeners = new Set<() => void>()
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as BIPEvent; listeners.forEach((f) => f()) })
  window.addEventListener('appinstalled', () => { deferred = null; listeners.forEach((f) => f()) })
}
export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as never as { standalone?: boolean }).standalone === true
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/** 'android' = native prompt available, 'ios' = show Share → Add to Home Screen steps, null = nothing to show */
export function useInstallHint(): { kind: 'prompt' | 'ios' | null; install: () => Promise<void> } {
  const [, tick] = useState(0)
  useEffect(() => { const f = () => tick((n) => n + 1); listeners.add(f); return () => { listeners.delete(f) } }, [])
  let dismissed = false
  try { dismissed = localStorage.getItem('bs_install_dismissed') === '1' } catch { /* */ }
  const kind = isStandalone() || dismissed ? null : deferred ? 'prompt' : isIos() ? 'ios' : null
  return { kind, install: async () => { await deferred?.prompt(); deferred = null; listeners.forEach((f) => f()) } }
}
export const dismissInstall = () => { try { localStorage.setItem('bs_install_dismissed', '1') } catch { /* */ } }

/** Ask the browser not to evict our IndexedDB (matters most on iOS Safari). */
export async function requestPersistence(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false } catch { return false }
}
