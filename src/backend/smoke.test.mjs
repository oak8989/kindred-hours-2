import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const port = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const zoneInput = (instant, timezone) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(instant);
  const pick = key => parts.find(part => part.type === key).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}T${pick('hour')}:${pick('minute')}`;
};

test('first-run, member, staff and QR smoke workflows', { timeout: 30000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), 'kindred-smoke-'));
  const assigned = await port();
  const origin = `http://127.0.0.1:${assigned}`;
  const child = spawn(process.execPath, ['src/backend/server.mjs'], { env: { ...process.env, DATA_DIR: data, PORT: String(assigned) }, stdio: 'ignore' });
  const call = async (path, body, cookie = '', method = 'POST') => {
    const response = await fetch(origin + path, { method: body === undefined && method === 'POST' ? 'GET' : method, headers: { Origin: origin, 'X-Requested-With': 'KindredHours', 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw Error('App server exited before the health check.'); try { if ((await fetch(origin + '/healthz')).ok) { ready = true; break; } } catch { /* Startup in progress. */ } await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.ok(ready, 'server started');
    const database = new DatabaseSync(join(data, 'kindred.sqlite'));
    assert.deepEqual(database.prepare('SELECT version FROM migrations ORDER BY version').all().map(row => row.version), [1, 2]);
    database.close();
    const setup = await call('/api/setup', { name: 'Neighborhood Helpers', color: '#D7654F', adminName: 'Test Admin', email: 'admin@example.test', password: 'A long testing password!' });
    assert.equal(setup.status, 200);
    const admin = setup.cookie;
    assert.equal((await call('/api/setup', {}, admin)).status, 403);
    assert.equal((await call('/api/staff', undefined, '')).status, 403);
    const recurring = await call('/api/staff/events', { title: 'Garden day', description: 'Planting together', location: 'Garden', startsAt: '2027-03-13T09:00', endsAt: '2027-03-13T11:00', timezone: 'America/New_York', capacity: 5, visibility: 'public', frequency: 'daily', count: 3 }, admin);
    assert.equal(recurring.status, 200);
    const staff = await call('/api/staff', undefined, admin);
    for (const event of staff.body.events.filter(event => recurring.body.ids.includes(event.id))) assert.equal(zoneInput(new Date(event.starts_at), 'America/New_York').slice(11), '09:00');
    const now = new Date();
    const live = await call('/api/staff/events', { title: 'Today', description: 'Join today', location: 'Garden', startsAt: zoneInput(new Date(now.getTime() - 1800000), 'UTC'), endsAt: zoneInput(new Date(now.getTime() + 3600000), 'UTC'), timezone: 'UTC', capacity: 2, visibility: 'public', frequency: 'none' }, admin);
    assert.equal(live.status, 200);
    const eventId = live.body.ids[0];
    assert.equal((await call('/api/staff/waivers', { text: 'I agree to help safely.' }, admin)).status, 200);
    assert.equal((await call('/api/staff/medals', { name: 'First shift', metric: 'events', threshold: 1 }, admin)).status, 200);
    assert.equal((await call('/api/register', { name: 'Test Member', email: 'member@example.test' })).status, 200);
    const mailFiles = await readdir(join(data, 'assets'));
    const invitation = await readFile(join(data, 'assets', mailFiles[0]), 'utf8');
    const setupToken = /token=([A-Za-z0-9_-]+)/.exec(invitation)?.[1];
    assert.ok(setupToken);
    const claim = await call('/api/password', { action: 'setup', token: setupToken, password: 'Member testing password!' });
    assert.equal(claim.status, 200);
    const member = claim.cookie;
    assert.equal((await call('/api/password', { action: 'setup', token: setupToken, password: 'Member testing password!' })).status, 400);
    const memberId = (await call('/api/me', undefined, member)).body.user.id;
    assert.equal((await call('/api/waiver/sign', { name: 'Test Member' }, member)).status, 200);
    assert.equal((await call('/api/registrations', { eventId }, member)).status, 200);
    assert.equal((await call('/api/registrations', { eventId }, member)).status, 200);
    const eventQr = (await call(`/api/qr/event/${eventId}`, undefined, admin)).body.code;
    assert.equal((await call('/api/qr/attendance', { code: eventQr, action: 'in' }, member)).status, 200);
    assert.equal((await call('/api/qr/attendance', { code: eventQr, action: 'in' }, member)).body.outcome, 'already');
    assert.equal((await call('/api/qr/attendance', { code: eventQr, action: 'out' }, member)).status, 200);
    assert.equal((await call('/api/qr/attendance', { code: eventQr, action: 'out' }, member)).body.outcome, 'already');
    assert.equal((await call('/api/qr/attendance', { code: eventQr.slice(0, -1) + '!', action: 'in' }, member)).status, 400);
    const memberQr = (await call('/api/qr/member', undefined, member)).body.code;
    assert.equal((await call('/api/qr/attendance', { code: memberQr, eventId, action: 'in' }, member)).status, 403);
    assert.equal((await call('/api/staff/role', { userId: memberId, role: 'assistant' }, admin)).status, 200);
    assert.equal((await call('/api/staff/export/attendance', undefined, member)).status, 200);
    assert.equal((await call('/api/forgot', { email: 'member@example.test' })).status, 200);
    const mails = await readdir(join(data, 'assets'));
    const resetFile = await Promise.all(mails.map(name => readFile(join(data, 'assets', name), 'utf8')));
    const resetToken = /token=([A-Za-z0-9_-]+)/.exec(resetFile.find(text => text.includes('Reset your password:')))?.[1];
    assert.ok(resetToken);
    assert.equal((await call('/api/password', { action: 'reset', token: resetToken, password: 'Replacement testing password!' })).status, 200);
    assert.equal((await call('/api/password', { action: 'reset', token: resetToken, password: 'Replacement testing password!' })).status, 400);
  } finally { child.kill(); await rm(data, { recursive: true, force: true }); }
});
