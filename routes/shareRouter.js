const express = require('express');
const { ObjectId } = require('mongodb');
const connectDB = require('../utils/db');
const config = require('../config');

const router = express.Router();

const FRONTEND_BASE_URL = process.env.FRONTEND_URL || 'https://mocos.co.tz';
const DEFAULT_PREVIEW_IMG = `${FRONTEND_BASE_URL}/og-preview.png`;

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripTags(html) {
  if (!html) return '';
  return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function resolveImageUrl(img, folder) {
  if (!img) return DEFAULT_PREVIEW_IMG;
  if (img.startsWith('http://') || img.startsWith('https://')) return img;
  if (img.startsWith('/')) return `${FRONTEND_BASE_URL}${img}`;
  return `https://storage.googleapis.com/${config.GCS_BUCKET_NAME}/${folder}/${img}`;
}

function renderHtmlPreview({ title, description, imageUrl, canonicalUrl, redirectUrl, type = 'website' }) {
  const safeTitle = escapeHtml(title || 'Mocos - Expert Mobile Phone Repair & Tech Shop');
  const safeDesc = escapeHtml(description || "Tanzania's leading phone repair, spare parts, and tech centre.");
  const safeImage = escapeHtml(imageUrl || DEFAULT_PREVIEW_IMG);
  const safeCanonical = escapeHtml(canonicalUrl);
  const safeRedirect = escapeHtml(redirectUrl);

  return `<!DOCTYPE html>
<html lang="en" prefix="og: http://ogp.me/ns#">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle} | Mocos</title>
  <meta name="description" content="${safeDesc}">

  <!-- Open Graph / WhatsApp / Facebook -->
  <meta property="og:type" content="${escapeHtml(type)}">
  <meta property="og:site_name" content="Mocos Tech Tanzania">
  <meta property="og:url" content="${safeCanonical}">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDesc}">
  <meta property="og:image" content="${safeImage}">
  <meta property="og:image:secure_url" content="${safeImage}">
  <meta property="og:image:alt" content="${safeTitle}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:locale" content="en_TZ">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@mocos_tz">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDesc}">
  <meta name="twitter:image" content="${safeImage}">

  <!-- Instant Browser Redirect to Front-end Page -->
  <meta http-equiv="refresh" content="0;url=${safeRedirect}">
  <script>
    window.location.replace(${JSON.stringify(redirectUrl)});
  </script>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; text-align: center; }
    .card { max-width: 480px; width: 100%; background: #1e293b; border: 1px solid #334155; border-radius: 20px; padding: 28px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    img { width: 100%; max-height: 240px; object-fit: cover; border-radius: 12px; margin-bottom: 16px; }
    h1 { font-size: 1.25rem; font-weight: 800; margin: 0 0 10px; color: #f8fafc; }
    p { font-size: 0.9rem; color: #94a3b8; line-height: 1.5; margin: 0 0 20px; }
    a.btn { display: inline-block; padding: 12px 28px; background: #dc2626; color: #fff; font-weight: 700; text-decoration: none; border-radius: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <img src="${safeImage}" alt="${safeTitle}">
    <h1>${safeTitle}</h1>
    <p>${safeDesc}</p>
    <a class="btn" href="${safeRedirect}">Open on Mocos</a>
  </div>
</body>
</html>`;
}

// 1. Blog Post Pre-render Preview
router.get('/blog/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await connectDB();
    
    let query = {};
    if (ObjectId.isValid(id)) {
      query = { $or: [{ _id: new ObjectId(id) }, { id: id }, { slug: id }] };
    } else {
      query = { $or: [{ id: id }, { slug: id }] };
    }

    const post = await db.collection('blogposts').findOne(query);
    if (!post) {
      return res.redirect(`${FRONTEND_BASE_URL}/blog`);
    }

    const title = post.title || 'Mocos Tech Article';
    const description = post.summary || stripTags(post.excerpt || post.html || '').slice(0, 160) || "Read this article on Mocos Tech Tanzania.";
    let imageUrl = post.featuredImage || '';
    if (imageUrl && !imageUrl.startsWith('http')) {
      imageUrl = resolveImageUrl(imageUrl, 'blog-images');
    }
    if (!imageUrl) imageUrl = DEFAULT_PREVIEW_IMG;

    const redirectUrl = `${FRONTEND_BASE_URL}/blog/${post.slug || post._id.toString()}`;
    const canonicalUrl = `${req.protocol}://${req.get('host')}/share/blog/${id}`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderHtmlPreview({
      title,
      description,
      imageUrl,
      canonicalUrl,
      redirectUrl,
      type: 'article'
    }));
  } catch (error) {
    console.error('Error pre-rendering blog preview:', error);
    res.redirect(`${FRONTEND_BASE_URL}/blog`);
  }
});

