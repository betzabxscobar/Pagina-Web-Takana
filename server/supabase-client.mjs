/**
 * Fabricas de clientes de Supabase para el backend.
 *
 * La idea central de la migracion: el backend NO consulta con la service_role
 * salvo en las pocas operaciones que de verdad la necesitan. Para todo lo demas
 * reenvia el token del usuario, de modo que las politicas RLS de Postgres son
 * las que deciden que puede ver y modificar cada quien.
 *
 * Si el backend usara service_role para todo, RLS quedaria anulada y la
 * seguridad volveria a depender de que ninguna ruta de Express se olvide de un
 * chequeo, que es justamente lo que la migracion busca eliminar.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE;

if (!url || !anonKey) {
  throw new Error("Faltan SUPABASE_URL y SUPABASE_ANON_KEY en el entorno.");
}

const options = { auth: { persistSession: false, autoRefreshToken: false } };

/**
 * Cliente con la identidad del visitante sin sesion.
 * En Postgres entra como rol `anon`, es decir: invitado.
 */
export const guestClient = createClient(url, anonKey, options);

/**
 * Cliente que actua EN NOMBRE del usuario dueno del token.
 * Todas las consultas pasan por RLS con su rol real.
 */
export function clientForToken(accessToken) {
  if (!accessToken) return guestClient;
  return createClient(url, anonKey, {
    ...options,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * Cliente anonimo nuevo y aislado, para operaciones de auth que necesitan
 * arrastrar una sesion entre dos llamadas (verificar un codigo y despues
 * cambiar la contrasena).
 *
 * No sirve reutilizar guestClient ni clientForToken para esto:
 * - guestClient es compartido por todo el proceso, y dejar una sesion pegada
 *   en el haria que dos peticiones simultaneas se pisaran.
 * - clientForToken pone el token como cabecera HTTP, que basta para consultar
 *   tablas, pero los metodos de auth leen la sesion guardada en la instancia
 *   y no esa cabecera.
 */
export function isolatedAuthClient() {
  return createClient(url, anonKey, options);
}

/**
 * Cliente administrativo. IGNORA RLS por completo.
 *
 * Reservado para lo que no puede hacerse de otra forma: crear cuentas y
 * asignar roles mediante la Admin API de Auth. Nunca debe usarse para atender
 * una peticion normal del usuario.
 */
export function adminClient() {
  if (!serviceRoleKey) {
    throw new Error("Esta operacion requiere SUPABASE_SERVICE_ROLE en el entorno del servidor.");
  }
  return createClient(url, serviceRoleKey, options);
}

export const hasServiceRole = Boolean(serviceRoleKey);

/**
 * Resuelve el usuario dueno de un token y su perfil (rol incluido).
 * Devuelve null si el token es invalido, expiro o la cuenta esta desactivada.
 */
export async function resolveUser(accessToken) {
  if (!accessToken) return null;

  const client = clientForToken(accessToken);
  const { data: auth, error: authError } = await client.auth.getUser();
  if (authError || !auth?.user) return null;

  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("id, display_name, email, role, active")
    .eq("id", auth.user.id)
    .single();

  if (profileError || !profile || !profile.active) return null;

  return {
    id: profile.id,
    name: profile.display_name,
    email: profile.email,
    role: profile.role,
    active: profile.active,
  };
}

/** Traduce un error de PostgREST al mensaje que ya esperaba el frontend. */
export function translateError(error, fallback = "No se pudo completar la operacion.") {
  if (!error) return null;
  // Las excepciones que lanzan nuestras funciones y triggers ya vienen en
  // espanol y son seguras de mostrar.
  if (error.message && !error.message.startsWith("JWT")) return error.message;
  if (error.code === "42501" || error.code === "PGRST301") {
    return "No tienes permiso para hacer esto.";
  }
  return fallback;
}
