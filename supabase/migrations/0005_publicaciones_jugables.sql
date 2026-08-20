-- TAKANA - Publicaciones que se juegan dentro de la web.
--
-- Hasta ahora una publicacion solo podia comprarse o descargarse. TAKABLOX se
-- juega en el navegador, asi que necesita una forma de decir "esto se abre,
-- no se descarga". play_url guarda a donde apunta ese boton.
--
-- Se hace con una columna y no comparando el slug en el frontend para que
-- sirva a cualquier juego web que publiquen despues, sin tocar codigo.

alter table public.listings
  add column if not exists play_url text;

comment on column public.listings.play_url is
  'Ruta del juego jugable en el navegador. NULL en publicaciones normales.';

-- ---------------------------------------------------------------------------
-- TAKABLOX en el catalogo.
-- Idempotente: si se vuelve a ejecutar actualiza en lugar de duplicar.
-- ---------------------------------------------------------------------------
insert into public.listings
  (slug, title, description, category, price_cents, publisher, cover_key, featured, published, play_url)
values (
  'takablox',
  'TAKABLOX',
  'El Tetris de TAKANA, creado por el equipo. Se juega aqui mismo en el navegador, sin descargar ni instalar nada.',
  'juego',
  0,
  'TAKANA Studio',
  'takablox',
  true,
  true,
  '/takablox/index.html'
)
on conflict (slug) do update set
  title       = excluded.title,
  description = excluded.description,
  category    = excluded.category,
  price_cents = excluded.price_cents,
  publisher   = excluded.publisher,
  cover_key   = excluded.cover_key,
  featured    = excluded.featured,
  published   = excluded.published,
  play_url    = excluded.play_url;
