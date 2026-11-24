// Lógica pura del feed: recibe los datos de Shopify y devuelve el XML.
// No hace llamadas de red ni lee secretos, así se puede probar sin token.

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5000;
const MAX_ADDITIONAL_IMAGES = 10;
const MAX_ID_LENGTH = 100;

// ---------- utilidades de texto ----------

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', iexcl: '¡', iquest: '¿',
  ordf: 'ª', ordm: 'º', deg: '°', middot: '·', bull: '•', hellip: '…',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', times: '×',
  euro: '€', cent: '¢', pound: '£',
};

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return ''; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, code) ? NAMED_ENTITIES[code] : match;
  });
}

export function htmlToText(html) {
  if (!html) return '';
  const text = String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// Quita caracteres que no son válidos en XML 1.0 (controles, surrogates sueltos).
function stripInvalidXmlChars(text) {
  return text.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  );
}

export function escapeXml(value) {
  return stripInvalidXmlChars(String(value))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max - 1).join('').trimEnd() + '…';
}

export function numericId(gid) {
  const match = /\/(\d+)$/.exec(String(gid || ''));
  return match ? match[1] : null;
}

// "12999.5" -> "12999.50 ARS". Devuelve null si no es un precio válido.
export function formatPrice(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${n.toFixed(2)} ${currency}`;
}

function isHttpsUrl(url) {
  return typeof url === 'string' && url.startsWith('https://');
}

// ---------- lectura del resultado de la Bulk Operation (JSONL) ----------

// Arma la lista de productos con sus variantes e imágenes a partir de las
// líneas JSONL (cada hijo trae __parentId apuntando a su producto).
export function assembleProducts(lines) {
  const products = new Map();
  const orphans = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const obj = JSON.parse(line);
    const id = String(obj.id || '');
    if (!obj.__parentId) {
      if (id.startsWith('gid://shopify/Product/')) {
        products.set(id, { ...obj, variants: [], images: [] });
      }
      continue;
    }
    const parent = products.get(obj.__parentId);
    if (!parent) { orphans.push(obj); continue; }
    if (id.startsWith('gid://shopify/ProductVariant/')) parent.variants.push(obj);
    else if (obj.image && obj.image.url) parent.images.push(obj.image.url);
  }
  // Por si alguna línea hija llegó antes que su producto.
  for (const obj of orphans) {
    const parent = products.get(obj.__parentId);
    if (!parent) continue;
    if (String(obj.id || '').startsWith('gid://shopify/ProductVariant/')) parent.variants.push(obj);
    else if (obj.image && obj.image.url) parent.images.push(obj.image.url);
  }
  return [...products.values()];
}

// ---------- reglas de negocio ----------

function isInStock(variant) {
  if (variant.availableForSale !== true) return false;
  const tracked = variant.inventoryItem ? variant.inventoryItem.tracked : true;
  if (tracked === false) return true; // stock no controlado: confiamos en availableForSale
  return Number(variant.inventoryQuantity) > 0;
}

export function buildItems(products, { storeUrl, currency }) {
  const stats = {
    productsRead: products.length,
    variantsRead: 0,
    exported: 0,
    excluded: { not_active: 0, not_published: 0, no_image: 0, price_zero: 0, out_of_stock: 0 },
    emptySkus: 0,
    duplicateSkus: [],
    skuTooLong: 0,
  };
  const base = storeUrl.replace(/\/+$/, '');
  const candidates = [];

  for (const product of products) {
    const variants = product.variants || [];
    stats.variantsRead += variants.length;
    const reasonForAll =
      product.status && product.status !== 'ACTIVE' ? 'not_active'
      : !product.onlineStoreUrl ? 'not_published' // solo lo publicado en la tienda online
      : !(product.images || []).some(isHttpsUrl) ? 'no_image'
      : null;
    if (reasonForAll) { stats.excluded[reasonForAll] += variants.length; continue; }

    const hasVariants = variants.length > 1;
    const images = product.images.filter(isHttpsUrl);
    const description = truncate(htmlToText(product.descriptionHtml) || product.title || '', MAX_DESCRIPTION);

    for (const variant of variants) {
      const regular = Number(variant.price);
      if (!(regular > 0)) { stats.excluded.price_zero++; continue; }
      if (!isInStock(variant)) { stats.excluded.out_of_stock++; continue; }

      const compareAt = Number(variant.compareAtPrice);
      const onSale = Number.isFinite(compareAt) && compareAt > regular;
      const variantId = numericId(variant.id);
      const variantTitle = variant.title && variant.title !== 'Default Title' ? variant.title : '';
      const title = hasVariants && variantTitle ? `${product.title} - ${variantTitle}` : product.title;

      candidates.push({
        sku: (variant.sku || '').trim(),
        variantId,
        groupId: hasVariants ? numericId(product.id) : null,
        title: truncate(title || '', MAX_TITLE),
        description,
        link: `${base}/products/${encodeURIComponent(product.handle)}?variant=${variantId}`,
        image: images[0],
        additionalImages: images.slice(1, 1 + MAX_ADDITIONAL_IMAGES),
        price: formatPrice(onSale ? compareAt : regular, currency),
        salePrice: onSale ? formatPrice(regular, currency) : null,
        brand: product.vendor || '',
        productType: product.productType || '',
      });
    }
  }

  // id = SKU si existe y es único; si no, ID numérico de la variante.
  const skuCount = new Map();
  for (const c of candidates) if (c.sku) skuCount.set(c.sku, (skuCount.get(c.sku) || 0) + 1);
  stats.duplicateSkus = [...skuCount].filter(([, n]) => n > 1).map(([sku, n]) => ({ sku, count: n }));

  const items = candidates.map((c) => {
    let id = c.variantId;
    if (!c.sku) stats.emptySkus++;
    else if (c.sku.length > MAX_ID_LENGTH) stats.skuTooLong++;
    else if (skuCount.get(c.sku) === 1) id = c.sku;
    return { ...c, id };
  });

  stats.exported = items.length;
  return { items, stats };
}

// ---------- XML ----------

function tag(name, value) {
  return value ? `      <g:${name}>${escapeXml(value)}</g:${name}>\n` : '';
}

export function renderXml(items, { storeUrl, title, description, buildDate = new Date() }) {
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n';
  out += '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n';
  out += '  <channel>\n';
  out += `    <title>${escapeXml(title)}</title>\n`;
  out += `    <link>${escapeXml(storeUrl)}</link>\n`;
  out += `    <description>${escapeXml(description)}</description>\n`;
  out += `    <lastBuildDate>${buildDate.toUTCString()}</lastBuildDate>\n`;
  for (const it of items) {
    out += '    <item>\n';
    out += tag('id', it.id);
    out += tag('item_group_id', it.groupId);
    out += tag('title', it.title);
    out += tag('description', it.description);
    out += tag('link', it.link);
    out += tag('image_link', it.image);
    for (const img of it.additionalImages) out += tag('additional_image_link', img);
    out += tag('availability', 'in stock');
    out += tag('condition', 'new');
    out += tag('price', it.price);
    out += tag('sale_price', it.salePrice);
    out += tag('brand', it.brand);
    out += tag('product_type', it.productType);
    out += '    </item>\n';
  }
  out += '  </channel>\n</rss>\n';
  return out;
}
