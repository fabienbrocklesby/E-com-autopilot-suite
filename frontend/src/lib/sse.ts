/**
 * SSE helper - opens a persistent Server-Sent Events connection to the backend.
 * EventSource connects through the same-origin SvelteKit proxy, which injects
 * backend auth server-side.
 */

export function openSSE(
	path: string,
	params: Record<string, string | number> = {},
): EventSource {
	const qs = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
	return new EventSource(`/api/events/${path}?${qs.toString()}`);
}
