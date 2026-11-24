/** Small stroke icon set (24px grid, currentColor). Replaces emoji so the UI has one visual voice. */
const P: Record<string, string> = {
  food: 'M7 3v8a2 2 0 0 0 2 2v8 M11 3v8a2 2 0 0 1-2 2 M17 3c-2.2 1.6-3 4-3 7h3v11',
  travel: 'M4 16v-4l2-5h12l2 5v4h-2 M4 16h16 M7 16v2 M17 16v2 M6 12h12',
  stay: 'M3 19V6 M3 15h18v4 M21 15v-2.5A2.5 2.5 0 0 0 18.5 10H11v5 M7 12.5h.01',
  shopping: 'M5 8h14l-1 12H6L5 8z M9 8V7a3 3 0 0 1 6 0v1',
  rent: 'M3 11l9-7 9 7 M5 10v10h14V10 M10 20v-6h4v6',
  utilities: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
  fun: 'M12 3l2.4 5.2 5.6.7-4.1 3.9 1 5.6L12 15.6 7.1 18.4l1-5.6L4 8.9l5.6-.7L12 3z',
  other: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3z M9 8h6 M9 12h6',
  expenses: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3z M9 8h6 M9 12h6',
  balances: 'M12 4v16 M7 20h10 M4 7h16 M4 7l-2.5 6a3 3 0 0 0 5 0L4 7z M20 7l-2.5 6a3 3 0 0 0 5 0L20 7z',
  activity: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M2.5 20v-1a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v1 M16 4.3a3.5 3.5 0 0 1 0 6.4 M18 14.2a5 5 0 0 1 3.5 4.8v1',
  plus: 'M12 5v14 M5 12h14',
  back: 'M15 5l-7 7 7 7',
  close: 'M6 6l12 12 M18 6L6 18',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4V8z M12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  repeat: 'M4 12V9a3 3 0 0 1 3-3h12 M16 3l3 3-3 3 M20 12v3a3 3 0 0 1-3 3H5 M8 21l-3-3 3-3',
  phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M11 18h2',
  cloud: 'M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9.5 3.8 3.8 0 0 1 17.5 18H7z',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M6 6l12 12',
  alert: 'M12 4l10 17H2L12 4z M12 10v5 M12 18h.01',
  arrow: 'M4 12h16 M14 6l6 6-6 6',
}
export function Icon({ name, size = 20, className = '', strokeWidth = 1.75 }: { name: keyof typeof P | string; size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={strokeWidth} strokeLinecap='round' strokeLinejoin='round' className={className}>
      <path d={P[name] ?? P.other} />
    </svg>
  )
}
export const CATEGORY_ICONS = ['food', 'travel', 'stay', 'shopping', 'rent', 'utilities', 'fun', 'other']
