import type { Request, Response } from 'express';
import { getCloudApp } from '../server/cloud/app.js';
import { HttpError } from '../server/cloud/store.js';

export function createHandler(factory = getCloudApp) { return function handler(req: Request, res: Response) {
  try {
    // The rewrite carries the full API path explicitly, independent of Vercel's req.url behavior.
    const url = new URL(req.url, 'https://collector.invalid');
    const route = url.searchParams.get('__route');
    if (route) {
      url.searchParams.delete('__route');
      req.url = `/api/${route}${url.search ? url.search : ''}`;
    }
    return factory()(req, res);
  } catch (error) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(error instanceof HttpError ? error.status : 503).json({ error: error instanceof HttpError ? error.message : 'The backend could not start. Check the Vercel runtime logs.' });
  }
}; }
export default createHandler();
