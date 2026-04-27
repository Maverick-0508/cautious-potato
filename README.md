# Lawn Craft Dashboard (cautious-potato)

Standalone Lawn Craft supervisor/admin dashboard frontend. This repository is **frontend only** (HTML/CSS/JS) and deploys to Vercel for the dashboard subdomain. The backend API is maintained in a separate service.

## Run locally (static)

From the repo root:

```bash
cd frontend
python -m http.server 5173
```

Then open: `http://localhost:5173/dashboard.html`

> Tip: Opening the file directly (`file://`) also works, but the dashboard will default to `http://127.0.0.1:8000/api` for the API base.

## Configure API base

The dashboard reads a runtime override from `window.DASHBOARD_API_BASE`. Place a script (or a small `config.js` file) **before** `dashboard.js` in `dashboard.html` when you need to point at a different backend.

```html
<script>
  window.DASHBOARD_API_BASE = 'https://api.lawncraft.com/api';
</script>
```

If no override is set, the dashboard uses `/api` for same-origin deployments.

**Required runtime value (production example):**

`DASHBOARD_API_BASE = https://api.lawncraft.com/api`

## Vercel deployment

1. Set the Vercel project root to `frontend/`.
2. Deploy as a static site (no build step required).
3. `vercel.json` routes non-asset paths to `dashboard.html` while allowing static assets (CSS/JS/images/fonts) to pass through.
4. Attach the custom domain (example: `dashboard.lawncraft.com`).
5. Ensure `window.DASHBOARD_API_BASE` is set in `dashboard.html` (or a `config.js` loaded before `dashboard.js`) for production.

## Backend CORS requirement

The backend API must allow requests from the dashboard subdomain and permit the `Authorization` header. Add `https://dashboard.lawncraft.com` (and any staging subdomains) to the backend CORS allowlist.
