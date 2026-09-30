import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { randomBytes, createHash, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import tls from 'node:tls';
import { advance, localOf, shift, toInstant } from './time.mjs';

const dataDir = process.env.DATA_DIR || './data';
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await mkdir(join(dataDir, 'assets'), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(dataDir, 'kindred.sqlite'));
db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','assistant','admin')), password TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, series_id INTEGER, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, timezone TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity>0), visibility TEXT NOT NULL CHECK(visibility IN ('public','private')), canceled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS registrations (event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(event_id,user_id));
CREATE TABLE IF NOT EXISTS attendance (event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, check_in TEXT NOT NULL, check_out TEXT, method TEXT NOT NULL, PRIMARY KEY(event_id,user_id));
CREATE TABLE IF NOT EXISTS waivers (id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE, text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS signatures (waiver_id INTEGER NOT NULL REFERENCES waivers(id), user_id INTEGER NOT NULL REFERENCES users(id), signed_name TEXT NOT NULL, signed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(waiver_id,user_id));
CREATE TABLE IF NOT EXISTS medals (id INTEGER PRIMARY KEY, name TEXT NOT NULL, metric TEXT NOT NULL CHECK(metric IN ('events','hours')), threshold INTEGER NOT NULL CHECK(threshold>0));
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
INSERT OR IGNORE INTO migrations(version) VALUES(1);`);
const migrations = [
  [2, `CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_at);
       CREATE INDEX IF NOT EXISTS idx_registrations_user ON registrations(user_id);
       CREATE INDEX IF NOT EXISTS idx_attendance_user ON attendance(user_id);
       CREATE INDEX IF NOT EXISTS idx_tokens_expiry ON tokens(expires_at);`],
];
for (const [version, sql] of migrations) {
  if (db.prepare('SELECT 1 FROM migrations WHERE version=?').get(version)) continue;
  db.exec('BEGIN IMMEDIATE');
  try { db.exec(sql); db.prepare('INSERT INTO migrations(version) VALUES(?)').run(version); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
const get = (key, fallback = '') => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? fallback;
const set = (key, value) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
if (!get('qrSecret')) set('qrSecret', randomBytes(32).toString('hex'));
const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const passwordHash = value => { const salt = randomBytes(16); return `scrypt:${salt.toString('hex')}:${scryptSync(value, salt, 64).toString('hex')}`; };
const passwordMatch = (value, encoded) => { if (!encoded) return false; const [, salt, digest] = encoded.split(':'); return timingSafeEqual(scryptSync(value, Buffer.from(salt, 'hex'), 64), Buffer.from(digest, 'hex')); };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const fail = (status, message) => { const err = new Error(message); err.status = status; throw err; };
const required = (value, max = 255) => { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'Please check the required fields.'); return value.trim(); };
const email = value => { const result = required(value, 254).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail(400, 'Enter a valid email address.'); return result; };
const validPassword = value => { if (typeof value !== 'string' || value.length < 12 || value.length > 128) fail(400, 'Use a password of 12–128 characters.'); return value; };
const isAdmin = user => { if (user?.role !== 'admin') fail(403, 'Administrator access required.'); };
const isStaff = user => { if (!['admin', 'assistant'].includes(user?.role)) fail(403, 'Staff access required.'); };
const signedIn = user => { if (!user) fail(401, 'Please sign in first.'); };
const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const rate = (key, max = 5) => transaction(() => { const now = Date.now(); let row = db.prepare('SELECT * FROM rate_limits WHERE key=?').get(key); if (!row || row.expires_at < now) row = { count: 0, expires_at: now + 15 * 60_000 }; if (row.count >= max) fail(429, 'Too many requests. Try again in 15 minutes.'); db.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,expires_at=excluded.expires_at').run(key, row.count + 1, row.expires_at); });
const baseUrl = request => { const proto = process.env.TRUST_PROXY === '1' && request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'; return `${proto}://${request.headers.host}`; };
const escapeMail = text => String(text).replace(/\r|\n/g, ' ');
async function smtpSend(to, subject, content) {
  const host = get('smtpHost'), port = Number(get('smtpPort', '587'));
  const secure = get('smtpEncryption') === 'tls';
  let socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
  let buffer = '', lines = [], waiting, failure;
  const pump = chunk => { buffer += chunk.toString(); let pos; while ((pos = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, pos).trimEnd(); buffer = buffer.slice(pos + 1); lines.push(line); if (/^\d{3} /.test(line) && waiting) { const done = waiting; waiting = undefined; done.resolve(lines.splice(0)); } } };
  const attach = s => {
    s.setTimeout(15000, () => s.destroy(new Error('SMTP connection timed out.')));
    s.on('data', pump);
    s.on('error', error => { failure = error; if (waiting) { const done = waiting; waiting = undefined; done.reject(error); } });
    s.on('close', () => { if (waiting) { const done = waiting; waiting = undefined; done.reject(new Error('SMTP connection closed.')); } });
  };
  attach(socket);
  const response = () => new Promise((resolve, reject) => { if (failure) reject(failure); else if (lines.some(l => /^\d{3} /.test(l))) resolve(lines.splice(0)); else waiting = { resolve, reject }; });
  const command = async (line, codes = [250]) => { socket.write(line + '\r\n'); const reply = await response(); if (!codes.includes(Number(reply.at(-1)?.slice(0,3)))) throw Error('SMTP delivery failed. Check the configured server and credentials.'); return reply; };
  try {
    const hello = await response(); if (Number(hello.at(-1)?.slice(0,3)) !== 220) throw Error('SMTP connection failed.');
    await command('EHLO kindred.local');
    if (get('smtpEncryption') === 'starttls') { await command('STARTTLS', [220]); socket.removeListener('data', pump); socket = tls.connect({ socket, servername: host }); attach(socket); await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); }); await command('EHLO kindred.local'); }
    if (get('smtpUser')) { await command('AUTH LOGIN', [334]); await command(Buffer.from(get('smtpUser')).toString('base64'), [334]); await command(Buffer.from(get('smtpPassword')).toString('base64'), [235]); }
    const from = get('smtpFrom'); await command(`MAIL FROM:<${from}>`); await command(`RCPT TO:<${to}>`, [250,251]); await command('DATA', [354]);
    const body = [`From: ${escapeMail(from)}`, `To: ${escapeMail(to)}`, `Subject: ${escapeMail(subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', content.replace(/\r/g, '').replace(/^\./gm, '..')].join('\r\n');
    await command(body + '\r\n.', [250]); await command('QUIT', [221]);
  } finally { socket.destroy(); }
}
async function mail(to, subject, body) {
  const mode = get('mailMode', 'file');
  if (mode === 'smtp') return smtpSend(to, subject, body);
  const entry = `To: ${to}\nSubject: ${subject}\n\n${body}\n`;
  if (mode === 'console') { console.log(`Email queued to ${to} (${subject}); content withheld from logs. Configure file or SMTP mode to retrieve the message.`); return; }
  const name = `${Date.now()}-${randomBytes(6).toString('hex')}.txt`;
  await writeFile(join(dataDir, 'assets', name), entry, { mode: 0o600, flag: 'wx' });
  console.log(`Email written to data/assets/${name}`);
}
function createToken(userId, kind) { const raw = secret(); db.prepare('INSERT INTO tokens(hash,user_id,kind,expires_at) VALUES(?,?,?,?)').run(hash(raw), userId, kind, Date.now() + 30 * 60_000); return raw; }
function consumeToken(raw, kind) { return transaction(() => { const row = db.prepare('SELECT * FROM tokens WHERE hash=? AND kind=? AND expires_at>?').get(hash(String(raw)), kind, Date.now()); if (!row) fail(400, 'This link is invalid or expired. Request a new one.'); db.prepare('DELETE FROM tokens WHERE hash=?').run(row.hash); return row.user_id; }); }
function currentUser(req) { const value = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '')?.[1]; if (!value) return null; return db.prepare('SELECT users.id,users.email,users.name,users.role FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires_at>?').get(hash(value), Date.now()) || null; }
function session(res, req, id) { const raw = secret(); db.prepare('INSERT INTO sessions(hash,user_id,expires_at) VALUES(?,?,?)').run(hash(raw), id, Date.now() + 14*86400000); const secure = baseUrl(req).startsWith('https:') ? '; Secure' : ''; res.setHeader('Set-Cookie', `sid=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1209600${secure}`); }
function clearSession(req, res) { const raw = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '')?.[1]; if (raw) db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(raw)); res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); }
function publicSettings() { return { name: get('name', 'Kindred Hours'), color: get('color', '#D7654F'), logo: get('logo'), initialized: !!get('initialized') }; }
function eventRows(user) { return db.prepare(`SELECT e.*, (SELECT count(*) FROM registrations r WHERE r.event_id=e.id) AS registered, EXISTS(SELECT 1 FROM registrations r WHERE r.event_id=e.id AND r.user_id=?) AS mine FROM events e WHERE e.canceled=0 AND e.ends_at>=? AND (e.visibility='public' OR ?=1) ORDER BY e.starts_at LIMIT 250`).all(user?.id ?? -1, new Date().toISOString(), user ? 1 : 0); }
function canSeeEvent(id, user) { const e = db.prepare('SELECT * FROM events WHERE id=?').get(id); if (!e || (!user && e.visibility !== 'public')) fail(404, 'Event not found.'); return e; }
function metrics(userId) { const row = db.prepare(`SELECT count(*) events, coalesce(sum((julianday(check_out)-julianday(check_in))*24),0) hours FROM attendance WHERE user_id=? AND check_out IS NOT NULL`).get(userId); return { events: row.events, hours: Math.max(0, Math.round(row.hours*10)/10) }; }
function csvCell(value) { const text = String(value ?? ''); const safe = /^[=+@\-\t\r]/.test(text) ? `'${text}` : text; return `"${safe.replace(/"/g, '""')}"`; }
function csv(res, filename, headers, rows) { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' }); res.end([headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')); }
const qrSlot = () => Math.floor(Date.now() / 300000);
function qrCode(kind, id) {
  const payload = `${kind}:${id}:${qrSlot()}`;
  const signature = createHmac('sha256', get('qrSecret')).update(payload).digest('base64url').slice(0, 16);
  return `${payload}:${signature}`;
}
function verifyQr(value) {
  const match = /^([EM]):([1-9]\d{0,9}):(\d{1,11}):([A-Za-z0-9_-]{16})$/.exec(value || '');
  if (!match || Number(match[3]) !== qrSlot()) fail(400, 'QR code expired. Refresh it and try again.');
  const expected = qrCode(match[1], match[2]);
  if (value.length !== expected.length || !timingSafeEqual(Buffer.from(value), Buffer.from(expected))) fail(400, 'Invalid QR code.');
  return { kind: match[1], id: Number(match[2]) };
}
const bodyOf = async req => { let size = 0, chunks = []; for await (const chunk of req) { size += chunk.length; if (size > 3_000_000) fail(413, 'Request is too large.'); chunks.push(chunk); } try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { fail(400, 'Invalid request.'); } };
const respond = async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY');
  const url = new URL(req.url, baseUrl(req)), path = url.pathname, method = req.method;
  if (path === '/healthz') return json(res, 200, { ok: true });
  if (!path.startsWith('/api/')) return serveStatic(path, res);
  if (!['GET','HEAD'].includes(method)) { const origin = req.headers.origin; if (!origin || origin !== baseUrl(req) || req.headers['x-requested-with'] !== 'KindredHours') fail(403, 'Request origin not allowed.'); }
  const user = currentUser(req);
  if (method === 'GET' && path === '/api/bootstrap') return json(res, 200, { settings: publicSettings(), user, events: eventRows(user), waiver: user ? db.prepare('SELECT w.*, EXISTS(SELECT 1 FROM signatures s WHERE s.waiver_id=w.id AND s.user_id=?) signed FROM waivers w ORDER BY version DESC LIMIT 1').get(user.id) : null });
  if (!get('initialized')) {
    if (path !== '/api/setup' || method !== 'POST') fail(403, 'Complete organization setup first.');
    const b = await bodyOf(req); const name = required(b.name, 100), adminName = required(b.adminName, 100), adminEmail = email(b.email), pass = validPassword(b.password);
    transaction(() => { if (get('initialized')) fail(409, 'Setup is already complete.'); set('name', name); set('color', /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : '#D7654F'); set('mailMode', 'file'); const id = db.prepare('INSERT INTO users(email,name,role,password) VALUES(?,?,?,?)').run(adminEmail, adminName, 'admin', passwordHash(pass)).lastInsertRowid; set('initialized', '1'); session(res, req, id); });
    return json(res, 200, { ok: true });
  }
  if (method === 'POST' && path === '/api/register') { const b = await bodyOf(req); rate(`register:${req.socket.remoteAddress}`, 10); const address = email(b.email); const existing = db.prepare('SELECT id FROM users WHERE email=?').get(address); if (!existing) { const id = db.prepare('INSERT INTO users(email,name) VALUES(?,?)').run(address, required(b.name, 100)).lastInsertRowid; const token = createToken(id, 'setup'); try { await mail(address, `Welcome to ${get('name')}`, `Set your password: ${baseUrl(req)}/?token=${token}&action=setup\nThis link expires in 30 minutes.`); } catch (e) { console.error('Registration email delivery failed:', e.message); } } return json(res, 200, { message: 'If this address can receive an invitation, an email is on its way.' }); }
  if (method === 'POST' && path === '/api/login') { const b = await bodyOf(req); rate(`login:${req.socket.remoteAddress}`, 12); const address = email(b.email); const row = db.prepare('SELECT * FROM users WHERE email=?').get(address); if (!row || !passwordMatch(b.password || '', row.password)) fail(401, 'Invalid email or password.'); session(res, req, row.id); return json(res, 200, { ok: true }); }
  if (method === 'POST' && path === '/api/forgot') { const b = await bodyOf(req); rate(`forgot:${req.socket.remoteAddress}`, 6); const address = email(b.email); const row = db.prepare('SELECT id FROM users WHERE email=?').get(address); if (row) { const token = createToken(row.id, 'reset'); try { await mail(address, `Reset your ${get('name')} password`, `Reset your password: ${baseUrl(req)}/?token=${token}&action=reset\nThis link expires in 30 minutes.`); } catch (e) { console.error('Password reset delivery failed:', e.message); } } return json(res, 200, { message: 'If an account exists, a password reset email is on its way.' }); }
  if (method === 'POST' && path === '/api/password') { const b = await bodyOf(req); validPassword(b.password); const id = consumeToken(b.token, b.action === 'setup' ? 'setup' : 'reset'); transaction(() => { db.prepare('UPDATE users SET password=? WHERE id=?').run(passwordHash(b.password), id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); }); session(res, req, id); return json(res, 200, { ok: true }); }
  if (method === 'POST' && path === '/api/logout') { clearSession(req, res); return json(res, 200, { ok: true }); }
  if (method === 'GET' && path === '/api/me') { signedIn(user); const registrations = db.prepare('SELECT events.* FROM registrations JOIN events ON events.id=registrations.event_id WHERE registrations.user_id=? ORDER BY starts_at DESC').all(user.id); const attendance = db.prepare('SELECT a.*,e.title FROM attendance a JOIN events e ON e.id=a.event_id WHERE a.user_id=? ORDER BY a.check_in DESC').all(user.id); const milestones = db.prepare('SELECT * FROM medals ORDER BY threshold').all(); return json(res, 200, { user, registrations, attendance, metrics: metrics(user.id), milestones }); }
  if (method === 'GET' && path === '/api/qr/member') { signedIn(user); return json(res, 200, { code: qrCode('M', user.id), expiresAt: (qrSlot() + 1) * 300000 }); }
  if (method === 'GET' && path.startsWith('/api/qr/event/')) { isStaff(user); const id = Number(path.split('/').at(-1)); const event = db.prepare('SELECT id,canceled FROM events WHERE id=?').get(id); if (!event || event.canceled) fail(404, 'Event not found.'); return json(res, 200, { code: qrCode('E', id), expiresAt: (qrSlot() + 1) * 300000 }); }
  if (method === 'POST' && path === '/api/qr/attendance') {
    signedIn(user);
    const b = await bodyOf(req), credential = verifyQr(b.code);
    if (!['in', 'out'].includes(b.action)) fail(400, 'Choose check-in or check-out.');
    if (credential.kind === 'M') isStaff(user);
    const memberId = credential.kind === 'M' ? credential.id : user.id;
    const eventId = credential.kind === 'E' ? credential.id : Number(b.eventId);
    const event = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
    if (!event || event.canceled || !db.prepare('SELECT 1 FROM users WHERE id=?').get(memberId)) fail(404, 'Event or member not found.');
    const now = Date.now();
    if (now < Date.parse(event.starts_at) - 7200000 || now > Date.parse(event.ends_at) + 7200000) fail(400, 'QR attendance is only open near event time.');
    if (credential.kind === 'E' && !db.prepare('SELECT 1 FROM registrations WHERE event_id=? AND user_id=?').get(eventId, user.id)) fail(403, 'Register for this event before scanning its QR code.');
    const outcome = transaction(() => {
      const existing = db.prepare('SELECT check_out FROM attendance WHERE event_id=? AND user_id=?').get(eventId, memberId);
      if (b.action === 'in') {
        if (existing) return 'already';
        db.prepare('INSERT INTO attendance(event_id,user_id,check_in,method) VALUES(?,?,?,?)').run(eventId, memberId, new Date(now).toISOString(), credential.kind === 'M' ? 'staff-qr' : 'event-qr');
      } else {
        if (!existing) fail(409, 'Member is not currently checked in.');
        if (existing.check_out) return 'already';
        db.prepare('UPDATE attendance SET check_out=? WHERE event_id=? AND user_id=?').run(new Date(now).toISOString(), eventId, memberId);
      }
      return 'recorded';
    });
    return json(res, 200, { outcome });
  }
  if (method === 'POST' && path === '/api/profile') { signedIn(user); const b = await bodyOf(req); db.prepare('UPDATE users SET name=? WHERE id=?').run(required(b.name, 100), user.id); return json(res, 200, { ok: true }); }
  if (method === 'POST' && path === '/api/registrations') { signedIn(user); const b = await bodyOf(req); const id = Number(b.eventId); const e = canSeeEvent(id, user); if (e.canceled || e.ends_at < new Date().toISOString()) fail(400, 'This event is no longer open.'); transaction(() => { const count = db.prepare('SELECT count(*) n FROM registrations WHERE event_id=?').get(id).n; if (count >= e.capacity && !db.prepare('SELECT 1 FROM registrations WHERE event_id=? AND user_id=?').get(id,user.id)) fail(409, 'This event is full.'); db.prepare('INSERT OR IGNORE INTO registrations(event_id,user_id) VALUES(?,?)').run(id,user.id); }); mail(user.email, `Registered: ${e.title}`, `You are registered for ${e.title} on ${e.starts_at} at ${e.location}.`).catch(err => console.error('Registration notice failed:', err.message)); return json(res, 200, { ok: true }); }
  if (method === 'DELETE' && path.startsWith('/api/registrations/')) { signedIn(user); const id = Number(path.split('/').at(-1)); const e = canSeeEvent(id,user); if (db.prepare('SELECT 1 FROM attendance WHERE event_id=? AND user_id=?').get(id,user.id)) fail(409, 'Attendance has already been recorded. Ask staff for help.'); db.prepare('DELETE FROM registrations WHERE event_id=? AND user_id=?').run(id,user.id); mail(user.email, `Registration canceled: ${e.title}`, `Your registration for ${e.title} has been canceled.`).catch(err => console.error('Cancellation notice failed:', err.message)); return json(res, 200, { ok: true }); }
  if (method === 'POST' && path === '/api/waiver/sign') { signedIn(user); const b = await bodyOf(req); const waiver = db.prepare('SELECT * FROM waivers ORDER BY version DESC LIMIT 1').get(); if (!waiver) fail(404, 'No waiver is available.'); if (required(b.name,100).toLowerCase() !== user.name.toLowerCase()) fail(400, 'Sign using your profile name.'); db.prepare('INSERT OR IGNORE INTO signatures(waiver_id,user_id,signed_name) VALUES(?,?,?)').run(waiver.id,user.id,user.name); return json(res, 200, { ok: true }); }
  if (method === 'GET' && path === '/api/staff') { isStaff(user); const members = db.prepare('SELECT id,name,email,role,created_at FROM users ORDER BY name').all(); const events = db.prepare('SELECT * FROM events ORDER BY starts_at DESC LIMIT 500').all(); const attendance = db.prepare('SELECT a.*,e.title,u.name,u.email FROM attendance a JOIN events e ON e.id=a.event_id JOIN users u ON u.id=a.user_id ORDER BY a.check_in DESC LIMIT 500').all(); return json(res, 200, { members, events, attendance, medals: db.prepare('SELECT * FROM medals').all(), waivers: db.prepare('SELECT * FROM waivers ORDER BY version DESC').all(), settings: user.role === 'admin' ? { ...publicSettings(), mailMode: get('mailMode','file'), smtpHost: get('smtpHost'), smtpPort: get('smtpPort','587'), smtpEncryption: get('smtpEncryption','starttls'), smtpUser: get('smtpUser'), smtpFrom: get('smtpFrom') } : undefined }); }
  if (method === 'POST' && path === '/api/staff/events') {
    isStaff(user);
    const b = await bodyOf(req);
    const title = required(b.title, 120), description = required(b.description, 4000), location = required(b.location, 250), timezone = required(b.timezone, 80);
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { fail(400, 'Invalid time zone.'); }
    const start = toInstant(b.startsAt, timezone), end = toInstant(b.endsAt, timezone);
    if (end <= start) fail(400, 'End time must be after start time.');
    const capacity = Number(b.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100000) fail(400, 'Enter a valid capacity.');
    const visibility = b.visibility === 'private' ? 'private' : 'public';
    const frequency = ['daily', 'weekly', 'monthly'].includes(b.frequency) ? b.frequency : 'none';
    const count = frequency === 'none' ? 1 : Number(b.count);
    if (!Number.isInteger(count) || count < 1 || count > 52) fail(400, 'Choose 1–52 occurrences.');
    const occurrences = Array.from({ length: count }, (_, index) => {
      const startsAt = toInstant(advance(b.startsAt, frequency, index), timezone);
      const endsAt = toInstant(advance(b.endsAt, frequency, index), timezone);
      if (endsAt <= startsAt) fail(400, 'Check the time of each recurrence.');
      return { startsAt, endsAt };
    });
    const ids = transaction(() => {
      const ids = []; let series = null;
      for (const occurrence of occurrences) {
        const id = Number(db.prepare('INSERT INTO events(series_id,title,description,location,starts_at,ends_at,timezone,capacity,visibility) VALUES(?,?,?,?,?,?,?,?,?)').run(series, title, description, location, occurrence.startsAt, occurrence.endsAt, timezone, capacity, visibility).lastInsertRowid);
        if (series === null) { series = id; db.prepare('UPDATE events SET series_id=? WHERE id=?').run(id, id); }
        ids.push(id);
      }
      return ids;
    });
    return json(res, 200, { ids });
  }
  if (method === 'PATCH' && path.startsWith('/api/staff/events/')) {
    isStaff(user);
    const id = Number(path.split('/').at(-1)), b = await bodyOf(req);
    const event = db.prepare('SELECT * FROM events WHERE id=?').get(id);
    if (!event) fail(404, 'Event not found.');
    const scope = b.scope === 'series' ? 'series' : 'single';
    const fields = ['title', 'description', 'location', 'timezone', 'capacity', 'visibility', 'canceled'];
    const updates = {};
    for (const key of fields) if (b[key] !== undefined) updates[key] = b[key];
    for (const key of ['title','location']) if (updates[key] !== undefined) updates[key] = required(updates[key], key === 'title' ? 120 : 250);
    if (updates.description !== undefined) updates.description = required(updates.description, 4000);
    if (updates.capacity !== undefined && (!Number.isInteger(Number(updates.capacity)) || Number(updates.capacity) < 1)) fail(400, 'Invalid capacity.');
    if (updates.visibility && !['public', 'private'].includes(updates.visibility)) fail(400, 'Invalid visibility.');
    if (updates.timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: updates.timezone }); } catch { fail(400, 'Invalid time zone.'); } }
    if (b.starts_at !== undefined) required(b.starts_at, 16);
    if (b.ends_at !== undefined) required(b.ends_at, 16);
    if (!Object.keys(updates).length && b.starts_at === undefined && b.ends_at === undefined) fail(400, 'Nothing to update.');
    const targets = scope === 'series' ? db.prepare('SELECT id FROM events WHERE series_id=?').all(event.series_id) : [{ id }];
    const changes = targets.map(row => {
      const old = db.prepare('SELECT * FROM events WHERE id=?').get(row.id);
      const next = { ...updates };
      const zone = next.timezone || old.timezone;
      if (b.starts_at !== undefined) next.starts_at = toInstant(scope === 'series' ? shift(localOf(old.starts_at, old.timezone), localOf(event.starts_at, event.timezone), b.starts_at) : b.starts_at, zone);
      if (b.ends_at !== undefined) next.ends_at = toInstant(scope === 'series' ? shift(localOf(old.ends_at, old.timezone), localOf(event.ends_at, event.timezone), b.ends_at) : b.ends_at, zone);
      const revised = { ...old, ...next };
      if (revised.ends_at <= revised.starts_at) fail(400, 'End time must be after start time.');
      return { id: row.id, next };
    });
    transaction(() => {
      for (const { id: target, next } of changes) {
        if (next.capacity !== undefined && Number(next.capacity) < db.prepare('SELECT count(*) n FROM registrations WHERE event_id=?').get(target).n) fail(409, 'Capacity cannot be below existing registrations.');
        db.prepare('UPDATE events SET ' + Object.keys(next).map(key => key + '=?').join(',') + ' WHERE id=?').run(...Object.values(next), target);
      }
    });
    for (const { id: target } of changes) for (const attendee of db.prepare('SELECT u.email FROM registrations r JOIN users u ON u.id=r.user_id WHERE r.event_id=?').all(target)) mail(attendee.email, 'Event update: ' + event.title, 'An event you registered for has changed. Please review it in ' + get('name') + '.').catch(err => console.error('Event notification failed:', err.message));
    return json(res, 200, { ok: true });
  }
  if (method === 'POST' && path === '/api/staff/attendance') { isStaff(user); const b = await bodyOf(req); const event = db.prepare('SELECT * FROM events WHERE id=?').get(Number(b.eventId)), member = db.prepare('SELECT id FROM users WHERE id=?').get(Number(b.userId)); if (!event || !member || event.canceled) fail(400,'Select an active event and member.'); const now = new Date().toISOString(); transaction(() => { const row = db.prepare('SELECT * FROM attendance WHERE event_id=? AND user_id=?').get(event.id,member.id); if (b.action === 'out') { if (!row || row.check_out) fail(409,'Member is not currently checked in.'); db.prepare('UPDATE attendance SET check_out=? WHERE event_id=? AND user_id=?').run(now,event.id,member.id); } else { if (row) fail(409,'Member already checked in.'); db.prepare('INSERT INTO attendance(event_id,user_id,check_in,method) VALUES(?,?,?,?)').run(event.id,member.id,now,b.method === 'walk-in' ? 'walk-in' : 'staff'); } }); return json(res, 200, { ok: true }); }
  if (method === 'POST' && path === '/api/staff/role') { isAdmin(user); const b = await bodyOf(req); if (!['member','assistant','admin'].includes(b.role)) fail(400,'Invalid role.'); if (Number(b.userId) === user.id && b.role !== 'admin') fail(400,'You cannot remove your own administrator access.'); db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role,Number(b.userId)); return json(res,200,{ok:true}); }
  if (method === 'POST' && path === '/api/staff/waivers') { isAdmin(user); const b = await bodyOf(req); const text = required(b.text,20000); db.prepare('INSERT INTO waivers(version,text) VALUES((SELECT coalesce(max(version),0)+1 FROM waivers),?)').run(text); return json(res,200,{ok:true}); }
  if (method === 'POST' && path === '/api/staff/medals') { isAdmin(user); const b = await bodyOf(req); const metric = b.metric; if (!['events','hours'].includes(metric) || !Number.isInteger(Number(b.threshold)) || Number(b.threshold)<1) fail(400,'Invalid milestone.'); db.prepare('INSERT INTO medals(name,metric,threshold) VALUES(?,?,?)').run(required(b.name,100),metric,Number(b.threshold)); return json(res,200,{ok:true}); }
  if (method === 'DELETE' && path.startsWith('/api/staff/medals/')) { isAdmin(user); db.prepare('DELETE FROM medals WHERE id=?').run(Number(path.split('/').at(-1))); return json(res,200,{ok:true}); }
  if (method === 'POST' && path === '/api/staff/settings') { isAdmin(user); const b = await bodyOf(req); const color = required(b.color,7); if (!/^#[\da-fA-F]{6}$/.test(color)) fail(400,'Enter a six-digit hex color.'); const mode = b.mailMode; if (!['file','console','smtp'].includes(mode)) fail(400,'Invalid email delivery mode.'); transaction(() => { set('name', required(b.name,100)); set('color',color); set('mailMode',mode); if (mode === 'smtp') { set('smtpHost',required(b.smtpHost,250)); const port = Number(b.smtpPort); if (!Number.isInteger(port) || port<1 || port>65535) fail(400,'Invalid SMTP port.'); set('smtpPort',port); if (!['tls','starttls'].includes(b.smtpEncryption)) fail(400,'Use TLS or STARTTLS.'); set('smtpEncryption',b.smtpEncryption); set('smtpUser',String(b.smtpUser || '')); if (b.smtpPassword) set('smtpPassword',String(b.smtpPassword)); set('smtpFrom',email(b.smtpFrom)); } }); return json(res,200,{ok:true}); }
  if (method === 'POST' && path === '/api/staff/test-email') { isAdmin(user); rate(`test:${user.id}`,5); await mail(user.email, `${get('name')} email test`, 'Your email delivery is working.'); return json(res,200,{ok:true}); }
  if (method === 'POST' && path === '/api/staff/logo') { isAdmin(user); const b = await bodyOf(req); if (!['image/png','image/jpeg','image/webp'].includes(b.type) || typeof b.base64 !== 'string') fail(400,'Use a PNG, JPEG, or WebP image.'); const bytes = Buffer.from(b.base64,'base64'); if (bytes.length > 2_000_000 || bytes.length === 0) fail(400,'Logo must be under 2 MB.'); const valid = b.type === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) : b.type === 'image/jpeg' ? bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex')) : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP'; if (!valid) fail(400,'Image content does not match its type.'); const ext = { 'image/png':'png','image/jpeg':'jpg','image/webp':'webp' }[b.type]; const filename = `logo-${Date.now()}.${ext}`; await writeFile(join(dataDir,'assets',filename),bytes,{mode:0o600}); set('logo',`/assets/${filename}`); return json(res,200,{url:get('logo')}); }
  if (method === 'GET' && path === '/api/staff/export/members') { isStaff(user); const rows = db.prepare('SELECT id,name,email,role,created_at FROM users ORDER BY id').all().map(u=>[u.id,u.name,u.email,u.role,u.created_at,metrics(u.id).events,metrics(u.id).hours]); return csv(res,'members.csv',['id','name','email','role','joined','verified_events','verified_hours'],rows); }
  if (method === 'GET' && path === '/api/staff/export/attendance') { isStaff(user); const rows = db.prepare('SELECT a.*,e.title,u.name,u.email FROM attendance a JOIN events e ON e.id=a.event_id JOIN users u ON u.id=a.user_id ORDER BY a.check_in').all().map(a=>[a.event_id,a.title,a.user_id,a.name,a.email,a.check_in,a.check_out,a.check_out ? Math.max(0,Math.round((Date.parse(a.check_out)-Date.parse(a.check_in))/360000)/10) : '',a.method]); return csv(res,'attendance.csv',['event_id','event','user_id','name','email','check_in','check_out','hours','method'],rows); }
  fail(404,'Not found.');
};
async function serveStatic(path, res) {
  if (path.startsWith('/assets/logo-')) { const name = path.split('/').at(-1); if (!/^logo-\d+\.(png|jpg|webp)$/.test(name)) fail(404,'Not found.'); const data = await readFile(join(dataDir,'assets',name)); res.writeHead(200,{'Content-Type':name.endsWith('.png')?'image/png':name.endsWith('.jpg')?'image/jpeg':'image/webp','Cache-Control':'public,max-age=86400','X-Content-Type-Options':'nosniff'}); return res.end(data); }
  const dist = resolve('dist'); let filename = resolve(dist, '.' + decodeURIComponent(path)); if (!filename.startsWith(dist + '/') && filename !== dist) fail(404,'Not found.'); try { if (!(await stat(filename)).isFile()) filename = join(dist,'index.html'); } catch { filename = join(dist,'index.html'); }
  const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.webp':'image/webp' }; const data = await readFile(filename); res.writeHead(200,{'Content-Type':types[extname(filename)] || 'application/octet-stream','Cache-Control':extname(filename)==='.html'?'no-cache':'public,max-age=3600'}); res.end(data);
}
const port = Number(process.env.PORT || 3000);
http.createServer((req,res) => { respond(req,res).catch(error => { if (!res.headersSent) json(res,error.status || 500,{ error: error.status ? error.message : 'Something went wrong. Please try again.' }); else res.end(); if (!error.status) console.error('Request failed:',error.message); }); }).listen(port,'0.0.0.0',()=>console.log(`Kindred Hours listening on port ${port}`));
