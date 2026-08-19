-- TAKANA - Operaciones que deben ser atomicas.
--
-- PostgREST no expone transacciones de varias sentencias: cada peticion HTTP es
-- su propia transaccion. El checkout y el conteo del carrito por lo tanto NO
-- pueden armarse con llamadas sueltas desde el backend sin abrir condiciones de
-- carrera. Se resuelven aqui, donde Postgres si garantiza atomicidad.
--
-- Todas son SECURITY INVOKER a proposito: corren con los permisos de quien
-- llama, asi que las politicas RLS siguen aplicando dentro de la funcion.

-- ---------------------------------------------------------------------------
-- Carrito
-- ---------------------------------------------------------------------------
create or replace function public.add_cart_item(p_listing_id bigint)
returns void
language plpgsql security invoker set search_path = public
as $fn$
begin
  if auth.uid() is null then
    raise exception 'Inicia sesion para usar el carrito.';
  end if;

  if not exists (
    select 1 from public.listings where id = p_listing_id and published
  ) then
    raise exception 'La publicacion seleccionada no esta disponible.';
  end if;

  insert into public.cart_items (user_id, listing_id, quantity)
  values (auth.uid(), p_listing_id, 1)
  on conflict (user_id, listing_id) do update
    set quantity = public.cart_items.quantity + 1,
        updated_at = now();
end;
$fn$;

-- Baja una unidad; si era la ultima, elimina la linea.
create or replace function public.remove_cart_item(p_listing_id bigint)
returns void
language plpgsql security invoker set search_path = public
as $fn$
begin
  if auth.uid() is null then
    raise exception 'Inicia sesion para usar el carrito.';
  end if;

  update public.cart_items
     set quantity = quantity - 1, updated_at = now()
   where user_id = auth.uid() and listing_id = p_listing_id and quantity > 1;

  if not found then
    delete from public.cart_items
     where user_id = auth.uid() and listing_id = p_listing_id;
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Checkout
-- Equivale a checkoutTransaction() de database.mjs: crea la orden, copia las
-- lineas con el precio del momento y vacia el carrito, todo o nada.
-- ---------------------------------------------------------------------------
create or replace function public.checkout_cart()
returns table (id bigint, total_cents integer, status public.order_status)
language plpgsql security invoker set search_path = public
as $fn$
declare
  v_user  uuid := auth.uid();
  v_total integer;
  v_order bigint;
begin
  if v_user is null then
    raise exception 'Inicia sesion para comprar.';
  end if;

  select coalesce(sum(l.price_cents * c.quantity), 0)
    into v_total
    from public.cart_items c
    join public.listings l on l.id = c.listing_id
   where c.user_id = v_user and l.published;

  if not exists (
    select 1 from public.cart_items c
      join public.listings l on l.id = c.listing_id
     where c.user_id = v_user and l.published
  ) then
    raise exception 'El carrito esta vacio.';
  end if;

  insert into public.orders (user_id, total_cents)
  values (v_user, v_total)
  returning orders.id into v_order;

  -- title y unit_price_cents se copian: el pedido conserva lo que se pago
  -- aunque despues cambie el precio o se elimine la publicacion.
  insert into public.order_items (order_id, listing_id, title, unit_price_cents, quantity)
  select v_order, l.id, l.title, l.price_cents, c.quantity
    from public.cart_items c
    join public.listings l on l.id = c.listing_id
   where c.user_id = v_user and l.published;

  delete from public.cart_items where user_id = v_user;

  return query
    select o.id, o.total_cents, o.status
      from public.orders o
     where o.id = v_order;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Autorizacion de descarga
-- Replica getListingDownload(): puede descargar el dueno, el staff, cualquiera
-- si el precio es 0, o quien tenga una orden no cancelada con esa publicacion.
-- ---------------------------------------------------------------------------
create or replace function public.can_download_listing(p_listing_id bigint)
returns boolean
language plpgsql stable security invoker set search_path = public
as $fn$
declare
  v_listing public.listings%rowtype;
begin
  if auth.uid() is null then
    return false;
  end if;

  select * into v_listing
    from public.listings
   where id = p_listing_id and published;

  if not found or v_listing.download_storage_key is null then
    return false;
  end if;

  if v_listing.owner_user_id = auth.uid() or public.is_staff() then
    return true;
  end if;

  if v_listing.price_cents = 0 then
    return true;
  end if;

  return exists (
    select 1
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
     where o.user_id = auth.uid()
       and oi.listing_id = p_listing_id
       and o.status <> 'cancelado'
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Resumen del panel administrativo.
-- Una sola llamada en lugar de siete conteos sueltos.
-- ---------------------------------------------------------------------------
create or replace function public.admin_summary()
returns json
language sql stable security invoker set search_path = public
as $fn$
  select json_build_object(
    'users',           (select count(*) from public.profiles where active),
    'admins',          (select count(*) from public.profiles where active and role in ('admin','superadmin')),
    'listings',        (select count(*) from public.listings where published),
    'bookings',        (select count(*) from public.bookings),
    'pendingBookings', (select count(*) from public.bookings where status = 'pendiente'),
    'orders',          (select count(*) from public.orders),
    'salesCents',      (select coalesce(sum(total_cents), 0) from public.orders where status <> 'cancelado')
  );
$fn$;

-- Solo usuarios autenticados pueden invocarlas.
revoke all on function public.add_cart_item(bigint)        from public, anon;
revoke all on function public.remove_cart_item(bigint)     from public, anon;
revoke all on function public.checkout_cart()              from public, anon;
revoke all on function public.can_download_listing(bigint) from public, anon;
revoke all on function public.admin_summary()              from public, anon;

grant execute on function public.add_cart_item(bigint)        to authenticated;
grant execute on function public.remove_cart_item(bigint)     to authenticated;
grant execute on function public.checkout_cart()              to authenticated;
grant execute on function public.can_download_listing(bigint) to authenticated;
grant execute on function public.admin_summary()              to authenticated;
