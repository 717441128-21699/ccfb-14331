/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
