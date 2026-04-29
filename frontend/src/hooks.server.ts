import { redirect } from '@sveltejs/kit';
import { createHmac } from 'node:crypto';
import type { Handle } from '@sveltejs/kit';

// Derive the expected session token from the current password.
// If the password changes, all existing session cookies are automatically invalidated.
function expectedToken(password: string): string {
	return createHmac('sha256', password).update('dashboard:authenticated').digest('hex');
}

export const handle: Handle = async ({ event, resolve }) => {
	// Use process.env directly — reliable in both Vite dev and Node production.
	const password = process.env.DASHBOARD_PASSWORD;

	// If no password is configured, allow through (allows unprotected dev setups).
	if (!password) {
		return resolve(event);
	}

	// Login route is always public.
	if (event.url.pathname.startsWith('/login')) {
		return resolve(event);
	}

	const session = event.cookies.get('dashboard_session');
	if (session !== expectedToken(password)) {
		// Preserve pathname. Also preserve oauth_success and oauth_error so the
		// settings page can show feedback after the user logs in. Other query
		// params are deliberately dropped to avoid stale state surviving login.
		let returnTo = event.url.pathname;
		const oauthSuccess = event.url.searchParams.get('oauth_success');
		const oauthError = event.url.searchParams.get('oauth_error');
		if (oauthSuccess) returnTo += `?oauth_success=${encodeURIComponent(oauthSuccess)}`;
		else if (oauthError) returnTo += `?oauth_error=${encodeURIComponent(oauthError)}`;
		throw redirect(302, `/login?returnTo=${encodeURIComponent(returnTo)}`);
	}

	return resolve(event);
};
