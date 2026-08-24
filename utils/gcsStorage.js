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
};
