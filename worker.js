// Oddzielny test głosu. Klucz ElevenLabs jest wyłącznie sekretem Cloudflare.
import { WorkerEntrypoint } from 'cloudflare:workers';

const VOICE_ID = 'pNInz6obpgDQGcFmaJgB'; // Adam, wybór zaakceptowany w teście.
const MAX_TEXT = 300;
// Publiczny katalog zatwierdzonych komunikatów. Nigdy nie umieszczamy tutaj
// nazwisk, danych pobytu ani wiadomości podanych przez gości.
const SHARED_PROMPTS = new Set([
  'Cześć Justynko, słucham rezerwacji.',
  'Wprowadziłem dane. Sprawdź podgląd rezerwacji. Czy coś jeszcze zmienić?',
  'Czy zatwierdzić rezerwację? Powiedz „zatwierdź”.',
  'Nie usłyszałem jeszcze danych rezerwacji. Mów dalej.',
  'Nie zmieniły się dane w podglądzie. Podaj nową wartość jeszcze raz.',
  'Czy dodać łóżeczko do rezerwacji? Powiedz tak albo nie.',
  'Czy dodać krzesełko do rezerwacji? Powiedz tak albo nie.',
  'Czy dodać psa do rezerwacji? Powiedz tak albo nie.',
  'Podana data przyjazdu już minęła. Popraw rok albo termin.',
  'Niektóre dane wymagają poprawki. Sprawdź podgląd i dopowiedz brakujące informacje.'
]);
const TTS_MODEL = 'eleven_multilingual_v2';
// Zmiana głosu, modelu lub formatu automatycznie oddziela bibliotekę.
const AUDIO_VERSION = 'v1-mp3';
const inflightAudio = new Map(); // Deduplikacja równoczesnych żądań w jednym procesie.

