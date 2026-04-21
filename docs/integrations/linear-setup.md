# Linear OAuth — admin setup

One-time setup for the Rogation deployment owner. After this is done, every Pro user can self-serve "Connect Linear" from `/settings/integrations` without further intervention.

Rogation's Linear integration is standard OAuth. You (the deployment owner) register **one** OAuth app with Linear. Every end user then authorizes that app to read/write *their own* Linear workspace. Your Linear workspace is never shared, never read, never the target of anyone else's pushes.

## 1. Register the OAuth app in Linear

1. Sign in to Linear as an admin.
2. Settings → **API** → **OAuth applications** → **Create new**.
3. Fill in:
   - **Name:** Rogation (or whatever you want your users to see on the consent screen)
   - **Description:** optional
   - **Developer:** your company name
   - **Callback URLs:** add one per environment:
     - Production: `https://<your-domain>/api/oauth/linear/callback`
     - Preview (optional): `https://<preview-domain>/api/oauth/linear/callback`
   - **Public:** leave unchecked. Rogation is a single-tenant integration per end user, not a public marketplace listing.
   - **Scopes:** `read`, `write`, `issues:create`
4. Save. Linear shows you a **Client ID** and a **Client secret**. Copy both.

## 2. Add the credentials to your deployment

### Vercel

```bash
vercel env add LINEAR_CLIENT_ID production
vercel env add LINEAR_CLIENT_SECRET production
# Optional: add to `preview` + `development` scopes too if you test OAuth on preview URLs.
```

Or via the dashboard: Project → Settings → Environment Variables.

### Local development

Add to `.env.local`:

```
LINEAR_CLIENT_ID=your_client_id
LINEAR_CLIENT_SECRET=your_client_secret
```

The callback URL for local dev is `http://localhost:3000/api/oauth/linear/callback` — register that as an additional callback in the Linear OAuth app if you want to test end-to-end locally.

## 3. Redeploy

Vercel env changes don't apply to live instances until the next deploy. Either push a commit or hit "Redeploy" on the latest deployment.

## 4. Verify

Hit `https://<your-domain>/api/oauth/linear/start` in an authed session. You should be redirected to `linear.app/oauth/authorize?...`. If you see `{"error":"Linear OAuth not configured"}` or a bounce back to `/settings/integrations?linear=error&reason=not_configured`, the env vars aren't in effect on the live deployment yet.

## What users see

- **Before setup:** "Linear" card on `/settings/integrations` shows a "Coming soon" pill instead of a Connect button. No error, no dead-end clicks.
- **After setup:** "Connect Linear" button. Click → Linear consent screen → back to Rogation with a success banner. They pick a default team, and every spec they generate gets a one-click "Push to Linear" action.

## What Rogation stores

- An AES-256-GCM encrypted access token per account in `integration_credential`, keyed by `(account_id, 'linear')`.
- The workspace id/name and default team id/name in `integration_state.config` (no secrets, just display text).
- Nothing else. Tokens never leave the server.

## Failure modes the UI handles

- **OAuth denied on Linear's consent screen:** user bounces back to `/settings/integrations?linear=error` with a generic retry prompt.
- **Token revoked from Linear's side:** next API call returns 401, the UI flips the integration to `token_invalid` and prompts a Reconnect.
- **Env vars missing on the server:** both `/api/oauth/linear/start` and `/api/oauth/linear/callback` redirect to `/settings/integrations?linear=error&reason=not_configured`, which surfaces a "Contact support" banner. The Connect button is also hidden so users can't click into the dead-end flow.

## Multi-tenant clarification

Rogation is a SaaS. Each end user connects *their own* Linear. You (the deployment owner) only configure one OAuth app — the one Linear uses to identify incoming authorization requests as coming from Rogation. You never see your users' Linear tokens in plaintext (encrypted with your `DATA_KEY_ENCRYPTION_KEY`), never push to your users' workspaces on their behalf, and never aggregate their data.

If you want to offer Linear as a "first-class marketplace app" so non-Rogation-users can install it from Linear's directory, that's a different setup — flip the **Public** toggle on the OAuth app and follow Linear's public-listing guidelines. Not needed for the current use case.
