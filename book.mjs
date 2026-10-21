#!/usr/bin/env node
/**
 * Reserva automática de puesto en Zityhub.
 *
 * Reserva el día que acaba de abrirse en la ventana de reserva (ZH_ADVANCE_DAYS días
 * laborables) en el puesto configurado. Toda la configuración va por variables de
 * entorno: ver README.md.
 *
 * Node >= 20 (usa fetch nativo). Sin dependencias.
 */

const API = 'https://api.zityhub.com';

// ---------------------------------------------------------------- configuración
const CFG = {
  personId:  int(process.env.ZH_PERSON_ID, null),
  spaceId:   int(process.env.ZH_SPACE_ID, null),
  // Puestos por orden de preferencia. El primero libre se lleva la reserva.
  deskIds:   list(process.env.ZH_DESK_IDS, []),
  startLocal: process.env.ZH_START || '09:00',
  endLocal:   process.env.ZH_END   || '18:00',
  tz:         process.env.ZH_TZ    || 'Europe/Madrid',
  advanceBusinessDays: int(process.env.ZH_ADVANCE_DAYS, 5), // ventana del espacio
  // Si el puesto preferido está ocupado: 'fail' avisa, 'any' coge cualquier libre.
  fallback:   process.env.ZH_FALLBACK || 'fail',
  holidays:   list(process.env.ZH_HOLIDAYS, [], String),    // 'YYYY-MM-DD,YYYY-MM-DD'
  // Día concreto 'YYYY-MM-DD' para pruebas: se reserva aunque no sea laborable.
  date:       process.env.ZH_DATE || '',
  attempts:   int(process.env.ZH_ATTEMPTS, 10),
  attemptGapMs: int(process.env.ZH_ATTEMPT_GAP_MS, 15000),
  dryRun:     process.env.ZH_DRY_RUN === '1',
  requireBooking: process.env.ZH_REQUIRE_BOOKING === '1',
  cookie:     process.env.ZITYHUB_COOKIE || '',
  email:      process.env.ZITYHUB_EMAIL || '',
  password:   process.env.ZITYHUB_PASSWORD || '',
};

function checkConfig() {
  const missing = [];
  if (!CFG.personId) missing.push('ZH_PERSON_ID');
  if (!CFG.spaceId) missing.push('ZH_SPACE_ID');
  if (!CFG.deskIds.length && CFG.fallback !== 'any') missing.push('ZH_DESK_IDS');
  if (missing.length) {
    throw new Error(`Faltan variables: ${missing.join(', ')}. Ponlas en Settings > Secrets and variables > Actions > Variables (ver README.md).`);
  }
  if (CFG.date && !/^\d{4}-\d{2}-\d{2}$/.test(CFG.date)) {
    throw new Error(`La fecha tiene que ir como YYYY-MM-DD, no '${CFG.date}'.`);
  }
}

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function list(v, d, map = Number) { return v ? v.split(',').map(s => map(s.trim())).filter(Boolean) : d; }

// ---------------------------------------------------------------- zonas horarias
function tzOffsetMs(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts));
  const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - ts;
}

/** Convierte una hora de pared (en `tz`) al instante UTC correspondiente. Aguanta cambios de hora. */
function wallToUtc(ymd, hhmm, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let ts = naive;
  for (let i = 0; i < 3; i++) ts = naive - tzOffsetMs(ts, tz);
  return new Date(ts);
}

/** Fecha 'YYYY-MM-DD' de hoy en `tz`. */
function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function isWeekend(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 || wd === 6;
}

const isWorkday = ymd => !isWeekend(ymd) && !CFG.holidays.includes(ymd);

/** El N-ésimo día laborable después de `from`: el día que la ventana acaba de abrir. */
function nthBusinessDayAfter(from, n) {
  let ymd = from, left = n;
  while (left > 0) { ymd = addDays(ymd, 1); if (isWorkday(ymd)) left--; }
  return ymd;
}

