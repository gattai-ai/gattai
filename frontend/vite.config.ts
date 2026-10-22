import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from "path";

/**
 * Backend dev berjalan di PORT (default 3000). Frontend memanggil API lewat
 * path relatif "/api/*" yang di-proxy ke backend, sehingga cookie sesi SIWE
 * dikirim same-origin (EventSource tidak bisa menyetel header Authorization).
 * Di produksi, biarkan VITE_API_URL kosong: rewrite Vercel meneruskan "/api/*"
 * ke backend Railway sehingga semuanya same-origin (lihat frontend/vercel.json).
 */
const API_TARGET = process.env.VITE_API_PROXY ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Folder shared/ berada di luar frontend/, jadi Vite perlu alias agar
      // "@shared/..." bisa diimpor. Pasangannya ada di tsconfig.json
      // ("paths": { "@shared/*": ["../shared/*"] }).
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  server: {
    port: 5173,
    open: true,
    // Izinkan pembacaan file di luar frontend/ (folder shared/ di root repo)
    fs: {
      allow: [".."],
    },
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
})
