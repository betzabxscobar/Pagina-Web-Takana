-- TAKANA - Roles, proteccion contra escalada de privilegios y RLS.

-- ---------------------------------------------------------------------------
-- Helpers de rol.
-- SECURITY DEFINER para que las politicas puedan consultarlos sin caer en
-- recursion infinita contra las propias politicas de profiles.
-- ---------------------------------------------------------------------------
create or replace function public.current_app_role()
returns public.app_role
language sql stable security definer set search_path = public
as $fn$
  select coalesce(
    (select p.role from public.profiles p where p.id = auth.uid() and p.active),
    'invitado'::public.app_role
  );
$fn$;

create or replace function public.is_superadmin()
returns boolean
language sql stable security definer set search_path = public
as $fn$ select public.current_app_role() = 'superadmin'; $fn$;

-- "staff" = admin o superadmin.
create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $fn$ select public.current_app_role() in ('admin', 'superadmin'); $fn$;

-- Conexiones privilegiadas (service_role del backend, o el SQL Editor).
create or replace function public.is_service_connection()
returns boolean
language sql stable
as $fn$ select current_user in ('service_role', 'postgres', 'supabase_admin'); $fn$;

-- ---------------------------------------------------------------------------
-- Alta de usuarios.
-- El rol se fija SIEMPRE en 'usuario'. Se ignora a proposito cualquier rol que
-- venga en la metadata del cliente: registrarse nunca puede dar admin ni
-- superadmin. Esos roles solo los otorga un superadmin ya existente.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $fn$
begin
  insert into public.profiles (id, display_name, email, role)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
      split_part(new.email, '@', 1)
    ),
    new.email,
    'usuario'
  )
  on conflict (id) do nothing;
  return new;
end;
$fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Candado anti-escalada.
-- Nadie puede cambiarse el rol ni reactivarse a si mismo. Solo un superadmin
-- (o el backend con service_role) puede tocar role y active.
-- Esto cierra el hueco que dejaria una politica UPDATE sobre la propia fila.
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql security definer set search_path = public
as $fn$
begin
  if public.is_service_connection() then
    return new;
  end if;

  if new.role is distinct from old.role or new.active is distinct from old.active then
    if not public.is_superadmin() then
      raise exception 'Solo un superadministrador puede cambiar el rol o el estado de una cuenta.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if new.id is distinct from old.id or new.email is distinct from old.email then
    raise exception 'El identificador y el correo de una cuenta no se modifican aqui.'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$fn$;

drop trigger if exists guard_profile_privileges on public.profiles;
create trigger guard_profile_privileges
  before update on public.profiles
  for each row execute function public.guard_profile_privileges();

-- ---------------------------------------------------------------------------
-- Debe quedar siempre al menos un superadmin activo.
-- Misma regla que ya existia en updateManagedUser() de SQLite.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_last_superadmin()
returns trigger
language plpgsql security definer set search_path = public
as $fn$
declare
  restantes integer;
begin
  if old.role = 'superadmin' and (new.role <> 'superadmin' or not new.active) then
    select count(*) into restantes
      from public.profiles
     where role = 'superadmin' and active and id <> old.id;
    if restantes = 0 then
      raise exception 'Debe permanecer al menos un superadministrador activo.';
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists ensure_last_superadmin on public.profiles;
create trigger ensure_last_superadmin
  before update on public.profiles
  for each row execute function public.ensure_last_superadmin();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles    enable row level security;
alter table public.listings    enable row level security;
alter table public.favorites   enable row level security;
alter table public.cart_items  enable row level security;
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;
alter table public.bookings    enable row level security;

-- profiles ------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_staff());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_superadmin())
  with check (id = auth.uid() or public.is_superadmin());

-- Sin politicas INSERT ni DELETE a proposito: las cuentas solo nacen por el
-- trigger on_auth_user_created, y se desactivan con active = false.

-- listings ------------------------------------------------------------------
-- El invitado (rol anon, sin sesion) SOLO ve publicaciones publicadas.
drop policy if exists listings_select_public on public.listings;
create policy listings_select_public on public.listings for select to anon, authenticated
  using (published or owner_user_id = auth.uid() or public.is_staff());

drop policy if exists listings_insert_own on public.listings;
create policy listings_insert_own on public.listings for insert to authenticated
  with check (auth.uid() is not null and owner_user_id = auth.uid());

drop policy if exists listings_update on public.listings;
create policy listings_update on public.listings for update to authenticated
  using (owner_user_id = auth.uid() or public.is_staff())
  with check (owner_user_id = auth.uid() or public.is_staff());

drop policy if exists listings_delete on public.listings;
create policy listings_delete on public.listings for delete to authenticated
  using (public.is_superadmin());

-- favorites y cart_items: estrictamente propios ------------------------------
drop policy if exists favorites_own on public.favorites;
create policy favorites_own on public.favorites for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists cart_items_own on public.cart_items;
create policy cart_items_own on public.cart_items for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- orders --------------------------------------------------------------------
drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders for select to authenticated
  using (user_id = auth.uid() or public.is_staff());

drop policy if exists orders_insert_own on public.orders;
create policy orders_insert_own on public.orders for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists orders_update_staff on public.orders;
create policy orders_update_staff on public.orders for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists orders_delete_superadmin on public.orders;
create policy orders_delete_superadmin on public.orders for delete to authenticated
  using (public.is_superadmin());

-- order_items: se cuelgan de la orden ---------------------------------------
drop policy if exists order_items_select on public.order_items;
create policy order_items_select on public.order_items for select to authenticated
  using (exists (
    select 1 from public.orders o
     where o.id = order_id and (o.user_id = auth.uid() or public.is_staff())
  ));

drop policy if exists order_items_insert on public.order_items;
create policy order_items_insert on public.order_items for insert to authenticated
  with check (exists (
    select 1 from public.orders o where o.id = order_id and o.user_id = auth.uid()
  ));

-- bookings ------------------------------------------------------------------
-- Un invitado SI puede agendar soporte sin cuenta, pero solo contra un
-- servicio publicado, y sin poder atribuir la cita a otro usuario.
drop policy if exists bookings_insert on public.bookings;
create policy bookings_insert on public.bookings for insert to anon, authenticated
  with check (
    (user_id is null or user_id = auth.uid())
    and exists (
      select 1 from public.listings l
       where l.id = listing_id and l.category = 'servicio' and l.published
    )
  );

drop policy if exists bookings_select on public.bookings;
create policy bookings_select on public.bookings for select to authenticated
  using (user_id = auth.uid() or public.is_staff());

drop policy if exists bookings_update_staff on public.bookings;
create policy bookings_update_staff on public.bookings for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists bookings_delete_superadmin on public.bookings;
create policy bookings_delete_superadmin on public.bookings for delete to authenticated
  using (public.is_superadmin());
