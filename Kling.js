/**
 * Kling relay — Vercel serverless function.  Drop this at  api/kling.js
 *
 * Runs against either provider. The browser never knows which — this file
 * normalizes both to the same two answers: {task_id} and {status, url}.
 * Switch providers by changing one environment variable and redeploying.
 * Nothing in execution-coach.html changes either way.
 *
 * ── OPTION A — official Kling (prepaid resource packages, from kling.ai/dev)
 *    KLING_PROVIDER = official          (or just leave it unset)
 *    KLING_ACCESS_KEY = your access key id
 *    KLING_SECRET_KEY = your access key secret
 *
 * ── OPTION B — EvoLink reseller (pay as you go, no prepaid block)
 *    KLING_PROVIDER = evolink
 *    EVOLINK_API_KEY = your key from evolink.ai/dashboard/keys
 *    KLING_MODEL = kling-v3-text-to-video     (optional, this is the default)
 *
 * Optional either way:
 *    ALLOWED_ORIGIN = https://your-app.vercel.app   (defaults to *)
 *
 * No npm dependencies. The JWT, when needed, is signed with node:crypto.
 */

import crypto from 'node:crypto';

const OFFICIAL = 'https://api.klingai.com/v1/videos/text2video';
const EVOLINK  = 'https://api.evolink.ai/v1';

const b64url = buf =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Official Kling only: HS256 JWT, issuer is the access key, 30 min life, backdated 5s. */
function signToken(accessKey, secretKey) {
  const now = Math.floor(Date.now() / 1000);
  const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: accessKey, exp: now + 1800, nbf: now - 5 }));
  const body = `${header}.${payload}`;
  return `${body}.${b64url(crypto.createHmac('sha256', secretKey).update(body).digest())}`;
}

/* ============================================================
   PROVIDER A — official Kling
   ============================================================ */
const official = {
  headers() {
    const { KLING_ACCESS_KEY, KLING_SECRET_KEY } = process.env;
    if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) throw new Error('KLING_ACCESS_KEY / KLING_SECRET_KEY are not set');
    return {
      Authorization: `Bearer ${signToken(KLING_ACCESS_KEY, KLING_SECRET_KEY)}`,
      'Content-Type': 'application/json'
    };
  },

  async create(shot) {
    const r = await fetch(OFFICIAL, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model_name: shot.model_name || 'kling-v2-6',
        prompt: shot.prompt,
        negative_prompt: shot.negative_prompt,
        duration: String(shot.duration || '5'),
        aspect_ratio: shot.aspect_ratio || '9:16',
        mode: shot.mode || 'professional',
        cfg_scale: shot.cfg_scale ?? 0.5
      })
    });
    const data = await r.json();
    if (!r.ok || data.code) throw new Error(data.message || `Kling rejected the request (${r.status})`);
    return { task_id: data.data?.task_id };
  },

  async status(taskId) {
    const r = await fetch(`${OFFICIAL}/${taskId}`, { headers: this.headers() });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || `lookup failed (${r.status})`);
    const d = data.data || {};
    return {
      status: d.task_status,                       // succeed | failed | processing | submitted
      message: d.task_status_msg,
      url: d.task_result?.videos?.[0]?.url || null
    };
  }
};

/* ============================================================
   PROVIDER B — EvoLink
   Plain bearer key, no signing. Different paths, different field
   names, different status words — all flattened below so the
   browser sees exactly what it sees from the official route.
   ============================================================ */
const evolink = {
  headers() {
    const key = process.env.EVOLINK_API_KEY;
    if (!key) throw new Error('EVOLINK_API_KEY is not set');
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  },

  async create(shot) {
    const r = await fetch(`${EVOLINK}/videos/generations`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: process.env.KLING_MODEL || 'kling-v3-text-to-video',
        prompt: shot.prompt,
        negative_prompt: shot.negative_prompt,
        duration: Number(shot.duration || 5),      // number here, string on the official route
        aspect_ratio: shot.aspect_ratio || '9:16',
        quality: process.env.KLING_QUALITY || '720p'
      })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || data.message || `EvoLink rejected the request (${r.status})`);
    return { task_id: data.task_id || data.id };
  },

  async status(taskId) {
    const r = await fetch(`${EVOLINK}/tasks/${taskId}`, { headers: this.headers() });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || `lookup failed (${r.status})`);

    // EvoLink says completed/failed/pending. The app speaks Kling. Translate.
    const raw = String(data.status || '').toLowerCase();
    const status = raw === 'completed' ? 'succeed'
                 : raw === 'failed'    ? 'failed'
                 : 'processing';

    const url = data.results?.[0]?.url || data.results?.[0] || data.result?.url || null;
    return { status, message: data.error?.message || data.message, url };
  }
};

/* ============================================================
   HANDLER
   ============================================================ */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const provider = (process.env.KLING_PROVIDER || 'official').toLowerCase() === 'evolink' ? evolink : official;

  try {
    const { action, task_id, ...shot } = req.body || {};

    if (action === 'create') {
      const { task_id: id } = await provider.create(shot);
      if (!id) throw new Error('provider returned no task id');
      return res.status(200).json({ task_id: id, status: 'processing' });
    }

    if (action === 'status') {
      if (!task_id) return res.status(400).json({ error: 'task_id required' });
      const out = await provider.status(task_id);
      // Result URLs are temporary — about 24 hours on EvoLink, longer on the
      // official route. Copy finished clips into Supabase or S3 right here
      // rather than trusting the link to still work tomorrow.
      return res.status(200).json(out);
    }

    return res.status(400).json({ error: 'action must be create or status' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
