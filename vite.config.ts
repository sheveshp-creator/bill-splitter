/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Bill Splitter', short_name: 'Splitter',
        description: 'Split bills with friends. Works offline.',
        theme_color: '#1c1917', background_color: '#f4efe4',
        display: 'standalone', start_url: '/', scope: '/',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'], navigateFallback: '/index.html', maximumFileSizeToCacheInBytes: 5_000_000 },
    }),
  ],
  // allow ngrok tunnels (Vite otherwise rejects unknown Host headers)
  server: { host: true, allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.io', '.ngrok.dev'] },
  preview: { host: true, allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.io', '.ngrok.dev'] },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
})
