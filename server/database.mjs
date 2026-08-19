import Database from "better-sqlite3";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { distributionExtension, isSupportedDistributionFile } from "./distribution-formats.mjs";

const dataDirectory = path.join(process.cwd(), "data");
mkdirSync(dataDirectory, { recursive: true });
const database = new Database(process.env.TAKANA_DB_PATH || path.join(dataDirectory, "takana.sqlite"));
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");

const seeds = [
  ["andes-quest", "Andes Quest", "Aventura narrativa para PC inspirada en paisajes andinos, decisiones y exploración.", "juego", 1499, "Inti Studio", "andes", 1],
  ["pixel-forge", "Pixel Forge", "Editor visual ligero para diseñar sprites, interfaces y recursos de videojuegos.", "software", 2499, "TAKANA Labs", "forge", 1],
  ["pc-preventivo", "PC Preventivo", "Limpieza interna, revisión térmica, diagnóstico y optimización general del equipo.", "servicio", 2500, "TAKANA Tech", "preventivo", 1],
  ["focus-flow", "Focus Flow", "Organiza proyectos, tareas y sesiones de concentración desde un panel sencillo.", "software", 999, "Nodo Digital", "focus", 0],
  ["orbit-runner", "Orbit Runner", "Arcade de velocidad espacial con retos cortos y clasificación local.", "juego", 1199, "Nova Byte", "orbit", 0],
  ["optimizacion-red", "Optimización de red", "Diagnóstico de cobertura, configuración del router y mejora de estabilidad.", "servicio", 2000, "TAKANA Tech", "network", 0],
];

database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'usuario',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    price_cents INTEGER NOT NULL DEFAULT 0,
    publisher TEXT NOT NULL DEFAULT 'TAKANA Studio',
    cover_key TEXT NOT NULL DEFAULT 'default',
    featured INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 1,
    owner_user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL,
    user_id INTEGER,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    scheduled_date TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pendiente',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (listing_id) REFERENCES listings(id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL,
    listing_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, listing_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS cart_items (
    user_id INTEGER NOT NULL,
    listing_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, listing_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmado',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    listing_id INTEGER,
    title TEXT NOT NULL,
    unit_price_cents INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_listings_category_published ON listings(category, published);
  CREATE INDEX IF NOT EXISTS idx_bookings_listing_id ON bookings(listing_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_expiry ON sessions(user_id, expires_at);
  CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id, created_at);
`);

function ensureColumn(table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn("listings", "owner_user_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL");
ensureColumn("listings", "download_filename", "TEXT");
ensureColumn("listings", "download_storage_key", "TEXT");
ensureColumn("listings", "download_size", "INTEGER");
ensureColumn("listings", "download_mime", "TEXT");
ensureColumn("bookings", "user_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL");
ensureColumn("users", "active", "INTEGER NOT NULL DEFAULT 1");
database.prepare("UPDATE users SET role = 'usuario' WHERE role NOT IN ('superadmin', 'admin', 'usuario')").run();
database.exec("CREATE INDEX IF NOT EXISTS idx_bookings_user_id ON bookings(user_id)");

const count = database.prepare("SELECT COUNT(*) AS total FROM listings").get();
if (count.total === 0) {
  const insert = database.prepare(`INSERT INTO listings
    (slug, title, description, category, price_cents, publisher, cover_key, featured)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  database.transaction(() => seeds.forEach((seed) => insert.run(...seed)))();
}

const listingSelect = `SELECT id, slug, title, description, category, price_cents AS priceCents,
  publisher, cover_key AS coverKey, featured, download_filename AS downloadFilename,
  download_size AS downloadSize, CASE WHEN download_storage_key IS NOT NULL THEN 1 ELSE 0 END AS hasExecutable,
  created_at AS createdAt FROM listings`;
const publicUserSelect = "SELECT users.id, users.display_name AS name, users.email, users.role, users.active FROM users";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function requireListing(listingId) {
  const item = database.prepare("SELECT id FROM listings WHERE id = ? AND published = 1").get(Number(listingId));
  if (!item) throw new Error("La publicación seleccionada no está disponible.");
  return item;
}

