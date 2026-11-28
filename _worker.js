/* Server intermediar pentru Asistent contravenții.
   1) /api/hit – numărătoare anonimă: primește cel mult o dată pe zi un cod aleatoriu al telefonului și tipul (apk / pwa / web).
      NU salvează IP-ul, textul căutat, numele sau altceva.
   2) /api/ai – butonul „Întreabă AI”: trimite descrierea (anonimizată în aplicație) la Anthropic și întoarce o sugestie.
      Cheia API stă doar aici (secret ANTHROPIC_API_KEY în Cloudflare). Textul NU se salvează și NU se scrie în jurnal;
      se păstrează doar un contor pe zi (cod aleatoriu al telefonului + număr de întrebări) pentru limită.
   Restul cererilor merg la fișierele site-ului. */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};
const J = (obj, status) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS)
});
const SYSTEM = [
  'Ești un asistent pentru polițiști din Republica Moldova. Ajuți să încadrezi o faptă descrisă pe scurt în Codul contravențional al R. Moldova (nr. 218/2008, partea specială, art. 47–373) sau în Legea nr. 45/2007 cu privire la prevenirea și combaterea violenței în familie.',
  'Primești: descrierea faptei (poate fi în română sau rusă; datele personale au fost scoase) și o listă de ARTICOLE CANDIDATE din baza de date a aplicației, fiecare cu un id.',
  'Reguli stricte:',
  '1) Nu inventa sancțiuni, sume, termene sau texte de lege. Aplicația afișează sancțiunea din baza ei; tu doar alegi articolul/alineatul potrivit și explici de ce.',
  '2) Alege de preferință din lista de candidați și întoarce id-ul lor exact. Dacă niciun candidat nu se potrivește, poți propune max. 2 articole din cunoștințele tale, ca număr de articol (și alineat dacă ești sigur); aplicația le verifică.',
  '3) Dacă faptele descrise pot constitui infracțiune (Codul penal) sau nu sunt în competența poliției, spune clar în „nota”.',
  '4) Dacă descrierea e prea vagă, pune 1–3 întrebări scurte despre ce lipsește (loc, vehicul, repetare în ultimul an, urmări, persoana vătămată etc.).',
  '5) Răspunde în română, scurt (telefon). Fără introduceri.',
  'Întoarce DOAR un obiect JSON, fără text în afară, cu forma exactă:',
  '{"rez":[{"id":"<id candidat sau null>","art":"<număr articol dacă nu e candidat, altfel null>","al":"<alineat sau null>","de_ce":"<max. 25 de cuvinte>"}],"intrebari":["..."],"nota":"<max. 40 de cuvinte sau gol>"}',
  'În „rez” pune 1–3 variante, cea mai probabilă prima.'
].join('\n');

function clean(s, n) {
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').slice(0, n);
}
function parseModelJson(t) {
  t = String(t || '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}
function shape(o) {
  const rez = (Array.isArray(o && o.rez) ? o.rez : []).slice(0, 3).map(function (r) {
    return {
      id: r && r.id ? clean(r.id, 24) : null,
      art: r && r.art ? clean(r.art, 12) : null,
      al: r && r.al ? clean(r.al, 8) : null,
      de_ce: clean(r && r.de_ce, 260)
    };
  }).filter(function (r) { return r.id || r.art; });
  const intrebari = (Array.isArray(o && o.intrebari) ? o.intrebari : []).slice(0, 3)
    .map(function (x) { return clean(x, 200); }).filter(Boolean);
  return { rez: rez, intrebari: intrebari, nota: clean(o && o.nota, 400) };
}

let _tbl = false;
/* limită pe zi: pe telefon și în total (ca să nu se consume banii din cheie). Fără bază de date nu se poate limita. */
async function aiLimit(env, id) {
  const perDev = parseInt(env.AI_MAX_PER_DAY || '30', 10), total = parseInt(env.AI_MAX_GLOBAL || '600', 10);
  if (!env.DB) return true;
  if (!_tbl) {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS ai_usage (day TEXT NOT NULL, id TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, id))').run();
    _tbl = true;
  }
  const day = new Date().toISOString().slice(0, 10);
  const g = await env.DB.prepare('SELECT COALESCE(SUM(n),0) AS s FROM ai_usage WHERE day = ?1').bind(day).first();
  if (g && g.s >= total) return false;
  const d = await env.DB.prepare('SELECT n FROM ai_usage WHERE day = ?1 AND id = ?2').bind(day, id).first();
  if (d && d.n >= perDev) return false;
  await env.DB.prepare('INSERT INTO ai_usage (day, id, n) VALUES (?1, ?2, 1) ON CONFLICT(day, id) DO UPDATE SET n = n + 1').bind(day, id).run();
  return true;
}

async function askAi(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return J({ err: 'metoda' }, 405);
  if (!env.ANTHROPIC_API_KEY) return J({ err: 'neconfigurat' }, 503);
  let b;
  try {
    const txt = await request.text();
    if (txt.length > 16000) return J({ err: 'prea lung' }, 413);
    b = JSON.parse(txt);
  } catch (e) { return J({ err: 'cerere invalidă' }, 400); }
  const id = String(b && b.id || '');
  if (!/^[a-f0-9]{16,64}$/.test(id)) return J({ err: 'cod invalid' }, 400);
  const q = clean(b.q, 1200).trim();
  if (q.length < 6) return J({ err: 'text prea scurt' }, 400);
  const cands = (Array.isArray(b.c) ? b.c : []).slice(0, 30)
    .map(function (c) { return { id: clean(c && c.id, 24), t: clean(c && c.t, 420) }; })
    .filter(function (c) { return c.id && c.t; });
  try { if (!(await aiLimit(env, id))) return J({ err: 'limită' }, 429); } catch (e) { /* dacă baza nu răspunde, nu blocăm */ }
  const user = 'DESCRIEREA FAPTEI:\n' + q + '\n\nARTICOLE CANDIDATE:\n' +
    (cands.length ? cands.map(function (c) { return '[' + c.id + '] ' + c.t; }).join('\n') : '(niciunul)');
  const ctl = new AbortController();
  const to = setTimeout(function () { ctl.abort(); }, 25000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: env.AI_MODEL || 'claude-sonnet-5-5', max_tokens: 700,
        system: SYSTEM, messages: [{ role: 'user', content: user }]
      })
    });
    if (!r.ok) return J({ err: (r.status === 401 || r.status === 403) ? 'cheie' : (r.status === 429 ? 'ocupat' : 'serviciu') }, 502);
    const j = await r.json();
    const txt = (j.content || []).filter(function (x) { return x.type === 'text'; }).map(function (x) { return x.text; }).join('');
    const o = parseModelJson(txt);
    if (!o) return J({ err: 'răspuns neclar' }, 502);
    return J(shape(o));
  } catch (e) {
    return J({ err: 'serviciu' }, 504);
  } finally { clearTimeout(to); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ai') return askAi(request, env);
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
