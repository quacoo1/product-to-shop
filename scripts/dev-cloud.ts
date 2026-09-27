import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCloudApp } from '../server/cloud/app.js';
import { configuredStore } from '../server/cloud/store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = createCloudApp({ store: configuredStore(), password: process.env.COLLECTOR_PASSWORD || '', secureCookies: false });
if (existsSync(path.join(root, 'dist/index.html'))) app.use(express.static(path.join(root, 'dist')));
else {
  const { createServer } = await import('vite');
  app.use((await createServer({ root, server: { middlewareMode: true, hmr: false }, appType: 'spa' })).middlewares);
}
const port = Number(process.env.PORT || 4318);
app.listen(port, '127.0.0.1', () => console.log(`Cloud-mode development server: http://localhost:${port}`));
