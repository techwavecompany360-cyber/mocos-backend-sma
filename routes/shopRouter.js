const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const connectDB = require('../utils/db');
const config = require('../config');
const { authenticateCustomer } = require('./customerAuthRouter');

const gcsStorage = require('../utils/gcsStorage');

const router = express.Router();
const JWT_SECRET = config.JWT_SECRET;

// Middleware: Verify Admin JWT Token (permits unauthenticated dev/dashboard access if token omitted)
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token || token === 'null' || token === 'undefined') {
    return next();
  }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired admin session. Please log in again.' });
    req.user = user;
    next();
  });
}

// Multer memory storage configuration for cover and secondary gallery photos
const storage = multer.memoryStorage();

const imageFilter = (req, file, cb) => {
  if (!file.mimetype.startsWith('image/')) {
    return cb(new Error('Only image files (JPG, PNG, WebP) are allowed.'));
  }
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter: imageFilter,
  limits: { fileSize: 15 * 1024 * 1024 } // 15 MB limit per image
});

// Helper: build public image URL
function buildImageUrl(req, storedImageName) {
  if (!storedImageName) return null;
  if (storedImageName.startsWith('http://') || storedImageName.startsWith('https://')) {
    return storedImageName;
  }
  return `https://storage.googleapis.com/${config.GCS_BUCKET_NAME}/shop-images/${storedImageName}`;
}

/**
 * GET /api/shop/categories
 * Public/Admin: Fetch all shop product categories
 */
