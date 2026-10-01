const express = require('express');
const router = express.Router();
const { getBucketStorageStats } = require('../utils/gcsStorage');

/**
 * GET /api/system/storage-stats
 * Query params: ?refresh=true (forces cache bypass)
 * Returns total file size, file count, and folder breakdown in Google Cloud Storage
 */
router.get('/storage-stats', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true' || req.query.refresh === '1';
    const stats = await getBucketStorageStats(forceRefresh);
    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    console.error('[SystemRouter] Error fetching storage stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve cloud storage statistics: ' + error.message,
    });
  }
});

module.exports = router;
