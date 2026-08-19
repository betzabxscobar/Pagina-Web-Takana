# TAKANA

## Autoría

Desarrollado por Takana. Fecha de autoría: 19 de agosto de 2026.
El código se distribuye bajo una licencia propietaria; consulta [LICENSE](LICENSE).

Marketplace local de videojuegos, software y soporte técnico.

## Arquitectura

- React + Vite + TypeScript
- Node.js + Express
- SQLite local con `better-sqlite3`
- Sin nube y sin servicios externos

## Backend local

La base `data/takana.sqlite` almacena:

- usuarios y sesiones seguras de 30 días;
- publicaciones de juegos, software y servicios;
- favoritos y carrito por usuario;
- pedidos confirmados y sus productos;
- citas de mantenimiento y soporte técnico.

### Roles y permisos

- `superadmin`: administra usuarios, roles, publicaciones, citas y pedidos; puede crear, editar y desactivar.
- `admin`: puede crear y editar publicaciones y estados, pero las rutas de eliminación y usuarios están bloqueadas.
- `usuario`: cuenta normal para comprar, publicar, guardar favoritos y solicitar soporte.

Si todavía no existe un superadministrador, la primera cuenta registrada recibe ese rol. Las siguientes cuentas creadas desde el registro público reciben el rol `usuario`. El superadmin puede crear administradores desde su panel.

Las contraseñas se protegen con `scrypt` y los tokens de sesión sólo se almacenan como hash. Las rutas privadas usan `Authorization: Bearer <token>`.

Rutas principales: `/api/auth`, `/api/listings`, `/api/favorites`, `/api/cart`, `/api/orders` y `/api/bookings`.

## Desarrollo

```bash
npm install
npm run dev
```

La aplicación abre en `http://127.0.0.1:3100` y el API local se ejecuta en el puerto `3101`.

## Producción local

```bash
npm run build
npm start
```

El servidor sirve la aplicación compilada y el API desde `http://127.0.0.1:3100`.

## Pruebas

```bash
npm test
```

La prueba del backend usa una base temporal aislada y no modifica los datos reales de TAKANA.
