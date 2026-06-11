// API utility to handle base URL in production
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

export function getApiUrl(path: string): string {
  // If path is already absolute, return as-is
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  
  // In production, prepend the API base URL
  // In development with proxy, use relative URLs
  return API_BASE_URL ? `${API_BASE_URL}${path}` : path;
}

// Helper to wrap fetch with API URL and Auth header
export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem('token');
  
  const headers = {
    ...options.headers,
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  };

  const response = await fetch(getApiUrl(path), {
    ...options,
    headers
  });

  // Only auto-logout on 401 in dev mode - in prod, handle via explicit logout or socket events
  if (!import.meta.env.PROD && response.status === 401 && token) {
    console.warn('[API] Received 401 with stale token, redirecting to login');
    localStorage.removeItem('token');
    localStorage.removeItem('profileId');
    localStorage.removeItem('username');
    localStorage.removeItem('displayName');
    localStorage.removeItem('color');
    window.location.href = '/login';
  }

  return response;
}
