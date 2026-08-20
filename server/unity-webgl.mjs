/**
 * Cabeceras para la compilación WebGL de TAKABLOX.
 *
 * Unity exporta el juego comprimido en Brotli: el cargador pide directamente
 * Build/Web.data.br, Web.wasm.br y Web.framework.js.br. El navegador sólo los
 * descomprime si la respuesta trae `Content-Encoding: br`; sin esa cabecera
 * recibe datos comprimidos creyendo que son el archivo final y el juego falla
 * al arrancar.
 *
 * Ni el servidor de desarrollo de Vite ni express.static ponen esa cabecera por
 * su cuenta, así que hay que añadirla a mano. El mismo criterio se usa en los
 * dos entornos para que el juego no se comporte distinto en desarrollo.
 */

/** Tipo real del archivo, mirando la extensión que queda bajo la de compresión. */
function tipoBase(ruta) {
  const sinComprimir = ruta.replace(/\.(br|gz)$/, "");
  if (sinComprimir.endsWith(".wasm")) return "application/wasm";
  if (sinComprimir.endsWith(".js")) return "application/javascript";
  if (sinComprimir.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

/** Devuelve las cabeceras que corresponden, o null si el archivo no va comprimido. */
export function cabecerasUnity(ruta) {
  if (ruta.endsWith(".br")) {
    return { "Content-Encoding": "br", "Content-Type": tipoBase(ruta) };
  }
  if (ruta.endsWith(".gz")) {
    return { "Content-Encoding": "gzip", "Content-Type": tipoBase(ruta) };
  }
  // Una compilación sin comprimir sigue necesitando el tipo correcto: los
  // navegadores rechazan instanciar WebAssembly servido como octet-stream.
  if (ruta.endsWith(".wasm")) return { "Content-Type": "application/wasm" };
  return null;
}

/** Middleware para Express y para el servidor de desarrollo de Vite. */
export function servirUnityWebGL(request, response, next) {
  const ruta = (request.url || "").split("?")[0];
  if (ruta.startsWith("/takablox/")) {
    const cabeceras = cabecerasUnity(ruta);
    if (cabeceras) {
      for (const [nombre, valor] of Object.entries(cabeceras)) response.setHeader(nombre, valor);
    }
  }
  next();
}
