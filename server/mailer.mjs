/**
 * Envio de correo propio de TAKANA.
 *
 * No se usa el servidor de correo de Supabase: esta pensado solo para pruebas
 * (unos pocos envios por hora, y en varios planes unicamente a miembros del
 * proyecto) y configurarlo exige permisos de administrador en el dashboard,
 * que el equipo no tiene. Con un SMTP propio el envio queda bajo control de
 * quien despliega la app, no de quien administra la cuenta de Supabase.
 *
 * Funciona con cualquier proveedor SMTP: Gmail con contrasena de aplicacion,
 * Brevo, Resend, Mailgun, el que sea.
 */
import nodemailer from "nodemailer";

const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT || 587);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASSWORD;
const from = process.env.SMTP_FROM || user;

export const mailerConfigured = Boolean(host && user && pass);

const transport = mailerConfigured
  ? nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // 465 exige TLS directo; 587 negocia con STARTTLS.
      auth: { user, pass },
    })
  : null;

/**
 * Envia el codigo de verificacion para cambiar la contrasena.
 *
 * Si el correo no sale, la funcion lanza. Es deliberado: nunca debe existir
 * un camino donde el codigo se entregue por otro medio o se omita la
 * verificacion, porque eso permitiria tomar la cuenta de cualquiera.
 */
export async function sendPasswordCode(email, code, displayName = "") {
  if (!transport) {
    throw new Error("El envío de correo no está configurado en el servidor. Avisa al administrador.");
  }

  const saludo = displayName ? `Hola ${displayName},` : "Hola,";

  await transport.sendMail({
    from: `TAKANA <${from}>`,
    to: email,
    subject: `${code} es tu código para cambiar la contraseña`,
    text: [
      saludo,
      "",
      `Tu código de verificación para cambiar la contraseña de TAKANA es: ${code}`,
      "",
      "El código vence en una hora y sólo puede usarse una vez.",
      "Si tú no pediste este cambio, ignora este mensaje: tu contraseña actual sigue funcionando.",
      "",
      "TAKANA",
    ].join("\n"),
    html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:460px;margin:0 auto;padding:32px 24px;color:#22263d">
        <h1 style="margin:0 0 4px;font-size:20px">Cambio de contraseña</h1>
        <p style="margin:0 0 24px;color:#6b7288;font-size:14px">${saludo} usa este código en TAKANA para confirmar el cambio.</p>
        <div style="padding:18px;border:1px solid #e0e4f1;border-radius:12px;background:#f8f9ff;text-align:center">
          <span style="font-size:30px;font-weight:800;letter-spacing:.16em">${code}</span>
        </div>
        <p style="margin:24px 0 0;color:#6b7288;font-size:13px;line-height:1.6">
          El código vence en una hora y sólo puede usarse una vez.<br>
          Si tú no pediste este cambio, ignora este mensaje: tu contraseña actual sigue funcionando.
        </p>
      </div>`.trim(),
  });
}
