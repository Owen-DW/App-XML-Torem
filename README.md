# App-XML-Torem

Robot que genera, **cada 1 hora y solo**, el catálogo de productos de Monococo en formato **feed de Meta** (RSS 2.0 XML) y lo publica en una URL fija para cargar en Torem.

- **URL del feed:** `https://owen-dw.github.io/App-XML-Torem/catalogo.xml`
  (la URL exacta aparece en cada corrida, en el paso *deploy*. Usá esa.)
- **Qué incluye:** productos activos, publicados en la tienda online (no los de otros canales, como mayorista), con stock, con imagen y con precio mayor a 0.
- **Qué NO incluye:** borradores, archivados, sin stock, sin foto o con precio 0.

## Cómo funciona

```
Shopify (solo lectura) ──> GitHub Actions cada 1 h ──> catalogo.xml ──> GitHub Pages ──> Torem
```

1. GitHub Actions se despierta cada 1 hora (GitHub puede atrasar o saltear algún turno en horarios de mucha demanda).
2. Le pide a Shopify una exportación completa del catálogo (Bulk Operation: una sola consulta, sin límite de páginas).
3. Filtra, arma el XML y lo valida.
4. Si todo salió bien, lo publica. **Si algo falla, no publica nada y queda online la última versión buena.**
5. Si salen menos de 1.000 productos (algo raro pasó), tampoco publica. Ese mínimo se cambia con la variable `MIN_ITEMS`.

## Puesta en marcha (una sola vez)

### 1. Crear la app de Shopify (solo lectura)
En el admin de Shopify: *Configuración → Apps → Desarrollar apps*. Si Shopify te redirige al **Dev Dashboard**, creala ahí.

- Permisos (scopes): **solo** `read_products` y `read_inventory`. Ninguno de escritura.
- Según dónde la crees, vas a obtener una de estas dos cosas:
  - **Un token fijo** (empieza con `shpat_`) → guardalo como `SHOPIFY_ADMIN_TOKEN`.
  - **Un Client ID y un Client secret** → guardalos como `SHOPIFY_CLIENT_ID` y `SHOPIFY_CLIENT_SECRET`. El robot pide un token temporal en cada corrida.

### 2. Guardar la credencial en GitHub
Repo → *Settings → Secrets and variables → Actions → New repository secret*.
Nunca la pegues en un archivo, un issue, un commit ni un chat.

### 3. Activar GitHub Pages
Repo → *Settings → Pages → Source: **GitHub Actions***.
(El plan gratis de GitHub exige que el repo sea **público**. Antes, mirá la sección *Seguridad*.)

### 4. Primera corrida
Repo → *Actions → Feed XML Monococo → Run workflow*.

## Tareas comunes

### Correrlo a mano
*Actions → Feed XML Monococo → Run workflow.*

En una computadora (con Node 20 o superior):
```bash
# Pide el token sin mostrarlo en pantalla ni guardarlo en el historial
read -rs SHOPIFY_ADMIN_TOKEN && export SHOPIFY_ADMIN_TOKEN && npm run build
```
Otras opciones: `npm test` (pruebas sin conexión) y `npm run build:sample` (feed de ejemplo con datos ficticios).
Nunca escribas el token directo en el comando (`SHOPIFY_ADMIN_TOKEN=shpat_... npm run build`): queda guardado en el historial de la terminal.

### Cambiar la frecuencia
En `.github/workflows/feed.yml`, línea `cron`:
- Cada 1 h: `'17 * * * *'` (actual)
- Cada 3 h: `'17 */3 * * *'`

**Antes de una difusión grande**, conviene correrlo a mano (*Run workflow*) y esperar unos 5 minutos, para mandar con el stock al día.

El horario está en UTC. Ojo: GitHub puede atrasar unos minutos las corridas programadas.

### Rotar (cambiar) la credencial
Hacelo si sospechás que se filtró, si alguien con acceso deja la empresa o una vez por año como rutina.
1. En Shopify, en la app: **revocá / regenerá** el token (o el client secret). El anterior deja de funcionar al instante.
2. En GitHub: *Settings → Secrets → Actions* → editá el secreto con el valor nuevo.
3. Corré el workflow a mano y fijate que termine en verde.

### Ver qué pasó en una corrida
*Actions →* elegí la corrida. En el resumen vas a ver: productos leídos, ítems exportados, excluidos por motivo (sin stock, sin imagen, precio 0) y SKUs vacíos o duplicados.

### Variables opcionales
En *Settings → Secrets and variables → Actions → Variables* (no son secretas):

| Variable | Valor por defecto |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | `jugueterias-monococo.myshopify.com` |
| `SHOPIFY_API_VERSION` | `2026-10` |
| `PUBLIC_STORE_URL` | `https://monococojugueterias.com` |
| `FEED_CURRENCY` | `ARS` |
| `MIN_ITEMS` | `1000` |

## Reglas del feed

| Campo | De dónde sale |
|---|---|
| `g:id` | SKU de la variante si existe y no se repite; si no, el ID de la variante |
| `g:item_group_id` | ID del producto (solo si tiene varias variantes) |
| `g:title` | Título del producto (+ nombre de la variante si tiene varias) |
| `g:description` | Descripción sin HTML, máximo 5.000 caracteres; si está vacía, el título |
| `g:link` | `https://monococojugueterias.com/products/{handle}?variant={id}` |
| `g:image_link` / `g:additional_image_link` | Imagen principal + hasta 10 más |
| `g:price` / `g:sale_price` | Si hay precio tachado mayor al precio: `price` = tachado y `sale_price` = precio actual |
| `g:brand` | Proveedor (vendor) de Shopify |
| `g:product_type` | Tipo de producto de Shopify |

Disponibilidad: se incluye una variante si está disponible para la venta **y** tiene stock mayor a 0. Si el inventario no se controla en Shopify, alcanza con que esté disponible para la venta.

## Seguridad

**Qué es público:** el código y el feed. El feed solo tiene lo que ya se ve en la tienda.
**Qué NO es público:** la credencial de Shopify, que vive solo en *GitHub Secrets*.

Medidas que ya trae el proyecto:
- La app de Shopify es de **solo lectura**: aunque alguien obtuviera la credencial, no podría modificar nada en la tienda.
- La credencial solo se envía al dominio `*.myshopify.com` configurado, nunca sigue redirecciones y nunca se imprime en los registros (GitHub además la tapa con `***`).
- El workflow arranca **sin permisos** y cada paso pide el mínimo necesario.
- Las acciones de GitHub están fijadas a una versión exacta (hash), así nadie puede cambiarlas por detrás. Dependabot avisa cuando hay versiones nuevas.
- El workflow no se dispara con pull requests de terceros, así que nadie de afuera puede ejecutarlo ni leer los secretos.
- Cero dependencias externas (solo Node), así que no hay paquetes de terceros que puedan venir comprometidos.
- `.gitignore` bloquea archivos `.env` y de claves.

Para activar en GitHub (*Settings → Code security*), si el repo es público:
- **Secret scanning** y **Push protection**: bloquean un commit si detectan una clave por error.
- *Settings → Actions → General*: "Fork pull request workflows" → **Require approval for all outside collaborators**.
- *Settings → Environments → github-pages*: en "Deployment branches" dejá **solo `main`**, así nadie puede publicar desde otra rama.

**Si se filtró una credencial:** rotala ya (ver arriba). Borrar el commit no alcanza: la clave tiene que quedar invalidada.
