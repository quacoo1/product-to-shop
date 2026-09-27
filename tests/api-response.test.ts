import test from 'node:test';
import assert from 'node:assert/strict';
import { readApiJson, responseError } from '../src/api.js';

test('Missing API and SPA fallback responses explain deployment routing rather than JSON parse failures', async () => {
  await assert.rejects(readApiJson(new Response('<h1>Not found</h1>', { status: 404 })), /backend connected to \/api/);
  await assert.rejects(readApiJson(new Response('<html>App</html>', { headers: { 'content-type': 'text/html' } })), /web page instead of JSON/);
});

test('API response handling preserves successful JSON and backend validation messages', async () => {
  assert.deepEqual(await readApiJson(Response.json({ token: 'test-session' })), { token: 'test-session' });
  await assert.rejects(readApiJson(Response.json({ error: 'Correct the quantity mismatch.' }, { status: 400 })), /Correct the quantity mismatch/);
  assert.match(await responseError(new Response('invalid JSON', { status: 502, headers: { 'content-type': 'application/json' } })), /HTTP 502/);
});