async function sharedKey(text) {
  const payload = new TextEncoder().encode(`${AUDIO_VERSION}|${VOICE_ID}|${TTS_MODEL}|${text}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
  return `${AUDIO_VERSION}/${VOICE_ID}/${Array.from(digest, n => n.toString(16).padStart(2, '0')).join('')}.mp3`;
}

async function generateSpeech(text, env) {
  let response;
  try {
    response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'content-type': 'application/json', 'accept': 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: TTS_MODEL })
    });
  } catch { return plain('Nie udało się połączyć z ElevenLabs', 502); }
  if (!response.ok) return plain(`ElevenLabs nie wygenerował nagrania. Kod HTTP: ${response.status}`, 502);
  return response;
}

const audioResponse = (body, source) => new Response(body, { headers: {
  'content-type': 'audio/mpeg', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff', 'x-gosia-audio-source': source
} });

async function standardClip(text, env) {
  const namespace = env.GOSIA_AUDIO_LIB;
  // Jeżeli nie ma KV, dalej działa generowanie głosu: bez współdzielonej pamięci.
  if (!namespace) return generateSpeech(text, env);
  const key = await sharedKey(text);
  try {
    const stored = await namespace.get(key, { type: 'arrayBuffer', cacheTtl: 30 });
    if (stored) return audioResponse(stored, 'shared');
  } catch (error) {
    console.error('KV odczyt nagrania:', String(error));
    // Tymczasowa awaria KV nie może wyłączyć głosu.
    return generateSpeech(text, env);
  }
  let producing = inflightAudio.get(key);
  if (!producing) {
    producing = (async () => {
      const speech = await generateSpeech(text, env);
      if (!speech.ok) return speech;
      const bytes = await speech.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024) {
        return audioResponse(bytes, 'new-not-stored');
      }
      try {
        // Obiekt prywatny, brak publicznego adresu KV. Tylko zatwierdzone frazy.
        await namespace.put(key, bytes);
      } catch (error) {
        console.error('KV zapis nagrania:', String(error));
      }
      return audioResponse(bytes, 'new');
    })();
    inflightAudio.set(key, producing);
  }
  try {
    const r = await producing;
    // Response.body może być przeczytane przez jednego odbiorcę; kopiujemy bajty.
    if (!r.ok) return r.clone();
    return audioResponse(await r.clone().arrayBuffer(), r.headers.get('x-gosia-audio-source') || 'new');
  } finally { if (inflightAudio.get(key) === producing) inflightAudio.delete(key); }
}


async function getCachedStandardClip(text,env) {
  if(!env.GOSIA_AUDIO_LIB) return null;
  try {
    const key=await sharedKey(text);
    return await env.GOSIA_AUDIO_LIB.get(key,{type:'arrayBuffer'});
  } catch (_) {return null;}
}

// Public test page intentionally removed: no anonymous paid TTS.

const plain = (message, status) => new Response(message, {
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
});

// Udostępniamy licznik także na domyślnym Service Binding. Panel Cloudflare
// nie pokazuje nazwanego entrypointu, więc oba warianty połączenia są obsługiwane.
export default class VoiceWorker extends WorkerEntrypoint {
  async fetch(request) {
    const env = this.env;
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowedOrigin = 'https://rezerwacje-osada-skandia.whvg7hvk89.workers.dev';
    const cors = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    const result = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: {...cors, 'content-type': 'application/json; charset=utf-8'}
    });
    if (origin !== allowedOrigin) return result({error:'forbidden_origin'},403);
    if(request.method === 'OPTIONS' && ['/tts','/credits'].includes(url.pathname))
      return new Response(null,{status:204,headers:cors});
    if (!env.ELEVENLABS_API_KEY || !env.OSADA_ALLOWED_EMAIL)
      return result({error:'not_configured'},503);
    if (!((url.pathname === '/credits' && request.method === 'GET') ||
          (url.pathname === '/tts' && request.method === 'POST')))
      return result({error:'not_found'},404);
    const authHeader = request.headers.get('Authorization') || '';
    const match = /^Bearer ([^\s]{20,4096})$/.exec(authHeader);
    if (!match) return result({error:'login_required'},401);
    // Verify with Supabase, not by decoding the unsigned browser JWT body.
    let user;
    try {
      const response = await fetch('https://kzmycvizhalrjtbmyyia.supabase.co/auth/v1/user', {
        headers: {
          'apikey':'sb_publishable_FYVgd6qoXwCV7At9AjX0vw_WoGGKKOY',
          'Authorization':authHeader,
        },signal:AbortSignal.timeout(6000),cache:'no-store'
      });
      if (!response.ok) return result({error:'session_invalid'},401);
      user = await response.json();
    } catch (_) {return result({error:'auth_unavailable'},503);}
    if (!user?.id || !user?.email ||
        user.email.toLowerCase() !== String(env.OSADA_ALLOWED_EMAIL).trim().toLowerCase() ||
        !user.email_confirmed_at) return result({error:'forbidden_user'},403);
    if (url.pathname === '/credits') {
      try {
        const usage = await readAccountUsage(env);
        return result({ ...usage, resetAt: usage.resetAt });
      } catch (_) { return result({error:'credits_unavailable'},503); }
    }
    // Never log user-supplied TTS text. Cap request size and price at the server.
    if (!request.headers.get('content-type')?.startsWith('application/json')) return result({error:'json_required'},415);
    if (Number(request.headers.get('content-length') || 0) > 1800) return result({error:'too_large'},413);
    let text;
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 1800) return result({error:'too_large'},413);
      text = JSON.parse(raw)?.text;
    } catch (_) {return result({error:'bad_request'},400);}
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return result({error:'invalid_text'},400);
    const phrase = text.trim();
    const isReusable = SHARED_PROMPTS.has(phrase);
    const cached = isReusable ? await getCachedStandardClip(phrase,env) : null;
    if (cached) return new Response(cached,{status:200,headers:{...cors,
      'content-type':'audio/mpeg','x-gosia-audio-source':'shared'}});
    // A real credit balance is read before every NEW clip. Fail closed if usage unavailable.
    let usage;
    try { usage = await readAccountUsage(env); }
    catch (_) {return result({error:'credits_unavailable'},503);}
    if (usage.remaining < phrase.length * 2 + 25) return result({error:'quota_exhausted'},402);
    // KV is attached to the existing Worker. No KV -> no paid API calls.
    const kv=env.GOSIA_AUDIO_LIB;
    if(!kv) return result({error:'budget_store_missing'},503);
    const day=new Date().toISOString().slice(0,10);
    const budgetKey='osada-adam-budget-v98/'+day+'/'+user.id;
    let count;
    try {
      count=Number(await kv.get(budgetKey) || '0');
      if (!Number.isFinite(count) || count < 0 || count + phrase.length > 1500)
        return result({error:'daily_limit'},429);
      // Conservative reservation before generation; concurrency is still not fully atomic.
      await kv.put(budgetKey, String(count + phrase.length), {expirationTtl:172800});
    } catch (_) {return result({error:'budget_unavailable'},503);}
    let speech;
    if(isReusable) speech=await standardClip(phrase,env);
    else speech=await generateSpeech(phrase,env);
    if(!speech.ok) return result({error:'tts_unavailable'},502);
    return new Response(speech.body,{status:200,headers:{...cors,
      'content-type':'audio/mpeg'}});
  }

  async getUsage() {
    return readAccountUsage(this.env);
  }
}

// Nazwany entrypoint jest dostępny przez GOSIA_USAGE, nie przez publiczny URL.
// Odczyt HTTP omija problem anulowanych wywołań RPC getUsage.
// Default VoiceWorker nadal obsługuje tylko / i /tts; bez ujawniania salda publicznie.
export class AccountUsage extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/internal/usage') {
      return plain('Nie znaleziono', 404);
    }
    try {
      const usage = await readAccountUsage(this.env);
      return new Response(JSON.stringify(usage), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Nieznany błąd odczytu subskrypcji';
      console.error('Odczyt konta ElevenLabs:', message);
      return new Response(JSON.stringify({ error: message }), {
        status: 502,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
      });
    }
  }

  // Zachowane wyłącznie dla zgodności z poprzednią wersją wywołującą RPC.
  async getUsage() {
    return readAccountUsage(this.env);
  }
}

async function readAccountUsage(env) {
  if (!env.ELEVENLABS_API_KEY) throw new Error('Brak klucza ElevenLabs');
  const response = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, accept: 'application/json' },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`ElevenLabs usage HTTP ${response.status}`);
  const data = await response.json();
  const used = data?.character_count, limit = data?.character_limit;
  if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('Brak danych o limicie ElevenLabs');
  }
  return {
    used, limit, remaining: Math.max(0, limit - used),
    percent: Math.max(0, Math.min(100, Math.round(100 * (limit - used) / limit))),
    resetAt: Number.isSafeInteger(data.next_character_count_reset_unix)
      ? data.next_character_count_reset_unix : null
  };
}
