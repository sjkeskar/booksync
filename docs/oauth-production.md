# Moving the Google OAuth app from Testing to In production

## Risks of staying in Testing mode

None of these put your bookmarks or their privacy at risk. Encryption, the `drive.appdata`
scope and the safety checks work the same in both modes. The risks are about convenience and
access.

| Risk | What happens | Impact on Bookmark Sync |
|---|---|---|
| **7-day authorization expiry** | Google expires a test user's grant 7 days after consent. | Silent token renewal stops working about once a week. The extension then shows **"Sign in to Google again"** (badge `!`) and **pauses syncing** until you click *Sign in* in Options. No data is lost: local edits wait and sync after sign-in. While paused, the other PCs don't get this PC's changes. |
| **Only listed test users can sign in** | Accounts not on the *Test users* list get "Access blocked: … has not completed the Google verification process". | Add every family member's Gmail address under *Audience → Test users* (100 maximum). |
| **"Google hasn't verified this app" screen** | Shown at each consent. | Click *Continue*. Harmless, but it trains people to click through warnings. |
| **Testing apps are meant for development** | Google may change how Testing behaves. | Low; noted for completeness. |

**If you stay in Testing:** add each person as a test user, and expect a sign-in click roughly
once a week per browser. Everything else works.

---

## What Google asks for before publishing

Google Cloud console → **Google Auth Platform** (or *APIs & Services → OAuth consent screen*).

### 1. Branding

| Field | What to enter |
|---|---|
| App name | `Bookmark Sync` (must not contain "Google" or imitate a Google product) |
| User support email | Your Gmail address, or a Google Group you own |
| App logo | **Leave empty.** Uploading a logo triggers *brand verification*, a manual review that takes days to weeks. Without a logo, the consent screen just shows the name. |
| Application home page | `https://<your-domain>/` → hosted copy of [`site/index.html`](site/index.html) |
| Application privacy policy link | `https://<your-domain>/privacy.html` → [`site/privacy.html`](site/privacy.html) |
| Application terms of service link | `https://<your-domain>/terms.html` → [`site/terms.html`](site/terms.html) (optional, but cheap to include) |
| Authorized domains | `<your-domain>` (the domain hosting the three pages; it must be verified as yours, see below) |
| Developer contact email | Your email address |

### 2. Data access (scopes)

Only **`https://www.googleapis.com/auth/drive.appdata`** — *"See, create, and delete its own
configuration data in your Google Drive"*.

- Remove any other scope, even `email`/`profile`/`openid`. The extension doesn't need them; it
  reads your email through the Drive `about` endpoint.
- Justification text, if asked:

  > Bookmark Sync stores the user's bookmarks, encrypted on the user's device, in the
  > application data folder of the user's own Google Drive so the user's browsers can sync with
  > each other. It only reads and writes its own files in that hidden folder and never accesses
  > other Drive content.

### 3. Audience

- User type **External** (Internal only works for accounts inside a Google Workspace
  organization).
- Click **Publish app** → *In production*.
- Expected result: with only `drive.appdata` (intended to be a non-sensitive scope) and no logo,
  Google should report that verification isn't needed and publish immediately. If it asks for
  verification anyway, it is the brand-verification flow: the pages below must be live and the
  domain verified, then submit and wait.

### 4. Clients

Unchanged: the *Web application* client with redirect URI
`https://<extension-id>.chromiumapp.org/`. You don't need a new client ID or a rebuild after
publishing.

---

## Hosting the three pages (free) and verifying the domain

Google requires the home page and privacy policy to be on a domain **you have verified you own**.
The simplest free option is a GitHub Pages *user site*:

1. Create a **public** GitHub repository named exactly `<your-github-username>.github.io`. It
   holds only these pages, never the extension source.
2. Copy `docs/site/index.html`, `privacy.html` and `terms.html` into it, after filling the
   placeholders:
   - `[YOUR NAME]`
   - `[CONTACT EMAIL]`: an address you're happy to publish
   - `[DATE]`: the effective date
3. Repo **Settings → Pages** → deploy from the `main` branch, root folder. The pages appear at
   `https://<username>.github.io/`, `…/privacy.html` and `…/terms.html`.
4. **Verify ownership:** open <https://search.google.com/search-console> with the **same Google
   account that owns the Cloud project** → *Add property* → *URL prefix*
   `https://<username>.github.io/` → method **HTML tag**. Paste the `<meta
   name="google-site-verification" …>` tag where the comment marks it in `index.html`, push,
   then click *Verify*.
5. In the consent screen, add `<username>.github.io` as an **authorized domain**, fill in the
   three URLs, save, then **Publish app**.

If you own a domain (e.g. `example.family`), host the same three files on any static host and
verify it in Search Console with a *Domain* property (DNS TXT record) instead.

> Google's console wording and requirements change from time to time. If a field or step looks
> different, the goal is the same: a public home page and privacy policy on a domain verified by
> the project owner, and only the `drive.appdata` scope.

---

## Checklist

- [ ] Placeholders filled in `index.html`, `privacy.html`, `terms.html`
- [ ] Pages live on the chosen domain (open all three in a private window)
- [ ] Domain verified in Search Console with the Cloud project owner's account
- [ ] Authorized domain added; home page, privacy and terms URLs filled in
- [ ] No logo uploaded
- [ ] Scopes: only `drive.appdata`
- [ ] *Publish app* → status shows **In production**
- [ ] Sign in from the extension once more on each browser
- [ ] 8+ days later: sync still runs without a sign-in prompt (README §8)
