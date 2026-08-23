const fs = require('fs');
const path = require('path');

const hasDatabase = Boolean(process.env.DATABASE_URL);
let pool = null;
let ready = false;
const states = new Map();
const writes = new Map();
const localRateLimits = new Map();
const localExternalEvents = new Map();

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
  await pool.query('CREATE TABLE IF NOT EXISTS public.security_rate_limits (key TEXT PRIMARY KEY, window_started TIMESTAMPTZ NOT NULL DEFAULT NOW(), count INTEGER NOT NULL DEFAULT 1)');
  await pool.query("CREATE TABLE IF NOT EXISTS public.external_events (provider TEXT NOT NULL, event_id TEXT NOT NULL, event_type TEXT, status TEXT NOT NULL DEFAULT 'processing', attempts INTEGER NOT NULL DEFAULT 1, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(provider,event_id))");
  await pool.query("CREATE TABLE IF NOT EXISTS public.background_jobs (id UUID PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', payload JSONB NOT NULL DEFAULT '{}'::jsonb, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(), locked_at TIMESTAMPTZ, locked_by TEXT, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await pool.query('CREATE INDEX IF NOT EXISTS background_jobs_ready_idx ON public.background_jobs(status,run_after)');
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

async function consumeRateLimit(key, windowMs, maximum) {
  const now=Date.now();
  if(!pool){const current=localRateLimits.get(key);const item=!current||now-current.windowStarted>=windowMs?{windowStarted:now,count:1}:{...current,count:current.count+1};localRateLimits.set(key,item);return {allowed:item.count<=maximum,count:item.count,retryAfterMs:Math.max(0,item.windowStarted+windowMs-now)};}
  const result=await pool.query(`INSERT INTO public.security_rate_limits (key,window_started,count) VALUES ($1,NOW(),1) ON CONFLICT (key) DO UPDATE SET count=CASE WHEN public.security_rate_limits.window_started < NOW()-($2::bigint*INTERVAL '1 millisecond') THEN 1 ELSE public.security_rate_limits.count+1 END,window_started=CASE WHEN public.security_rate_limits.window_started < NOW()-($2::bigint*INTERVAL '1 millisecond') THEN NOW() ELSE public.security_rate_limits.window_started END RETURNING count,window_started`,[key,windowMs]);
  const item=result.rows[0],started=new Date(item.window_started).getTime();return {allowed:Number(item.count)<=maximum,count:Number(item.count),retryAfterMs:Math.max(0,started+windowMs-now)};
}

async function claimExternalEvent(provider,eventId,eventType){
  const key=`${provider}:${eventId}`;
  if(!pool){const existing=localExternalEvents.get(key);if(existing&&existing.status!=='failed')return false;localExternalEvents.set(key,{status:'processing',eventType,attempts:Number(existing?.attempts||0)+1});return true;}
  const result=await pool.query("INSERT INTO public.external_events(provider,event_id,event_type) VALUES($1,$2,$3) ON CONFLICT(provider,event_id) DO UPDATE SET status='processing',attempts=public.external_events.attempts+1,error=NULL,updated_at=NOW() WHERE public.external_events.status='failed' RETURNING event_id",[provider,eventId,eventType]);
  return result.rowCount===1;
}
async function finishExternalEvent(provider,eventId,status='completed',error=null){
  const key=`${provider}:${eventId}`;
  if(!pool){localExternalEvents.set(key,{...(localExternalEvents.get(key)||{}),status,error});return;}
  await pool.query('UPDATE public.external_events SET status=$3,error=$4,updated_at=NOW() WHERE provider=$1 AND event_id=$2',[provider,eventId,status,error?String(error).slice(0,1000):null]);
}

module.exports = { init, load, save, snapshot, saveNow, restoreMany, consumeRateLimit, claimExternalEvent, finishExternalEvent };
