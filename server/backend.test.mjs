import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

const temporaryDirectory = path.join(process.cwd(), ".tmp", `backend-test-${process.pid}`);
mkdirSync(temporaryDirectory, { recursive: true });
process.env.TAKANA_DB_PATH = path.join(temporaryDirectory, "takana-test.sqlite");

const backend = await import(`./database.mjs?test=${Date.now()}`);

after(() => {
  backend.closeDatabase();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("flujo completo del backend local", () => {
  const user = backend.registerUser({ name: "Prueba Local", email: "prueba@takana.local", password: "segura123" });
  assert.equal(user.email, "prueba@takana.local");
  assert.equal(user.role, "superadmin");
  assert.equal(backend.loginUser({ email: user.email, password: "segura123" }).id, user.id);

  const regularUser = backend.registerUser({ name: "Usuario", email: "usuario@takana.local", password: "segura123" });
  assert.equal(regularUser.role, "usuario");
  const admin = backend.createManagedUser({ name: "Administrador", email: "admin@takana.local", password: "segura123", role: "admin" });
  assert.equal(admin.role, "admin");
  assert.equal(backend.getAdminUsers().length, 3);
  assert.throws(() => backend.updateManagedUser(user.id, { active: false }, user.id), /propia cuenta/);

  const session = backend.createSession(user.id);
  assert.equal(backend.getUserByToken(session.token).id, user.id);

  const listings = backend.getListings();
  const game = listings.find((item) => item.category === "juego");
  const service = listings.find((item) => item.category === "servicio");
  assert.ok(game);
  assert.ok(service);

  backend.addFavorite(user.id, game.id);
  assert.deepEqual(backend.getFavoriteIds(user.id), [game.id]);
  backend.removeFavorite(user.id, game.id);
  assert.deepEqual(backend.getFavoriteIds(user.id), []);

  assert.equal(backend.addCartItem(user.id, game.id).count, 1);
  assert.equal(backend.addCartItem(user.id, game.id).count, 2);
  assert.equal(backend.removeCartItem(user.id, game.id).count, 1);
  const order = backend.checkoutCart(user.id);
  assert.equal(order.status, "confirmado");
  assert.equal(backend.getOrders(user.id).length, 1);
  assert.equal(backend.getCart(user.id).count, 0);
  assert.equal(backend.updateOrderStatus(order.id, "completado").status, "completado");

  const booking = backend.createBooking({
    listingId: service.id,
    customerName: user.name,
    customerEmail: user.email,
    scheduledDate: "2030-06-15",
    notes: "Revisión completa",
  }, user.id);
  assert.equal(booking.status, "pendiente");
  assert.equal(backend.getBookings(user.id).length, 1);

  const publication = backend.createListing({
    title: "Herramienta de prueba",
    description: "Una publicación creada por la prueba automática local.",
    category: "software",
    priceCents: 500,
    executable: {
      filename: "Herramienta de prueba.zip",
      storageKey: "archivo-prueba.zip",
      size: 512,
      mime: "application/octet-stream",
    },
  }, user.id);
  assert.ok(publication.id > 0);
  assert.ok(backend.getListings({ search: "Herramienta de prueba" }).some((item) => item.id === publication.id && item.hasExecutable));
  assert.equal(backend.getListingDownload(publication.id, user.id).storageKey, "archivo-prueba.zip");
  assert.throws(() => backend.getListingDownload(publication.id, regularUser.id), /Confirma la compra/);
  backend.addCartItem(regularUser.id, publication.id);
  backend.checkoutCart(regularUser.id);
  assert.equal(backend.getListingDownload(publication.id, regularUser.id).downloadFilename, "Herramienta de prueba.zip");
  assert.equal(backend.updateListingByAdmin(publication.id, { title: "Herramienta editada", published: false }, false).published, true);
  assert.equal(backend.archiveListing(publication.id).published, false);
  assert.equal(backend.getAdminSummary().users, 3);

  backend.revokeSession(session.token);
  assert.equal(backend.getUserByToken(session.token), null);
});
