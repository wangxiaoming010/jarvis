import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { strictPort: true, port: Number(process.env.CLIENT_PORT ?? 1420), host: '127.0.0.1' },
  envDir: '../..',
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('react-markdown') ||
            id.includes('remark-') ||
            id.includes('micromark') ||
            id.includes('mdast-') ||
            id.includes('hast-') ||
            id.includes('unified')
          )
            return 'markdown';
          if (
            id.includes('@heroui') ||
            id.includes('react-aria') ||
            id.includes('react-stately') ||
            id.includes('@internationalized')
          )
            return 'ui';
          if (id.includes('motion')) return 'motion';
        },
      },
    },
  },
});
