import express, { Request, Response } from 'express';
import { Storage } from '@google-cloud/storage';

const router = express.Router();

// Initialize Google Cloud Storage
const storage = new Storage({
  keyFilename: './netaris-2988e6729597.json'
});

const bucket = storage.bucket('netaris-first-launch');

/**
 * Generate a signed URL for uploading files to Google Cloud Storage
 *
 * Endpoint: POST /api/upload/get-upload-url
 * Body: { filename: string, contentType: string }
 * Responses:
 *  - 200: { uploadUrl: string, filename: string }
 *  - 400: Missing required fields
 *  - 500: Failed to generate upload URL
 */
router.post('/get-upload-url', async (req: Request, res: Response) => {
  try {
    const { filename, contentType } = req.body;

    if (!filename || !contentType) {
      return res.status(400).json({ error: 'Missing filename or contentType' });
    }

    // Create unique filename with timestamp
    const uniqueFilename = `${Date.now()}-${filename}`;
    const file = bucket.file(uniqueFilename);

    // Generate signed URL for uploading
    // Note: Don't specify contentType in getSignedUrl - let the PUT request's Content-Type header take precedence
    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
    });

    res.json({
      uploadUrl: url,
      filename: uniqueFilename,
      publicUrl: `https://storage.googleapis.com/netaris-first-launch/${encodeURIComponent(uniqueFilename)}`
    });
  } catch (error) {
    console.error('Error generating signed URL:', error);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

export default router;
