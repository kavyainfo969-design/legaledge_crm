import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, '/api'),
      },
    },
  },
  // Allow Vite preview to accept requests routed to the Render host
  preview: {
    // whitelist Render backend hostname so preview binds correctly when Render
    // routes traffic through the platform
    allowedHosts: ['legaledge-crm-backend.onrender.com'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    css: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return;
          }
          if (id.includes('react') || id.includes('scheduler')) {
            return 'react-vendor';
          }
          if (id.includes('react-router')) {
            return 'router-vendor';
          }
          if (id.includes('chart.js') || id.includes('react-chartjs-2')) {
            return 'chart-vendor';
          }
          if (id.includes('@fortawesome')) {
            return 'icons-vendor';
          }
          if (id.includes('@emailjs')) {
            return 'email-vendor';
          }
          return 'vendor';
        },
      },
    },
  },
});
