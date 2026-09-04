const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length'
]);

function normalizeBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getProxyBase() {
  return normalizeBase(process.env.BACKEND_API_BASE || process.env.DASHBOARD_API_BASE || '');
}

function buildTargetUrl(req, base) {
  const pathParts = Array.isArray(req.query.path)
    ? req.query.path
    : req.query.path
      ? [req.query.path]
      : [];
  const upstreamPath = pathParts.join('/');
  const upstreamUrl = new URL(`${base}/${upstreamPath}`);

  for (const [key, value] of Object.entries(req.query || {})) {
    if (key === 'path') continue;
    if (Array.isArray(value)) {
      value.forEach(v => upstreamUrl.searchParams.append(key, String(v)));
    } else if (value !== undefined) {
      upstreamUrl.searchParams.set(key, String(value));
    }
  }

  return upstreamUrl;
}

function buildForwardHeaders(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (!value) continue;
    const lower = key.toLowerCase();
    if (HOP_HEADERS.has(lower)) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }
  return headers;
}

function getRequestBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  if (req.body == null) return undefined;
  if (Buffer.isBuffer(req.body) || typeof req.body === 'string') return req.body;
  return JSON.stringify(req.body);
}

export default async function handler(req, res) {
  const base = getProxyBase();

  if (!base || !/^https?:\/\//i.test(base)) {
    return res.status(500).json({
      detail: 'Backend API proxy is not configured. Set BACKEND_API_BASE (or DASHBOARD_API_BASE) to your live API /api URL.'
    });
  }

  try {
    const targetUrl = buildTargetUrl(req, base);
    const upstreamResp = await fetch(targetUrl, {
      method: req.method,
      headers: buildForwardHeaders(req),
      body: getRequestBody(req),
      redirect: 'manual'
    });

    res.status(upstreamResp.status);

    upstreamResp.headers.forEach((value, key) => {
      if (HOP_HEADERS.has(key.toLowerCase())) return;
      res.setHeader(key, value);
    });

    const buffer = Buffer.from(await upstreamResp.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    res.status(502).json({
      detail: 'Unable to reach upstream backend API.',
      error: String(error?.message || error)
    });
  }
}
