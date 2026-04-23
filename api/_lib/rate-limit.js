const memoryBuckets = new Map();

function toSafeKeyPart(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9:_-]/g, '_');
}

async function runUpstashPipeline(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => 'unknown upstash error');
    throw new Error(`Upstash pipeline failed: ${resp.status} ${err}`);
  }

  const data = await resp.json();
  if (!Array.isArray(data)) throw new Error('Upstash returned unexpected response shape');
  return data.map((r) => r.result);
}

function checkMemoryRateLimit(key, maxRequests, windowSeconds) {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const bucket = memoryBuckets.get(key) || [];
  const fresh = bucket.filter((ts) => now - ts < windowMs);
  fresh.push(now);
  memoryBuckets.set(key, fresh);
  return {
    allowed: fresh.length <= maxRequests,
    count: fresh.length,
  };
}

export async function checkRateLimit({ route, identifier, maxRequests, windowSeconds }) {
  const key = `rl:${toSafeKeyPart(route)}:${toSafeKeyPart(identifier)}`;

  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      // Send INCR and EXPIRE atomically in one pipeline call.
      // EXPIRE NX only sets the TTL if the key has no expiry — this keeps
      // the window fixed rather than sliding on every request.
      const [rawCount] = await runUpstashPipeline([
        ['INCR', key],
        ['EXPIRE', key, String(windowSeconds), 'NX'],
      ]);
      const count = Number(rawCount);
      if (!Number.isFinite(count) || count < 1) {
        throw new Error(`Invalid Upstash INCR response: ${String(rawCount)}`);
      }
      return { allowed: count <= maxRequests, count };
    } catch (err) {
      console.error('[rate-limit] Upstash failed, using memory fallback:', err?.message || err);
    }
  }

  return checkMemoryRateLimit(key, maxRequests, windowSeconds);
}