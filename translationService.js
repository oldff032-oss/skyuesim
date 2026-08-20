// Server-only DeepL integration. The API key is deliberately never sent to
// the browser. Failed translations fall back to the original text.
const storage = require('./persistentState');

let cache = {};
let cooldownUntil = 0;
let lastRateLimitLogAt = 0;

async function bootstrap() {
  cache = await storage.load('translations.json', {});
}

function enabled() {
  return Boolean(process.env.DEEPL_API_KEY);
}

async function translate(text, targetLanguage) {
  const source = String(text || '');
  if (!source || targetLanguage !== 'en' || !enabled()) return source;

  const result = await translateBatch([source], targetLanguage);
  return result[source] || source;
}

async function translateBatch(texts, targetLanguage) {
  const sources = [...new Set((Array.isArray(texts) ? texts : []).map(value=>String(value||'').trim()).filter(Boolean))].slice(0,40);
  const output = Object.fromEntries(sources.map(source=>[source,cache[`en:${source}`]||source]));
  if (!sources.length || targetLanguage !== 'en' || !enabled() || Date.now() < cooldownUntil) return output;
  const missing = sources.filter(source=>!cache[`en:${source}`]);
  if (!missing.length) return output;

  const endpoint = process.env.DEEPL_API_URL || 'https://api-free.deepl.com/v2/translate';
  try {
    const body = new URLSearchParams({ target_lang: 'EN-US', source_lang: 'UK' });
    missing.forEach(source=>body.append('text',source));
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (response.status === 429) {
      cooldownUntil = Date.now() + 2 * 60 * 1000;
      if (Date.now() - lastRateLimitLogAt > 60 * 1000) { console.warn('[translation] DeepL rate limit reached; pausing for 2 minutes'); lastRateLimitLogAt=Date.now(); }
      return output;
    }
    if (!response.ok) throw new Error(`DeepL HTTP ${response.status}`);
    const result = await response.json();
    missing.forEach((source,index)=>{const translated=result?.translations?.[index]?.text;if(translated){cache[`en:${source}`]=translated;output[source]=translated;}});
    Promise.resolve(storage.save('translations.json', cache)).catch(()=>{});
    return output;
  } catch (error) {
    console.error('[translation] DeepL:', error.message);
    return output;
  }
}

async function forEmail(email, text, getUser) {
  return translate(text, getUser(email)?.language || 'uk');
}

module.exports = { bootstrap, enabled, translate, translateBatch, forEmail };
