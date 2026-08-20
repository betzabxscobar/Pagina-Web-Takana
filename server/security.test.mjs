/**
 * Pruebas de integración contra Supabase.
 *
 * Verifican lo que de verdad protege TAKANA: que un invitado sólo vea lo
 * publicado, que registrarse nunca otorgue privilegios y que nadie pueda
 * ascenderse a sí mismo. Eso vive en las políticas RLS y en los triggers de
 * Postgres, no en JavaScript, así que sólo puede comprobarse contra la base.
 *
 * LOS DATOS REALES NO SE TOCAN:
 * - Todo lo que crean lleva el prefijo `PREFIJO` y se borra al terminar.
 * - borrarCuenta() se niega a eliminar nada que no lleve ese prefijo, de modo
 *   que un error de programación no puede alcanzar a una cuenta del equipo.
 * - La última prueba compara el número de perfiles, roles y publicaciones
 *   contra el estado inicial y falla si algo cambió.
 *
 * Uso:  npm run test:backend
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

const URL_BASE = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICIO = process.env.SUPABASE_SERVICE_ROLE;

const configurado = Boolean(URL_BASE && ANON && SERVICIO);
const saltar = configurado
  ? false
  : "Faltan SUPABASE_URL, SUPABASE_ANON_KEY o SUPABASE_SERVICE_ROLE. Copia .env.example a .env.";

const PREFIJO = "zz-test-";
const CLAVE = "Tk26!PruebaAutomatica9";

const cabecerasServicio = {
  apikey: SERVICIO,
  Authorization: `Bearer ${SERVICIO}`,
  "Content-Type": "application/json",
};

const cabecerasAnon = { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" };

const cabecerasUsuario = (token) => ({ apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function pedir(ruta, opciones = {}) {
  const respuesta = await fetch(`${URL_BASE}${ruta}`, opciones);
  const texto = await respuesta.text();
  return { estado: respuesta.status, ok: respuesta.ok, cuerpo: texto ? JSON.parse(texto) : null };
}

const creadas = [];

/** Crea una cuenta desechable y la registra para su limpieza. */
async function crearCuenta(etiqueta, rol = "usuario") {
  const correo = `${PREFIJO}${etiqueta}-${Date.now()}${Math.random().toString(36).slice(2, 6)}@takana.test`;
  const alta = await pedir("/auth/v1/admin/users", {
    method: "POST",
    headers: cabecerasServicio,
    // Se manda un rol a propósito en la metadata: el trigger debe ignorarlo.
    body: JSON.stringify({
      email: correo,
      password: CLAVE,
      email_confirm: true,
      user_metadata: { display_name: "Cuenta de prueba", role: "superadmin" },
    }),
  });
  assert.ok(alta.cuerpo?.id, `no se pudo crear la cuenta de prueba: ${JSON.stringify(alta.cuerpo)}`);
  creadas.push(alta.cuerpo.id);

  if (rol !== "usuario") {
    await pedir(`/rest/v1/profiles?id=eq.${alta.cuerpo.id}`, {
      method: "PATCH", headers: cabecerasServicio, body: JSON.stringify({ role: rol }),
    });
  }
  return { id: alta.cuerpo.id, correo };
}

/** Sólo borra cuentas de prueba: comprueba el prefijo antes de eliminar. */
async function borrarCuenta(id) {
  const { cuerpo } = await pedir(`/auth/v1/admin/users/${id}`, { headers: cabecerasServicio });
  if (!cuerpo?.email?.startsWith(PREFIJO)) return;
  await pedir(`/auth/v1/admin/users/${id}`, { method: "DELETE", headers: cabecerasServicio });
}

async function iniciarSesion(correo) {
  const { cuerpo } = await pedir("/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: correo, password: CLAVE }),
  });
  assert.ok(cuerpo?.access_token, "no se pudo iniciar sesión con la cuenta de prueba");
  return cuerpo.access_token;
}

async function rolDe(id) {
  const { cuerpo } = await pedir(`/rest/v1/profiles?select=role,active&id=eq.${id}`, { headers: cabecerasServicio });
  return cuerpo[0];
}

let referencia = null;

async function retrato() {
  const perfiles = await pedir("/rest/v1/profiles?select=id,role", { headers: cabecerasServicio });
  const publicaciones = await pedir("/rest/v1/listings?select=id", { headers: cabecerasServicio });
  const reales = perfiles.cuerpo.filter((p) => !creadas.includes(p.id));
  return {
    perfiles: reales.length,
    superadmins: reales.filter((p) => p.role === "superadmin").length,
    admins: reales.filter((p) => p.role === "admin").length,
    publicaciones: publicaciones.cuerpo.length,
  };
}

