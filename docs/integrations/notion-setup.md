# Notion OAuth — admin setup

One-time setup for the Rogation deployment owner. After this is done, every Pro user can self-serve "Connect Notion" from `/settings/integrations`. On first connect, Rogation auto-creates a "Rogation Specs" database in their workspace; every spec push becomes a page in that database.

Rogation is a SaaS. Each end user connects their own Notion workspace. You (the deployment owner) only register one OAuth integration — the one Notion uses to identify authorization requests as coming from Rogation. You never see your users' Notion tokens in plaintext, never push to their workspaces on their behalf, and never aggregate their data.

## 1. Register the public integration in Notion

1. Sign in to Notion as an admin of the team that will own the OAuth app (not the end users' workspaces).
2. Go to https://www.notion.so/my-integrations and click **New integration**.
3. Pick **Type: Public**. Internal integrations can't be used for user-installed OAuth.
4. Fill in:
   - **Name:** Rogation
   - **Logo / icon:** your brand (shown on the consent screen)
   - **Company name / website / TOS / privacy** — required for public integrations
   - **Redirect URIs:**
     - Production: `https://<your-domain>/api/oauth/notion/callback`
     - Preview (optional): `https://<preview-domain>/api/oauth/notion/callback`
     - Local (optional): `http://localhost:3000/api/oauth/notion/callback`
   - **Capabilities:** Read content, Update content, Insert content, No user information beyond basic is needed.
5. Save. Notion shows you an **OAuth client ID** and **OAuth client secret**. Copy both.

## 2. Add the credentials to your deployment

### Vercel

```bash
vercel env add NOTION_CLIENT_ID production
vercel env add NOTION_CLIENT_SECRET production
# Optional: add to `preview` + `development` scopes too.
```

Or via the dashboard: Project → Settings → Environment Variables.

### Local development

Add to `.env.local`:

```
NOTION_CLIENT_ID=your_client_id
NOTION_CLIENT_SECRET=your_client_secret
```

## 3. Redeploy

Vercel env changes don't apply to live instances until the next deploy. Either push a commit or hit "Redeploy" on the latest deployment.

## 4. Verify

Hit `https://<your-domain>/api/oauth/notion/start` in an authed session. You should be redirected to `notion.so/v1/oauth/authorize?...`. If you see a bounce back to `/settings/integrations?notion=error&reason=not_configured`, the env vars aren't in effect yet.

## What users see on first connect

- They click "Connect Notion" in `/settings/integrations`.
- Notion consent screen: they pick which pages Rogation can see + edit.
- Rogation auto-creates a "Rogation Specs" database under the first page the bot can write to.
- Back to Rogation with a "Notion connected" banner. No further setup needed — every spec now has a "Push to Notion" button.

## What Rogation stores

- An AES-256-GCM encrypted access token per account in `integration_credential`, keyed by `(account_id, 'notion')`.
- Workspace id / name / icon, bot id, and the auto-created database id + name in `integration_state.config` (no secrets, just display text + routing ids).
- Nothing else. Tokens never leave the server.

## Database schema created on first connect

The "Rogation Specs" database has:

| Property | Type | Populated from |
|---|---|---|
| Title | title | spec IR title |
| Opportunity | rich_text | source opportunity title |
| Readiness | select (A / B / C / D) | `spec.readiness_grade` |
| Version | number | `spec.version` |
| Source | url | deep link back to the spec in Rogation |
| Created | date | push timestamp |

Each page's body is the SpecIR rendered as Notion blocks (heading_2 per section, bulleted_list_item per story / criterion / edge case / citation).

## Failure modes the UI handles

- **OAuth denied on Notion's consent screen:** user bounces back to `/settings/integrations?notion=error` with a generic retry prompt.
- **Consent granted without sharing any page:** Rogation saves the credential but can't create the spec database. The integration shows as connected with a "Reconnect with page access" CTA. `integration_state.status = 'disabled'`, `config.setupReason = 'no_writable_page'`.
- **Provision failed** (Notion 5xx, rate limit, etc.): same branch, `config.setupReason = 'provision_failed'`.
- **Token revoked from Notion's side:** next API call returns 401; UI flips to `token_invalid` and prompts a Reconnect.
- **Env vars missing on the server:** both `/api/oauth/notion/start` and `/api/oauth/notion/callback` redirect to `/settings/integrations?notion=error&reason=not_configured`, which surfaces a "Contact support" banner. The Connect button is hidden so users can't click into the dead-end flow.

## Multi-tenant clarification

You register the integration once. Every end user connects their own Notion during OAuth. Your own Notion workspace is never shared, never read, never the target of anyone else's pushes — unless you also connect it as a regular user.
