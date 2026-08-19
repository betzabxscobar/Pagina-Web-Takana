# TAKANA

## Autoría

Desarrollado por Takana. Fecha de autoría: 19 de agosto de 2026.
El código se distribuye bajo una licencia propietaria; consulta [LICENSE](LICENSE).

Marketplace local de videojuegos, software y soporte técnico.

## Arquitectura

- React + Vite + TypeScript
- Node.js + Express
- Supabase (Postgres) con Row Level Security
- Los archivos de distribución siguen guardándose en disco local

## Backend

Los datos viven en Supabase (Postgres). El esquema está en `supabase/migrations/`:

- publicaciones de juegos, software y servicios;
- favoritos y carrito por usuario;
- pedidos confirmados y sus productos;
- citas de mantenimiento y soporte técnico.

Las cuentas las maneja Supabase Auth; `profiles` guarda el nombre, el rol y el estado.

### Roles y permisos

- `invitado`: visitante sin cuenta. Sólo ve publicaciones publicadas y puede agendar soporte.
- `usuario`: comprar, publicar, guardar favoritos y solicitar soporte.
- `admin`: crear y editar publicaciones, citas y pedidos. No puede eliminar ni gestionar cuentas.
- `superadmin`: control total, incluida la gestión de usuarios y roles.

**Registrarse siempre otorga el rol `usuario`.** El trigger `handle_new_user` lo fija así e ignora
cualquier rol que venga en la petición, de modo que nadie puede darse privilegios al crear su cuenta.
`admin` y `superadmin` sólo los concede un superadmin desde su panel, y un trigger impide que alguien
se cambie a sí mismo el rol o el estado.

Los permisos no dependen del backend: los aplica Row Level Security dentro de Postgres, así que rigen
aunque la consulta llegue por otro camino. Las rutas privadas usan `Authorization: Bearer <token>`.

Rutas principales: `/api/auth`, `/api/listings`, `/api/favorites`, `/api/cart`, `/api/orders` y `/api/bookings`.

### Cambio de contraseña

Desde el modal de cuenta, o con "¿Olvidaste tu contraseña?" en el de acceso. Se envía un código al
correo y nada cambia hasta que la persona lo confirma.

El correo lo manda un SMTP propio, configurado en `.env`, y no el de Supabase: aquel es sólo para
pruebas y activarlo exige permisos de administrador en el dashboard. Es una conexión saliente, así
que funciona desde un equipo local sin servidor público ni dominio.

Para comprobar las credenciales antes de probar desde la página:

```bash
npm run test:smtp -- tu@correo.com
```

## Desarrollo

```bash
npm install
```

### El archivo `.env`

**No hay que configurarlo desde cero.** Las credenciales son del servidor, no de cada persona:
alguien del equipo ya las obtuvo una vez y el mismo archivo sirve para todos.

Pide el `.env` a quien montó el proyecto y déjalo en esta carpeta, junto a `package.json`. No hace
falta crear cuentas de correo ni tocar Google: eso ya está hecho.

Después comprueba que todo esté en orden:

```bash
npm run doctor
```

Te dice qué falta, si es que falta algo. Cuando salga «Todo listo»:

```bash
npm run dev
```

Sólo si vas a montar el proyecto por primera vez y no existe ningún `.env`, copia `.env.example`
y sigue las indicaciones que trae dentro.

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