before(async () => {
  if (!configurado) return;
  referencia = await retrato();
});

after(async () => {
  for (const id of creadas) await borrarCuenta(id);
});

// ---------------------------------------------------------------------------
// Invitado: sin sesión, rol `anon` en Postgres.
// ---------------------------------------------------------------------------
test("un invitado sólo ve las publicaciones publicadas", { skip: saltar }, async () => {
  const visibles = await pedir("/rest/v1/listings?select=id,published", { headers: cabecerasAnon });
  assert.ok(Array.isArray(visibles.cuerpo));
  assert.ok(
    visibles.cuerpo.every((fila) => fila.published === true),
    "RLS dejó ver una publicación sin publicar a alguien sin sesión",
  );
});

test("un invitado no puede crear publicaciones", { skip: saltar }, async () => {
  const intento = await pedir("/rest/v1/listings", {
    method: "POST",
    headers: cabecerasAnon,
    body: JSON.stringify({
      slug: `${PREFIJO}intruso-${Date.now()}`,
      title: "Intruso",
      description: "No debería poder crearse",
      category: "juego",
      price_cents: 0,
    }),
  });
  assert.equal(intento.ok, false, "un invitado logró insertar una publicación");
  assert.equal(intento.cuerpo.code, "42501");
});

test("un invitado no puede leer los perfiles de nadie", { skip: saltar }, async () => {
  const { cuerpo } = await pedir("/rest/v1/profiles?select=email", { headers: cabecerasAnon });
  assert.deepEqual(cuerpo, [], "RLS expuso perfiles a alguien sin sesión");
});

// ---------------------------------------------------------------------------
// Alta de cuentas: registrarse jamás debe otorgar privilegios.
// ---------------------------------------------------------------------------
test("el alta ignora el rol pedido en la metadata y crea 'usuario'", { skip: saltar }, async () => {
  const cuenta = await crearCuenta("alta");
  const perfil = await rolDe(cuenta.id);
  assert.equal(perfil.role, "usuario", "una cuenta nueva obtuvo un rol distinto de usuario");
  assert.equal(perfil.active, true);
});

// ---------------------------------------------------------------------------
// Escalada de privilegios: el punto que ya falló una vez.
// ---------------------------------------------------------------------------
test("un admin NO puede ascenderse a superadmin", { skip: saltar }, async () => {
  const cuenta = await crearCuenta("escalada", "admin");
  const token = await iniciarSesion(cuenta.correo);

  const intento = await pedir(`/rest/v1/profiles?id=eq.${cuenta.id}`, {
    method: "PATCH", headers: cabecerasUsuario(token), body: JSON.stringify({ role: "superadmin" }),
  });

  assert.equal(intento.ok, false, "un admin logró ascenderse a superadmin");
  assert.equal((await rolDe(cuenta.id)).role, "admin", "el rol cambió pese a que la petición falló");
});

test("un admin NO puede cambiar el estado de una cuenta", { skip: saltar }, async () => {
  const cuenta = await crearCuenta("estado", "admin");
  const token = await iniciarSesion(cuenta.correo);

  const intento = await pedir(`/rest/v1/profiles?id=eq.${cuenta.id}`, {
    method: "PATCH", headers: cabecerasUsuario(token), body: JSON.stringify({ active: false }),
  });

  assert.equal(intento.ok, false);
  assert.equal((await rolDe(cuenta.id)).active, true);
});

test("pero sí puede editar su propio nombre", { skip: saltar }, async () => {
  const cuenta = await crearCuenta("nombre", "admin");
  const token = await iniciarSesion(cuenta.correo);

  const cambio = await pedir(`/rest/v1/profiles?id=eq.${cuenta.id}`, {
    method: "PATCH", headers: cabecerasUsuario(token), body: JSON.stringify({ display_name: "Nombre Nuevo" }),
  });

  assert.equal(cambio.ok, true, "el candado bloqueó también los cambios legítimos");
});

