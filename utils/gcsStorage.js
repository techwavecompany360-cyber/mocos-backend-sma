const { Storage } = require('@google-cloud/storage');
const path = require('path');
const config = require('../config');

// Initialize Google Cloud Storage client
let storage;
if (config.GCS_KEY_FILE) {
  storage = new Storage({ keyFilename: config.GCS_KEY_FILE });
} else {
  // Falls back to Application Default Credentials (ADC) — for Cloud Run, GKE, etc.
  storage = new Storage();
}

const bucket = storage.bucket(config.GCS_BUCKET_NAME);

/**
 * Upload a file buffer to Google Cloud Storage.
 * @param {Buffer} fileBuffer - The file contents as a Buffer
 * @param {string} destPath - Destination path in the bucket (e.g., 'shop-images/filename.jpg')
 * @param {string} contentType - MIME type of the file (e.g., 'image/jpeg')
 * @param {boolean} [isPublic=true] - Whether to make the object publicly accessible (fine-grained ACLs)
 * @returns {Promise<string>} Public URL of the uploaded file
 */
async function uploadFile(fileBuffer, destPath, contentType, isPublic = true) {
  const file = bucket.file(destPath);
  await file.save(fileBuffer, {
    metadata: { contentType },
    resumable: false, // For files under 10MB; larger files use resumable by default
  });
  if (isPublic) {
    try {
      await file.makePublic();
    } catch (err) {
      if (!err.message?.includes('uniform bucket-level access')) {
        console.warn(`[GCS Warning] makePublic failed for ${destPath}:`, err.message);
      }
    }
  }
  return `https://storage.googleapis.com/${config.GCS_BUCKET_NAME}/${destPath}`;
}

/**
 * Upload a string/text content (e.g., HTML) to Google Cloud Storage.
 * @param {string} content - The text content to upload
 * @param {string} destPath - Destination path in the bucket
 * @param {string} contentType - MIME type (e.g., 'text/html')
 * @param {boolean} [isPublic=true] - Whether to make the object publicly accessible
 * @returns {Promise<string>} Public URL of the uploaded file
 */
async function uploadBuffer(content, destPath, contentType, isPublic = true) {
  const file = bucket.file(destPath);
  await file.save(content, {
    metadata: { contentType },
    resumable: false,
  });
  if (isPublic) {
    try {
      await file.makePublic();
    } catch (err) {
      if (!err.message?.includes('uniform bucket-level access')) {
        console.warn(`[GCS Warning] makePublic failed for ${destPath}:`, err.message);
      }
    }
  }
  return `https://storage.googleapis.com/${config.GCS_BUCKET_NAME}/${destPath}`;
}

/**
 * Download a file's content from GCS as a Buffer.
 * @param {string} destPath - The file path in the bucket
 * @returns {Promise<Buffer>} File contents
 */
async function downloadFile(destPath) {
  const file = bucket.file(destPath);
  const [contents] = await file.download();
  return contents;
}

/**
 * Delete a file from Google Cloud Storage.
 * @param {string} destPath - The file path in the bucket to delete
 * @returns {Promise<void>}
 */
async function deleteFile(destPath) {
  try {
    await bucket.file(destPath).delete();
  } catch (err) {
    // Silently ignore "not found" errors — file may already be deleted
    if (err.code !== 404) {
      console.error(`[GCS] Failed to delete ${destPath}:`, err.message);
    }
  }
}

/**
 * Generate a signed URL for temporary/private file access (e.g., firmware downloads).
 * @param {string} destPath - The file path in the bucket
 * @param {number} expiresMinutes - How many minutes the URL should be valid (default: 15)
 * @returns {Promise<string>} A time-limited signed download URL
 */
async function getSignedUrl(destPath, expiresMinutes = 15) {
  const file = bucket.file(destPath);
  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + expiresMinutes * 60 * 1000,
  });
  return url;
}

/**
 * Create a readable stream from GCS for streaming downloads.
 * @param {string} destPath - The file path in the bucket
 * @param {object} [options] - Stream options (e.g. { start, end })
 * @returns {ReadableStream}
 */
function createReadStream(destPath, options = {}) {
  return bucket.file(destPath).createReadStream(options);
}

/**
 * Get metadata (size, content type, etc.) of a GCS file.
 * @param {string} destPath - The file path in the bucket
 * @returns {Promise<object>} Metadata object
 */
