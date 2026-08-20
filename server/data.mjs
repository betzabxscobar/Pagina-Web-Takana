/**
 * Capa de datos sobre Supabase.
 *
 * Cada funcion recibe el cliente ya ligado al usuario de la peticion, asi que
 * las politicas RLS son las que autorizan. Cuando una consulta no devuelve
 * filas por falta de permiso, RLS la filtra en silencio: por eso varias
 * funciones comprueban el resultado y lanzan un mensaje explicito.
 *
 * Las formas de retorno se mantienen tal como las espera el frontend.
 */
import { adminClient, translateError } from "./supabase-client.mjs";

const LISTING_FIELDS = `id, slug, title, description, category, publisher,
  priceCents:price_cents, coverKey:cover_key, featured,
  downloadFilename:download_filename, downloadSize:download_size,
  downloadStorageKey:download_storage_key, ownerUserId:owner_user_id,
  createdAt:created_at`;

const CATEGORIES = ["juego", "software", "servicio"];

function fail(error, fallback) {
  throw new Error(translateError(error, fallback));
}

/** El frontend espera hasExecutable, no la clave interna de almacenamiento. */
function shapeListing(row) {
  const { downloadStorageKey, ...rest } = row;
  return { ...rest, featured: Boolean(row.featured), hasExecutable: Boolean(downloadStorageKey) };
}

