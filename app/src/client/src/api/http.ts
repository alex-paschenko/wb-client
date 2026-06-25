import { apiBaseUrl } from './config';

export async function apiRequest<TResponse>(
  path: string,
  options?: RequestInit,
): Promise<TResponse> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  const data = await response.json();

  if (!response.ok || data.ok === false) {
    throw new Error(data.error ?? 'API request failed');
  }

  return data as TResponse;
}
