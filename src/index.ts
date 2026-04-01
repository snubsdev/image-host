import { Hono } from 'hono/tiny'
import { cache } from 'hono/cache'
import { sha256 } from 'hono/utils/crypto'
import { basicAuth } from 'hono/basic-auth'
import { getExtension } from 'hono/utils/mime'
import * as z from 'zod'

const generateShortId = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

const getDatedPath = () => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

const maxAge = 60 * 60 * 24 * 30

const app = new Hono<{ Bindings: Cloudflare.Env }>()

app.get('/', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fluffy Images</title>
  <meta name="description" content="This service provides hosting for images">
  <link rel="shortcut icon" href="https://pub-a4443e381b024b27a2b33c5ed3c0d88e.r2.dev/fi_icon.png">
  <meta property="og:title" content="Fluffy Images">
  <meta property="og:description" content="This service provides hosting for images">
  <meta property="og:url" content="https://i.fluffynet.dev">
  <meta property="og:type" content="website">
  <meta property="og:image" content="https://pub-a4443e381b024b27a2b33c5ed3c0d88e.r2.dev/fi_icon.png">
  <meta property="og:image:alt" content="Fluffy Images">
  <meta property="og:site_name" content="Fluffy Images">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="Fluffy Images">
  <meta name="twitter:description" content="This service provides hosting for images">
  <meta name="twitter:image" content="https://pub-a4443e381b024b27a2b33c5ed3c0d88e.r2.dev/fi_icon.png">
  <meta name="twitter:image:alt" content="FluffyImages logo">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@100..900&family=Geist:wght@100..900&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%);
      color: #ffffff;
      margin: 0;
      padding: 0;
      text-align: center;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
    }
    h1 {
      color: #00d4ff;
      font-size: 3rem;
      margin-bottom: 1rem;
    }
    p {
      color: #b8b8b8;
      font-size: 1.2rem;
      max-width: 600px;
    }
    a {
      color: #00d4ff;
      text-decoration:none;
    }
  </style>
</head>
<body>
  <h1><img src="https://pub-a4443e381b024b27a2b33c5ed3c0d88e.r2.dev/fi_logo.png" alt="Fluffy Images" height="128px"></h1>
  <p>This service provides image hosting.</p>
</body>
</html>

  `)
})

app.put('/upload', async (c, next) => {
  const auth = basicAuth({ username: c.env.USER, password: c.env.PASS })
  await auth(c, next)
})

app.put('/upload', async (c) => {
  const data = await c.req.parseBody<{ image: File; width: string; height: string }>()

  const body = data.image
  const type = data.image.type
  const extension = getExtension(type) ?? 'png'

  const datedPath = getDatedPath()
  const shortId = generateShortId()
  
  let key
  if (data.width && data.height) {
    key = `${datedPath}/${shortId}_${data.width}x${data.height}.${extension}`
  } else {
    key = `${datedPath}/${shortId}.${extension}`
  }

  await c.env.BUCKET.put(key, body, { httpMetadata: { contentType: type } })

  return c.text(key)
})

app.get(
  '*',
  cache({
    cacheName: 'cdn-img-fluffy'
  })
)

const imageParameterSchema = z.object({
  width: z.coerce.number().optional(),
  height: z.coerce.number().optional(),
  quality: z.coerce.number().optional()
})

const getPreferredContentType = (acceptHeader: string | undefined, fallback: string) => {
  if (acceptHeader) {
    const types = ['image/avif', 'image/webp']
    for (const type of types) {
      if (acceptHeader.includes(type)) {
        return type
      }
    }
  }
  return fallback
}

app.get('/*', async (c) => {
  const key = c.req.path.slice(1) // Remove leading slash

  const object = await c.env.BUCKET.get(key)
  if (!object) return c.notFound()
  const contentType = object.httpMetadata?.contentType ?? ''

  const query = c.req.query()

  if (Object.keys(query).length !== 0 && c.env.IMAGES) {
    const schemaResult = imageParameterSchema.safeParse(query)
    if (schemaResult.success) {
      const preferredContentType = getPreferredContentType(c.req.header('Accept'), contentType)
      const parameters = schemaResult.data
      const imageResult = await c.env.IMAGES.input(object.body).transform(parameters).output({
        //@ts-expect-error the contentType maybe valid format
        format: preferredContentType,
        quality: parameters.quality
      })
      const res = imageResult.response()
      res.headers.set('Cache-Control', `public, max-age=${maxAge}`)
      return res
    }
  }

  const data = await object.arrayBuffer()
  return c.body(data, 200, {
    'Cache-Control': `public, max-age=${maxAge}`,
    'Content-Type': contentType
  })
})

export default app