// ---------------------------------------------------------------------------
// Publicaciones
// ---------------------------------------------------------------------------
export async function getListings(client, filters = {}) {
  let query = client.from("listings").select(LISTING_FIELDS).eq("published", true);

  const category = String(filters.category || "");
  if (CATEGORIES.includes(category)) query = query.eq("category", category);

  const search = String(filters.search || "").trim();
  if (search) {
    const term = `%${search}%`;
    query = query.or(`title.ilike.${term},description.ilike.${term},publisher.ilike.${term}`);
  }

  const { data, error } = await query
    .order("featured", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (error) fail(error, "No se pudieron cargar las publicaciones.");
  return data.map(shapeListing);
}

export async function createListing(client, input, ownerUserId) {
  const title = String(input.title || "").trim();
  const description = String(input.description || "").trim();
  const category = String(input.category || "");
  const priceCents = Math.round(Number(input.priceCents));

  if (title.length < 3) throw new Error("El nombre debe tener al menos 3 caracteres.");
  if (description.length < 12) throw new Error("La descripción debe tener al menos 12 caracteres.");
  if (!CATEGORIES.includes(category)) throw new Error("Selecciona una categoría válida.");
  if (!Number.isFinite(priceCents) || priceCents < 0) throw new Error("Ingresa un precio válido.");

  const { data: owner, error: ownerError } = await client
    .from("profiles").select("id, display_name").eq("id", ownerUserId).single();
  if (ownerError || !owner) throw new Error("Inicia sesión para publicar.");

  const baseSlug = title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "publicacion";

  const executable = input.executable && typeof input.executable === "object" ? input.executable : null;

  const { data, error } = await client.from("listings").insert({
    slug: `${baseSlug}-${Date.now().toString(36)}`,
    title,
    description,
    category,
    price_cents: priceCents,
    publisher: owner.display_name,
    cover_key: category === "juego" ? "orbit" : category === "software" ? "forge" : "preventivo",
    owner_user_id: owner.id,
    download_filename: executable?.filename ?? null,
    download_storage_key: executable?.storageKey ?? null,
    download_size: executable?.size ?? null,
    download_mime: executable?.mime ?? null,
  }).select("id, slug").single();

  if (error) fail(error, "No se pudo crear la publicación.");
  return data;
}

/**
 * La decision de si el usuario puede descargar la toma Postgres
 * (can_download_listing), no este backend: asi la regla es la misma sin
 * importar por donde entre la peticion.
 */
export async function getListingDownload(client, listingId) {
  const { data: allowed, error: rpcError } = await client
    .rpc("can_download_listing", { p_listing_id: Number(listingId) });
  if (rpcError) fail(rpcError, "No se pudo verificar el permiso de descarga.");
  if (!allowed) throw new Error("Confirma la compra para descargar este proyecto.");

  const { data, error } = await client.from("listings")
    .select("id, title, category, downloadFilename:download_filename, storageKey:download_storage_key, downloadSize:download_size")
    .eq("id", listingId).eq("published", true).single();

  if (error || !data) fail(error, "La publicación no está disponible.");
  if (!data.storageKey || !data.downloadFilename) {
    throw new Error("Esta publicación no tiene un archivo descargable disponible.");
  }
  return data;
}

// ---------------------------------------------------------------------------
// Favoritos
// ---------------------------------------------------------------------------
export async function getFavoriteIds(client) {
  const { data, error } = await client.from("favorites")
    .select("listing_id").order("created_at", { ascending: false });
  if (error) fail(error, "No se pudieron cargar los favoritos.");
  return data.map((row) => row.listing_id);
}

export async function addFavorite(client, userId, listingId) {
  const { error } = await client.from("favorites")
    .upsert({ user_id: userId, listing_id: Number(listingId) }, { onConflict: "user_id,listing_id" });
  if (error) fail(error, "No se pudo guardar el favorito.");
  return { listingId: Number(listingId), favorite: true };
}

export async function removeFavorite(client, listingId) {
  const { error } = await client.from("favorites").delete().eq("listing_id", Number(listingId));
  if (error) fail(error, "No se pudo quitar el favorito.");
  return { listingId: Number(listingId), favorite: false };
}

// ---------------------------------------------------------------------------
// Carrito. Las mutaciones pasan por funciones de Postgres para que el
// incremento de cantidad sea atomico y no dependa de leer-luego-escribir.
// ---------------------------------------------------------------------------
export async function getCart(client) {
  const { data, error } = await client.from("cart_items")
    .select("quantity, listing:listings!inner(id, title, category, priceCents:price_cents, publisher, coverKey:cover_key, published)")
    .eq("listings.published", true)
    .order("updated_at", { ascending: false });

  if (error) fail(error, "No se pudo cargar el carrito.");

  const items = data.map((row) => ({
    listingId: row.listing.id,
    title: row.listing.title,
    category: row.listing.category,
    priceCents: row.listing.priceCents,
    publisher: row.listing.publisher,
    coverKey: row.listing.coverKey,
    quantity: row.quantity,
  }));

  return {
    items,
    count: items.reduce((total, item) => total + item.quantity, 0),
    totalCents: items.reduce((total, item) => total + item.priceCents * item.quantity, 0),
  };
}

export async function addCartItem(client, listingId) {
  const { error } = await client.rpc("add_cart_item", { p_listing_id: Number(listingId) });
  if (error) fail(error, "No se pudo agregar al carrito.");
  return getCart(client);
}

export async function removeCartItem(client, listingId) {
  const { error } = await client.rpc("remove_cart_item", { p_listing_id: Number(listingId) });
  if (error) fail(error, "No se pudo quitar del carrito.");
  return getCart(client);
}

// ---------------------------------------------------------------------------
// Pedidos
// ---------------------------------------------------------------------------
export async function checkoutCart(client) {
  const { data, error } = await client.rpc("checkout_cart");
  if (error) fail(error, "No se pudo confirmar el pedido.");
  const order = Array.isArray(data) ? data[0] : data;
  return { id: order.id, totalCents: order.total_cents, status: order.status };
}

export async function getOrders(client) {
  const { data, error } = await client.from("orders")
    .select(`id, totalCents:total_cents, status, createdAt:created_at,
      items:order_items(listingId:listing_id, title, unitPriceCents:unit_price_cents, quantity)`)
    .order("id", { ascending: false });
  if (error) fail(error, "No se pudieron cargar los pedidos.");
  return data;
}

// ---------------------------------------------------------------------------
// Citas de soporte. Un invitado puede agendar sin cuenta: el cliente que llega
// aqui puede ser el anonimo, y RLS ya valida que el servicio este publicado.
// ---------------------------------------------------------------------------
export async function createBooking(client, input, userId = null) {
  const name = String(input.customerName || "").trim();
  const email = String(input.customerEmail || "").trim().toLowerCase();
  const date = String(input.scheduledDate || "");

  if (name.length < 2) throw new Error("Ingresa tu nombre.");
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Ingresa un correo válido.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Selecciona una fecha válida.");

  const { data, error } = await client.from("bookings").insert({
    listing_id: Number(input.listingId),
    user_id: userId,
    customer_name: name,
    customer_email: email,
    scheduled_date: date,
    notes: String(input.notes || "").trim(),
  }).select("id, status").single();

  if (error) fail(error, "El servicio seleccionado no está disponible.");
  return data;
}

export async function getBookings(client) {
  const { data, error } = await client.from("bookings")
    .select(`id, scheduledDate:scheduled_date, notes, status, createdAt:created_at,
      listingId:listing_id, listing:listings(title)`)
    .order("scheduled_date", { ascending: false });
  if (error) fail(error, "No se pudieron cargar las citas.");
  return data.map(({ listing, ...row }) => ({ ...row, listingTitle: listing?.title ?? "" }));
}

// ---------------------------------------------------------------------------
// Panel administrativo.
// Ninguna de estas funciones comprueba el rol: eso ya lo hacen las politicas
// RLS y el middleware requireRole de Express.
// ---------------------------------------------------------------------------
export async function getAdminSummary(client) {
  const { data, error } = await client.rpc("admin_summary");
  if (error) fail(error, "No se pudo cargar el resumen.");
  return data;
}

export async function getAdminUsers(client) {
  const { data, error } = await client.from("profiles")
    .select("id, name:display_name, email, role, active, createdAt:created_at")
    .order("created_at", { ascending: false });
  if (error) fail(error, "No se pudieron cargar las cuentas.");
  return data;
}

/**
 * Alta manual desde el panel del superadmin.
 * Requiere la Admin API porque hay que crear la credencial en Supabase Auth,
 * y despues fijar el rol: el trigger on_auth_user_created siempre crea el
 * perfil como 'usuario', nunca con privilegios.
 */
export async function createManagedUser(input) {
  const name = String(input.name || "").trim();
  const email = String(input.email || "").trim().toLowerCase();
  const password = String(input.password || "");
  const role = String(input.role || "usuario");

  if (name.length < 2) throw new Error("Escribe un nombre de al menos 2 caracteres.");
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Escribe un correo válido.");
  if (password.length < 6) throw new Error("La contraseña debe tener al menos 6 caracteres.");
  if (!["superadmin", "admin", "usuario"].includes(role)) throw new Error("Selecciona un rol válido.");

  const admin = adminClient();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: name },
  });
  if (createError) throw new Error(createError.message || "Ya existe una cuenta con este correo.");

  const { data, error } = await admin.from("profiles")
    .update({ role, display_name: name })
    .eq("id", created.user.id)
    .select("id, name:display_name, email, role, active")
    .single();

  if (error) {
    // No dejar una credencial huerfana si el perfil no pudo completarse.
    await admin.auth.admin.deleteUser(created.user.id);
    fail(error, "No se pudo asignar el rol a la cuenta.");
  }
  return data;
}

