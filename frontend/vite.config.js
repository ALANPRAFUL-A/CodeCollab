import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The dev server now mirrors what the nginx reverse proxy does in production, so
 * `npm run dev` and the Docker stack behave identically from the app's point of
 * view: everything is same-origin, and /api + /socket.io are forwarded.
 *
 * BACKEND_TARGET lets you point the dev server at the Dockerised load balancer
 * instead of a bare local backend:
 *
 *   npm run dev                                    -> proxies to localhost:5000
 *   BACKEND_TARGET=http://localhost:8080 npm run dev  -> proxies to the LB
 */
const target = process.env.BACKEND_TARGET || 'http://localhost:5000'

export default defineConfig({
  plugins: [react()],
  server: {
    // 0.0.0.0 is required if you ever run the dev server inside a container;
    // Vite binds localhost by default and the port would look dead from outside.
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target,
        changeOrigin: true,
      },
      // The original config was missing this entirely, which is why the client
      // had to use an absolute URL for Socket.IO. `ws: true` is what allows the
      // HTTP -> WebSocket Upgrade handshake to pass through.
      '/socket.io': {
        target,
        changeOrigin: true,
        ws: true,
      },
      '/health': {
        target,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Monaco and Yjs are large; raise the warning ceiling so the build output
    // stays readable instead of drowning in chunk-size warnings.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Vite 8 ships Rolldown, which requires the FUNCTION form of
        // manualChunks - the object form throws "manualChunks is not a function".
        // Splitting vendor code lets nginx cache these hashed chunks for a year
        // while index.html stays no-cache.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('monaco')) return 'monaco'
          if (/[\\/](yjs|y-monaco|y-protocols|socket\.io-client|engine\.io-client)[\\/]/.test(id))
            return 'collab'
          if (/[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id))
            return 'react'
        },
      },
    },
  },
})
