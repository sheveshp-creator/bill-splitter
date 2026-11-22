// Run the app locally and expose it through an ngrok HTTPS tunnel for phone testing.
//   npm run share        -> dev server (hot reload)
//   npm run share:prod   -> production build + preview (tests the real PWA / service worker)
import { spawn, spawnSync } from 'node:child_process'

const prod = process.argv.includes('--prod')
const port = prod ? 4173 : 5173
if (spawnSync('ngrok', ['version']).error) {
  console.error('ngrok not found. Install it (brew install ngrok) and run: ngrok config add-authtoken <token>')
  process.exit(1)
}
if (prod) {
  const b = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' })
  if (b.status !== 0) process.exit(b.status ?? 1)
}
const vite = spawn('npx', ['vite', ...(prod ? ['preview'] : []), '--host', '--port', String(port), '--strictPort'], { stdio: 'inherit' })
const ngrok = spawn('ngrok', ['http', String(port)], { stdio: 'inherit' })
const stop = () => { vite.kill(); ngrok.kill(); process.exit(0) }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
vite.on('exit', stop); ngrok.on('exit', stop)
