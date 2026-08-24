const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const connectDB = require('../utils/db');
const { authenticateCustomer } = require('./customerAuthRouter');

const config = require('../config');
const gcsStorage = require('../utils/gcsStorage');

const router = express.Router();

const DOWNLOAD_WARNING_MESSAGE = "⚠️ WARNING: Do NOT share this download link with anyone. Once the download completes on any device, this single-use link will permanently expire and cannot be used again.";

// Multer memory storage
const storage = multer.memoryStorage();

const imageFilter = (req, file, cb) => {
  if (file.fieldname === 'image') {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed for the cover photo.'));
    }
  }
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter: imageFilter,
  limits: { fileSize: 500 * 1024 * 1024 } // 500 MB limit
});

// Helper: build public image URL from stored filename
function buildImageUrl(req, storedImageName) {
  if (!storedImageName) return null;
  if (storedImageName.startsWith('http://') || storedImageName.startsWith('https://')) {
    return storedImageName;
  }
  return `https://storage.googleapis.com/${config.GCS_BUCKET_NAME}/firmware-images/${storedImageName}`;
}

// Helper: build purchase download URL
function buildDownloadUrl(req, token) {
  const protocol = req.protocol;
  const host = req.get('host');
  return `${protocol}://${host}/api/firmware/download/${token}`;
}

/**
 * GET /api/firmware/categories
 * Public/Admin: Fetch all firmware categories
 */