export async function updateManagedUser(client, userId, input) {
  const payload = {};
  if (input.name !== undefined) payload.display_name = String(input.name).trim();
  if (input.role !== undefined) payload.role = String(input.role);
  if (input.active !== undefined) payload.active = Boolean(input.active);

  const { data, error } = await client.from("profiles")
    .update(payload).eq("id", userId)
    .select("id, name:display_name, email, role, active").single();

  // Aqui afloran los mensajes de guard_profile_privileges y
  // ensure_last_superadmin, que ya vienen redactados en espanol.
  if (error) fail(error, "No se pudo actualizar la cuenta.");
  return data;
}

/** Las cuentas no se borran, se desactivan: los pedidos deben conservarse. */
export async function deactivateManagedUser(client, userId, actorUserId) {
  if (String(userId) === String(actorUserId)) {
    throw new Error("No puedes desactivar tu propia cuenta.");
  }
  return updateManagedUser(client, userId, { active: false });
}

export async function getAdminListings(client) {
  const { data, error } = await client.from("listings")
    .select(`${LISTING_FIELDS}, published`)
    .order("id", { ascending: false });
  if (error) fail(error, "No se pudieron cargar las publicaciones.");
  return data.map(shapeListing);
}

export async function updateListingByAdmin(client, listingId, input, allowVisibilityChanges = false) {
  const payload = {};
  if (input.title !== undefined) payload.title = String(input.title).trim();
  if (input.description !== undefined) payload.description = String(input.description).trim();
  if (input.priceCents !== undefined) payload.price_cents = Math.round(Number(input.priceCents));
  if (allowVisibilityChanges) {
    if (input.published !== undefined) payload.published = Boolean(input.published);
    if (input.featured !== undefined) payload.featured = Boolean(input.featured);
  }

  const { data, error } = await client.from("listings")
    .update(payload).eq("id", listingId).select(LISTING_FIELDS).single();
  if (error) fail(error, "No se pudo actualizar la publicación.");
  return shapeListing(data);
}

