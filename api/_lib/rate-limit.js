const memoryBuckets = new Map();

function toSafeKeyPart(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9:_-]/g, '_');
}

async function runUpstashCommand(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([command]),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => 'unknown upstash error');
    throw new Error(`Upstash command failed: ${resp.status} ${err}`);
  }

  const data = await resp.json();
  return data?.[0]?.result ?? null;
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
      const count = Number(await runUpstashCommand(['INCR', key]));
      if (count === 1) {
        await runUpstashCommand(['EXPIRE', key, String(windowSeconds)]);
      }
      return { allowed: count <= maxRequests, count };
    } catch (err) {
      console.error('[rate-limit] Upstash failed, using memory fallback:', err?.message || err);
    }
  }

  return checkMemoryRateLimit(key, maxRequests, windowSeconds);
}