test("un admin NO puede eliminar publicaciones", { skip: saltar }, async () => {
  const cuenta = await crearCuenta("borrado", "admin");
  const token = await iniciarSesion(cuenta.correo);

  const antes = await pedir("/rest/v1/listings?select=id", { headers: cabecerasServicio });
  await pedir("/rest/v1/listings?select=id", { method: "DELETE", headers: cabecerasUsuario(token) });
  const despues = await pedir("/rest/v1/listings?select=id", { headers: cabecerasServicio });

  assert.equal(despues.cuerpo.length, antes.cuerpo.length, "un admin eliminó publicaciones");
});

test("un usuario no ve el carrito ni los pedidos de otras personas", { skip: saltar }, async () => {
  const cuenta = await crearCuenta("aislamiento");
  const token = await iniciarSesion(cuenta.correo);

  const carrito = await pedir("/rest/v1/cart_items?select=user_id", { headers: cabecerasUsuario(token) });
  const pedidos = await pedir("/rest/v1/orders?select=user_id", { headers: cabecerasUsuario(token) });

  assert.ok(carrito.cuerpo.every((f) => f.user_id === cuenta.id));
  assert.ok(pedidos.cuerpo.every((f) => f.user_id === cuenta.id));
});

// ---------------------------------------------------------------------------
// Un superadmin sí debe poder administrar: un candado que bloquea a todos
// dejaría el panel inservible.
// ---------------------------------------------------------------------------
test("un superadmin SÍ puede asignar roles y desactivar cuentas", { skip: saltar }, async () => {
  const jefe = await crearCuenta("jefe", "superadmin");
  const objetivo = await crearCuenta("objetivo");
  const token = await iniciarSesion(jefe.correo);

  const ascenso = await pedir(`/rest/v1/profiles?id=eq.${objetivo.id}`, {
    method: "PATCH", headers: cabecerasUsuario(token), body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(ascenso.ok, true, "un superadmin no pudo asignar un rol");
  assert.equal((await rolDe(objetivo.id)).role, "admin");

  const baja = await pedir(`/rest/v1/profiles?id=eq.${objetivo.id}`, {
    method: "PATCH", headers: cabecerasUsuario(token), body: JSON.stringify({ active: false }),
  });
  assert.equal(baja.ok, true, "un superadmin no pudo desactivar una cuenta");
});

// ---------------------------------------------------------------------------
// Cambio de contraseña con verificación por correo.
// ---------------------------------------------------------------------------
test("el código de verificación cambia la contraseña y sólo sirve una vez", { skip: saltar }, async () => {
  const cuenta = await crearCuenta("clave");
  const nueva = "Tk26!ClaveCambiada7";

  const enlace = await pedir("/auth/v1/admin/generate_link", {
    method: "POST", headers: cabecerasServicio,
    body: JSON.stringify({ type: "recovery", email: cuenta.correo }),
  });
  const codigo = enlace.cuerpo.email_otp;
  assert.ok(codigo, "no se generó el código de verificación");

  const malo = await pedir("/auth/v1/verify", {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "recovery", email: cuenta.correo, token: "000000" }),
  });
  assert.equal(malo.ok, false, "un código incorrecto fue aceptado");

  const bueno = await pedir("/auth/v1/verify", {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "recovery", email: cuenta.correo, token: codigo }),
  });
  assert.ok(bueno.cuerpo?.access_token, "el código correcto no devolvió sesión");

  const cambio = await pedir("/auth/v1/user", {
    method: "PUT", headers: cabecerasUsuario(bueno.cuerpo.access_token),
    body: JSON.stringify({ password: nueva }),
  });
  assert.equal(cambio.ok, true, "no se pudo aplicar la contraseña nueva");

  const conNueva = await pedir("/auth/v1/token?grant_type=password", {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: cuenta.correo, password: nueva }),
  });
  assert.ok(conNueva.cuerpo?.access_token, "la contraseña nueva no funciona");

  const conVieja = await pedir("/auth/v1/token?grant_type=password", {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: cuenta.correo, password: CLAVE }),
  });
  assert.equal(conVieja.ok, false, "la contraseña anterior sigue sirviendo");

  const reuso = await pedir("/auth/v1/verify", {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "recovery", email: cuenta.correo, token: codigo }),
  });
  assert.equal(reuso.ok, false, "el código pudo reutilizarse");
});

// ---------------------------------------------------------------------------
// Debe ir al final: comprueba que las pruebas no dejaron huella.
// ---------------------------------------------------------------------------
test("los datos reales quedaron intactos", { skip: saltar }, async () => {
  const ahora = await retrato();
  assert.deepEqual(ahora, referencia,
    "las pruebas alteraron los datos reales; revisa la limpieza antes de volver a ejecutarlas");
});