router.get('/categories', async (req, res) => {
  try {
    const db = await connectDB();
    let categories = await db.collection('shop_categories').find().sort({ name: 1 }).toArray();

    // Seed default categories if none exist
    if (categories.length === 0) {
      const defaults = [
        { name: 'Smartphones & Devices', createdAt: new Date() },
        { name: 'Spare Parts & Displays', createdAt: new Date() },
        { name: 'Repair Tools & Boxes', createdAt: new Date() },
        { name: 'Accessories & Chargers', createdAt: new Date() },
        { name: 'General', createdAt: new Date() }
      ];
      await db.collection('shop_categories').insertMany(defaults);
      categories = await db.collection('shop_categories').find().sort({ name: 1 }).toArray();
    }

    res.json(categories.map(c => ({ id: c._id.toString(), name: c.name, createdAt: c.createdAt })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/shop/categories
 * Admin: Create a new shop product category
 */
router.post('/categories', authenticateToken, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Category name is required.' });
    }
    const cleanName = name.trim();
    const db = await connectDB();

    const existing = await db.collection('shop_categories').findOne({
      name: { $regex: new RegExp(`^${cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    });
    if (existing) {
      return res.status(400).json({ error: `Category "${cleanName}" already exists.` });
    }

    const doc = { name: cleanName, createdAt: new Date() };
    const result = await db.collection('shop_categories').insertOne(doc);

    res.status(201).json({ id: result.insertedId.toString(), name: cleanName, createdAt: doc.createdAt });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/shop/categories/:id
 * Admin: Delete a shop product category (only if no products are using it)
 */
router.delete('/categories/:id', authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const cat = await db.collection('shop_categories').findOne({ _id: new ObjectId(req.params.id) });
    if (!cat) {
      return res.status(404).json({ error: 'Category not found.' });
    }

    // Check if category is attached to any shop products
    const count = await db.collection('shop_products').countDocuments({ category: cat.name });
    if (count > 0) {
      return res.status(400).json({
        error: `Cannot delete category "${cat.name}" because it is currently assigned to ${count} product(s). Please reassign or delete those products first.`
      });
    }

    await db.collection('shop_categories').deleteOne({ _id: cat._id });
    res.json({ success: true, message: `Category "${cat.name}" deleted successfully.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/shop/products
 * Public: List shop products (non-hidden only unless ?all=true is passed by admin)
 */
router.get('/products', async (req, res) => {
  try {
    const db = await connectDB();
    const showAll = req.query.all === 'true';

    const filter = showAll ? {} : { hidden: { $ne: true } };

    if (req.query.category && req.query.category !== 'All') {
      filter.category = req.query.category;
    }

    if (req.query.search) {
      filter.title = { $regex: req.query.search.trim(), $options: 'i' };
    }

    const items = await db
      .collection('shop_products')
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.json(
      items.map(item => ({
        id: item._id.toString(),
        title: item.title,
        price: item.price,
        category: item.category || 'General',
        stock: item.stock !== undefined ? item.stock : 1,
        description: item.description || '',
        coverImageUrl: buildImageUrl(req, item.storedCoverImageName),
        otherImageUrls: (item.storedOtherImageNames || []).map(name => buildImageUrl(req, name)),
        hidden: item.hidden === true,
        createdAt: item.createdAt
      }))
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/shop/products/:id
 * Public: Get single product details
 */
router.get('/products/:id', async (req, res) => {
  try {
    const db = await connectDB();
    const item = await db.collection('shop_products').findOne({ _id: new ObjectId(req.params.id) });
    if (!item) return res.status(404).json({ error: 'Product not found.' });

    res.json({
      id: item._id.toString(),
      title: item.title,
      price: item.price,
      category: item.category || 'General',
      stock: item.stock !== undefined ? item.stock : 1,
      description: item.description || '',
      coverImageUrl: buildImageUrl(req, item.storedCoverImageName),
      otherImageUrls: (item.storedOtherImageNames || []).map(name => buildImageUrl(req, name)),
      hidden: item.hidden === true,
      createdAt: item.createdAt
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/shop/products
 * Admin: Create a new shop product (cover image + up to 8 extra photos)
 */
router.post(
  '/products',
  authenticateToken,
  (req, res, next) => {
    upload.fields([
      { name: 'coverImage', maxCount: 1 },
      { name: 'otherImages', maxCount: 8 }
    ])(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const { title, price, category, stock, description } = req.body;

      if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Product title is required.' });
      }

      const priceNum = parseFloat(price);
      if (isNaN(priceNum) || priceNum < 0) {
        return res.status(400).json({ error: 'Price must be a non-negative number.' });
      }

      const stockNum = parseInt(stock, 10);
      const safeStock = isNaN(stockNum) || stockNum < 0 ? 1 : stockNum;

      const coverFile = req.files?.coverImage?.[0];
      const otherFiles = req.files?.otherImages || [];

      let storedCoverImageName = null;
      if (coverFile) {
        const filename = gcsStorage.generateFilename('shop', coverFile.originalname);
        const destPath = `shop-images/${filename}`;
        await gcsStorage.uploadFile(coverFile.buffer, destPath, coverFile.mimetype);
        storedCoverImageName = filename;
      }

      const storedOtherImageNames = [];
      for (const f of otherFiles) {
        const filename = gcsStorage.generateFilename('shop', f.originalname);
        const destPath = `shop-images/${filename}`;
        await gcsStorage.uploadFile(f.buffer, destPath, f.mimetype);
        storedOtherImageNames.push(filename);
      }

      const db = await connectDB();

      const doc = {
        title: title.trim(),
        price: priceNum,
        category: category ? category.trim() : 'General',
        stock: safeStock,
        description: description || '',
        storedCoverImageName,
        storedOtherImageNames,
        hidden: false,
        createdAt: new Date()
      };

      const result = await db.collection('shop_products').insertOne(doc);

      res.status(201).json({
        success: true,
        message: `Product "${title}" created successfully!`,
        product: {
          id: result.insertedId.toString(),
          ...doc,
          coverImageUrl: buildImageUrl(req, doc.storedCoverImageName),
          otherImageUrls: doc.storedOtherImageNames.map(name => buildImageUrl(req, name))
        }
      });
    } catch (error) {
      console.error('[Shop Product Creation Error]:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * PUT /api/shop/products/:id
 * Admin: Update shop product details & photos
 */
router.put(
  '/products/:id',
  authenticateToken,
  (req, res, next) => {
    upload.fields([
      { name: 'coverImage', maxCount: 1 },
      { name: 'otherImages', maxCount: 8 }
    ])(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const { title, price, category, stock, description, removeCoverImage, keepOtherImageNames } = req.body;

      const db = await connectDB();
      const existing = await db.collection('shop_products').findOne({ _id: new ObjectId(req.params.id) });
      if (!existing) return res.status(404).json({ error: 'Product not found.' });

      const updateFields = {};
      if (title && title.trim()) updateFields.title = title.trim();
      if (category && category.trim()) updateFields.category = category.trim();
      if (description !== undefined) updateFields.description = description;

      if (price !== undefined && price !== null) {
        const priceNum = parseFloat(price);
        if (!isNaN(priceNum) && priceNum >= 0) updateFields.price = priceNum;
      }

      if (stock !== undefined && stock !== null) {
        const stockNum = parseInt(stock, 10);
        if (!isNaN(stockNum) && stockNum >= 0) updateFields.stock = stockNum;
      }

      // Handle Cover Image update
      const newCoverFile = req.files?.coverImage?.[0];
      if (newCoverFile) {
        if (existing.storedCoverImageName) {
          const oldGcsPath = existing.storedCoverImageName.startsWith('http')
            ? gcsStorage.extractGcsPath(existing.storedCoverImageName)
            : `shop-images/${existing.storedCoverImageName}`;
          if (oldGcsPath) await gcsStorage.deleteFile(oldGcsPath);
        }
        const filename = gcsStorage.generateFilename('shop', newCoverFile.originalname);
        const destPath = `shop-images/${filename}`;
        await gcsStorage.uploadFile(newCoverFile.buffer, destPath, newCoverFile.mimetype);
        updateFields.storedCoverImageName = filename;
      } else if (removeCoverImage === 'true' || removeCoverImage === true) {
        if (existing.storedCoverImageName) {
          const oldGcsPath = existing.storedCoverImageName.startsWith('http')
            ? gcsStorage.extractGcsPath(existing.storedCoverImageName)
            : `shop-images/${existing.storedCoverImageName}`;
          if (oldGcsPath) await gcsStorage.deleteFile(oldGcsPath);
        }
        updateFields.storedCoverImageName = null;
      }

      // Handle Secondary Images update
      let currentOthers = existing.storedOtherImageNames || [];

      // Parse list of existing secondary filenames admin chose to keep
      if (keepOtherImageNames !== undefined) {
        let keptList = [];
        try {
          keptList = typeof keepOtherImageNames === 'string' ? JSON.parse(keepOtherImageNames) : keepOtherImageNames;
        } catch (e) {
          keptList = Array.isArray(keepOtherImageNames) ? keepOtherImageNames : [];
        }
        
        // Remove photos from GCS that are no longer kept
        for (const fileName of currentOthers) {
          if (!keptList.includes(fileName)) {
            const oldGcsPath = fileName.startsWith('http')
              ? gcsStorage.extractGcsPath(fileName)
              : `shop-images/${fileName}`;
            if (oldGcsPath) await gcsStorage.deleteFile(oldGcsPath);
          }
        }
        currentOthers = currentOthers.filter(name => keptList.includes(name));
      }

      // Append newly uploaded secondary files
      const newOtherFiles = req.files?.otherImages || [];
      const newOtherNames = [];
      for (const f of newOtherFiles) {
        const filename = gcsStorage.generateFilename('shop', f.originalname);
        const destPath = `shop-images/${filename}`;
        await gcsStorage.uploadFile(f.buffer, destPath, f.mimetype);
        newOtherNames.push(filename);
      }
      const combinedOthers = [...currentOthers, ...newOtherNames].slice(0, 8); // hard limit 8 photos max

      updateFields.storedOtherImageNames = combinedOthers;
      updateFields.updatedAt = new Date();

      await db.collection('shop_products').updateOne(
        { _id: existing._id },
        { $set: updateFields }
      );

      const updatedDoc = await db.collection('shop_products').findOne({ _id: existing._id });

      res.json({
        success: true,
        message: 'Product updated successfully!',
        product: {
          id: updatedDoc._id.toString(),
          title: updatedDoc.title,
          price: updatedDoc.price,
          category: updatedDoc.category || 'General',
          stock: updatedDoc.stock,
          description: updatedDoc.description,
          coverImageUrl: buildImageUrl(req, updatedDoc.storedCoverImageName),
          otherImageUrls: (updatedDoc.storedOtherImageNames || []).map(name => buildImageUrl(req, name)),
          hidden: updatedDoc.hidden === true,
          createdAt: updatedDoc.createdAt
        }
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * PATCH /api/shop/products/:id/visibility
 * Admin: Toggle product visibility (Hide/Show on website)
 */
router.patch('/products/:id/visibility', authenticateToken, async (req, res) => {
  try {
    const hidden = req.body.hidden === true;
    const db = await connectDB();

    const item = await db.collection('shop_products').findOne({ _id: new ObjectId(req.params.id) });
    if (!item) return res.status(404).json({ error: 'Product not found.' });

    await db.collection('shop_products').updateOne(
      { _id: item._id },
      { $set: { hidden, updatedAt: new Date() } }
    );

    const statusText = hidden ? 'hidden from' : 'visible on';
    res.json({
      success: true,
      hidden,
      message: `"${item.title}" is now ${statusText} the shop.`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/shop/products/:id
 * Admin: Delete a product and all associated images
 */
router.delete('/products/:id', authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const item = await db.collection('shop_products').findOne({ _id: new ObjectId(req.params.id) });
    if (!item) return res.status(404).json({ error: 'Product not found.' });

    // Clean up cover image from GCS
    if (item.storedCoverImageName) {
      const coverGcsPath = item.storedCoverImageName.startsWith('http')
        ? gcsStorage.extractGcsPath(item.storedCoverImageName)
        : `shop-images/${item.storedCoverImageName}`;
      if (coverGcsPath) await gcsStorage.deleteFile(coverGcsPath);
    }

    // Clean up secondary gallery images from GCS
    if (item.storedOtherImageNames && Array.isArray(item.storedOtherImageNames)) {
      for (const name of item.storedOtherImageNames) {
        const otherGcsPath = name.startsWith('http')
          ? gcsStorage.extractGcsPath(name)
          : `shop-images/${name}`;
        if (otherGcsPath) await gcsStorage.deleteFile(otherGcsPath);
      }
    }

    await db.collection('shop_products').deleteOne({ _id: item._id });

    res.json({ success: true, message: `Product "${item.title}" deleted successfully.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/shop/products/:id/purchase
 * Customer: Purchase shop product using Mocos Wallet
 */
router.post('/products/:id/purchase', authenticateCustomer, async (req, res) => {
  try {
    const db = await connectDB();

    const product = await db.collection('shop_products').findOne({ _id: new ObjectId(req.params.id) });
    if (!product) return res.status(404).json({ error: 'Product not found.' });

    if (product.hidden) {
      return res.status(400).json({ error: 'This item is currently unavailable.' });
    }

    if (product.stock !== undefined && product.stock <= 0) {
      return res.status(400).json({ error: 'Sorry, this product is out of stock.' });
    }

    const customer = await db.collection('customers').findOne({ _id: new ObjectId(req.customer.id) });
    if (!customer) return res.status(404).json({ error: 'Customer account not found.' });

    const currentBalance = Number(customer.wallet?.balance || 0);

    if (currentBalance < product.price) {
      return res.status(402).json({
        error: 'insufficient_balance',
        message: `Your wallet balance is ${currentBalance.toLocaleString()} TZS. You need ${product.price.toLocaleString()} TZS to purchase "${product.title}". Shortfall: ${(product.price - currentBalance).toLocaleString()} TZS. Please top up your wallet at any Mocos branch.`,
        currentBalance,
        required: product.price,
        shortfall: product.price - currentBalance
      });
    }

    // Deduct balance
    const newBalance = currentBalance - product.price;

    await db.collection('customers').updateOne(
      { _id: customer._id },
      { $set: { 'wallet.balance': newBalance } }
    );

    // Create wallet transaction record
    const transactionDoc = {
      customerId: customer._id.toString(),
      type: 'debit',
      amount: product.price,
      description: `Shop Purchase: ${product.title}`,
      createdAt: new Date()
    };
    await db.collection('wallet_transactions').insertOne(transactionDoc);

    // Decrement stock if finite
    if (product.stock > 0) {
      await db.collection('shop_products').updateOne(
        { _id: product._id },
        { $inc: { stock: -1 } }
      );
    }

    // Create order record
    const orderNumber = `ORD-${Date.now().toString().slice(-6)}-${Math.floor(1000 + Math.random() * 9000)}`;
    const orderDoc = {
      orderNumber,
      productId: product._id.toString(),
      productTitle: product.title,
      price: product.price,
      category: product.category,
      customerId: customer._id.toString(),
      customerName: customer.fullName || customer.phone || 'Customer',
      customerPhone: customer.phone,
      paymentMethod: 'Mocos Wallet',
      status: 'In Review',
      createdAt: new Date()
    };
    await db.collection('shop_orders').insertOne(orderDoc);

    res.json({
      success: true,
      message: `Congratulations! You successfully purchased "${product.title}" for ${product.price.toLocaleString()} TZS.`,
      orderNumber,
      newBalance,
      productTitle: product.title,
      price: product.price
    });
  } catch (error) {
    console.error('[Shop Purchase Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/shop/orders
 * Admin: List all shop orders (with optional search)
 */
router.get('/orders', authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const filter = {};

    if (req.query.search) {
      const q = req.query.search.trim();
      filter.$or = [
        { orderNumber: { $regex: q, $options: 'i' } },
        { customerName: { $regex: q, $options: 'i' } },
        { customerPhone: { $regex: q, $options: 'i' } },
        { productTitle: { $regex: q, $options: 'i' } }
      ];
    }

    const orders = await db
      .collection('shop_orders')
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.json(
      orders.map(o => ({
        id: o._id.toString(),
        orderNumber: o.orderNumber,
        productId: o.productId,
        productTitle: o.productTitle,
        price: o.price,
        category: o.category,
        customerId: o.customerId,
        customerName: o.customerName,
        customerPhone: o.customerPhone,
        paymentMethod: o.paymentMethod,
        status: o.status,
        createdAt: o.createdAt
      }))
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/shop/orders/my
 * Customer: Get own order history
 */
router.get('/orders/my', authenticateCustomer, async (req, res) => {
  try {
    const db = await connectDB();
    const orders = await db
      .collection('shop_orders')
      .find({ customerId: req.customer.id })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(
      orders.map(o => ({
        id: o._id.toString(),
        orderNumber: o.orderNumber,
        productTitle: o.productTitle,
        price: o.price,
        category: o.category,
        paymentMethod: o.paymentMethod,
        status: o.status,
        createdAt: o.createdAt
      }))
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/shop/orders/:id/status
 * Admin: Update order status (In Review, Processing, Shipping, Arrived, Completed)
 */
router.patch('/orders/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['In Review', 'Processing', 'Shipping', 'Arrived', 'Completed'];

    if (!status || !validStatuses.map(s => s.toLowerCase()).includes(status.toLowerCase())) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const normalizedStatus = validStatuses.find(s => s.toLowerCase() === status.toLowerCase());

    const db = await connectDB();
    const order = await db.collection('shop_orders').findOne({ _id: new ObjectId(req.params.id) });
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    await db.collection('shop_orders').updateOne(
      { _id: order._id },
      { $set: { status: normalizedStatus, updatedAt: new Date() } }
    );

    res.json({
      success: true,
      status: normalizedStatus,
      message: `Order ${order.orderNumber} status updated to "${normalizedStatus}".`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