function hashToken(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

export function getListings(filters = {}) {
  const clauses = ["published = 1"];
  const values = [];
  const category = String(filters.category || "");
  const search = String(filters.search || "").trim();
  if (["juego", "software", "servicio"].includes(category)) {
    clauses.push("category = ?");
    values.push(category);
  }
  if (search) {
    clauses.push("(title LIKE ? OR description LIKE ? OR publisher LIKE ?)");
    const term = `%${search}%`;
    values.push(term, term, term);
  }
  return database.prepare(`${listingSelect} WHERE ${clauses.join(" AND ")}
    ORDER BY featured DESC, datetime(created_at) DESC, id DESC`).all(...values)
    .map((item) => ({ ...item, featured: Boolean(item.featured), hasExecutable: Boolean(item.hasExecutable) }));
}

export function getListingDownload(listingId, userId) {
  const listing = database.prepare(`SELECT id, title, category, price_cents AS priceCents,
    owner_user_id AS ownerUserId, download_filename AS downloadFilename,
    download_storage_key AS storageKey, download_size AS downloadSize
    FROM listings WHERE id = ? AND published = 1`).get(Number(listingId));
  if (!listing) throw new Error("La publicación no está disponible.");
  if (!listing.storageKey || !listing.downloadFilename) throw new Error("Esta publicación no tiene un archivo descargable disponible.");
  const user = database.prepare(`${publicUserSelect} WHERE users.id = ?`).get(Number(userId));
  if (!user) throw new Error("Inicia sesión para descargar.");
  const privileged = listing.ownerUserId === user.id || ["superadmin", "admin"].includes(user.role);
  const purchased = listing.priceCents === 0 || Boolean(database.prepare(`SELECT 1 FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.user_id = ? AND oi.listing_id = ? AND o.status != 'cancelado' LIMIT 1`).get(user.id, listing.id));
  if (!privileged && !purchased) throw new Error("Confirma la compra para descargar este proyecto.");
  return listing;
}

export function createListing(input, ownerUserId) {
  const title = String(input.title || "").trim();
  const description = String(input.description || "").trim();
  const category = String(input.category || "");
  const priceCents = Math.round(Number(input.priceCents));
  if (title.length < 3) throw new Error("El nombre debe tener al menos 3 caracteres.");
  if (description.length < 12) throw new Error("La descripción debe tener al menos 12 caracteres.");
  if (!["juego", "software", "servicio"].includes(category)) throw new Error("Selecciona una categoría válida.");
  if (!Number.isFinite(priceCents) || priceCents < 0) throw new Error("Ingresa un precio válido.");
  const owner = database.prepare(`${publicUserSelect} WHERE id = ?`).get(Number(ownerUserId));
  if (!owner) throw new Error("Inicia sesión para publicar.");
  const baseSlug = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "publicacion";
  const slug = `${baseSlug}-${Date.now().toString(36)}`;
  const coverKey = category === "juego" ? "orbit" : category === "software" ? "forge" : "preventivo";
  const executable = input.executable && typeof input.executable === "object" ? input.executable : null;
  const downloadFilename = executable ? path.basename(String(executable.filename || "")) : null;
  const storageKey = executable ? String(executable.storageKey || "") : null;
  const downloadSize = executable ? Number(executable.size) : null;
  const downloadMime = executable ? String(executable.mime || "application/octet-stream") : null;
  const validStorageKey = storageKey && path.basename(storageKey) === storageKey
    && /^[a-z0-9][a-z0-9-]*\.[a-z0-9]+$/i.test(storageKey);
  if (executable && (!isSupportedDistributionFile(downloadFilename) || !isSupportedDistributionFile(storageKey)
    || distributionExtension(downloadFilename) !== distributionExtension(storageKey) || !validStorageKey
    || !Number.isSafeInteger(downloadSize) || downloadSize <= 0)) throw new Error("El archivo de distribución no es válido.");
  const result = database.prepare(`INSERT INTO listings
    (slug, title, description, category, price_cents, publisher, cover_key, owner_user_id,
      download_filename, download_storage_key, download_size, download_mime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(slug, title, description, category, priceCents,
      owner.name, coverKey, owner.id, downloadFilename, storageKey, downloadSize, downloadMime);
  return { id: Number(result.lastInsertRowid), slug };
}

export function createBooking(input, userId = null) {
  const name = String(input.customerName || "").trim();
  const email = normalizeEmail(input.customerEmail);
  const date = String(input.scheduledDate || "");
  if (name.length < 2) throw new Error("Ingresa tu nombre.");
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Ingresa un correo válido.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Selecciona una fecha válida.");
  const service = database.prepare("SELECT id FROM listings WHERE id = ? AND category = 'servicio' AND published = 1").get(Number(input.listingId));
  if (!service) throw new Error("El servicio seleccionado no está disponible.");
  const result = database.prepare(`INSERT INTO bookings
    (listing_id, user_id, customer_name, customer_email, scheduled_date, notes) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(Number(input.listingId), userId ? Number(userId) : null, name, email, date, String(input.notes || "").trim());
  return { id: Number(result.lastInsertRowid), status: "pendiente" };
}

export function getBookings(userId) {
  return database.prepare(`SELECT b.id, b.scheduled_date AS scheduledDate, b.notes, b.status,
    b.created_at AS createdAt, l.id AS listingId, l.title AS listingTitle
    FROM bookings b JOIN listings l ON l.id = b.listing_id
    WHERE b.user_id = ? ORDER BY b.scheduled_date DESC, b.id DESC`).all(Number(userId));
}

export function registerUser(input) {
  const name = String(input.name || "").trim();
  const email = normalizeEmail(input.email);
  const password = String(input.password || "");
  if (name.length < 2) throw new Error("Escribe un nombre de al menos 2 caracteres.");
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Escribe un correo válido.");
  if (password.length < 6) throw new Error("La contraseña debe tener al menos 6 caracteres.");
  if (database.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(email)) {
    throw new Error("Ya existe una cuenta local con este correo.");
  }
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  const hasSuperadmin = Boolean(database.prepare("SELECT id FROM users WHERE role = 'superadmin' AND active = 1 LIMIT 1").get());
  const role = hasSuperadmin ? "usuario" : "superadmin";
  const result = database.prepare("INSERT INTO users (display_name, email, password_hash, password_salt, role) VALUES (?, ?, ?, ?, ?)")
    .run(name, email, hash, salt, role);
  return { id: Number(result.lastInsertRowid), name, email, role, active: true };
}

export function loginUser(input) {
  const email = normalizeEmail(input.email);
  const password = String(input.password || "");
  const row = database.prepare(`SELECT id, display_name, email, password_hash, password_salt, role, active
    FROM users WHERE email = ? COLLATE NOCASE`).get(email);
  if (!row) throw new Error("Correo o contraseña incorrectos.");
  if (!row.active) throw new Error("Esta cuenta fue desactivada por el superadministrador.");
  const supplied = scryptSync(password, row.password_salt, 64);
  const stored = Buffer.from(row.password_hash, "hex");
  if (stored.length !== supplied.length || !timingSafeEqual(stored, supplied)) throw new Error("Correo o contraseña incorrectos.");
  return { id: row.id, name: row.display_name, email: row.email, role: row.role, active: true };
}

export function createSession(userId) {
  database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  database.prepare("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)")
    .run(Number(userId), hashToken(token), expiresAt);
  return { token, expiresAt };
}

export function getUserByToken(token) {
  if (!token) return null;
  return database.prepare(`${publicUserSelect} JOIN sessions s ON s.user_id = users.id
    WHERE s.token_hash = ? AND s.expires_at > ? AND users.active = 1`).get(hashToken(token), new Date().toISOString()) || null;
}

export function revokeSession(token) {
  if (token) database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

export function getFavoriteIds(userId) {
  return database.prepare("SELECT listing_id AS listingId FROM favorites WHERE user_id = ? ORDER BY created_at DESC")
    .all(Number(userId)).map((item) => item.listingId);
}

export function addFavorite(userId, listingId) {
  requireListing(listingId);
  database.prepare("INSERT OR IGNORE INTO favorites (user_id, listing_id) VALUES (?, ?)").run(Number(userId), Number(listingId));
  return { listingId: Number(listingId), favorite: true };
}

export function removeFavorite(userId, listingId) {
  database.prepare("DELETE FROM favorites WHERE user_id = ? AND listing_id = ?").run(Number(userId), Number(listingId));
  return { listingId: Number(listingId), favorite: false };
}

export function getCart(userId) {
  const items = database.prepare(`SELECT l.id AS listingId, l.title, l.category, l.price_cents AS priceCents,
    l.publisher, l.cover_key AS coverKey, c.quantity
    FROM cart_items c JOIN listings l ON l.id = c.listing_id
    WHERE c.user_id = ? AND l.published = 1 ORDER BY datetime(c.updated_at) DESC`).all(Number(userId));
  return {
    items,
    count: items.reduce((total, item) => total + item.quantity, 0),
    totalCents: items.reduce((total, item) => total + item.priceCents * item.quantity, 0),
  };
}

export function addCartItem(userId, listingId) {
  requireListing(listingId);
  database.prepare(`INSERT INTO cart_items (user_id, listing_id, quantity) VALUES (?, ?, 1)
    ON CONFLICT(user_id, listing_id) DO UPDATE SET quantity = quantity + 1, updated_at = CURRENT_TIMESTAMP`)
    .run(Number(userId), Number(listingId));
  return getCart(userId);
}

export function removeCartItem(userId, listingId) {
  database.prepare("DELETE FROM cart_items WHERE user_id = ? AND listing_id = ? AND quantity = 1").run(Number(userId), Number(listingId));
  database.prepare(`UPDATE cart_items SET quantity = quantity - 1, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND listing_id = ? AND quantity > 1`).run(Number(userId), Number(listingId));
  return getCart(userId);
}

const checkoutTransaction = database.transaction((userId) => {
  const cart = getCart(userId);
  if (!cart.items.length) throw new Error("El carrito está vacío.");
  const order = database.prepare("INSERT INTO orders (user_id, total_cents) VALUES (?, ?)").run(Number(userId), cart.totalCents);
  const orderId = Number(order.lastInsertRowid);
  const insertItem = database.prepare(`INSERT INTO order_items
    (order_id, listing_id, title, unit_price_cents, quantity) VALUES (?, ?, ?, ?, ?)`);
  cart.items.forEach((item) => insertItem.run(orderId, item.listingId, item.title, item.priceCents, item.quantity));
  database.prepare("DELETE FROM cart_items WHERE user_id = ?").run(Number(userId));
  return { id: orderId, totalCents: cart.totalCents, status: "confirmado" };
});

export function checkoutCart(userId) {
  return checkoutTransaction(Number(userId));
}

export function getOrders(userId) {
  const orders = database.prepare(`SELECT id, total_cents AS totalCents, status, created_at AS createdAt
    FROM orders WHERE user_id = ? ORDER BY id DESC`).all(Number(userId));
  const itemsForOrder = database.prepare(`SELECT listing_id AS listingId, title, unit_price_cents AS unitPriceCents, quantity
    FROM order_items WHERE order_id = ? ORDER BY id`);
  return orders.map((order) => ({ ...order, items: itemsForOrder.all(order.id) }));
}

const allowedRoles = ["superadmin", "admin", "usuario"];

export function getAdminSummary() {
  return {
    users: database.prepare("SELECT COUNT(*) AS total FROM users WHERE active = 1").get().total,
    admins: database.prepare("SELECT COUNT(*) AS total FROM users WHERE active = 1 AND role IN ('superadmin', 'admin')").get().total,
    listings: database.prepare("SELECT COUNT(*) AS total FROM listings WHERE published = 1").get().total,
    bookings: database.prepare("SELECT COUNT(*) AS total FROM bookings").get().total,
    pendingBookings: database.prepare("SELECT COUNT(*) AS total FROM bookings WHERE status = 'pendiente'").get().total,
    orders: database.prepare("SELECT COUNT(*) AS total FROM orders").get().total,
    salesCents: database.prepare("SELECT COALESCE(SUM(total_cents), 0) AS total FROM orders WHERE status != 'cancelado'").get().total,
  };
}

export function getAdminUsers() {
  return database.prepare(`SELECT id, display_name AS name, email, role, active, created_at AS createdAt
    FROM users ORDER BY id DESC`).all()
    .map((item) => ({ ...item, active: Boolean(item.active) }));
}

export function createManagedUser(input) {
  const name = String(input.name || "").trim();
  const email = normalizeEmail(input.email);
  const password = String(input.password || "");
  const role = String(input.role || "usuario");
  if (name.length < 2) throw new Error("Escribe un nombre de al menos 2 caracteres.");
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Escribe un correo válido.");
  if (password.length < 6) throw new Error("La contraseña debe tener al menos 6 caracteres.");
  if (!allowedRoles.includes(role)) throw new Error("Selecciona un rol válido.");
  if (database.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(email)) throw new Error("Ya existe una cuenta con este correo.");
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  const result = database.prepare(`INSERT INTO users
    (display_name, email, password_hash, password_salt, role) VALUES (?, ?, ?, ?, ?)`)
    .run(name, email, hash, salt, role);
  return { id: Number(result.lastInsertRowid), name, email, role, active: true };
}

export function updateManagedUser(userId, input, actorUserId) {
  const id = Number(userId);
  const current = database.prepare(`${publicUserSelect} WHERE users.id = ?`).get(id);
  if (!current) throw new Error("El usuario no existe.");
  const name = String(input.name ?? current.name).trim();
  const role = String(input.role ?? current.role);
  const active = input.active === undefined ? Boolean(current.active) : Boolean(input.active);
  if (name.length < 2) throw new Error("El nombre debe tener al menos 2 caracteres.");
  if (!allowedRoles.includes(role)) throw new Error("Selecciona un rol válido.");
  if (id === Number(actorUserId) && !active) throw new Error("No puedes desactivar tu propia cuenta.");
  if (current.role === "superadmin" && (role !== "superadmin" || !active)) {
    const total = database.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'superadmin' AND active = 1").get().total;
    if (total <= 1) throw new Error("Debe permanecer al menos un superadministrador activo.");
  }
  database.prepare("UPDATE users SET display_name = ?, role = ?, active = ? WHERE id = ?")
    .run(name, role, active ? 1 : 0, id);
  if (!active) database.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  return { id, name, email: current.email, role, active };
}

export function deactivateManagedUser(userId, actorUserId) {
  return updateManagedUser(userId, { active: false }, actorUserId);
}

export function getAdminListings() {
  return database.prepare(`SELECT id, slug, title, description, category, price_cents AS priceCents,
    publisher, cover_key AS coverKey, featured, published, owner_user_id AS ownerUserId,
    download_filename AS downloadFilename, download_size AS downloadSize,
    CASE WHEN download_storage_key IS NOT NULL THEN 1 ELSE 0 END AS hasExecutable,
    created_at AS createdAt FROM listings ORDER BY id DESC`).all().map((item) => ({
      ...item,
      featured: Boolean(item.featured),
      published: Boolean(item.published),
      hasExecutable: Boolean(item.hasExecutable),
    }));
}

export function updateListingByAdmin(listingId, input, allowVisibilityChanges = false) {
  const id = Number(listingId);
  const current = database.prepare("SELECT * FROM listings WHERE id = ?").get(id);
  if (!current) throw new Error("La publicación no existe.");
  const title = String(input.title ?? current.title).trim();
  const description = String(input.description ?? current.description).trim();
  const category = String(input.category ?? current.category);
  const priceCents = input.priceCents === undefined ? current.price_cents : Math.round(Number(input.priceCents));
  const featured = input.featured === undefined ? Boolean(current.featured) : Boolean(input.featured);
  const published = allowVisibilityChanges && input.published !== undefined ? Boolean(input.published) : Boolean(current.published);
  if (title.length < 3) throw new Error("El título debe tener al menos 3 caracteres.");
  if (description.length < 12) throw new Error("La descripción debe tener al menos 12 caracteres.");
  if (!["juego", "software", "servicio"].includes(category)) throw new Error("Selecciona una categoría válida.");
  if (!Number.isFinite(priceCents) || priceCents < 0) throw new Error("Ingresa un precio válido.");
  database.prepare(`UPDATE listings SET title = ?, description = ?, category = ?, price_cents = ?,
    featured = ?, published = ? WHERE id = ?`).run(title, description, category, priceCents, featured ? 1 : 0, published ? 1 : 0, id);
  return { id, title, description, category, priceCents, featured, published };
}

export function archiveListing(listingId) {
  const result = database.prepare("UPDATE listings SET published = 0 WHERE id = ?").run(Number(listingId));
  if (!result.changes) throw new Error("La publicación no existe.");
  return { id: Number(listingId), published: false };
}

export function getAdminBookings() {
  return database.prepare(`SELECT b.id, b.customer_name AS customerName, b.customer_email AS customerEmail,
    b.scheduled_date AS scheduledDate, b.notes, b.status, b.created_at AS createdAt,
    l.id AS listingId, l.title AS listingTitle
    FROM bookings b JOIN listings l ON l.id = b.listing_id ORDER BY b.id DESC`).all();
}

export function updateBookingStatus(bookingId, status) {
  const value = String(status || "");
  if (!["pendiente", "confirmada", "completada", "cancelada"].includes(value)) throw new Error("Estado de cita inválido.");
  const result = database.prepare("UPDATE bookings SET status = ? WHERE id = ?").run(value, Number(bookingId));
  if (!result.changes) throw new Error("La cita no existe.");
  return { id: Number(bookingId), status: value };
}

export function deleteBooking(bookingId) {
  const result = database.prepare("DELETE FROM bookings WHERE id = ?").run(Number(bookingId));
  if (!result.changes) throw new Error("La cita no existe.");
  return { id: Number(bookingId), deleted: true };
}

export function getAdminOrders() {
  return database.prepare(`SELECT o.id, o.total_cents AS totalCents, o.status, o.created_at AS createdAt,
    u.display_name AS customerName, u.email AS customerEmail
    FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC`).all();
}

export function updateOrderStatus(orderId, status) {
  const value = String(status || "");
  if (!["confirmado", "procesando", "completado", "cancelado"].includes(value)) throw new Error("Estado de pedido inválido.");
  const result = database.prepare("UPDATE orders SET status = ? WHERE id = ?").run(value, Number(orderId));
  if (!result.changes) throw new Error("El pedido no existe.");
  return { id: Number(orderId), status: value };
}

export function deleteOrder(orderId) {
  const result = database.prepare("DELETE FROM orders WHERE id = ?").run(Number(orderId));
  if (!result.changes) throw new Error("El pedido no existe.");
  return { id: Number(orderId), deleted: true };
}

export function databaseStatus() {
  const listings = database.prepare("SELECT COUNT(*) AS total FROM listings WHERE published = 1").get().total;
  const users = database.prepare("SELECT COUNT(*) AS total FROM users").get().total;
  const superadmins = database.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'superadmin' AND active = 1").get().total;
  const orders = database.prepare("SELECT COUNT(*) AS total FROM orders").get().total;
  const bookings = database.prepare("SELECT COUNT(*) AS total FROM bookings").get().total;
  return { connected: true, storage: "SQLite local", listings, users, superadmins, orders, bookings };
}

export function closeDatabase() {
  database.close();
}
