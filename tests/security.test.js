const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('sensitive legacy user routes require a session', () => {
  const server = read('server.js');
  for (const route of ['/api/status', '/api/usage', '/api/billing', '/api/cancel', '/api/create-subscription']) {
    const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(server, new RegExp(`app\\.(?:get|post)\\('${escaped}',\\s*requireUserSession`), `${route} must require authentication`);
  }
});

test('support tickets enforce authenticated ownership', () => {
  const server = read('server.js');
  assert.match(server, /app\.get\('\/api\/support\/tickets\/:id',\s*requireUserSession/);
  assert.match(server, /ticket\.email !== req\.userEmail/);
  assert.doesNotMatch(server, /req\.query\.email\s*&&\s*ticket\.email/);
});

test('verification codes use cryptographic randomness and hashed storage', () => {
  const auth = read('authService.js');
  assert.match(auth, /crypto\.randomInt\(/);
  assert.match(auth, /codeHash/);
  assert.doesNotMatch(auth, /Math\.random\(/);
});

test('production CORS is allowlisted and seeded user data is absent', () => {
  const server = read('server.js');
  assert.doesNotMatch(server, /app\.use\(cors\(\)\)/);
  assert.equal(fs.existsSync(path.join(root, 'data', 'users.json')), false);
});

test('Stripe success redirect does not disclose customer email', () => {
  const stripe = read('stripeService.js');
  assert.doesNotMatch(stripe, /installing\.html\?email=/);
  assert.match(stripe, /session_id=\{CHECKOUT_SESSION_ID\}/);
});

test('frontend ticket messages are escaped before HTML rendering', () => {
  for (const page of ['ticket.html', 'admin-ticket.html']) {
    const html = read(page);
    assert.match(html, /escapeHtml\(m\.text\)\.replace/);
  }
});
