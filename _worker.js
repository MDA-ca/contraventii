/* Numărătoare anonimă pentru Asistent contravenții.
   Primește de la aplicație, cel mult o dată pe zi, un cod aleatoriu al telefonului și tipul (apk / pwa / web).
   NU salvează IP-ul, textul căutat, numele sau altceva. Restul cererilor merg la fișierele site-ului. */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/hit') return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return new Response('metoda nu e permisă', { status: 405, headers: CORS });
    try {
      const txt = (await request.text()).slice(0, 300);
      const b = JSON.parse(txt);
      const id = String(b.id || '');
      if (!/^[a-f0-9]{16,64}$/.test(id)) return new Response('cod invalid', { status: 400, headers: CORS });
      const kind = ['apk', 'pwa', 'web'].indexOf(b.kind) >= 0 ? b.kind : 'web';
      const day = new Date().toISOString().slice(0, 10);
      await env.DB.prepare(
        'INSERT INTO devices (id, kind, first, last, days) VALUES (?1, ?2, ?3, ?3, 1) ' +
        'ON CONFLICT(id) DO UPDATE SET kind = ?2, days = days + (CASE WHEN last <> ?3 THEN 1 ELSE 0 END), last = ?3'
      ).bind(id, kind, day).run();
      return new Response(null, { status: 204, headers: CORS });
    } catch (e) {
      return new Response('eroare', { status: 503, headers: CORS });
    }
  }
};
