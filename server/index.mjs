import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { distributionExtension, isSupportedDistributionFile } from "./distribution-formats.mjs";
import { mailerConfigured, sendPasswordCode } from "./mailer.mjs";
import { adminClient, clientForToken, guestClient, isolatedAuthClient, resolveUser } from "./supabase-client.mjs";
import {
  addCartItem,
  addFavorite,
  archiveListing,
  checkoutCart,
  createBooking,
  createListing,
  createManagedUser,
  databaseStatus,
  deactivateManagedUser,
  deleteBooking,
  deleteOrder,
  getAdminBookings,
  getAdminListings,
  getAdminOrders,
  getAdminSummary,
  getAdminUsers,
  getBookings,
  getCart,
  getFavoriteIds,
  getListings,
  getListingDownload,
  getOrders,
  removeCartItem,
  removeFavorite,
  updateBookingStatus,
  updateListingByAdmin,
  updateManagedUser,
  updateOrderStatus,
} from "./data.mjs";

const app = express();
const portIndex = process.argv.indexOf("--port");
const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : process.env.PORT || 3101);
const uploadDirectory = path.resolve(process.env.TAKANA_UPLOADS_PATH || path.join(process.cwd(), "data", "uploads"));
const maximumDistributionMegabytes = Math.max(1, Number(
  process.env.TAKANA_MAX_PROJECT_MB || process.env.TAKANA_MAX_EXECUTABLE_MB || 2048,
));
mkdirSync(uploadDirectory, { recursive: true });

const distributionUpload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, uploadDirectory),
    filename: (_request, file, callback) => callback(null, `${randomUUID()}${distributionExtension(file.originalname)}`),
  }),
  limits: { fileSize: maximumDistributionMegabytes * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    const filename = path.basename(String(file.originalname || ""));
    const accepted = isSupportedDistributionFile(filename);
    callback(accepted ? null : new Error("Selecciona un ejecutable compatible o un paquete .zip, .7z o .rar."), accepted);
  },
});

function receiveDistribution(request, response, next) {
  distributionUpload.single("executable")(request, response, (error) => {
    if (!error) { next(); return; }
    const message = error?.code === "LIMIT_FILE_SIZE"
      ? `El archivo supera el límite local de ${maximumDistributionMegabytes} MB.`
      : error instanceof Error ? error.message : "No se pudo recibir el archivo del proyecto.";
    response.status(400).json({ error: message });
  });
}

function removeUploadedDistribution(file) {
  if (!file?.path) return;
  try { unlinkSync(file.path); } catch { /* El archivo ya no existe. */ }
}

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

function tokenFrom(request) {
  const authorization = String(request.headers.authorization || "");
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

/**
 * Adjunta a la peticion un cliente de Supabase con la identidad de quien llama.
 *
 * Sin token queda el cliente anonimo, que en Postgres es el rol `anon`: eso es
 * un invitado. Con token, todas las consultas viajan con su JWT y las politicas
 * RLS aplican su rol real. El backend nunca decide permisos por su cuenta.
 */
async function optionalAuth(request, _response, next) {
  const token = tokenFrom(request);
  const user = token ? await resolveUser(token) : null;
  request.auth = { token, user, client: user ? clientForToken(token) : guestClient };
  next();
}

async function requireAuth(request, response, next) {
  await optionalAuth(request, response, () => {
    if (!request.auth.user) {
      response.status(401).json({ error: "Inicia sesión para continuar." });
      return;
    }
    next();
  });
}

/**
 * Segunda barrera, no la unica: RLS ya impide en la base que un usuario sin
 * privilegios lea o escriba lo que no le toca. Esto solo devuelve un 403 claro
 * en vez de una lista vacia.
 */
function requireRole(...roles) {
  return (request, response, next) => requireAuth(request, response, () => {
    if (!roles.includes(request.auth.user.role)) {
      response.status(403).json({ error: "No tienes permisos para realizar esta acción." });
      return;
    }
    next();
  });
}

function route(handler, status = 200) {
  return async (request, response) => {
    try {
      const body = await handler(request, response);
      if (!response.headersSent) response.status(status).json(body);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "No se pudo completar la operación." });
    }
  };
}

app.get("/api/health", route(() => databaseStatus(guestClient)));

