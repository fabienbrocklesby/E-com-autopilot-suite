import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { createHmac } from 'node:crypto';
import type { Actions, PageServerLoad } from './$types';

function expectedToken(password: string): string {
	return createHmac('sha256', password).update('dashboard:authenticated').digest('hex');
}

export const load: PageServerLoad = async ({ cookies, url }) => {
	const password = env.DASHBOARD_PASSWORD;
	if (!password) {
		// No password configured — skip to app.
		throw redirect(302, '/');
	}

	const session = cookies.get('dashboard_session');
	if (session === expectedToken(password)) {
		// Already authenticated.
		const returnTo = url.searchParams.get('returnTo') ?? '/';
		throw redirect(302, returnTo);
	}

	return { returnTo: url.searchParams.get('returnTo') ?? '/' };
};

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const data = await request.formData();
		const password = data.get('password');

		if (typeof password !== 'string' || !password) {
			return fail(400, { error: 'Password is required.' });
		}

		const envPassword = env.DASHBOARD_PASSWORD;
		if (!envPassword || password !== envPassword) {
			// Use a short fixed delay to slow brute-force attempts.
			await new Promise((r) => setTimeout(r, 400));
			return fail(401, { error: 'Incorrect password.' });
		}

		const isProduction = process.env.NODE_ENV === 'production';

		cookies.set('dashboard_session', expectedToken(envPassword), {
			path: '/',
			httpOnly: true,
			sameSite: 'strict',
			secure: isProduction,
			maxAge: 60 * 60 * 24 * 30 // 30 days
		});

		const returnTo = url.searchParams.get('returnTo') ?? '/';
		throw redirect(302, returnTo);
	}
};
