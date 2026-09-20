import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The backend's port. 8000 is what the README, the deployment notes and the
// nginx sample all use; set API_PORT to override without editing this file —
// useful when something else on the machine already has 8000.
const API_PORT = process.env.API_PORT || 8000

export default defineConfig({
  plugins: [react()],
  // Component tests run against jsdom, so a click and a re-render can be
  // asserted the way somebody using the builder would experience them.
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.jsx'],
  },
  server: {
    port: 5173,
    proxy: {
      // 127.0.0.1 rather than localhost: on Windows, localhost resolves to ::1
      // first, and a backend bound only to IPv4 refuses that connection —
      // which surfaces here as an unexplained ECONNREFUSED from the proxy.
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
})