// ---------------------------------------------------------------------------
// Autenticacion, delegada a Supabase Auth.
// El registro nunca envia un rol: el trigger on_auth_user_created de Postgres
// siempre crea el perfil como 'usuario'. Admin y superadmin solo se otorgan
// desde el panel del superadmin.
// ---------------------------------------------------------------------------
app.post("/api/auth", route(async (request) => {
  const action = request.body.action === "register" ? "register" : "login";
  const email = String(request.body.email || "").trim().toLowerCase();
  const password = String(request.body.password || "");

  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Escribe un correo válido.");
  if (password.length < 6) throw new Error("La contraseña debe tener al menos 6 caracteres.");

  if (action === "register") {
    const name = String(request.body.name || "").trim();
    if (name.length < 2) throw new Error("Escribe un nombre de al menos 2 caracteres.");

    const { error } = await guestClient.auth.signUp({
      email,
      password,
      options: { data: { display_name: name } },
    });
    if (error) throw new Error(error.message || "No se pudo crear la cuenta.");
  }

  const { data, error } = await guestClient.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new Error(action === "register"
      ? "Cuenta creada. Confirma tu correo para poder iniciar sesión."
      : "Correo o contraseña incorrectos.");
  }

  const user = await resolveUser(data.session.access_token);
  if (!user) throw new Error("Esta cuenta fue desactivada por el superadministrador.");

  return {
    user,
    token: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: new Date(data.session.expires_at * 1000).toISOString(),
  };
}));

/**
 * Renueva la sesion.
 *
 * El token de acceso de Supabase vive ~1 hora, muy por debajo de los 30 dias
 * que duraba la sesion propia. El refresh_token es el que sostiene la sesion
 * larga, asi que el frontend lo canjea cuando el acceso vence.
 */
app.post("/api/auth/refresh", route(async (request) => {
  const refreshToken = String(request.body.refreshToken || "");
  if (!refreshToken) throw new Error("Falta el token de renovación.");

  const { data, error } = await guestClient.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) throw new Error("La sesión venció. Inicia sesión de nuevo.");

  const user = await resolveUser(data.session.access_token);
  if (!user) throw new Error("Esta cuenta fue desactivada por el superadministrador.");

  return {
    user,
    token: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: new Date(data.session.expires_at * 1000).toISOString(),
  };
}));

/**
 * Cambio de contrasena verificado por correo, en dos pasos.
 *
 * No se usa resetPasswordForEmail() porque ese camino depende de dos ajustes
 * del dashboard de Supabase que el equipo no puede tocar: la lista de Redirect
 * URLs y el servidor de correo. En su lugar se genera el codigo con la Admin
 * API (que si funciona con la service_role) y se envia con el SMTP propio.
 *
 * Nada cambia hasta que la persona escribe el codigo que le llego al correo.
 */

// Freno simple por correo, para que nadie use el formulario como maquina de
// mandar mensajes a una casilla ajena.
const codeRequests = new Map();
const CODE_COOLDOWN_MS = 60_000;

app.post("/api/auth/password-reset", optionalAuth, route(async (request) => {
  // Con sesion abierta se usa el correo de la sesion y no el que mande el
  // cliente: de lo contrario cualquiera podria disparar correos a terceros.
  const email = request.auth.user?.email
    ?? String(request.body.email || "").trim().toLowerCase();

  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Escribe un correo válido.");

  // Respuesta deliberadamente identica exista o no la cuenta: decir cuales
  // correos estan registrados permitiria enumerar a los usuarios.
  const respuestaNeutra = {
    sent: true,
    message: `Si ${email} tiene una cuenta, le enviamos un código de verificación.`,
  };

  const last = codeRequests.get(email);
  if (last && Date.now() - last < CODE_COOLDOWN_MS) return respuestaNeutra;
  codeRequests.set(email, Date.now());

  try {
    const { data, error } = await adminClient().auth.admin.generateLink({ type: "recovery", email });
    if (error || !data?.properties?.email_otp) return respuestaNeutra;

    await sendPasswordCode(
      email,
      data.properties.email_otp,
      data.user?.user_metadata?.display_name || "",
    );
  } catch (error) {
    // Que el SMTP no este configurado si debe verse: es un fallo del servidor,
    // no una pista sobre si la cuenta existe.
    if (!mailerConfigured) throw error;
    return respuestaNeutra;
  }

  return respuestaNeutra;
}));

