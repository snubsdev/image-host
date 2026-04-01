const express = require('express')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const mime = require('mime-types')

// Storage configuration
const STORAGE_ROOT = path.resolve(__dirname, 'storage')
const MAX_AGE = 60 * 60 * 24 * 30 // 30 days, for cache headers

// Ensure storage root exists
if (!fs.existsSync(STORAGE_ROOT)) {
  fs.mkdirSync(STORAGE_ROOT, { recursive: true })
}

// Simple Basic Auth middleware using env vars or defaults
function basicAuthMiddleware(req, res, next) {
  const USER = process.env.USER || 'admin'
  const PASS = process.env.PASS || 'secret'
  const auth = req.headers['authorization'] || ''
  const token = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString() : ''
  const [user, pass] = token.split(':')

  if (user === USER && pass === PASS) {
    return next()
  }
  res.set('WWW-Authenticate', 'Basic realm="Restricted"')
  return res.status(401).send('Unauthorized')
}

// Helpers
const generateShortId = () => {
  // 6-character alphanumeric id
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 6; i++) s += chars.charAt(Math.floor(Math.random() * chars.length))
  return s
}

const getDatedPath = () => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

const toExt = (mimeType) => {
  // Map mime type to extension; fallback to 'bin'
  const ext = (mime.extension) ? mime.extension(mimeType) : null
  // fallback using common types
  if (!ext) {
    if (mimeType === 'image/jpeg') return 'jpg'
    if (mimeType === 'image/png') return 'png'
    if (mimeType === 'image/webp') return 'webp'
  }
  return ext || 'bin'
}

// Initialize Express app
const app = express()

// Multer setup: store to memory first, we'll write to disk ourselves
const upload = multer({ storage: multer.memoryStorage() })

// Root page: simple landing similar to the Cloudflare worker
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Fluffy Images (Node)</title>
  </head>
  <body style="font-family: system-ui, Arial; text-align:center; padding:2rem;"> 
    <h1>Fluffy Images (Node)</h1>
    <p>This is a local storage image hosting service backed by a Node.js app.</p>
  </body>
  </html>`)
})

// Upload endpoint (Basic Auth required)
// Expects multipart/form-data with fields: image (file), width (optional), height (optional)
app.put('/upload', basicAuthMiddleware, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No image uploaded')
  }

  const { width, height } = req.body || {}
  const ext = toExt(req.file.mimetype) || 'bin'
  const datedPath = getDatedPath() // e.g., 2026/04/01
  const shortId = generateShortId()
  let filename
  if (width && height) {
    filename = `${shortId}_${width}x${height}.${ext}`
  } else {
    filename = `${shortId}.${ext}`
  }

  const dir = path.resolve(STORAGE_ROOT, datedPath)
  await fs.promises.mkdir(dir, { recursive: true })
  const filePath = path.resolve(dir, filename)
  await fs.promises.writeFile(filePath, req.file.buffer)

  // Return the storage key (relative to storage root)
  const key = path.relative(STORAGE_ROOT, filePath).replace(/\\/g, '/')
  res.send(key)
})

// Serve images from local storage
// URL pattern: /images/<path-to-image>
app.get('/images/*', async (req, res) => {
  const key = req.params[0] // the wildcard segment
  const filePath = path.resolve(STORAGE_ROOT, key)
  // Guard against path traversal
  if (!filePath.startsWith(STORAGE_ROOT)) {
    return res.status(400).send('Invalid path')
  }
  try {
    await fs.promises.access(filePath, fs.constants.R_OK)
  } catch {
    return res.status(404).send('Not found')
  }
  const stat = await fs.promises.stat(filePath)
  const contentType = mime.lookup(filePath) || 'application/octet-stream'
  res.set('Content-Type', contentType)
  res.set('Cache-Control', `public, max-age=${MAX_AGE}`)
  // Stream file
  const readStream = fs.createReadStream(filePath)
  readStream.pipe(res)
})

// Keyboard-agnostic 404 for other routes
app.use((req, res) => {
  res.status(404).send('Not Found')
})

// Cleanup: remove files older than 24 hours
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000
const cleanupOldFiles = async () => {
  const walk = async (dir) => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.resolve(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.isFile()) {
        try {
          const stats = await fs.promises.stat(full)
          const age = Date.now() - stats.mtimeMs
          if (age > CLEANUP_AGE_MS) {
            await fs.promises.unlink(full)
            // console.log('Deleted old file', full)
          }
        } catch {
          // ignore
        }
      }
    }
  }
  try {
    await walk(STORAGE_ROOT)
  } catch {
    // ignore cleanup errors
  }
}

// Start server
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  // initial cleanup at startup
  cleanupOldFiles()
  // schedule cleanup every 24 hours
  setInterval(cleanupOldFiles, 24 * 60 * 60 * 1000)
  console.log(`Node image server listening on port ${PORT}`)
})
