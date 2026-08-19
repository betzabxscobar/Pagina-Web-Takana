/**
 * Migra data/takana.sqlite a Supabase.
 *
 * Requiere que las migraciones SQL de supabase/migrations/ ya esten aplicadas.
 *
 * Uso:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... node scripts/migrate-to-supabase.mjs [--dry-run]
 *
 * La service_role NUNCA debe quedar escrita en el repositorio ni llegar al
 * frontend: se lee solo desde variables de entorno.
 */
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

const url = process.env.SUPABASE_URL;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE;
const dryRun = process.argv.includes("--dry-run");

if (!url || !serviceRole) {
  console.error("Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE en el entorno.");
  process.exit(1);
}

const headers = {
  apikey: serviceRole,
  Authorization: `Bearer ${serviceRole}`,
  "Content-Type": "application/json",
};

async function api(path, options = {}) {
  const response = await fetch(`${url}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} -> ${response.status} ${text}`);
  return body;
}

/**
 * SQLite guarda los timestamps como "YYYY-MM-DD HH:MM:SS" en UTC. El separador
 * con espacio no es ISO valido, asi que se normaliza antes de convertir.
 */
function toIso(value) {
  if (!value) return null;
  const normalized = String(value).trim().replace(" ", "T");
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Fecha invalida en SQLite: ${value}`);
  return date.toISOString();
}

/** Mismo estilo de contrasena que ya usa el equipo: Tk26! + 14 caracteres. */
function generatePassword() {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHIJKLMNPQRSTUVWXYZ23456789-";
  let suffix = "";
  for (const byte of randomBytes(14)) suffix += alphabet[byte % alphabet.length];
  return `Tk26!${suffix}`;
}

const db = new Database("data/takana.sqlite", { readonly: true });
const rows = (sql) => db.prepare(sql).all();

const users = rows("SELECT id, display_name, email, role, active, created_at FROM users ORDER BY id");
const listings = rows(`SELECT id, slug, title, description, category, price_cents, publisher, cover_key,
  featured, published, owner_user_id, download_filename, download_storage_key, download_size,
  download_mime, created_at FROM listings ORDER BY id`);
const favorites = rows("SELECT user_id, listing_id, created_at FROM favorites");
const cartItems = rows("SELECT user_id, listing_id, quantity, created_at, updated_at FROM cart_items");
const orders = rows("SELECT id, user_id, total_cents, status, created_at FROM orders ORDER BY id");
const orderItems = rows("SELECT id, order_id, listing_id, title, unit_price_cents, quantity FROM order_items ORDER BY id");
const bookings = rows(`SELECT id, listing_id, user_id, customer_name, customer_email, scheduled_date,
  notes, status, created_at FROM bookings ORDER BY id`);

console.log("Origen SQLite:");
console.log(`  usuarios ${users.length} | publicaciones ${listings.length} | favoritos ${favorites.length}`);
console.log(`  carrito ${cartItems.length} | pedidos ${orders.length} | lineas ${orderItems.length} | citas ${bookings.length}`);

if (dryRun) {
  console.log("\n--dry-run: no se escribio nada en Supabase.");
  db.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Cuentas.
// Los hashes scrypt de SQLite no son portables a Supabase Auth, asi que cada
// cuenta se recrea con una contrasena nueva. El rol original se conserva:
// admin y superadmin se restauran despues del alta, porque el trigger
// on_auth_user_created siempre crea el perfil como 'usuario'.
// ---------------------------------------------------------------------------
const userIdMap = new Map();
const credentials = [];

for (const user of users) {
  const password = generatePassword();
  const created = await api("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({
      email: user.email,
      password,
      email_confirm: true,
      user_metadata: { display_name: user.display_name },
    }),
  });

  userIdMap.set(user.id, created.id);
  credentials.push({ nombre: user.display_name, correo: user.email, rol: user.role, password });

  // Restaura el rol real y el estado activo (service_role salta el candado).
  await api(`/rest/v1/profiles?id=eq.${created.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      role: user.role,
      active: Boolean(user.active),
      display_name: user.display_name,
      created_at: toIso(user.created_at),
    }),
  });

  console.log(`  cuenta migrada: ${user.email} (${user.role})`);
}

// ---------------------------------------------------------------------------
// 2. Publicaciones.
// ---------------------------------------------------------------------------
const listingIdMap = new Map();

for (const listing of listings) {
  const [created] = await api("/rest/v1/listings", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      slug: listing.slug,
      title: listing.title,
      description: listing.description,
      category: listing.category,
      price_cents: listing.price_cents,
      publisher: listing.publisher,
      cover_key: listing.cover_key,
      featured: Boolean(listing.featured),
      published: Boolean(listing.published),
      owner_user_id: userIdMap.get(listing.owner_user_id) ?? null,
      download_filename: listing.download_filename,
      download_storage_key: listing.download_storage_key,
      download_size: listing.download_size,
      download_mime: listing.download_mime,
      created_at: toIso(listing.created_at),
    }),
  });
  listingIdMap.set(listing.id, created.id);
  console.log(`  publicacion migrada: ${listing.slug}`);
}

// ---------------------------------------------------------------------------
// 3. Tablas dependientes.
// ---------------------------------------------------------------------------
async function insertAll(table, records) {
  if (!records.length) return;
  await api(`/rest/v1/${table}`, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(records),
  });
  console.log(`  ${table}: ${records.length} filas`);
}

await insertAll("favorites", favorites.map((row) => ({
  user_id: userIdMap.get(row.user_id),
  listing_id: listingIdMap.get(row.listing_id),
  created_at: toIso(row.created_at),
})));

await insertAll("cart_items", cartItems.map((row) => ({
  user_id: userIdMap.get(row.user_id),
  listing_id: listingIdMap.get(row.listing_id),
  quantity: row.quantity,
  created_at: toIso(row.created_at),
  updated_at: toIso(row.updated_at),
})));

const orderIdMap = new Map();
for (const order of orders) {
  const [created] = await api("/rest/v1/orders", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      user_id: userIdMap.get(order.user_id),
      total_cents: order.total_cents,
      status: order.status,
      created_at: toIso(order.created_at),
    }),
  });
  orderIdMap.set(order.id, created.id);
}
if (orders.length) console.log(`  orders: ${orders.length} filas`);

await insertAll("order_items", orderItems.map((row) => ({
  order_id: orderIdMap.get(row.order_id),
  listing_id: listingIdMap.get(row.listing_id) ?? null,
  title: row.title,
  unit_price_cents: row.unit_price_cents,
  quantity: row.quantity,
})));

await insertAll("bookings", bookings.map((row) => ({
  listing_id: listingIdMap.get(row.listing_id),
  user_id: row.user_id ? userIdMap.get(row.user_id) : null,
  customer_name: row.customer_name,
  customer_email: row.customer_email,
  scheduled_date: row.scheduled_date,
  notes: row.notes,
  status: row.status,
  created_at: toIso(row.created_at),
})));

db.close();

console.log("\n=================================================================");
console.log("CONTRASENAS NUEVAS - entregar a cada persona por canal privado");
console.log("=================================================================");
console.table(credentials);
console.log("\nMigracion terminada.");
