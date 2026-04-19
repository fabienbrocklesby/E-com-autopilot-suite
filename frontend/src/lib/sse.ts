/**
 * SSE helper - opens a persistent Server-Sent Events connection to the backend.
 * Native EventSource can't send headers, so auth is passed via ?token= query param.
 */
import { PUBLIC_API_BASE_URL } from '$env/static/public';

export function openSSE(
	path: string,
	params: Record<string, string | number> = {},
): EventSource {
	const token =
		typeof localStorage !== 'undefined' ? (localStorage.getItem('api_token') ?? '') : '';
	const qs = new URLSearchParams();
	qs.set('token', token);
	for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
	return new EventSource(`${PUBLIC_API_BASE_URL}/events/${path}?${qs.toString()}`);
}