/**
 * Paso 2: canjear el codigo por una sesion y aplicar la contrasena nueva.
 * Llegar aqui con un codigo valido prueba que la persona controla esa casilla.
 */
app.post("/api/auth/password", route(async (request) => {
  const email = String(request.body.email || "").trim().toLowerCase();
  const code = String(request.body.code || "").trim();
  const password = String(request.body.password || "");

  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Escribe un correo válido.");
  if (!code) throw new Error("Escribe el código que te llegó al correo.");
  if (password.length < 6) throw new Error("La contraseña debe tener al menos 6 caracteres.");

  // Las dos llamadas van sobre la MISMA instancia: verifyOtp deja la sesion
  // cargada en ella y updateUser la necesita ahi. Y es una instancia propia de
  // esta peticion, para que dos cambios simultaneos no se pisen.
  const authClient = isolatedAuthClient();

  const { data, error } = await authClient.auth.verifyOtp({ email, token: code, type: "recovery" });
  if (error || !data.session) {
    throw new Error("El código no es válido o ya venció. Solicita uno nuevo.");
  }

  const { error: updateError } = await authClient.auth.updateUser({ password });
  if (updateError) {
    console.error("[password] updateUser fallo:", updateError.message);
    throw new Error("No se pudo guardar la contraseña nueva. Intenta otra vez.");
  }

  codeRequests.delete(email);
  return { changed: true, message: "Contraseña actualizada. Inicia sesión con la nueva." };
}));

app.get("/api/auth/me", requireAuth, route((request) => ({ user: request.auth.user })));

app.delete("/api/auth/session", async (request, response) => {
  const token = tokenFrom(request);
  if (token) await clientForToken(token).auth.signOut();
  response.status(204).end();
});

// ---------------------------------------------------------------------------
// Catalogo. GET es publico: un invitado ve las publicaciones publicadas.
// ---------------------------------------------------------------------------
app.get("/api/listings", optionalAuth, route(async (request) => ({
  items: await getListings(request.auth.client, {
    category: request.query.category,
    search: request.query.search,
  }),
})));

app.post("/api/listings", requireAuth, receiveDistribution, async (request, response) => {
  try {
    const category = String(request.body.category || "");
    if (category !== "servicio" && !request.file) throw new Error("Selecciona el ejecutable o paquete completo de tu proyecto.");
    const listing = await createListing(request.auth.client, {
      ...request.body,
      priceCents: Number(request.body.priceCents),
      executable: request.file ? {
        filename: path.basename(request.file.originalname),
        storageKey: request.file.filename,
        size: request.file.size,
        mime: "application/octet-stream",
      } : null,
    }, request.auth.user.id);
    response.status(201).json(listing);
  } catch (error) {
    removeUploadedDistribution(request.file);
    response.status(400).json({ error: error instanceof Error ? error.message : "No se pudo publicar el proyecto." });
  }
});

// Los archivos siguen en disco local; solo la autorizacion se movio a Postgres.
app.get("/api/listings/:listingId/download", requireAuth, async (request, response) => {
  try {
    const download = await getListingDownload(request.auth.client, request.params.listingId);
    const storageKey = path.basename(download.storageKey);
    const distributionPath = path.join(uploadDirectory, storageKey);
    if (!existsSync(distributionPath)) throw new Error("El archivo del proyecto no está disponible en este equipo.");
    response.attachment(download.downloadFilename);
    response.set({
      "Cache-Control": "private, no-store",
      "Content-Type": "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    const distributionStream = createReadStream(distributionPath);
    distributionStream.on("error", () => {
      if (!response.headersSent) response.status(500).json({ error: "No se pudo leer el archivo local." });
      else response.destroy();
    });
    distributionStream.pipe(response);
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "No se pudo descargar el proyecto." });
  }
});

// ---------------------------------------------------------------------------
// Cuenta del usuario
// ---------------------------------------------------------------------------
app.get("/api/favorites", requireAuth, route(async (request) => ({ ids: await getFavoriteIds(request.auth.client) })));
app.post("/api/favorites/:listingId", requireAuth, route((request) =>
  addFavorite(request.auth.client, request.auth.user.id, request.params.listingId), 201));
app.delete("/api/favorites/:listingId", requireAuth, route((request) =>
  removeFavorite(request.auth.client, request.params.listingId)));

