import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const HOP_BY_HOP_HEADERS = new Set([
	'connection',
	'content-encoding',
	'content-length',
	'host',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade'
]);

function apiBaseUrl(url: URL): string {
	const baseUrl = env.SERVER_API_BASE_URL ?? env.API_BASE_URL ?? inferredApiBaseUrl(url);
	return baseUrl.replace(/\/$/, '');
}

function inferredApiBaseUrl(url: URL): string {
	const hostname = url.hostname;
	if (hostname === 'localhost' || hostname === '127.0.0.1') {
		return 'http://localhost:8000';
	}

	if (hostname.startsWith('api.')) {
		return url.origin;
	}

	return `${url.protocol}//api.${hostname}`;
}

function apiSecret(): string {
	return env.API_SECRET ?? '';
}

function proxiedHeaders(request: Request): Headers {
	const headers = new Headers();
	for (const [key, value] of request.headers) {
		if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== 'authorization') {
			headers.set(key, value);
		}
	}

	const secret = apiSecret();
	if (secret) {
		headers.set('authorization', `Bearer ${secret}`);
	}

	return headers;
}

const proxy: RequestHandler = async ({ params, request, url }) => {
	const path = params.path ?? '';
	const targetUrl = `${apiBaseUrl(url)}/${path}${url.search}`;
	const method = request.method.toUpperCase();
	const hasBody = method !== 'GET' && method !== 'HEAD';

	let response: Response;
	try {
		response = await fetch(targetUrl, {
			method,
			headers: proxiedHeaders(request),
			body: hasBody ? request.body : undefined,
			duplex: hasBody ? 'half' : undefined,
			redirect: 'manual'
		} as RequestInit & { duplex?: 'half' });
	} catch (err) {
		console.error('[api proxy] upstream request failed', { targetUrl, error: String(err) });
		return Response.json(
			{
				error: {
					message: 'API proxy upstream request failed',
					detail: targetUrl,
					status: 502
				}
			},
			{ status: 502 }
		);
	}

	const responseHeaders = new Headers(response.headers);
	for (const header of HOP_BY_HOP_HEADERS) {
		responseHeaders.delete(header);
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders
	});
};

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
