export async function responseError(response: Response): Promise<string> {
  const isJson = response.headers.get('content-type')?.includes('application/json');
  if (isJson) {
    try {
      const data: unknown = await response.json();
      if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') return data.error;
    } catch { /* Return a useful HTTP error even if an upstream returned invalid JSON. */ }
  }
  if (response.status === 404) return 'The API route was not found. This deployment needs the Product Collector backend connected to /api.';
  if (response.status === 401 || response.status === 403) return 'Access to the backend was denied. Check your session and deployment access settings.';
  return `The backend returned HTTP ${response.status}. Check the server logs and deployment configuration.`;
}

export async function readApiJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new ApiError(await responseError(response), response.status);
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('The API returned a web page instead of JSON. Connect /api to the Product Collector backend.');
  }
  return response.json() as Promise<T>;
}
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