// ---------------------------------------------------------------- cliente HTTP
let cookieJar = CFG.cookie;

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'app-id': 'pwa',
      'User-Date': new Date().toISOString(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(cookieJar ? { Cookie: cookieJar } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  if (setCookie.length) {
    cookieJar = setCookie.map(c => c.split(';')[0]).join('; ');
  }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

async function login() {
  if (CFG.email && CFG.password) {
    const r = await api('POST', '/api/v1/auth/login', { email: CFG.email, password: CFG.password });
    if (!r.ok) throw new Error(`Login fallido (${r.status}): ${JSON.stringify(r.data)}`);
    log('Sesión iniciada con email y contraseña.');
    return;
  }
  if (!cookieJar) throw new Error('Falta ZITYHUB_COOKIE (o ZITYHUB_EMAIL + ZITYHUB_PASSWORD).');
  const me = await api('GET', `/api/v1/person/${CFG.personId}`);
  if (!me.ok) throw new Error(`La cookie de sesión no vale (${me.status}). Renuévala en los secrets del repo.`);
  log(`Sesión válida: ${me.data.name} ${me.data.lastName}.`);
}

// ---------------------------------------------------------------- lógica
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

async function deskAvailability(date) {
  const r = await api('GET', `/api/v1/resources/${CFG.spaceId}/availability?date=${date}`);
  if (!r.ok) throw new Error(`No pude leer disponibilidad (${r.status}): ${JSON.stringify(r.data)}`);
  return (r.data?.[0]?.children) || [];
}

/** Todas las medias horas de start (incl.) a end (excl.), que es lo que lista la API. */
function neededSlots(start, end) {
  const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const out = [];
  for (let t = toMin(start); t < toMin(end); t += 30) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
  return out;
}

function pickDesk(children, slots) {
  const free = d => slots.every(s => d.availableSlots.includes(s));
  for (const id of CFG.deskIds) {
    const d = children.find(c => c.resourceId === id);
    if (d && free(d)) return d;
  }
  if (CFG.fallback === 'any') return children.find(free) || null;
  return null;
}

async function alreadyBooked(date) {
  // La API rechaza una segunda reserva del mismo día, así que un 400 por límite
  // diario también vale como "ya está hecha". Esto es solo para no llamar de más.
  return false;
}

async function bookOnce(date) {
  const slots = neededSlots(CFG.startLocal, CFG.endLocal);
  const children = await deskAvailability(date);
  if (!children.length) return { retry: true, reason: 'La API aún no devuelve puestos para ese día.' };

  const desk = pickDesk(children, slots);
  if (!desk) {
    const wanted = CFG.deskIds.join(', ');
    return { retry: true, reason: `Ningún puesto preferido (${wanted}) libre de ${CFG.startLocal} a ${CFG.endLocal}.` };
  }

  const from = wallToUtc(date, CFG.startLocal, CFG.tz);
  const to   = wallToUtc(date, CFG.endLocal,   CFG.tz);

  if (CFG.dryRun) {
    log(`[dry-run] Reservaría ${desk.resourceName} (${desk.resourceId}) el ${date} ${CFG.startLocal}-${CFG.endLocal}.`);
    return { done: true, dryRun: true, desk };
  }

  const r = await api('POST', '/api/v1/booking', {
    person: CFG.personId,
    space: CFG.spaceId,
    type: 'desk',
    deskId: desk.resourceId,
    isDraft: false,
    from: from.toISOString(),
    to: to.toISOString(),
  });

  if (r.status === 201) return { done: true, desk, booking: r.data };

  const code = r.data?.errorCode;
  if (code === 'DAILY_BOOKING_LIMIT_REACHED') {
    return { done: true, skipped: true, reason: `Ya había una reserva para el ${date}.` };
  }
  if (code === 'INVALID_DATE_RANGE') {
    return { retry: true, reason: 'La ventana aún no se ha abierto para ese día.' };
  }
  return { retry: true, reason: `Error ${r.status}: ${JSON.stringify(r.data)}` };
}

/** Si arrancamos poco antes de la medianoche (en CFG.tz), espera a que se abra el dia nuevo. */
async function waitForWindow() {
  if (process.env.ZH_WAIT_FOR_MIDNIGHT !== '1' || CFG.date) return;
  const maxWaitMs = int(process.env.ZH_MAX_WAIT_MIN, 45) * 60000;
  const ms = wallToUtc(addDays(todayIn(CFG.tz), 1), '00:00', CFG.tz).getTime() + 5000 - Date.now();
  if (ms > 0 && ms <= maxWaitMs) {
    log('Faltan ' + Math.round(ms / 1000) + 's para la medianoche en ' + CFG.tz + '. Espero y disparo en cuanto abra el dia.');
    await new Promise(r => setTimeout(r, ms));
  }
}

/** Comprueba en Zityhub que la reserva existe de verdad. Un job en verde tiene que
 *  significar "hay reserva", no "el script termino sin lanzar excepciones". */
async function findBookingFor(date) {
  const qs = 'person=' + CFG.personId + '&offset=0&limit=100&sortBy=from&direction=desc';
  const r = await api('GET', '/api/v1/booking/search?' + qs);
  if (!r.ok || !Array.isArray(r.data)) return null;
  return r.data.find(b => String(b.from).slice(0, 10) === date
    && b.status !== 'cancelled' && !b.cancelled_at) || null;
}

async function confirm(date, outcome) {
  if (outcome.dryRun) {
    if (CFG.requireBooking) {
      throw new Error('Se ha ejecutado en simulacion una tirada que debia reservar de verdad. Revisa ZH_DRY_RUN en el workflow.');
    }
    return;
  }
  const b = await findBookingFor(date);
  if (!b) {
    throw new Error('El script daba por hecha la reserva del ' + date + ', pero Zityhub no la encuentra. No te fies de este job.');
  }
  log('VERIFICADO en Zityhub: reserva ' + b.id + ', ' + b.from + ' -> ' + b.to + ', puesto ' + b.deskId + ', estado ' + b.status + '.');
}

async function main() {
  checkConfig();
  await waitForWindow();

  const today = todayIn(CFG.tz);

  const target = CFG.date || nthBusinessDayAfter(today, CFG.advanceBusinessDays);

  log(`Hoy en ${CFG.tz}: ${today}. Día objetivo: ${target} (${CFG.startLocal}-${CFG.endLocal}).`);

  if (!CFG.date && !isWorkday(target)) { log('El día objetivo no es laborable. Nada que hacer.'); return; }

  await login();

  for (let i = 1; i <= CFG.attempts; i++) {
    const r = await bookOnce(target);
    if (r.done) {
      if (r.skipped) log(`OK — ${r.reason}`);
      else if (r.dryRun) log('OK — simulación completada.');
      else log(`RESERVADO: ${r.desk.resourceName} el ${target} de ${CFG.startLocal} a ${CFG.endLocal} (id ${r.booking.id}).`);
      await confirm(target, r);
      return;
    }
    log(`Intento ${i}/${CFG.attempts}: ${r.reason}`);
    if (i < CFG.attempts) await new Promise(res => setTimeout(res, CFG.attemptGapMs));
  }

  throw new Error(`No se pudo reservar el ${target} tras ${CFG.attempts} intentos.`);
}

export { wallToUtc, nthBusinessDayAfter, neededSlots, pickDesk, todayIn };

// Solo se ejecuta al lanzarlo directamente, para poder importar las funciones en tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error('FALLO:', err.message); process.exit(1); });
}
