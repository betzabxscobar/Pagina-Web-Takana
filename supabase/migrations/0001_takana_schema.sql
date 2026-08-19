-- TAKANA - Esquema Postgres para Supabase
-- Migracion desde SQLite (data/takana.sqlite).
--
-- Modelo de roles:
--   invitado   -> visitante SIN cuenta. No existe fila en profiles.
--   usuario    -> unico rol que se asigna al registrarse. Siempre.
--   admin      -> solo lo asigna un superadmin. Nunca el registro publico.
--   superadmin -> solo lo asigna otro superadmin. Nunca el registro publico.

create extension if not exists citext;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.app_role as enum ('invitado', 'usuario', 'admin', 'superadmin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.listing_category as enum ('juego', 'software', 'servicio');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.booking_status as enum ('pendiente', 'confirmada', 'completada', 'cancelada');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.order_status as enum ('confirmado', 'enviado', 'completado', 'cancelado');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- profiles: reemplaza la tabla users de SQLite.
-- Las credenciales ya NO viven aqui, las maneja Supabase Auth (auth.users).
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) >= 2),
  email        citext not null unique,
  role         public.app_role not null default 'usuario',
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  -- 'invitado' es un rol calculado, nunca se almacena.
  constraint profiles_role_no_invitado check (role <> 'invitado')
);

-- ---------------------------------------------------------------------------
-- listings
-- ---------------------------------------------------------------------------
create table if not exists public.listings (
  id                   bigint generated always as identity primary key,
  slug                 text not null unique,
  title                text not null check (char_length(trim(title)) >= 3),
  description          text not null check (char_length(trim(description)) >= 12),
  category             public.listing_category not null,
  price_cents          integer not null default 0 check (price_cents >= 0),
  publisher            text not null default 'TAKANA Studio',
  cover_key            text not null default 'default',
  featured             boolean not null default false,
  published            boolean not null default true,
  owner_user_id        uuid references public.profiles(id) on delete set null,
  download_filename    text,
  download_storage_key text,
  download_size        bigint check (download_size is null or download_size > 0),
  download_mime        text,
  created_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- favorites y cart_items: clave primaria compuesta, igual que en SQLite.
-- ---------------------------------------------------------------------------
create table if not exists public.favorites (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  listing_id bigint not null references public.listings(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, listing_id)
);

create table if not exists public.cart_items (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  listing_id bigint not null references public.listings(id) on delete cascade,
  quantity   integer not null default 1 check (quantity > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, listing_id)
);

-- ---------------------------------------------------------------------------
-- orders / order_items
-- order_items conserva title y unit_price_cents como copia historica:
-- si el listing cambia de precio o se borra, el pedido no se altera.
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete restrict,
  total_cents integer not null check (total_cents >= 0),
  status      public.order_status not null default 'confirmado',
  created_at  timestamptz not null default now()
);

create table if not exists public.order_items (
  id               bigint generated always as identity primary key,
  order_id         bigint not null references public.orders(id) on delete cascade,
  listing_id       bigint references public.listings(id) on delete set null,
  title            text not null,
  unit_price_cents integer not null check (unit_price_cents >= 0),
  quantity         integer not null check (quantity > 0)
);

-- ---------------------------------------------------------------------------
-- bookings: user_id es nullable porque un invitado puede agendar sin cuenta.
-- ---------------------------------------------------------------------------
create table if not exists public.bookings (
  id             bigint generated always as identity primary key,
  listing_id     bigint not null references public.listings(id),
  user_id        uuid references public.profiles(id) on delete set null,
  customer_name  text not null check (char_length(trim(customer_name)) >= 2),
  customer_email citext not null,
  scheduled_date date not null,
  notes          text not null default '',
  status         public.booking_status not null default 'pendiente',
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indices
-- ---------------------------------------------------------------------------
create index if not exists idx_listings_category_published on public.listings (category, published);
create index if not exists idx_listings_owner              on public.listings (owner_user_id);
create index if not exists idx_bookings_listing_id         on public.bookings (listing_id);
create index if not exists idx_bookings_user_id            on public.bookings (user_id);
create index if not exists idx_orders_user_id              on public.orders (user_id, created_at);
create index if not exists idx_order_items_order_id        on public.order_items (order_id);