export async function archiveListing(client, listingId) {
  const { error } = await client.from("listings").update({ published: false }).eq("id", listingId);
  if (error) fail(error, "No se pudo archivar la publicación.");
  return { id: Number(listingId), published: false };
}

export async function getAdminBookings(client) {
  const { data, error } = await client.from("bookings")
    .select(`id, scheduledDate:scheduled_date, notes, status, createdAt:created_at,
      customerName:customer_name, customerEmail:customer_email,
      listingId:listing_id, listing:listings(title)`)
    .order("scheduled_date", { ascending: false });
  if (error) fail(error, "No se pudieron cargar las citas.");
  return data.map(({ listing, ...row }) => ({ ...row, listingTitle: listing?.title ?? "" }));
}

export async function updateBookingStatus(client, bookingId, status) {
  const { data, error } = await client.from("bookings")
    .update({ status }).eq("id", bookingId).select("id, status").single();
  if (error) fail(error, "No se pudo actualizar la cita.");
  return data;
}

export async function deleteBooking(client, bookingId) {
  const { error } = await client.from("bookings").delete().eq("id", bookingId);
  if (error) fail(error, "No se pudo eliminar la cita.");
  return { id: Number(bookingId) };
}

export async function getAdminOrders(client) {
  const { data, error } = await client.from("orders")
    .select(`id, totalCents:total_cents, status, createdAt:created_at,
      buyer:profiles(name:display_name, email),
      items:order_items(listingId:listing_id, title, unitPriceCents:unit_price_cents, quantity)`)
    .order("id", { ascending: false });
  if (error) fail(error, "No se pudieron cargar los pedidos.");
  return data;
}

export async function updateOrderStatus(client, orderId, status) {
  const { data, error } = await client.from("orders")
    .update({ status }).eq("id", orderId).select("id, status").single();
  if (error) fail(error, "No se pudo actualizar el pedido.");
  return data;
}

export async function deleteOrder(client, orderId) {
  const { error } = await client.from("orders").delete().eq("id", orderId);
  if (error) fail(error, "No se pudo eliminar el pedido.");
  return { id: Number(orderId) };
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
export async function databaseStatus(client) {
  const { count, error } = await client.from("listings")
    .select("id", { count: "exact", head: true }).eq("published", true);
  if (error) return { connected: false, storage: "Supabase", error: translateError(error) };
  return { connected: true, storage: "Supabase (Postgres)", listings: count ?? 0 };
}
