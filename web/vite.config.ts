import { fileURLToPath } from 'node:url';
import { exactDevOrigins } from './src/server/origins.ts';
import { defineConfig, loadEnv } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ command, mode }) => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const configured =
    command === 'serve'
      ? loadEnv(mode, root, 'DEV_TRUSTED_ORIGINS').DEV_TRUSTED_ORIGINS
      : undefined;
  const origins = exactDevOrigins(configured);
  return {
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: { allowedHosts: origins.map((origin) => new URL(origin).hostname) },
    environments: {
      ssr: {
        build: {
          rolldownOptions: {
            output: {
              // Better Auth loads multiple Drizzle dialects. Keep their shared classes
              // together so circular chunks cannot evaluate a subclass before Table.
              codeSplitting: {
                groups: [{ name: 'drizzle', test: /node_modules[\\/]drizzle-orm[\\/]/ }],
              },
            },
          },
        },
      },
    },
    plugins: [
      cloudflare({
        viteEnvironment: { name: 'ssr' },
        // .dev.vars may hold secrets, which makes Wrangler ignore .env.local.
        // Share only this nonsecret development value with the Worker explicitly.
        ...(command === 'serve'
          ? {
              config: (config) => ({
                vars: { ...config.vars, DEV_TRUSTED_ORIGINS: origins.join(',') },
              }),
            }
          : {}),
      }),
      tanstackStart(),
      viteReact(),
      tailwindcss(),
    ],
  };
});
