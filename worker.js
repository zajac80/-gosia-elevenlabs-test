// Oddzielny test głosu. Klucz ElevenLabs jest wyłącznie sekretem Cloudflare.
import { WorkerEntrypoint } from 'cloudflare:workers';

const VOICE_ID = 'pNInz6obpgDQGcFmaJgB'; // Adam, wybór zaakceptowany w teście.
const MAX_TEXT = 300;

const html = `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gosia — test głosu ElevenLabs</title><style>
body{font:17px/1.5 system-ui,sans-serif;max-width:600px;margin:32px auto;padding:0 20px;color:#183047}
h1{font-size:26px}textarea{box-sizing:border-box;width:100%;height:150px;font:inherit;padding:12px;border:1px solid #9aabb9;border-radius:10px}
button{font:600 18px system-ui;padding:14px 22px;background:#1765b3;color:white;border:0;border-radius:10px}
button:disabled{opacity:.5}audio{margin-top:16px;width:100%}#status{white-space:pre-wrap;overflow-wrap:anywhere}
</style></head><body>
<h1>Gosia — test głosu</h1><p>Testujemy naturalną polską wymowę głosu Adam. To osobny test; rezerwacje Osady Skandia pozostają bez zmian.</p>
<label for="text">Tekst do odczytania (do 300 znaków)</label>
<textarea id="text" maxlength="300">Dzień dobry. Przygotowałam rezerwację w Osadzie Skandia. Przyjazd osiemnastego lipca, wyjazd dwudziestego lipca. Czy zatwierdzić rezerwację?</textarea>
<p><button id="play" type="button">Odtwórz głos</button></p><p id="status" role="status" aria-live="polite"></p><audio id="audio" controls playsinline></audio>
<script>
const btn=document.querySelector('#play'),status=document.querySelector('#status'),audio=document.querySelector('#audio');
let previousURL;
btn.addEventListener('click',async()=>{
 btn.disabled=true;status.textContent='Trwa generowanie głosu…';
 try{
  const r=await fetch('/tts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:document.querySelector('#text').value})});
  if(!r.ok)throw Error(await r.text());
  const blob=await r.blob();
  if(previousURL)URL.revokeObjectURL(previousURL);
  previousURL=URL.createObjectURL(blob);audio.src=previousURL;
  status.textContent='Głos gotowy. Jeśli iPhone nie uruchomi go automatycznie, naciśnij Play poniżej.';
  try{await audio.play()}catch{}
 }catch(e){status.textContent='Błąd: '+e.message}
 finally{btn.disabled=false}
});
</script></body></html>`;

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
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(html, { headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; media-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      } });
    }
    if (url.pathname !== '/tts' || request.method !== 'POST') return plain('Nie znaleziono', 404);
    // Ograniczenie przeglądarkowe; publiczny endpoint nadal wymaga ochrony przed nadużyciem przy szerszym wdrożeniu.
    if (request.headers.get('origin') !== url.origin) return plain('Niedozwolone pochodzenie', 403);
    if (!env.ELEVENLABS_API_KEY) return plain('Nie skonfigurowano sekretu ELEVENLABS_API_KEY', 500);
    if (!request.headers.get('content-type')?.startsWith('application/json')) return plain('Oczekiwano JSON', 415);
    if (Number(request.headers.get('content-length') || 0) > 2048) return plain('Za duże żądanie', 413);
    let body;
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 2048) return plain('Za duże żądanie', 413);
      body = JSON.parse(raw);
    } catch { return plain('Niepoprawne dane', 400); }
    const text = body?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return plain('Wpisz od 1 do 300 znaków', 400);
    let response;
    try {
      response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
        method: 'POST',
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'content-type': 'application/json', 'accept': 'audio/mpeg' },
        body: JSON.stringify({ text: text.trim(), model_id: 'eleven_multilingual_v2' })
      });
    } catch { return plain('Nie udało się połączyć z ElevenLabs', 502); }
    if (!response.ok) return plain(`ElevenLabs nie wygenerował nagrania. Kod HTTP: ${response.status}`, 502);
    return new Response(response.body, { headers: {
      'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
    } });
  }

  async getUsage() {
    return readAccountUsage(this.env);
  }
}

// Obie metody RPC są dostępne tylko dla Workerów z Service Binding.
// Publiczny handler fetch nadal obsługuje wyłącznie stronę i /tts.
export class AccountUsage extends WorkerEntrypoint {
  async getUsage() {
    return readAccountUsage(this.env);
  }
}

async function readAccountUsage(env) {
  if (!env.ELEVENLABS_API_KEY) throw new Error('Brak klucza ElevenLabs');
  const response = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, accept: 'application/json' }
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
