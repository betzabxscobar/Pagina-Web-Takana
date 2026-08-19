/**
 * Revisa que el equipo este listo para levantar TAKANA.
 *
 * Uso:  npm run doctor
 *
 * Pensado para quien acaba de clonar el repositorio: dice exactamente que
 * falta, en vez de dejar que el servidor falle con un error suelto.
 */
import { existsSync } from "node:fs";

const ok = (t) => console.log("  ✓  " + t);
const bad = (t, ayuda) => { console.log("  ✗  " + t); if (ayuda) console.log("     " + ayuda); fallos++; };
let fallos = 0;

console.log("\nRevisión del entorno de TAKANA\n");

// --- Node ------------------------------------------------------------------
const major = Number(process.versions.node.split(".")[0]);
if (major >= 22) ok(`Node ${process.versions.node}`);
else bad(`Node ${process.versions.node} es muy antiguo`, "Se necesita Node 22 o superior: nodejs.org");

// --- Dependencias ----------------------------------------------------------
if (existsSync("node_modules")) ok("Dependencias instaladas");
else bad("Faltan las dependencias", "Ejecuta: npm install");

// --- Archivo .env ----------------------------------------------------------
if (!existsSync(".env")) {
  bad("No existe el archivo .env",
    "Pídeselo a quien configuró el proyecto y déjalo en esta misma carpeta.");
} else {
  ok("Archivo .env encontrado");
}

// --- Supabase --------------------------------------------------------------
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE } = process.env;

if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/listings?select=id&limit=1`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) ok("Conexión con Supabase");
    else bad(`Supabase respondió ${response.status}`, "Revisa SUPABASE_URL y SUPABASE_ANON_KEY en el .env");
  } catch {
    bad("No se pudo conectar con Supabase", "Revisa tu conexión a internet y los valores del .env");
  }
} else {
  bad("Faltan SUPABASE_URL o SUPABASE_ANON_KEY", "Deben venir en el .env");
}

if (SUPABASE_SERVICE_ROLE) ok("Clave de servicio presente");
else bad("Falta SUPABASE_SERVICE_ROLE", "Sin ella no funciona el cambio de contraseña ni crear cuentas desde el panel");

// --- Correo ----------------------------------------------------------------
const { SMTP_HOST, SMTP_USER, SMTP_PASSWORD } = process.env;
if (SMTP_HOST && SMTP_USER && SMTP_PASSWORD) {
  ok(`Correo configurado (${SMTP_HOST})`);
  console.log("     Para confirmar que envía: npm run test:smtp -- tu@correo.com");
} else {
  bad("Falta la configuración de correo",
    "Sin SMTP_HOST, SMTP_USER y SMTP_PASSWORD no se puede cambiar la contraseña.");
}

// --- Resumen ---------------------------------------------------------------
console.log("");
if (fallos === 0) {
  console.log("Todo listo. Levanta la aplicación con:  npm run dev\n");
} else {
  console.log(`${fallos} ${fallos === 1 ? "cosa pendiente" : "cosas pendientes"}. Resuélvelas y vuelve a ejecutar: npm run doctor\n`);
  process.exit(1);
}
