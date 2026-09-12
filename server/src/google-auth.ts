// One-time consent: run `npm run google:auth`, approve in the browser, paste the code back.
// Prints the refresh token to store in .env. Nothing is written for you.
import { createInterface } from 'node:readline/promises';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env first.');

// The out-of-band flow is gone, so this uses the loopback redirect that the Desktop app type allows.
const redirect = 'http://localhost:5599';
const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth');
consent.searchParams.set('client_id', clientId);
consent.searchParams.set('redirect_uri', redirect);
consent.searchParams.set('response_type', 'code');
consent.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly');
consent.searchParams.set('access_type', 'offline');
consent.searchParams.set('prompt', 'consent');

console.log('\n1. Open this URL and approve access:\n');
console.log(consent.toString());
console.log(`\n2. The browser lands on ${redirect}/?code=... and will fail to load. That is expected.`);
console.log('3. Copy the value of the "code" parameter from the address bar and paste it here.\n');

const rl = createInterface({ input: process.stdin, output: process.stdout });
const code = (await rl.question('code: ')).trim();
rl.close();

const response = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: decodeURIComponent(code), grant_type: 'authorization_code', redirect_uri: redirect }),
});
const body = await response.json() as { refresh_token?: string; error_description?: string; error?: string };
if (!response.ok || !body.refresh_token) {
  throw new Error(`Google did not return a refresh token: ${body.error_description ?? body.error ?? response.status}`);
}
console.log('\nAdd this line to server/.env:\n');
console.log(`GOOGLE_REFRESH_TOKEN=${body.refresh_token}\n`);
