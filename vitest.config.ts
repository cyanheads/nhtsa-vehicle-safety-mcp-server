import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@/': new URL('./src/', import.meta.url).pathname },
    tsconfigPaths: true,
  },
  ssr: {
    noExternal: ['zod'],
  },
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    isolate: true,
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
