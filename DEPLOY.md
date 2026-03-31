# Acuros Health — Vercel Deployment Guide

## Project Structure

```
acuros-health/
├── index.html        ← Single-page frontend
├── hero-bg.jpg       ← Hero background image
├── api/
│   ├── chat.js       ← Gemini AI serverless function
│   └── contact.js    ← Resend contact serverless function
├── vercel.json       ← Routing + security headers
├── package.json
└── DEPLOY.md         ← This file
```

---

## Step 1 — Push to GitHub

1. Create a new repository at github.com (name it `acuros-health` or similar)
2. In your terminal, from this project folder:

```bash
git init
git add .
git commit -m "Initial Acuros Health v2"
git remote add origin https://github.com/YOUR_USERNAME/acuros-health.git
git push -u origin main
```

---

## Step 2 — Connect to Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New Project**
2. Import your GitHub repository
3. Vercel auto-detects the project — no build settings needed (static HTML)
4. Click **Deploy** — your site will be live in ~30 seconds

---

## Step 3 — Add Environment Variables

In Vercel dashboard → your project → **Settings → Environment Variables**, add:

| Variable            | Value                          | Environments         |
|---------------------|--------------------------------|----------------------|
| `GEMINI_API_KEY`    | `your_gemini_api_key`          | Production, Preview  |
| `RESEND_API_KEY`    | `your_resend_api_key`          | Production, Preview  |
| `CONTACT_TO_EMAIL`  | `info@acuros.ca`               | Production, Preview  |
| `GEMINI_MODEL`      | `gemini-2.0-flash` (optional)  | Production, Preview  |
| `ALLOWED_ORIGINS`   | `https://acuros.ca,https://www.acuros.ca` (optional) | Production, Preview  |

After adding variables, go to **Deployments → Redeploy** (latest deployment) to apply them.

---

## Step 4 — Connect Your Domain (acuros.ca)

1. Vercel dashboard → your project → **Settings → Domains**
2. Add `acuros.ca` and `www.acuros.ca`
3. Vercel gives you DNS records to add at your domain registrar
4. HTTPS is automatic

---

## Step 5 — Google OAuth (for patient portal)

In your Supabase dashboard:
1. **Authentication → Providers → Google** → Enable
2. Paste your Google OAuth Client ID and Secret
   (Get these from [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → OAuth 2.0 Client)
3. Add this as an authorized redirect URI in Google Cloud Console:
   ```
   https://pyexkdoupqzbnrybiubo.supabase.co/auth/v1/callback
   ```
4. In Supabase → **Authentication → URL Configuration**, set:
   - Site URL: `https://acuros.ca`
   - Redirect URLs: `https://acuros.ca/*`

---

## Local Development

To test API routes locally (they won't work by just opening index.html):

```bash
npm install
npx vercel dev
```

This starts a local server at `http://localhost:3000` with all API routes working.
You'll need a `.env.local` file:

```
GEMINI_API_KEY=your_gemini_api_key
RESEND_API_KEY=your_resend_api_key
CONTACT_TO_EMAIL=info@acuros.ca
ALLOWED_ORIGINS=http://localhost:3000
```

---

## Security Notes

- **Supabase anon key** — safe to keep in `index.html` (it's a public key by design, protected by Supabase Row Level Security)
- **Gemini key** — server-side only, in Vercel env vars
- **Resend key** — server-side only, in Vercel env vars
- Never commit `.env.local` to Git (add it to `.gitignore`)
