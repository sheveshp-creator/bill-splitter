const c = (v) => `rgb(var(--${v}) / <alpha-value>)`
export default {
  darkMode: 'media',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: { paper: c('paper'), card: c('card'), ink: c('ink'), 'on-ink': c('on-ink'), rule: c('rule'), muted: c('muted'), owe: c('owe'), get: c('get'), mark: c('mark') },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: { DEFAULT: '6px' },
    },
  },
  plugins: [],
}