router.get('/categories', async (req, res) => {
  try {
    const db = await connectDB();
    let categories = await db.collection('firmware_categories').find().sort({ name: 1 }).toArray();
    
    // Seed default categories if none exist
    if (categories.length === 0) {
      const defaults = [
        { name: 'Samsung', createdAt: new Date() },
        { name: 'iPhone / iOS', createdAt: new Date() },
        { name: 'Xiaomi / Redmi', createdAt: new Date() },
        { name: 'Tecno / Infinix', createdAt: new Date() },
        { name: 'General Tools', createdAt: new Date() }
      ];
      await db.collection('firmware_categories').insertMany(defaults);
      categories = await db.collection('firmware_categories').find().sort({ name: 1 }).toArray();
    }

    res.json(categories.map(c => ({ id: c._id.toString(), name: c.name, createdAt: c.createdAt })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/firmware/categories
 * Admin: Create a new category
 */
router.post('/categories', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Category name is required.' });
    }
    const cleanName = name.trim();
    const db = await connectDB();

    const existing = await db.collection('firmware_categories').findOne({
      name: { $regex: new RegExp(`^${cleanName}$`, 'i') }
    });
    if (existing) {
      return res.status(400).json({ error: `Category "${cleanName}" already exists.` });
    }

    const doc = { name: cleanName, createdAt: new Date() };
    const result = await db.collection('firmware_categories').insertOne(doc);

    res.status(201).json({ id: result.insertedId.toString(), name: cleanName, createdAt: doc.createdAt });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/firmware/categories/:id
 * Admin: Delete a category (only if not attached to any firmware/software items)
 */
router.delete('/categories/:id', async (req, res) => {
  try {
    const db = await connectDB();
    const cat = await db.collection('firmware_categories').findOne({ _id: new ObjectId(req.params.id) });
    if (!cat) {
      return res.status(404).json({ error: 'Category not found.' });
    }

    // Check if category is attached to any firmware items
    const count = await db.collection('firmware').countDocuments({ category: cat.name });
    if (count > 0) {
      return res.status(400).json({
        error: `Cannot delete category "${cat.name}" because it is currently attached to ${count} firmware/software item(s). Reassign or delete those items first.`
      });
    }

    await db.collection('firmware_categories').deleteOne({ _id: cat._id });
    res.json({ success: true, message: `Category "${cat.name}" deleted successfully.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/firmware
 * Admin: Upload a new firmware or software item (with optional cover image)
 */
router.post('/', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'image', maxCount: 1 }]), async (req, res) => {
  try {
    const { title, type, category, price, description } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required.' });
    }
    if (!type || !['Firmware', 'Software'].includes(type)) {
      return res.status(400).json({ error: 'Type must be "Firmware" or "Software".' });
    }
    if (!category || !category.trim()) {
      return res.status(400).json({ error: 'Category is required.' });
    }
    const mainFile = req.files?.file?.[0];
    if (!mainFile) {
      return res.status(400).json({ error: 'A firmware/software file is required.' });
    }
    const priceNum = parseFloat(price);
    if (isNaN(priceNum) || priceNum < 0) {
      return res.status(400).json({ error: 'Price must be a non-negative number.' });
    }

    const imageFile = req.files?.image?.[0];

    let storedFileName = null;
    if (mainFile) {
      storedFileName = gcsStorage.generateFilename('fw', mainFile.originalname);
      const destPath = `firmware/${storedFileName}`;
      await gcsStorage.uploadFile(mainFile.buffer, destPath, mainFile.mimetype || 'application/octet-stream', false);
    }

    let storedImageName = null;
    if (imageFile) {
      storedImageName = gcsStorage.generateFilename('fw-img', imageFile.originalname);
      const destPath = `firmware-images/${storedImageName}`;
      await gcsStorage.uploadFile(imageFile.buffer, destPath, imageFile.mimetype);
    }

    const db = await connectDB();

    const doc = {
      title: title.trim(),
      type,
      category: category.trim(),
      price: priceNum,
      description: description || '',
      fileName: mainFile.originalname,
      storedFileName,
      fileSize: mainFile.size,
      fileMimeType: mainFile.mimetype,
      storedImageName,
      downloads: 0,
      createdAt: new Date()
    };

    const result = await db.collection('firmware').insertOne(doc);

    res.status(201).json({
      success: true,
      message: `${type} "${title}" uploaded successfully!`,
      item: {
        id: result.insertedId.toString(),
        ...doc,
        imageUrl: buildImageUrl(req, doc.storedImageName)
      }
    });
  } catch (error) {
    console.error('[Firmware Upload Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/firmware
 * Public: List all visible firmware/software items.
 * Admin can pass ?all=true (with token) to see hidden items too — handled client-side.
 * By default only hidden=false items are shown.
 */
router.get('/', async (req, res) => {
  try {
    const db = await connectDB();
    const showAll = req.query.all === 'true';

    const filter = showAll ? {} : { hidden: { $ne: true } };

    const items = await db
      .collection('firmware')
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.json(
      items.map(item => ({
        id: item._id.toString(),
        title: item.title,
        type: item.type,
        category: item.category || 'General',
        price: item.price,
        description: item.description,
        fileName: item.fileName,
        fileSize: item.fileSize,
        downloads: item.downloads || 0,
        hidden: item.hidden === true,
        imageUrl: buildImageUrl(req, item.storedImageName),
        createdAt: item.createdAt
      }))
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/firmware/:id/visibility
 * Admin: Toggle visibility of a firmware/software item.
 * Body: { hidden: true|false }
 */
router.patch('/:id/visibility', async (req, res) => {
  try {
    const hidden = req.body.hidden === true;
    const db = await connectDB();

    const item = await db.collection('firmware').findOne({ _id: new ObjectId(req.params.id) });
    if (!item) return res.status(404).json({ error: 'Item not found.' });

    await db.collection('firmware').updateOne(
      { _id: item._id },
      { $set: { hidden, updatedAt: new Date() } }
    );

    const action = hidden ? 'hidden from' : 'visible on';
    res.json({
      success: true,
      hidden,
      message: `"${item.title}" is now ${action} the website.`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/firmware/:id
 * Public: Get single item details
 */
router.get('/:id', async (req, res) => {
  try {
    const db = await connectDB();
    const item = await db.collection('firmware').findOne({ _id: new ObjectId(req.params.id) });
    if (!item) return res.status(404).json({ error: 'Item not found.' });

    res.json({
      id: item._id.toString(),
      title: item.title,
      type: item.type,
      category: item.category || 'General',
      price: item.price,
      description: item.description,
      fileName: item.fileName,
      fileSize: item.fileSize,
      downloads: item.downloads || 0,
      imageUrl: buildImageUrl(req, item.storedImageName),
      createdAt: item.createdAt
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/firmware/:id/active-purchase
 * Customer: Check if customer has an active uncompleted purchase for this firmware item
 */
router.get('/:id/active-purchase', authenticateCustomer, async (req, res) => {
  try {
    const db = await connectDB();
    const purchase = await db.collection('firmware_purchases').findOne({
      customerId: req.customer.id,
      firmwareId: req.params.id,
      status: { $ne: 'Completed' }
    });
    if (!purchase) {
      return res.json({ hasActivePurchase: false });
    }
    res.json({
      hasActivePurchase: true,
      downloadToken: purchase.downloadToken,
      downloadUrl: buildDownloadUrl(req, purchase.downloadToken),
      status: purchase.status,
      fileName: purchase.fileName,
      fileSize: purchase.fileSize,
      title: purchase.firmwareTitle
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/firmware/:id/purchase
 * Customer: Purchase access to a firmware/software item.
 * Deducts wallet balance and returns a download link.
 * If user already purchased and download is not completed, re-uses the active link with 0 deduction!
 */
router.post('/:id/purchase', authenticateCustomer, async (req, res) => {
  try {
    const db = await connectDB();

    const item = await db.collection('firmware').findOne({ _id: new ObjectId(req.params.id) });
    if (!item) return res.status(404).json({ error: 'Item not found.' });

    const customer = await db.collection('customers').findOne({ _id: new ObjectId(req.customer.id) });
    if (!customer) return res.status(404).json({ error: 'Customer account not found.' });

    const currentBalance = Number(customer.wallet?.balance || 0);

    // 1. Check if customer already has an active (uncompleted) purchase for this firmware item
    const existingPurchase = await db.collection('firmware_purchases').findOne({
      customerId: customer._id.toString(),
      firmwareId: item._id.toString(),
      status: { $ne: 'Completed' }
    });

    if (existingPurchase) {
      // Re-use active uncompleted download without charging wallet!
      return res.json({
        success: true,
        isExisting: true,
        message: 'Active download link restored. You can download and resume this file anytime until 100% completed.',
        downloadToken: existingPurchase.downloadToken,
        downloadUrl: buildDownloadUrl(req, existingPurchase.downloadToken),
        status: existingPurchase.status,
        newBalance: currentBalance,
        warningMessage: DOWNLOAD_WARNING_MESSAGE,
        item: {
          id: item._id.toString(),
          title: item.title,
          type: item.type,
          fileName: item.fileName,
          fileSize: item.fileSize
        }
      });
    }

    // 2. If new purchase and item has price > 0, check balance
    if (item.price > 0 && currentBalance < item.price) {
      return res.status(402).json({
        error: 'insufficient_balance',
        message: `Your wallet balance is ${currentBalance.toLocaleString()} TZS. You need ${item.price.toLocaleString()} TZS to purchase "${item.title}". You need ${(item.price - currentBalance).toLocaleString()} TZS more. Please visit any Mocos branch to top up your wallet.`,
        currentBalance,
        required: item.price,
        shortfall: item.price - currentBalance
      });
    }

    // 3. Deduct balance (if price > 0)
    let newBalance = currentBalance;
    if (item.price > 0) {
      newBalance = currentBalance - item.price;
      await db.collection('customers').updateOne(
        { _id: customer._id },
        { $set: { 'wallet.balance': newBalance } }
      );

      // Log transaction
      await db.collection('wallet_transactions').insertOne({
        customerId: customer._id.toString(),
        customerName: customer.fullName,
        walletNumber: customer.wallet?.accountNumber,
        type: 'purchase',
        itemId: item._id.toString(),
        itemTitle: item.title,
        itemType: item.type,
        amount: item.price,
        oldBalance: currentBalance,
        newBalance,
        description: `Purchase: ${item.type} - ${item.title}`,
        createdAt: new Date()
      });
    }

    // 4. Create new purchase document with fresh token
    const token = `dl-${crypto.randomBytes(16).toString('hex')}`;
    const purchaseDoc = {
      customerId: customer._id.toString(),
      customerName: customer.fullName || customer.phone || 'Customer',
      customerPhone: customer.phone,
      firmwareId: item._id.toString(),
      firmwareTitle: item.title,
      firmwareType: item.type,
      storedFileName: item.storedFileName,
      fileName: item.fileName,
      fileSize: item.fileSize || 0,
      price: item.price,
      downloadToken: token,
      status: 'Pending', // 'Pending' | 'Downloading' | 'Completed'
      downloadCount: 0,
      completedAt: null,
      createdAt: new Date(),
      warningMessage: DOWNLOAD_WARNING_MESSAGE
    };
    await db.collection('firmware_purchases').insertOne(purchaseDoc);

    // Increment download counter on firmware item
    await db.collection('firmware').updateOne(
      { _id: item._id },
      { $inc: { downloads: 1 } }
    );

    res.json({
      success: true,
      isExisting: false,
      message: 'Purchase successful! Your download link is ready and stored in your account until fully completed.',
      downloadToken: token,
      downloadUrl: buildDownloadUrl(req, token),
      status: 'Pending',
      newBalance,
      warningMessage: DOWNLOAD_WARNING_MESSAGE,
      item: {
        id: item._id.toString(),
        title: item.title,
        type: item.type,
        fileName: item.fileName,
        fileSize: item.fileSize
      }
    });
  } catch (error) {
    console.error('[Firmware Purchase Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/firmware/purchases/my
 * Customer: Get list of own firmware purchases with status and download link
 */
router.get('/purchases/my', authenticateCustomer, async (req, res) => {
  try {
    const db = await connectDB();
    const purchases = await db
      .collection('firmware_purchases')
      .find({ customerId: req.customer.id })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(
      purchases.map(p => ({
        id: p._id.toString(),
        firmwareId: p.firmwareId,
        title: p.firmwareTitle,
        type: p.firmwareType,
        fileName: p.fileName,
        fileSize: p.fileSize,
        price: p.price,
        status: p.status, // 'Pending' | 'Downloading' | 'Completed'
        isCompleted: p.status === 'Completed',
        downloadToken: p.status === 'Completed' ? null : p.downloadToken,
        downloadUrl: p.status === 'Completed' ? null : buildDownloadUrl(req, p.downloadToken),
        downloadCount: p.downloadCount || 0,
        completedAt: p.completedAt,
        createdAt: p.createdAt,
        warningMessage: p.status === 'Completed'
          ? 'Download completed successfully. Link has expired.'
          : DOWNLOAD_WARNING_MESSAGE
      }))
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/firmware/purchases
 * Admin: List all firmware purchases with download completion statuses
 */
router.get('/purchases', async (req, res) => {
  try {
    const db = await connectDB();
    const purchases = await db
      .collection('firmware_purchases')
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    res.json(
      purchases.map(p => ({
        id: p._id.toString(),
        customerId: p.customerId,
        customerName: p.customerName,
        customerPhone: p.customerPhone,
        firmwareId: p.firmwareId,
        title: p.firmwareTitle,
        type: p.firmwareType,
        fileName: p.fileName,
        fileSize: p.fileSize,
        price: p.price,
        status: p.status,
        downloadCount: p.downloadCount || 0,
        completedAt: p.completedAt,
        createdAt: p.createdAt
      }))
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/firmware/download/:token
 * Streams the file from GCS with Range/Resume support.
 * Tracks bytes streamed and marks status as 'Completed' ONLY when 100% finished.
 */
router.get('/download/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const db = await connectDB();

    const purchase = await db.collection('firmware_purchases').findOne({ downloadToken: token });

    if (!purchase) {
      return res.status(404).json({ error: 'Download link not found or invalid.' });
    }

    if (purchase.status === 'Completed') {
      return res.status(410).json({
        error: 'link_expired',
        message: 'This download link has completed downloading and is now permanently expired. It cannot be downloaded again.',
        status: 'Completed',
        completedAt: purchase.completedAt
      });
    }

    const destPath = `firmware/${purchase.storedFileName}`;

    // Update status to 'Downloading' if currently 'Pending'
    if (purchase.status === 'Pending') {
      await db.collection('firmware_purchases').updateOne(
        { _id: purchase._id },
        { $set: { status: 'Downloading', lastStartedAt: new Date() }, $inc: { downloadCount: 1 } }
      );
    }

    // Get file size from purchase record or GCS metadata
    let fileSize = Number(purchase.fileSize || 0);
    if (!fileSize) {
      try {
        const meta = await gcsStorage.getFileMetadata(destPath);
        fileSize = Number(meta.size || 0);
      } catch (e) {
        console.warn(`[GCS Metadata Warning]:`, e.message);
      }
    }

    // Support HTTP Range Requests for pausing/resuming large downloads
    const rangeHeader = req.headers.range;
    let streamOptions = {};
    let start = 0;
    let end = fileSize ? fileSize - 1 : 0;

    if (rangeHeader && fileSize > 0) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      start = parseInt(parts[0], 10);
      end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (isNaN(start) || start >= fileSize) {
        return res.status(416).set('Content-Range', `bytes */${fileSize}`).json({ error: 'Requested range not satisfiable' });
      }

      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);
      streamOptions = { start, end };
    } else if (fileSize > 0) {
      res.status(200);
      res.setHeader('Content-Length', fileSize);
    } else {
      res.status(200);
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(purchase.fileName)}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Download-Warning', encodeURIComponent(DOWNLOAD_WARNING_MESSAGE));

    // Stream file contents from GCS
    const gcsStream = gcsStorage.createReadStream(destPath, streamOptions);
    let bytesTransferred = 0;

    gcsStream.on('data', (chunk) => {
      bytesTransferred += chunk.length;
    });

    gcsStream.pipe(res);

    // Listen for response completion
    res.on('finish', async () => {
      const isFullDownload = !rangeHeader && fileSize > 0 && bytesTransferred >= Math.floor(fileSize * 0.95);
      const isRangeEndReached = rangeHeader && fileSize > 0 && end === fileSize - 1 && bytesTransferred >= Math.floor((end - start + 1) * 0.95);

      if (isFullDownload || isRangeEndReached) {
        console.log(`[Firmware Download Completed]: Purchase ${purchase._id} ("${purchase.fileName}") marked as Completed.`);
        await db.collection('firmware_purchases').updateOne(
          { _id: purchase._id },
          {
            $set: {
              status: 'Completed',
              completedAt: new Date()
            }
          }
        );
      }
    });

    gcsStream.on('error', (err) => {
      console.error('[GCS Download Stream Error]:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download stream failed. Please retry from your account.' });
      }
    });

  } catch (error) {
    console.error('[Download Route Error]:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * PUT /api/firmware/:id
 * Admin: Update details of a firmware/software item (title, type, category, price, description, cover image)
 */
router.put('/:id', upload.fields([{ name: 'image', maxCount: 1 }]), async (req, res) => {
  try {
    const { title, type, category, price, description, removeImage } = req.body;

    const db = await connectDB();
    const existing = await db.collection('firmware').findOne({ _id: new ObjectId(req.params.id) });
    if (!existing) return res.status(404).json({ error: 'Item not found.' });

    const updateFields = {};
    if (title && title.trim()) updateFields.title = title.trim();
    if (type && ['Firmware', 'Software'].includes(type)) updateFields.type = type;
    if (category && category.trim()) updateFields.category = category.trim();
    if (price !== undefined && price !== null) {
      const priceNum = parseFloat(price);
      if (!isNaN(priceNum) && priceNum >= 0) {
        updateFields.price = priceNum;
      }
    }
    if (description !== undefined) updateFields.description = description;

    // Handle cover image
    const newImageFile = req.files?.image?.[0];
    if (newImageFile) {
      // Delete old image from GCS if exists
      if (existing.storedImageName) {
        const oldGcsPath = existing.storedImageName.startsWith('http')
          ? gcsStorage.extractGcsPath(existing.storedImageName)
          : `firmware-images/${existing.storedImageName}`;
        if (oldGcsPath) await gcsStorage.deleteFile(oldGcsPath);
      }
      const storedImageName = gcsStorage.generateFilename('fw-img', newImageFile.originalname);
      const destPath = `firmware-images/${storedImageName}`;
      await gcsStorage.uploadFile(newImageFile.buffer, destPath, newImageFile.mimetype);
      updateFields.storedImageName = storedImageName;
    } else if (removeImage === 'true' || removeImage === true) {
      // Admin explicitly removed the image
      if (existing.storedImageName) {
        const oldGcsPath = existing.storedImageName.startsWith('http')
          ? gcsStorage.extractGcsPath(existing.storedImageName)
          : `firmware-images/${existing.storedImageName}`;
        if (oldGcsPath) await gcsStorage.deleteFile(oldGcsPath);
      }
      updateFields.storedImageName = null;
    }

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    updateFields.updatedAt = new Date();

    await db.collection('firmware').updateOne(
      { _id: existing._id },
      { $set: updateFields }
    );

    const updatedItem = await db.collection('firmware').findOne({ _id: existing._id });
    res.json({
      success: true,
      message: 'Item updated successfully!',
      item: {
        id: updatedItem._id.toString(),
        title: updatedItem.title,
        type: updatedItem.type,
        category: updatedItem.category || 'General',
        price: updatedItem.price,
        description: updatedItem.description,
        fileName: updatedItem.fileName,
        fileSize: updatedItem.fileSize,
        downloads: updatedItem.downloads || 0,
        imageUrl: buildImageUrl(req, updatedItem.storedImageName),
        createdAt: updatedItem.createdAt
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/firmware/:id
 * Admin: Delete a firmware/software item and its file
 */
router.delete('/:id', async (req, res) => {
  try {
    const db = await connectDB();
    const item = await db.collection('firmware').findOne({ _id: new ObjectId(req.params.id) });
    if (!item) return res.status(404).json({ error: 'Item not found.' });

    // Delete firmware binary file from GCS
    if (item.storedFileName) {
      const fwGcsPath = item.storedFileName.startsWith('http')
        ? gcsStorage.extractGcsPath(item.storedFileName)
        : `firmware/${item.storedFileName}`;
      if (fwGcsPath) await gcsStorage.deleteFile(fwGcsPath);
    }

    // Delete cover image from GCS if exists
    if (item.storedImageName) {
      const imgGcsPath = item.storedImageName.startsWith('http')
        ? gcsStorage.extractGcsPath(item.storedImageName)
        : `firmware-images/${item.storedImageName}`;
      if (imgGcsPath) await gcsStorage.deleteFile(imgGcsPath);
    }

    await db.collection('firmware').deleteOne({ _id: item._id });

    res.json({ success: true, message: `"${item.title}" deleted successfully.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
