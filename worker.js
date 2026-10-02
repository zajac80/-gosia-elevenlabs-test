// Gosia — niezalezny test glosu ElevenLabs dla Osady Skandia.
// Wazne: klucz API zostaje po stronie Cloudflare w Secret ELEVENLABS_API_KEY.
const VOICE_ID = 'pNInz6obpgDQGcFmaJgB'; // Adam
const MAX_TEXT = 300;

const html = `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gosia — test ElevenLabs</title><style>
body{font-family:system-ui,sans-serif;max-width:560px;margin:32px auto;padding:0 20px;color:#202124}
h1{font-size:26px}textarea{box-sizing:border-box;width:100%;height:155px;font:17px/1.5 system-ui;padding:12px;border:1px solid #bbb;border-radius:10px}
button{font:600 18px system-ui;padding:15px 24px;background:#174ea6;color:white;border:0;border-radius:10px}
button:disabled{opacity:.5}audio{margin-top:16px;width:100%}#status{white-space:pre-wrap;overflow-wrap:anywhere}
</style></head><body>
<h1>Gosia — test glosu</h1><p>Testujemy glos Adam. Dzialajacej aplikacji Osada Skandia nie zmieniamy.</p>
<textarea id="text" maxlength="300">Dzień dobry. Przygotowałam rezerwację w Osadzie Skandia. Przyjazd osiemnastego lipca, wyjazd dwudziestego lipca. Czy zatwierdzić rezerwację?</textarea>
<p><button id="play">Odtwórz głos</button></p><p id="status" role="status"></p><audio id="audio" controls playsinline></audio>
<script>
const btn=document.querySelector('#play'),status=document.querySelector('#status'),audio=document.querySelector('#audio');
let previousURL;
btn.addEventListener('click',async()=>{
 btn.disabled=true;status.textContent='Trwa generowanie głosu…';
 try{
  const r=await fetch('/tts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:document.querySelector('#text').value})});
  if(!r.ok){const details=await r.text();throw Error(details)}
  const blob=await r.blob();if(previousURL)URL.revokeObjectURL(previousURL);
  previousURL=URL.createObjectURL(blob);audio.src=previousURL;status.textContent='Głos gotowy. Jeśli odtwarzanie nie ruszy, naciśnij Play poniżej.';
  try{await audio.play()}catch{}
 }catch(e){status.textContent='Błąd: '+e.message}
 finally{btn.disabled=false}
});
</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(html, { headers: { 'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; media-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
    }
    if (url.pathname !== '/tts' || request.method !== 'POST') return new Response('Nie znaleziono', {status:404});
    // Tylko wywolania z tej samej witryny; nie jest to pelna ochrona przed naduzyciem.
    const origin = request.headers.get('origin');
    if (origin !== url.origin) return new Response('Niedozwolone pochodzenie', {status:403});
    if (!env.ELEVENLABS_API_KEY) return new Response('Nie skonfigurowano sekretu ELEVENLABS_API_KEY',{status:500});
    const size = Number(request.headers.get('content-length')||0);
    if (size > 2048) return new Response('Za duże żądanie',{status:413});
    let text;
    try { const body = await request.json(); text = body.text; } catch { return new Response('Niepoprawne dane',{status:400}); }
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_TEXT) return new Response('Wpisz od 1 do 300 znaków',{status:400});
    const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/'+VOICE_ID, {
      method:'POST',
      headers:{'xi-api-key':env.ELEVENLABS_API_KEY,'content-type':'application/json','accept':'audio/mpeg'},
      body:JSON.stringify({text:text.trim(),model_id:'eleven_multilingual_v2'})
    });
    if (!response.ok) {
      // Nie przekazujemy surowej odpowiedzi dostawcy, moze zawierac dane diagnostyczne.
      return new Response('ElevenLabs nie wygenerował nagrania. Kod HTTP: '+response.status,{status:502});
    }
    return new Response(response.body,{headers:{'content-type':'audio/mpeg','cache-control':'no-store','x-content-type-options':'nosniff'}});
  }
};
