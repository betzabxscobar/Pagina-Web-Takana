import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { distributionExtension, isSupportedDistributionFile } from "./distribution-formats.mjs";
import {
  addCartItem,
  addFavorite,
  archiveListing,
  checkoutCart,
  createBooking,
  createListing,
  createManagedUser,
  createSession,
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
  getUserByToken,
  loginUser,
  registerUser,
  removeCartItem,
  removeFavorite,
  revokeSession,
  updateBookingStatus,
  updateListingByAdmin,
  updateManagedUser,
  updateOrderStatus,
} from "./database.mjs";

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

function optionalAuth(request, _response, next) {
  const token = tokenFrom(request);
  request.auth = { token, user: getUserByToken(token) };
  next();
}

function requireAuth(request, response, next) {
  optionalAuth(request, response, () => {
    if (!request.auth.user) {
      response.status(401).json({ error: "Inicia sesión para continuar." });
      return;
    }
    next();
  });
}

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
  return (request, response) => {
    try {
      const body = handler(request, response);
      if (!response.headersSent) response.status(status).json(body);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "No se pudo completar la operación." });
    }
  };
}

app.get("/api/health", (_request, response) => response.json(databaseStatus()));

app.get("/api/listings", route((request) => ({
  items: getListings({ category: request.query.category, search: request.query.search }),
})));
app.post("/api/listings", requireAuth, receiveDistribution, (request, response) => {
  try {
    const category = String(request.body.category || "");
    if (category !== "servicio" && !request.file) throw new Error("Selecciona el ejecutable o paquete completo de tu proyecto.");
    const listing = createListing({
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

app.get("/api/listings/:listingId/download", requireAuth, (request, response) => {
  try {
    const download = getListingDownload(request.params.listingId, request.auth.user.id);
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

app.post("/api/auth", route((request) => {
  const action = request.body.action === "register" ? "register" : "login";
  const user = action === "register" ? registerUser(request.body) : loginUser(request.body);
  const session = createSession(user.id);
  return { user, ...session };
}));
app.get("/api/auth/me", requireAuth, route((request) => ({ user: request.auth.user })));
app.delete("/api/auth/session", (request, response) => {
  revokeSession(tokenFrom(request));
  response.status(204).end();
});

app.get("/api/favorites", requireAuth, route((request) => ({ ids: getFavoriteIds(request.auth.user.id) })));
app.post("/api/favorites/:listingId", requireAuth, route((request) => addFavorite(request.auth.user.id, request.params.listingId), 201));
app.delete("/api/favorites/:listingId", requireAuth, route((request) => removeFavorite(request.auth.user.id, request.params.listingId)));

app.get("/api/cart", requireAuth, route((request) => getCart(request.auth.user.id)));
app.post("/api/cart/items", requireAuth, route((request) => addCartItem(request.auth.user.id, request.body.listingId), 201));
app.delete("/api/cart/items/:listingId", requireAuth, route((request) => removeCartItem(request.auth.user.id, request.params.listingId)));

app.post("/api/orders/checkout", requireAuth, route((request) => checkoutCart(request.auth.user.id), 201));
app.get("/api/orders", requireAuth, route((request) => ({ items: getOrders(request.auth.user.id) })));

app.post("/api/bookings", optionalAuth, route((request) => createBooking(request.body, request.auth.user?.id), 201));
app.get("/api/bookings", requireAuth, route((request) => ({ items: getBookings(request.auth.user.id) })));

app.get("/api/admin/summary", requireRole("superadmin", "admin"), route(() => getAdminSummary()));
app.get("/api/admin/users", requireRole("superadmin"), route(() => ({ items: getAdminUsers() })));
app.post("/api/admin/users", requireRole("superadmin"), route((request) => createManagedUser(request.body), 201));
app.put("/api/admin/users/:userId", requireRole("superadmin"), route((request) =>
  updateManagedUser(request.params.userId, request.body, request.auth.user.id)));
app.delete("/api/admin/users/:userId", requireRole("superadmin"), route((request) =>
  deactivateManagedUser(request.params.userId, request.auth.user.id)));

app.get("/api/admin/listings", requireRole("superadmin", "admin"), route(() => ({ items: getAdminListings() })));
app.put("/api/admin/listings/:listingId", requireRole("superadmin", "admin"), route((request) =>
  updateListingByAdmin(request.params.listingId, request.body, request.auth.user.role === "superadmin")));
app.delete("/api/admin/listings/:listingId", requireRole("superadmin"), route((request) =>
  archiveListing(request.params.listingId)));

app.get("/api/admin/bookings", requireRole("superadmin", "admin"), route(() => ({ items: getAdminBookings() })));
app.put("/api/admin/bookings/:bookingId", requireRole("superadmin", "admin"), route((request) =>
  updateBookingStatus(request.params.bookingId, request.body.status)));
app.delete("/api/admin/bookings/:bookingId", requireRole("superadmin"), route((request) =>
  deleteBooking(request.params.bookingId)));

app.get("/api/admin/orders", requireRole("superadmin", "admin"), route(() => ({ items: getAdminOrders() })));
app.put("/api/admin/orders/:orderId", requireRole("superadmin", "admin"), route((request) =>
  updateOrderStatus(request.params.orderId, request.body.status)));
app.delete("/api/admin/orders/:orderId", requireRole("superadmin"), route((request) =>
  deleteOrder(request.params.orderId)));

app.use("/api", (_request, response) => response.status(404).json({ error: "Ruta de API no encontrada." }));

const distDirectory = path.join(process.cwd(), "dist");
if ((port === 3100 || process.env.TAKANA_SERVE_APP === "1") && existsSync(distDirectory)) {
  app.use(express.static(distDirectory));
  app.get("/{*path}", (_request, response) => response.sendFile(path.join(distDirectory, "index.html")));
}

app.listen(port, "127.0.0.1", () => {
  console.log(`TAKANA local listo en http://127.0.0.1:${port}`);
});