// 2. Shop Product Pre-render Preview
router.get('/product/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await connectDB();

    let query = {};
    if (ObjectId.isValid(id)) {
      query = { $or: [{ _id: new ObjectId(id) }, { id: id }] };
    } else {
      query = { id: id };
    }

    const product = await db.collection('shop_products').findOne(query);
    if (!product) {
      return res.redirect(`${FRONTEND_BASE_URL}/shop`);
    }

    const formattedPrice = product.price ? `${Number(product.price).toLocaleString()} TZS` : '';
    const title = formattedPrice ? `${product.title} - ${formattedPrice}` : product.title;
    const description = stripTags(product.description || '').slice(0, 160) || `Buy ${product.title} on Mocos Official Store Tanzania.`;
    
    let imageUrl = product.storedCoverImageName 
      ? `https://storage.googleapis.com/${config.GCS_BUCKET_NAME}/shop-images/${product.storedCoverImageName}`
      : (product.coverImageUrl || DEFAULT_PREVIEW_IMG);

    const redirectUrl = `${FRONTEND_BASE_URL}/shop?product=${product._id.toString()}`;
    const canonicalUrl = `${req.protocol}://${req.get('host')}/share/product/${id}`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderHtmlPreview({
      title,
      description,
      imageUrl,
      canonicalUrl,
      redirectUrl,
      type: 'product'
    }));
  } catch (error) {
    console.error('Error pre-rendering product preview:', error);
    res.redirect(`${FRONTEND_BASE_URL}/shop`);
  }
});

// 3. Firmware / Software Pre-render Preview
router.get('/firmware/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await connectDB();

    let query = {};
    if (ObjectId.isValid(id)) {
      query = { $or: [{ _id: new ObjectId(id) }, { id: id }] };
    } else {
      query = { id: id };
    }

    const item = await db.collection('firmware').findOne(query);
    if (!item) {
      return res.redirect(`${FRONTEND_BASE_URL}/firmware`);
    }

    const formattedPrice = item.price === 0 ? 'FREE Download' : `${Number(item.price || 0).toLocaleString()} TZS`;
    const title = `${item.title} (${formattedPrice})`;
    const description = stripTags(item.description || '').slice(0, 160) || `Download ${item.title} (${item.type || 'Firmware'}) on Mocos.`;

    let imageUrl = item.storedImageName
      ? `https://storage.googleapis.com/${config.GCS_BUCKET_NAME}/firmware-images/${item.storedImageName}`
      : (item.imageUrl || DEFAULT_PREVIEW_IMG);

    const redirectUrl = `${FRONTEND_BASE_URL}/firmware?item=${item._id.toString()}`;
    const canonicalUrl = `${req.protocol}://${req.get('host')}/share/firmware/${id}`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderHtmlPreview({
      title,
      description,
      imageUrl,
      canonicalUrl,
      redirectUrl,
      type: 'website'
    }));
  } catch (error) {
    console.error('Error pre-rendering firmware preview:', error);
    res.redirect(`${FRONTEND_BASE_URL}/firmware`);
  }
});

module.exports = router;
