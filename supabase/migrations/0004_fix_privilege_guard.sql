-- TAKANA - Corrige el candado anti-escalada de privilegios.
--
-- BUG: is_service_connection() decidia con current_user. Como
-- guard_profile_privileges() es SECURITY DEFINER, dentro de esa funcion
-- current_user es siempre el dueno (postgres), no quien hizo la peticion.
-- El resultado era que TODA actualizacion parecia venir del backend y el
-- candado se saltaba: cualquier usuario podia asignarse el rol superadmin
-- con un simple PATCH sobre su propia fila de profiles.
--
-- SECURITY DEFINER cambia el usuario efectivo, pero NO toca los parametros
-- de la peticion. Por eso la identidad real se lee del JWT, que PostgREST
-- deja en request.jwt.claims y sobrevive al cambio de dueno.

create or replace function public.is_service_connection()
returns boolean
language sql stable
as $fn$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  ) in (
    'service_role',  -- backend con la llave de servicio
    ''               -- sin JWT: conexion directa (SQL Editor, psql, migraciones)
  );
$fn$;

-- El resto de la funcion no cambia; se recrea solo para dejar el archivo
-- autocontenido y poder reaplicarlo sin depender del 0002.
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

-- NOTA: no se revoca el permiso de ejecucion de current_app_role() ni de
-- is_staff() al rol anon. La politica listings_select_public aplica a anon y
-- llama a is_staff(); si anon no pudiera ejecutarla, la evaluacion de la
-- politica fallaria y el catalogo publico dejaria de verse por completo.
-- Ninguna de las dos filtra informacion: a un visitante sin sesion le
-- responden 'invitado' y false sobre si mismo.
