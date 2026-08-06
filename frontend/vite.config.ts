import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const liaProxy = {
  '/api/lia-agent': {
    target: 'http://127.0.0.1:13004',
    changeOrigin: false,
    secure: false,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: liaProxy,
  },
  preview: {
    host: '0.0.0.0',
    port: 5199,
    strictPort: true,
    proxy: liaProxy,
  },
});
