import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const LIA_AGENT_BACKEND_TARGET = 'http://127.0.0.1:3014';

const translateLiaAgentPath = (path: string): string => {
  if (path === '/api/lia-agent/query') {
    return '/api/hermes/query';
  }

  if (path === '/api/lia-agent/hermes/status') {
    return '/api/hermes/status';
  }

  if (
    path === '/api/lia-agent/projects/tasks'
    || path.startsWith('/api/lia-agent/projects/tasks/')
    || path === '/api/lia-agent/projects/goals'
    || path.startsWith('/api/lia-agent/projects/goals/')
    || path === '/api/lia-agent/projects/office'
    || /^\/api\/lia-agent\/projects\/[^/]+\/board-decisions(?:\/[^/]+)?(?:\?.*)?$/.test(path)
  ) {
    return path.replace(/^\/api\/lia-agent/, '/api');
  }

  return path;
};

const liaProxy = {
  '/api/lia-agent': {
    target: LIA_AGENT_BACKEND_TARGET,
    changeOrigin: false,
    secure: false,
    rewrite: translateLiaAgentPath,
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
