const fs = require('fs');
const path = require('path');

const hasDatabase = Boolean(process.env.DATABASE_URL);
let pool = null;
let ready = false;
const states = new Map();
const writes = new Map();

function localFile(name) { return path.join(__dirname, 'data', name); }
function readLocal(name, fallback) {
  try {
    const raw = fs.readFileSync(localFile(name), 'utf8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function writeLocal(name, value) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(localFile(name), JSON.stringify(value, null, 2));
}

async function init() {
  if (ready) return;
  if (!hasDatabase) {
    console.warn('[storage] DATABASE_URL is not set: data on an ephemeral host will be lost after a restart.');
    ready = true;
    return;
  }
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  await pool.query("CREATE TABLE IF NOT EXISTS public.app_state (key TEXT PRIMARY KEY, value JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  ready = true;
  console.log('[storage] PostgreSQL persistence is enabled.');
}

async function load(name, fallback) {
  if (!ready) throw new Error('Persistent storage has not been initialized');
  if (states.has(name)) return states.get(name);
  let value = fallback;
  if (pool) {
    const result = await pool.query('SELECT value FROM public.app_state WHERE key = $1', [name]);
    if (result.rowCount) value = result.rows[0].value;
    else {
      value = readLocal(name, fallback);
      await pool.query('INSERT INTO public.app_state (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING', [name, JSON.stringify(value)]);
    }
  } else value = readLocal(name, fallback);
  states.set(name, value);
  return value;
}

function save(name, value) {
  states.set(name, value);
  if (!pool) return writeLocal(name, value);
  const previous = writes.get(name) || Promise.resolve();
  const next = previous.catch(() => undefined).then(() => pool.query(
    'INSERT INTO public.app_state (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()',
    [name, JSON.stringify(value)]
  ));
  writes.set(name, next);
  next.catch(error => console.error(`[storage] could not persist ${name}:`, error.message));
}

function snapshot(names) {
  return Object.fromEntries(names.map(name => [name, JSON.parse(JSON.stringify(states.get(name) ?? null))]));
}

async function saveNow(name, value) {
  states.set(name, value);
  if (!pool) return writeLocal(name, value);
  const previous = writes.get(name) || Promise.resolve();
  await previous.catch(() => undefined);
  await pool.query('INSERT INTO public.app_state (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()', [name, JSON.stringify(value)]);
}

async function restoreMany(entries) {
  const pairs = Object.entries(entries);
  if (!pool) {
    for (const [name, value] of pairs) writeLocal(name, value);
    pairs.forEach(([name, value]) => states.set(name, value));
    return;
  }
  const client = await pool.connect();
  try {
    await Promise.all([...writes.values()].map(promise => promise.catch(() => undefined)));
    await client.query('BEGIN');
    for (const [name, value] of pairs) await client.query('INSERT INTO public.app_state (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()', [name, JSON.stringify(value)]);
    await client.query('COMMIT');
    pairs.forEach(([name, value]) => states.set(name, value));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

module.exports = { init, load, save, snapshot, saveNow, restoreMany };
