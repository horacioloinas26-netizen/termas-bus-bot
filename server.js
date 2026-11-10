// Termas Bus - Bot de envio de flyers por WhatsApp (API oficial de Meta, Cloud API)
// Sin dependencias: solo Node 18+.
const http = require('http');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.WA_TOKEN;                 // token de acceso permanente
const PHONE_ID = process.env.WA_PHONE_ID;           // ID del numero (no es el telefono)
const VERIFY = process.env.WA_VERIFY || 'termasbus'; // palabra para verificar el webhook
const GRAPH = process.env.GRAPH_BASE || 'https://graph.facebook.com/v21.0';
const PORT = process.env.PORT || 3000;
const HORAS_SIN_REPETIR = Number(process.env.HORAS_SIN_REPETIR || 12);
const PAUSA_MS = Number(process.env.PAUSA_MS || 1500);

const INTRO = 'Hola! Soy Horacio de Termas Bus, de Federación. Te paso los viajes que tenemos 👇';
const CIERRE = 'Cuál te interesa? Te cuento fechas y cómo reservar tu lugar.';

// Orden en que llegan los flyers. Editá los textos cuando cambien precios o fechas.
const VIAJES = [
  ['01-padre-ignacio.jpg', 'Peregrinación con el Padre Ignacio. Salimos el 15 y 22 de noviembre. $100.000 por persona, traslado ida y vuelta. Cupos limitados.'],
  ['02-itati.jpg', 'Virgen de Itatí, 8 de diciembre. Pasaje $110.000.'],
  ['03-lujan-tigre.jpg', 'Luján (misa) + Tigre Mercado de Frutos. Pasaje $100.000, solo traslado ida y vuelta. No incluye entradas ni catamarán.'],
  ['04-lujan-dia-de-campo.jpg', 'Luján - misa + Día de Campo en Vieja Chacra. $150.000, incluye traslado y almuerzo.'],
  ['05-valle-hermoso.jpg', 'Valle Hermoso, 3 noches / 4 días, Hotel Tehuel. Media pensión y pileta climatizada. $299.000 por persona. Salimos desde Chajarí, Federación, Concordia, Colón, Villaguay y Rosario del Tala.'],
  ['06-la-falda.jpg', 'La Falda, 3 noches / 4 días, Hotel Nortomarza. Media pensión. $299.000 por persona. Salimos desde Chajarí, Federación, Concordia, Colón, Villaguay y Rosario del Tala.'],
];

// Palabras que vuelven a mandar los flyers aunque ya se hayan enviado hace poco
const PIDE_VIAJES = /\b(viajes?|cat[aá]logo|flyers?|precios?|info|informaci[oó]n|salidas?)\b/i;

const ESTADO_FILE = process.env.ESTADO_FILE || path.join(__dirname, 'estado.json');
let estado = {};
try { estado = JSON.parse(fs.readFileSync(ESTADO_FILE, 'utf8')); } catch (e) {}
const guardar = () => { try { fs.writeFileSync(ESTADO_FILE, JSON.stringify(estado)); } catch (e) {} };

const dormir = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function api(ruta, opciones) {
  const r = await fetch(`${GRAPH}/${ruta}`, {
    ...opciones,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(opciones.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(JSON.stringify(j.error || j)); e.status = r.status; throw e; }
  return j;
}

// Sube cada flyer una sola vez a Meta y guarda el id
const mediaIds = {};
async function subirFlyer(archivo) {
  if (mediaIds[archivo]) return mediaIds[archivo];
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', 'image/jpeg');
  fd.append('file', new Blob([fs.readFileSync(path.join(__dirname , archivo))], { type: 'image/jpeg' }), archivo);
  const j = await api(`${PHONE_ID}/media`, { method: 'POST', body: fd });
  mediaIds[archivo] = j.id;
  return j.id;
}

async function enviar(para, cuerpo) {
  const body = JSON.stringify({ messaging_product: 'whatsapp', to: para, ...cuerpo });
  return api(`${PHONE_ID}/messages`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
}

// Argentina: a veces el numero llega como 549XXXXXXXXXX y hay que enviarlo como 54XXXXXXXXXX
async function enviarConFallback(para, cuerpo) {
  try { return await enviar(para, cuerpo); }
  catch (e) {
    if (/^549\d{10}$/.test(para)) { return await enviar('54' + para.slice(3), cuerpo); }
    throw e;
  }
}

const enCurso = new Set();
async function mandarCatalogo(para) {
  if (enCurso.has(para)) return;
  enCurso.add(para);
  try {
    await enviarConFallback(para, { type: 'text', text: { body: INTRO } });
    for (const [archivo, texto] of VIAJES) {
      await dormir(PAUSA_MS);
      const id = await subirFlyer(archivo);
      await enviarConFallback(para, { type: 'image', image: { id, caption: texto } });
    }
    await dormir(PAUSA_MS);
    await enviarConFallback(para, { type: 'text', text: { body: CIERRE } });
    estado[para] = { ultimo: Date.now() };
    guardar();
    log('catalogo enviado a', para);
  } catch (e) {
    log('ERROR enviando a', para, e.message);
  } finally { enCurso.delete(para); }
}

function procesar(payload) {
  for (const entry of payload.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      // Mensajes que escribis VOS desde la app (coexistencia): si ya atendiste, el bot no interviene
      for (const eco of v.message_echoes || []) {
        if (eco.to) { estado[eco.to] = { ultimo: Date.now() }; guardar(); }
      }
      // Mensajes de clientes
      for (const m of v.messages || []) {
        const de = m.from;
        if (!de) continue;
        const texto = (m.text && m.text.body) || (m.button && m.button.text) ||
          (m.interactive && ((m.interactive.button_reply && m.interactive.button_reply.title) || '')) || '';
        const previo = estado[de];
        const pasoHoras = previo ? (Date.now() - previo.ultimo) / 3600000 : Infinity;
        if (pasoHoras >= HORAS_SIN_REPETIR || PIDE_VIAJES.test(texto)) mandarCatalogo(de);
      }
    }
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/webhook') {
    if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === VERIFY) {
      res.writeHead(200); return res.end(url.searchParams.get('hub.challenge'));
    }
    res.writeHead(403); return res.end();
  }
  if (req.method === 'POST' && url.pathname === '/webhook') {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      res.writeHead(200); res.end('ok'); // responder rapido a Meta
      try { procesar(JSON.parse(data)); } catch (e) { log('payload invalido', e.message); }
    });
    return;
  }
  res.writeHead(200); res.end('Termas Bus bot activo');
}).listen(PORT, () => log('escuchando en', PORT));