async function getFileMetadata(destPath) {
  const [metadata] = await bucket.file(destPath).getMetadata();
  return metadata;
}

/**
 * Extract the GCS object path from a full GCS public URL.
 * e.g., 'https://storage.googleapis.com/bucket/shop-images/file.jpg' → 'shop-images/file.jpg'
 * @param {string} url - The full GCS URL
 * @returns {string|null} The object path, or null if not a valid GCS URL
 */
function extractGcsPath(url) {
  if (!url) return null;
  const prefix = `https://storage.googleapis.com/${config.GCS_BUCKET_NAME}/`;
  if (url.startsWith(prefix)) {
    return url.substring(prefix.length);
  }
  return null;
}

/**
 * Generate a unique filename with a prefix.
 * @param {string} prefix - e.g., 'shop', 'ba', 'fw'
 * @param {string} originalName - Original filename from the upload
 * @returns {string} Unique filename
 */
function generateFilename(prefix, originalName) {
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}`;
}

/**
 * Create a writable stream to GCS for large file streaming (e.g., firmware files up to 100GB).
 * The file is streamed directly to GCS without buffering the entire content in memory.
 * Uses GCS resumable upload internally for reliability on large files.
 * @param {string} destPath - Destination path in the bucket (e.g., 'firmware/file.bin')
 * @param {string} contentType - MIME type of the file
 * @returns {WritableStream} A writable stream — pipe your file stream into this
 */
function createWriteStream(destPath, contentType) {
  const file = bucket.file(destPath);
  return file.createWriteStream({
    metadata: { contentType },
    resumable: true,   // Required for files > 5MB; handles network interruptions
    validation: false, // Skip MD5 validation for speed on very large files
  });
}

let storageCache = {
  data: null,
  timestamp: 0,
};
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Get total file size, file count, and folder breakdown across Google Cloud Storage bucket.
 * @param {boolean} [forceRefresh=false] - Force bypass cache and query GCS API directly
 * @returns {Promise<object>} Storage statistics
 */
async function getBucketStorageStats(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && storageCache.data && (now - storageCache.timestamp < CACHE_TTL_MS)) {
    return {
      ...storageCache.data,
      cached: true,
      cachedAt: new Date(storageCache.timestamp).toISOString(),
    };
  }

  const [files] = await bucket.getFiles();
  let totalBytes = 0;
  const folders = {};
  const fileList = [];

  for (const file of files) {
    const size = parseInt(file.metadata?.size || '0', 10);
    totalBytes += size;
    const name = file.name;
    const prefix = name.includes('/') ? name.split('/')[0] : 'root';
    if (!folders[prefix]) {
      folders[prefix] = { count: 0, bytes: 0 };
    }
    folders[prefix].count += 1;
    folders[prefix].bytes += size;

    fileList.push({
      name,
      size,
      formattedSize: formatBytes(size),
      contentType: file.metadata?.contentType || 'application/octet-stream',
      updated: file.metadata?.updated || null,
      folder: prefix,
      publicUrl: `https://storage.googleapis.com/${config.GCS_BUCKET_NAME}/${name}`,
    });
  }

  fileList.sort((a, b) => b.size - a.size);

  const folderStats = Object.keys(folders).map((folder) => {
    const bytes = folders[folder].bytes;
    const count = folders[folder].count;
    const percentage = totalBytes > 0 ? ((bytes / totalBytes) * 100).toFixed(1) : 0;
    return {
      folder,
      count,
      bytes,
      formattedSize: formatBytes(bytes),
      percentage: Number(percentage),
    };
  }).sort((a, b) => b.bytes - a.bytes);

  const result = {
    bucketName: config.GCS_BUCKET_NAME,
    totalBytes,
    formattedTotalSize: formatBytes(totalBytes),
    totalFiles: files.length,
    folders: folderStats,
    largestFiles: fileList.slice(0, 15),
    updatedAt: new Date().toISOString(),
    cached: false,
  };

  storageCache = {
    data: result,
    timestamp: now,
  };

  return result;
}

module.exports = {
  uploadFile,
  uploadBuffer,
  downloadFile,
  createReadStream,
  createWriteStream,
  getFileMetadata,
  deleteFile,
  getSignedUrl,
  extractGcsPath,
  generateFilename,
  getBucketStorageStats,
  formatBytes,
};

