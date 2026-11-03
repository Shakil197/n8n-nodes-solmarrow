# n8n-nodes-solmarrow

[SolMarrow](https://solmarrow.com) nodes for [n8n](https://n8n.io): schedule and publish social media posts from your
workflows, and start workflows when a post is scheduled, published or fails.

- **SolMarrow**: create posts (draft, scheduled or published right away), upload images and videos, list posts,
  accounts, media and workspaces, delete posts, and read post results.
- **SolMarrow Trigger**: starts a workflow on `post.scheduled`, `post.published` or `post.failed`. Every delivery is
  signed, and the node checks the signature.

[Installation](#installation) · [Credentials](#credentials) · [Operations](#operations) · [Trigger](#trigger) ·
[Example](#example) · [Limits](#limits) · [Resources](#resources)

## Installation

In n8n, open **Settings → Community Nodes → Install**, enter `n8n-nodes-solmarrow`, and confirm. See n8n's
[community nodes guide](https://docs.n8n.io/integrations/community-nodes/installation/) for other ways to install.

## Credentials

The nodes sign in with your SolMarrow account (OAuth 2.0). You make a small app in SolMarrow once, then connect it
from n8n:

1. In n8n, create a **SolMarrow OAuth2 API** credential and copy the **OAuth Redirect URL** it shows (it ends in
   `/rest/oauth2-credential/callback`).
2. In SolMarrow, open **Settings → Apps and AI agents → Your own apps** and create an app. Paste the redirect URL as
   its redirect address.
3. SolMarrow shows a **client ID** and a **client secret** once. Paste both into the n8n credential.
4. Click **Connect my account**, sign in to SolMarrow if asked, choose the workspaces n8n may use, and allow.

Leave **SolMarrow URL** as `https://app.solmarrow.com`.

You can see and remove the connection at any time in SolMarrow under **Settings → Apps and AI agents**. Removing it
stops n8n's access and turns off its triggers.

## Operations

| Resource  | Operation | What it does                                                                                       |
| --------- | --------- | -------------------------------------------------------------------------------------------------- |
| Post      | Create    | Save a draft, schedule a post (at least 5 minutes ahead), or publish now                            |
| Post      | Get       | One post with each account's status, link, and latest results                                       |
| Post      | Get Many  | Posts, newest first; filter by status and time                                                      |
| Post      | Delete    | Delete a draft, scheduled or failed post                                                            |
| Media     | Upload    | Add an image or video from an earlier node's binary data (up to 90 MB) or from a public https link |
| Media     | Get Many  | Recent files in the media library                                                                   |
| Account   | Get Many  | Connected social accounts and each network's posting rules                                          |
| Workspace | Get Many  | Your workspaces and their time zones                                                                |
| Analytic  | Get       | Likes, comments, shares and views of published posts (last 30 days unless you set a range)          |

**Creating posts**

- **When**: _Save as Draft_, _Schedule_ (pick **Publish At**), or _Publish Now_. Times without an offset use the
  workflow's time zone.
- **Accounts**: required for Publish Now and Schedule; choose from the list, or pass IDs from **Account → Get Many**.
  For a draft they are optional, under **Additional Fields**.
- **Media IDs**: upload with **Media → Upload** first, then pass the `media_id` values, separated by commas, in order.
- **Text per Account**: different text for some accounts.
- **Network Settings (JSON)**: settings some networks need, keyed by account ID, for example
  `{"<youtube account id>": {"title": "Launch video", "privacy": "public"}}`. YouTube takes `title`, `privacy`,
  `madeForKids`; Pinterest `boardId`, `title`, `link`; Dribbble `title`, `tags`; Tumblr `tags`; WordPress, DEV and
  Ghost `title`, `tags`, `status`.

SolMarrow checks each post against the network's rules (length, number of images, video, required settings) before
it accepts it, and the node shows SolMarrow's message when something needs fixing.

TikTok posts need choices made in SolMarrow's own composer, so for TikTok accounts save a draft and finish it in
SolMarrow.

## Trigger

Choose the workspace and the events. When the workflow is activated, the node subscribes to those events; when it is
deactivated, it unsubscribes.

Each event is one item:

```json
{
  "id": "1042",
  "event": "post.published",
  "created_at": "2026-11-02T09:30:04.112Z",
  "workspace_id": "…",
  "post": {
    "id": "…",
    "text": "We just shipped…",
    "status": "published",
    "scheduled_at": "2026-11-02T09:30:00.000Z",
    "published_at": "2026-11-02T09:30:03.871Z",
    "accounts": [
      { "account_id": "…", "network": "linkedin", "name": "Samero", "status": "published", "url": "https://www.linkedin.com/…", "error": null }
    ]
  }
}
```

`post.published` also covers posts that went out to some of their accounts but not all (`status` is
`partially_published`; each account has its own `status` and `error`).

SolMarrow must be able to reach your n8n at a public **https** address, so the trigger doesn't work with n8n running
only on `localhost`. Use n8n Cloud, a server with a domain, or a tunnel.

## Example

A ready-made workflow to try every action: import [`examples/solmarrow-demo.workflow.json`](examples/solmarrow-demo.workflow.json)
(n8n → Workflows → ⋯ → Import from file), pick your SolMarrow credential, and run it. It saves a draft, reads it back,
uploads an image from a link, lists drafts and deletes the demo draft.

Post every new RSS item to LinkedIn and X, one hour later:

1. **RSS Feed Trigger**
2. **SolMarrow → Post → Create**: Text `{{ $json.title }} {{ $json.link }}`, When _Schedule_, Publish At
   `{{ $now.plus({ hours: 1 }) }}`, Accounts _LinkedIn_ and _X_.

Tell a Slack channel when a post fails:

1. **SolMarrow Trigger**: Events _Post Failed_
2. **Slack → Send Message**: `Post failed: {{ $json.post.text }}`

## Limits

- 120 requests a minute per connection.
- Apps and agents can create up to 300 posts a day per person.
- Uploads from binary data: up to 90 MB a file. Larger files: put them at a public https link and use the URL option.
- Your SolMarrow plan's limits (accounts, storage) apply as usual.

## Resources

- [SolMarrow API documentation](https://solmarrow.com/developers)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- Help: support@solmarrow.com

## Development

```sh
npm install
npm run lint
npm test        # builds, then runs the tests in test/
npm run dev     # n8n with this package loaded, at http://localhost:5678
```

Releases are published from GitHub Actions with an npm provenance statement through npm trusted publishing (no
tokens): bump the version in `package.json`, push to `main`, then `git push origin main:release`.

## License

[MIT](LICENSE.md)
