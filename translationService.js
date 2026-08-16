// Server-only DeepL integration. The API key is deliberately never sent to
// the browser. Failed translations fall back to the original text.
const storage = require('./persistentState');

let cache = {};

async function bootstrap() {
  cache = await storage.load('translations.json', {});
}

function enabled() {
  return Boolean(process.env.DEEPL_API_KEY);
}

async function translate(text, targetLanguage) {
  const source = String(text || '');
  if (!source || targetLanguage !== 'en' || !enabled()) return source;

  const key = `en:${source}`;
  if (cache[key]) return cache[key];

  const endpoint = process.env.DEEPL_API_URL || 'https://api-free.deepl.com/v2/translate';
  try {
    const body = new URLSearchParams({ text: source, target_lang: 'EN-US', source_lang: 'UK' });
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!response.ok) throw new Error(`DeepL HTTP ${response.status}`);
    const result = await response.json();
    const translated = result?.translations?.[0]?.text;
    if (!translated) throw new Error('DeepL returned no translation');
    cache[key] = translated;
    storage.save('translations.json', cache);
    return translated;
  } catch (error) {
    console.error('[translation] DeepL:', error.message);
    return source;
  }
}

async function forEmail(email, text, getUser) {
  return translate(text, getUser(email)?.language || 'uk');
}

module.exports = { bootstrap, enabled, translate, forEmail };
