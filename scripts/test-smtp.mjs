/**
 * Comprueba que el envio de correo funciona, sin tocar ninguna cuenta.
 *
 * Uso:  npm run test:smtp -- tu@correo.com
 *
 * Manda un mensaje de prueba con un codigo inventado. No consulta Supabase ni
 * cambia contrasenas: sirve para saber si las credenciales SMTP del archivo
 * .env estan bien antes de probar el flujo real desde la pagina.
 */
import { mailerConfigured, sendPasswordCode } from "../server/mailer.mjs";

const destino = process.argv[2];

if (!destino || !/^\S+@\S+\.\S+$/.test(destino)) {
  console.error("Indica a que correo enviar la prueba:\n  npm run test:smtp -- tu@correo.com");
  process.exit(1);
}

if (!mailerConfigured) {
  console.error([
    "Faltan credenciales SMTP.",
    "",
    "Copia .env.example a .env y rellena SMTP_HOST, SMTP_USER y SMTP_PASSWORD.",
    "El archivo .env esta ignorado por git, asi que no se sube al repositorio.",
  ].join("\n"));
  process.exit(1);
}

console.log(`Enviando correo de prueba a ${destino}...`);

try {
  await sendPasswordCode(destino, "123456", "Prueba");
  console.log([
    "",
    "Correo enviado.",
    "",
    "Revisa la bandeja de entrada y la carpeta de spam. Si llego, el cambio de",
    "contrasena desde la pagina ya funciona: usa el boton 'Cambiar contrasena'",
    "del modal de cuenta.",
  ].join("\n"));
} catch (error) {
  console.error([
    "",
    "No se pudo enviar: " + (error?.message || error),
    "",
    "Causas habituales:",
    "  - Gmail: hay que usar una contrasena de aplicacion, no la del correo,",
    "    y tener la verificacion en dos pasos activada en la cuenta de Google.",
    "  - Puerto: 587 para STARTTLS (lo normal) o 465 para TLS directo.",
    "  - SMTP_USER debe ser la direccion completa, con el dominio.",
  ].join("\n"));
  process.exit(1);
}