app.get("/api/cart", requireAuth, route((request) => getCart(request.auth.client)));
app.post("/api/cart/items", requireAuth, route((request) => addCartItem(request.auth.client, request.body.listingId), 201));
app.delete("/api/cart/items/:listingId", requireAuth, route((request) => removeCartItem(request.auth.client, request.params.listingId)));

app.post("/api/orders/checkout", requireAuth, route((request) => checkoutCart(request.auth.client), 201));
app.get("/api/orders", requireAuth, route(async (request) => ({ items: await getOrders(request.auth.client) })));

// Un invitado puede agendar soporte sin cuenta.
app.post("/api/bookings", optionalAuth, route((request) =>
  createBooking(request.auth.client, request.body, request.auth.user?.id ?? null), 201));
app.get("/api/bookings", requireAuth, route(async (request) => ({ items: await getBookings(request.auth.client) })));

// ---------------------------------------------------------------------------
// Panel administrativo
// ---------------------------------------------------------------------------
app.get("/api/admin/summary", requireRole("superadmin", "admin"), route((request) => getAdminSummary(request.auth.client)));

app.get("/api/admin/users", requireRole("superadmin"), route(async (request) => ({ items: await getAdminUsers(request.auth.client) })));
app.post("/api/admin/users", requireRole("superadmin"), route((request) => createManagedUser(request.body), 201));
app.put("/api/admin/users/:userId", requireRole("superadmin"), route((request) =>
  updateManagedUser(request.auth.client, request.params.userId, request.body)));
app.delete("/api/admin/users/:userId", requireRole("superadmin"), route((request) =>
  deactivateManagedUser(request.auth.client, request.params.userId, request.auth.user.id)));

app.get("/api/admin/listings", requireRole("superadmin", "admin"), route(async (request) => ({ items: await getAdminListings(request.auth.client) })));
app.put("/api/admin/listings/:listingId", requireRole("superadmin", "admin"), route((request) =>
  updateListingByAdmin(request.auth.client, request.params.listingId, request.body, request.auth.user.role === "superadmin")));
app.delete("/api/admin/listings/:listingId", requireRole("superadmin"), route((request) =>
  archiveListing(request.auth.client, request.params.listingId)));

app.get("/api/admin/bookings", requireRole("superadmin", "admin"), route(async (request) => ({ items: await getAdminBookings(request.auth.client) })));
app.put("/api/admin/bookings/:bookingId", requireRole("superadmin", "admin"), route((request) =>
  updateBookingStatus(request.auth.client, request.params.bookingId, request.body.status)));
app.delete("/api/admin/bookings/:bookingId", requireRole("superadmin"), route((request) =>
  deleteBooking(request.auth.client, request.params.bookingId)));

app.get("/api/admin/orders", requireRole("superadmin", "admin"), route(async (request) => ({ items: await getAdminOrders(request.auth.client) })));
app.put("/api/admin/orders/:orderId", requireRole("superadmin", "admin"), route((request) =>
  updateOrderStatus(request.auth.client, request.params.orderId, request.body.status)));
app.delete("/api/admin/orders/:orderId", requireRole("superadmin"), route((request) =>
  deleteOrder(request.auth.client, request.params.orderId)));

app.use("/api", (_request, response) => response.status(404).json({ error: "Ruta de API no encontrada." }));

// En desarrollo el frontend lo sirve Vite en el 3100 y este proceso solo
// atiende el API. Desplegado no hay Vite, asi que el mismo servidor entrega la
// pagina compilada. TAKANA_SERVE_APP=1 fuerza ese modo con cualquier puerto.
const distDirectory = path.join(process.cwd(), "dist");
const serveApp = port === 3100 || process.env.TAKANA_SERVE_APP === "1" || Boolean(process.env.TAKANA_HOST);
if (serveApp && existsSync(distDirectory)) {
  app.use(express.static(distDirectory));
  app.get("/{*path}", (_request, response) => response.sendFile(path.join(distDirectory, "index.html")));
}

// Por defecto escucha solo en 127.0.0.1, de modo que en un equipo local no
// queda expuesto a la red. Al desplegar hay que poner TAKANA_HOST=0.0.0.0 para
// que el proveedor pueda alcanzar el proceso.
const host = process.env.TAKANA_HOST || "127.0.0.1";
app.listen(port, host, () => {
  console.log(`TAKANA listo en http://${host}:${port}`);
});
