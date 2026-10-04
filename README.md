# SignFlow

An electronic signature app. Upload a PDF, drag fields onto the page, send private
links to signers, and get back a sealed PDF with a certificate of completion, a
SHA-256 seal and a full audit trail.

Built for South African use: signatures are standard electronic signatures under
the Electronic Communications and Transactions Act 25 of 2002, consent is taken
explicitly before anything is recorded, and the data-region wording throughout is
configurable so it says where your files actually live.

```
npm install
cp .env.example .env      # then fill in SESSION_SECRET and APP_KEY
npm start                 # http://localhost:3000
```

`npm run smoke` runs a 28-check end-to-end test — register, upload, place fields,
send, sign, seal, verify, plus tamper detection and access control — against a
throwaway database.

---

## What it does

**Field placer.** Drag any of 19 field types onto a rendered page: signature,
initials, date signed, stamp, textbox, name, email, job title, company, editable
date, checkbox, dropdown, radio group, image upload, drawing, attachment, label,
hyperlink and QR code. Fields snap to a grid, resize from the corner, nudge with
the arrow keys, and each one is assigned to a specific signer (or to the document
itself, for the static types). Everything autosaves.

**Signing.** Recipients need no account. They open a private link, see the whole
document, and are walked through only the fields addressed to them. Signatures can
be drawn, typed or uploaded. There is a checklist, and Finish stays disabled until
every required field and the consent box are done.

**Certified signatures.** A signature is not stamped onto the page as a bare mark.
It is drawn inside a certification block — a bracket enclosing the short document
reference, the signature itself, and the signer's name, email address and the exact
time they signed with its UTC offset. A printed or forwarded copy travels away from
the audit trail, so the mark has to describe itself. Authors can turn it off per
field for a plain signature; if the field is drawn too small for the details to be
legible, it falls back to the mark alone rather than rendering unreadable text.

**The seal.** When the last signer finishes, every value is flattened into the PDF,
the attachments are appended, and a certificate of completion is added listing the
document hashes, each recipient's verification steps with timestamps and IPs, and
the full activity log.

**Verification.** The public face of the app, so it lives at **`/`** — someone handed
a signed PDF can type the bare domain, upload it, and be told whether it matches
what was sealed. No account needed.

`/verify/:id` is **permanent and must not be moved**. That exact URL is printed on
the certificate page inside every sealed PDF and encoded into QR-code fields, and
those documents are immutable — re-pointing it would break verification for every
document already issued. The bare `/verify` 301s to the root; `/verify/:id` and the
old form endpoints are kept as working aliases for the same reason.

---

## How the hashing works

Three hashes are recorded per document:

| Hash | Taken when | What it proves |
|---|---|---|
| `original_sha256` | on upload, before anything is placed | what the sender actually sent out |
| `signed_sha256` | after fields are flattened, **before** the certificate is appended | the agreed content, intact |
| `sealed_sha256` | over the complete final file | the whole artefact, certificate included |

The middle one exists because a certificate cannot print the hash of a file it is
itself part of. Both the original and signed hashes appear on the certificate page;
the sealed hash is what `/verify` matches a re-uploaded download against. Change one
byte of any of them and the digest no longer matches anything.

## Security

- **Passwords**: Argon2id via `@node-rs/argon2`, at OWASP's parameters (19 MiB,
  t=2, p=1). Login verifies against a dummy hash when the account is unknown, so a
  wrong email and a wrong password take the same time to answer.
- **Signing links**: 256 bits of random, one per recipient, single-use. A spent or
  out-of-turn link will not open the document.
- **SMTP passwords**: encrypted at rest with AES-256-GCM under `APP_KEY`. They are
  encrypted rather than hashed because they have to be replayed to your mail server
  — this is the one secret in the system that is recoverable, and it is not an
  account credential.
- **Sessions**: server-side in SQLite, regenerated on login, `httpOnly` +
  `sameSite=lax`, `secure` in production.
- **Authorisation**: documents are scoped to their owner and return 404 — not 403 —
  to anyone else, so IDs cannot be probed. Fields lock against edits once sent.

### Known gaps

Be honest with anyone you sell this to:

- **No CSRF tokens.** `sameSite=lax` cookies block cross-site form POSTs, which
  covers the realistic attacks, but there is no second layer. Add one before this
  handles anything valuable.
- **No rate limiting** on login or on the signing endpoints.
- **No 2FA**, no password reset, no email verification on registration.
- **No independent penetration test and no ISO 27001.** Say so plainly if a customer
  asks — an unverified claim there is worse than the gap.
- **Signatures are cryptographically sealed, not PKI-signed.** The audit trail and
  hash chain are the evidence; there is no X.509 certificate embedded in the PDF, so
  Acrobat will not show a green tick. That is the difference between a *standard*
  and an *advanced* electronic signature under ECTA. Standard is sufficient for the
  documents listed below; advanced is not on offer here.

## POPIA

- The signer is told, before they sign, exactly what is recorded — name, email, IP,
  browser, and the time of each step — and must tick a box to agree. The consent
  timestamp is stored and printed on the certificate.
- Location is never collected.
- Storage location is stated on every page footer and on the certificate, driven by
  `DATA_REGION`. Set it to where your server actually is; it is a claim, not a
  guarantee the code can enforce.
- Deleting a document removes its PDFs, its attachments' database rows and its whole
  audit trail.
- `BRAND_INFORMATION_OFFICER` and `BRAND_POPIA_REG_NO` are blank by default and
  render nothing until you set them. Do not fill them in until they are true — a
  registration number on a footer is a representation to a regulator.

## Legal wording

The footer states the ECTA position and names the document classes that cannot be
signed electronically (wills, sale of land, bills of exchange, long-term leases).
It is general information, not legal advice, and says so. Have your attorney read
`views/partials/foot.ejs` before you put this in front of customers.

---

## Layout

```
src/
  server.js        express app, sessions, static mounts
  config.js        env, secrets, storage paths
  crypto.js        argon2, sha256, tokens, AES-GCM for SMTP passwords
  db.js            sqlite connection, audit() — every state change goes through it
  schema.sql       users, documents, recipients, fields, attachments, audit_events
  fields.js        the 19 field types, shared by placer / signing page / stamper
  seal.js          flattens fields into the PDF, appends attachments, hashes
  certificate.js   renders the certificate of completion from the audit table
  mailer.js        per-account SMTP, invitation / completion templates
  routes/          auth, documents, prepare (fields API), sign, verify, settings
public/js/
  placer.js        the field placer
  sign.js          the signing page
  signature-pad.js draw / type / upload capture, trimmed to a transparent PNG
scripts/
  smoke.js         end-to-end HTTP test (31 checks)
  ui-check.js      drives the placer and signing page in real Edge (18 checks)
  sample.js        seeds a fake completed document and seals it, for checking layout
  inspect-pdf.js   dumps a PDF's text with coordinates
  render-pdf.js    renders PDF pages to PNG via PDF.js in headless Edge
```

`render-pdf.js` exists because there is no poppler on Windows and layout bugs are
invisible in a text dump. It takes an optional crop in page fractions:

```
node scripts/sample.js .\out
node scripts/render-pdf.js .\out\sealed-sample.pdf .\out\png 3 "2,0.14,0.37,0.44,0.15"
```

### Coordinates

Field positions are stored as fractions of the page box (`x`/`y`/`w`/`h` in 0..1,
`y` from the top) rather than pixels. That is what lets a layout survive a zoom
change, a different screen, and the jump from a rendered canvas to PDF points at
sealing time.

`placeRect()` in `seal.js` maps that onto unrotated PDF user space. It carries the
page's `/Rotate` through, because PDF.js honours rotation when it renders and
pdf-lib does not when it draws — without the transform, a signature on a rotated
scan lands sideways in the margin.

`npm run rotation-check` asserts this. It seals a document with one page at each
of 0/90/180/270, reads the result back through PDF.js's viewport transform — which
is what the reader actually sees — and checks that a top-left label lands top-left
and the page footer lands on the bottom edge, at every angle. Scanned documents
routinely arrive rotated, and the failure mode is invisible until a signature turns
up sideways on somebody's signed contract.

### The page footer

Every page of a sealed document carries a provenance line along the bottom:
`Signed via SignFlow · Document <id>`. A page that gets separated from the bundle —
printed, photocopied, pulled out of a folder — still says which record it belongs
to. The certificate of completion has its own footer and is appended afterwards, so
it is not double-stamped.

It sits in the bottom margin. On a source PDF whose own content runs to the very
edge of the page it will overlap, so `PAGE_FOOTER=off` disables it and
`PAGE_FOOTER_TEXT` changes the wording (`{brand}` and `{id}` are substituted).

## Version control and backups

Two layers, because they protect different things.

**Git tracks the code.** Every change, with diffs, so a bad edit is one command
away from being undone.

```
git log --oneline              # history
git diff                       # what you have changed since the last commit
git add -A && git commit -m "…"
git restore <file>             # throw away changes to one file
git reset --hard known-good    # back to the last verified-working state
```

The `known-good` tag marks a state with all six suites passing. Move it forward
when you next have everything green: `git tag -f known-good`.

**`.env` and `storage/` are deliberately untracked.** `.env` holds `APP_KEY`,
which decrypts the stored SMTP password — committed once, it is effectively
published even if a later commit removes it. `storage/` is the live database,
uploaded originals and sealed PDFs: real documents, real audit trails, real
personal data.

**Zip checkpoints cover what git does not** — see `scripts/backup.ps1`. Those
archives *do* include `.env` and `storage/`, which is exactly why they live
outside the project and must be kept as protected as the server itself.

So: git to undo a change, a zip checkpoint to recover an installation.

## Verification: public and in-app

Verification exists twice and works identically — look up by document ID or any
recorded hash, or upload a PDF and have it hashed and matched:

- **Public** — `/` and `/verify/<id>`. No account. `/verify/<id>` is printed on every
  certificate and encoded in QR fields, and the people following it (signers, a
  bank, a parent) have no account, so it must never require one.
- **In-app** — `/verification` and `/verification/<id>`. Signed-in only, inside the app
  with the sidebar; it is where the sidebar's *Verify a document* goes.

Both are mounted from the same handlers in `src/routes/verify.js`; only the frame
and the form addresses differ.

## Trash

Deleting a document moves it to the **trash** first. It leaves every list and the
dashboard, its signing links close, and it cannot be sent, reminded or edited — but
nothing is removed, and **Restore** puts it back exactly as it was, links working
again. Only from the trash can a document be deleted permanently, one at a time or
with **Empty trash**; that removes its records, audit trail, PDFs and attachments.
Both trips are written to the document's audit trail. A trashed sealed document
still verifies until it is permanently deleted, because the evidence still exists.

## Accounts and roles

The installation is **invitation-only**. Public sign-up exists for exactly one
purpose: the first account on an empty database, which becomes the administrator.
After that `/register` redirects to the login page, and posting to it directly is
refused — an open registration form on a document-signing tool lets anyone give
themselves a seat.

| | Member | Administrator |
|---|---|---|
| Send, track and seal their own documents | ✅ | ✅ |
| Verify documents | ✅ | ✅ |
| Change own name and password (`/profile`) | ✅ | ✅ |
| See other people's documents | ❌ | ❌ |
| Invite, deactivate, promote people (`/team`) | ❌ | ✅ |
| Outgoing mail and org settings (`/settings`) | ❌ | ✅ |
| Issue password resets | ❌ | ✅ |

Admin-only routes return **404, not 403** — a route a member may not use should not
confirm it exists.

### Invitations

An admin enters an email and a role. The invitation is a 256-bit token, valid for
7 days, and can be resent (which extends the window) or withdrawn. Re-inviting the
same address revokes the previous invitation rather than leaving two live links.
Accepting is one form: name and password. A used, withdrawn or expired link returns
410 and says which.

If mail is not configured yet, the invitation is still created and the team page
shows a **Copy link** button, so a new installation is not deadlocked on SMTP.

### Deactivation, not deletion

Deactivating blocks sign-in **and ends any session already open** — the identity is
dropped on the next request, not at the next login. Their documents, signatures and
audit trail are untouched, because the evidence has to outlive the account. There is
no delete-user button on purpose.

Two guards exist for the ways an installation can be left with nobody who can
administer it, both easy to trigger by accident and impossible to undo from inside
the app: you cannot deactivate your own account, and the last active administrator
cannot be demoted or deactivated.

### Password resets

Closing public sign-up also closes the only route a member had to recover an
account, so an admin can issue a reset link (24 hours, single use). Setting a new
password invalidates every other outstanding link for that account. Members change
their own password at `/profile`, which requires the current one — an authenticated
session is not enough to take an account over permanently.

### Outgoing mail is per company, with a platform default

The platform owner sets one mail account at `/platform/mail` that every company
uses by default; a company administrator can switch their organisation to its own
server in Settings, so mail comes from their own domain. Members cannot reach
Settings, so per-user credentials would leave their invitations silently unable to
send. Mail goes out from one envelope address (most servers reject a `From` they do
not own), with the **sending user's name as the display name and their address as
`Reply-To`** — so a recipient sees a name they recognise and replies reach the right
person.

### Administration log

Who was invited, promoted, deactivated or reset, and who changed the organisation's
settings — on the Activity log page (`/activity`, admins only), and only for the admin's own company. Kept in `admin_events`, separate from the
per-document `audit_events`, so it survives the deletion of every document those
people touched.

`npm run admin-check` covers the things that are quietly catastrophic if they
regress: a member reaching admin pages, a revoked invitation still working, the last
administrator being removed, and a deactivated account keeping its session.

## Multiple companies

One server hosts any number of organisations. Every account belongs to exactly one
company (an email address can only be in one), and everything a company owns —
people, documents, templates, invitations, its administration log — carries its id.
A company administrator manages their own organisation and cannot see or touch
another's, even by guessing ids; "team" templates are shared within the company only.

The **platform owner** is a flag on an account, separate from the per-company
administrator role. They get a Platform page (`/platform`) to add a company and
invite its first administrator, rename it, invite a replacement administrator, and
suspend or reactivate it. It is deliberately an **overview**: people, counts and the
company's administration log, never a document, recipient or signature.

Suspending a company signs its people out and stops them signing in. Nothing is
deleted, and signing links it already sent keep working, so its recipients are not
left stranded mid-signature. The platform owner is exempt from their own company's
suspension, or they could lock themselves out of the page that reverses it.

**Company logos.** A company administrator uploads a logo in Settings (or the
platform owner does, from the company's page). It leads the certificate of every
document the company seals — top-left, above the title, with the platform mark kept
smaller on the right — replaces the platform logo at the top of the company's
emails, and sits beside its name in the sidebar. PNG or JPG up to 1 MB; the type is
judged from the file's bytes and proven by embedding it into a scratch PDF, the same
step sealing performs, so a logo that uploads cannot fail a seal. It is embedded in
every certificate, so a small file matters. Sealed certificates keep the logo they
were sealed with, and the file goes when the company is deleted.

**Platform owners need no company.** They are invited from the Platform page into
no organisation at all, so the operator never appears on a client's team page and
no client is undeletable because the operator lives there. Such an account sees
only the platform pages, its profile and Verify — every company page sends it to
`/platform` — and can still enter any company through a support session. An owner
who also belongs to a company can have their platform access removed and keeps
their company role; a company-less owner is deactivated instead. Nobody can remove
their own access, and the last active owner cannot be removed.

**Support sessions.** From a company's page the platform owner can sign in as one
of its people to help them — seeing and doing exactly what they can, for up to 60
minutes. A reason is required, and the start, the end and that reason go into the
company's own administration log as well as the platform's, so a company can always
see who came in, when, as whom and why. Anything done meanwhile is attributed to
both people: admin actions as `owner (platform support, as person)`, document
events as `person (via platform support: owner)` — in the audit trail, and so on
the certificate. A banner and an Exit button are on every page; signing out just
ends the session. Platform owners cannot be impersonated, suspended companies
cannot be entered, platform pages are closed for the duration, the person's
last-seen time is left alone, and the session ends itself if it runs out, the
person is deactivated or their company suspended.

**Deleting** a company is permanent and takes everything it owns: its accounts,
documents and templates with every recipient, field and audit trail, its
invitations and administration log, and the PDFs and attachments on disk. Its
sealed documents stop verifying, because the record they are checked against is
gone. Two steps stand in front of it — the company must already be suspended, and
its exact name has to be typed — and a company holding a platform owner's account
cannot be deleted at all. The platform log keeps a line saying what was removed.

`npm run tenant-check` drives two companies against each other and fails on any
crossing of that line; it runs as part of every release.

### Upgrading an existing database

`src/migrate.js` runs on every boot and is idempotent. On a database that predates
roles it adds the columns, promotes the **oldest account** to administrator (so
nobody is locked out of Settings), and lifts the first configured user's SMTP
settings up to the installation record so mail keeps working. On a database that
predates companies it creates one from the installation's name, moves every user,
document, invitation and log entry into it, keeps the existing mail as the platform
default, and makes the founding administrator the platform owner. All of it is
logged.

## Dark mode

Follows the OS by default; the toggle in the top bar overrides it and the choice
persists. An inline script in the page head resolves the theme and writes it to
`<html data-theme>` **before the stylesheet paints** — loading that as a separate
file would let the page render light first and flash white on a dark-mode device.

Everything is driven by the tokens at the top of `public/css/app.css`. Two families
live there and must not be confused:

- **Themed tokens** flip between light and dark.
- **`--paper-*` never flips.** It describes the white page of a PDF and the ink
  stamped into it. The signature pad, the typed-signature preview and every field
  overlay sit on white paper in both themes — a signature captured as light-on-dark
  would be invisible in the sealed document. `ui-check` asserts the pad is still
  white paper with the app in dark mode.

Emails deliberately do **not** follow the app theme: they land in other people's
inboxes. They carry `color-scheme: light only` so dark-mode clients do not
auto-invert the design and leave the navy header muddy or the button unreadable.

`responsive-audit` runs the full sweep in **both themes** and measures real WCAG
contrast ratios on rendered colours, because dark mode fails quietly — a token
that was never re-mixed leaves unreadable text that no layout check would notice.
That check immediately found that **light mode had been failing AA since the
start**: `--ink-3` measured 4.32:1 where 4.5 is required, on every hint, caption
and table label in the app. Both themes now pass.

## Emails

Four messages go out: the signing invitation (and reminders), the completion
notice, a decline notification to the sender, and the SMTP test from Settings.
All four share one layout in `src/email-template.js` — dark header band with the
logo, accent rule, heading, body, a single call to action, a detail panel and a
footer.

`npm run email-preview` renders every one to HTML and screenshots it at 900px and
390px, so the templates can be reviewed without configuring SMTP and sending real
mail. It also writes the plain-text alternative next to each.

Two constraints shaped the markup:

- **Nested tables with inline styles.** Outlook renders mail through Word, which
  supports no flexbox, no grid, no reliable `<style>` block and no shorthand
  backgrounds. The CTA puts its background on the `<td>` rather than the `<a>`
  because Outlook ignores padding on an anchor and would otherwise paint a
  text-sized button.
- **The logo is a `cid:` attachment, not a URL.** Most clients block remote images
  by default, and an invitation showing a broken image where the brand should be
  reads like phishing. If the asset is missing the header falls back to the brand
  name as text rather than rendering an empty band.

Every message carries a plain-text alternative — HTML-only mail scores worse with
spam filters — and the completion notice gives each person a download link they
can actually use: the owner through their account, each signer through their own
token.

## Responsive layout

`npm run responsive-audit` walks all ten pages at phone (390), tablet (768) and
desktop (1440) widths and fails on horizontal overflow, controls that trigger the
iOS focus-zoom, and tap targets under 40px. It writes a screenshot of every
page/width combination so regressions are visible rather than inferred.

What it drove:

- **The signing page is the mobile-first one** — most signers open on a phone. Below
  900px the side panel becomes a bottom sheet: the document gets the screen, a peek
  bar shows progress and a Review & sign button, and the checklist, POPIA notice,
  consent box and Finish button are one tap away. The sheet raises itself once every
  required field is done, because the consent box and Finish live inside it and a
  shut sheet would read as a dead end.
- **Tables become stacked cards** below 760px. Five columns cannot be squeezed into
  390px, and side-scrolling a table of record is a poor way to read one. Each cell
  carries a `data-label` the CSS renders as its heading.
- **Inputs go to 16px** below 820px. iOS Safari zooms the whole page when a control
  under 16px takes focus and does not zoom back out.
- **The field placer** turns its palette and inspector into off-canvas drawers below
  1040px. HTML5 drag-and-drop does not fire on touch at all, so the palette also
  supports tap-to-arm then tap-to-place — without it the editor is inert on a phone.
  The page is **fitted to the column it is in** rather than rendered at a fixed
  width: an 820px page inside a 390px viewport means placing fields through a
  letterbox, tapping where you cannot see. It refits on rotation, and zooming past
  100% still overflows and scrolls, which is what zoom is for.
  Placement is decided on **pointerup**, by how far the finger travelled. A touch
  that becomes a scroll and a touch that is a tap begin with an identical
  pointerdown, so placing on pointerdown drops a field at the start of every swipe
  and — because it calls `preventDefault` — stops the page scrolling at all.
  Fields carry `touch-action: none` so dragging one moves it rather than scrolling
  the page out from under your finger.

`npm run mobile-check` drives both the editor and the signing page on an emulated
iPhone with touch only, using **CDP input rather than synthetic events**. That
distinction matters: dispatching `TouchEvent` objects from page script fires
listeners but never triggers the browser's own behaviour, so the page does not
actually scroll and the test proves nothing. Playwright's `tap()` has the same
blind spot — it sends down and up at one point, which is exactly why placing on
pointerdown passed every test and failed on a real phone the moment anyone swiped.
- **Modals become bottom sheets** below 620px, with stacked full-width buttons and a
  taller signature pad.

## Branding

The logo appears in the nav bar, the signing page, the footer, the favicon, the
invitation and completion emails, the certificate of completion header, and inside
every signature certification block.

The full-resolution source lives at `brand/signflow-logo-source.png`. The app never
serves it — `npm run build-brand` derives three right-sized copies into
`public/brand/`:

| Asset | Size | Used by |
|---|---|---|
| `logo-web.png` | 440px wide, 52 KB | nav, signing page, footer, emails |
| `logo-print.png` | 760px wide, 130 KB | certificate header, signature block |
| `logo-mark.png` | 128×128, 20 KB | favicon, and anywhere a wordmark will not fit |

That step is not cosmetic. The source is 790 KB; embedding it in every sealed PDF
would add most of a megabyte to each document, and serving it into a 26px-tall nav
bar wastes the same again on every page load.

**To rebrand**, replace the source file and re-run `npm run build-brand`. The
derivation trims the transparent margin, downscales with alpha-premultiplied
averaging (a naive box filter drags the transparent black into the edges and leaves
a dark halo), and finds the leading glyph for the square mark by locating the
kerning gap rather than assuming a fixed fraction. Set `BRAND_LOGO_WEB`,
`BRAND_LOGO_PRINT` and `BRAND_LOGO_MARK` to point elsewhere if you would rather not
overwrite the files.

If the assets are missing the app still runs: the certificate falls back to the
brand name in text, and emails drop the header image rather than showing a broken
one.

## Configuration

See `.env.example`. The two that matter:

- `SESSION_SECRET` and `APP_KEY` — 32+ random bytes each, **required in
  production**. In development they are generated into `.secrets/` so restarts do
  not log everyone out.
- `BASE_URL` — must be the URL recipients can actually reach, since signing links
  are built from it.

Set `TRUST_PROXY` **only** when the app really is behind a reverse proxy. Without a
proxy in front, trusting `X-Forwarded-For` lets a client write whatever IP it likes
onto the audit trail.

## Not built yet

Templates, bulk send, bulk links, reminder scheduling, email OTP, logo branding,
document intelligence, and the API / embedded signing. The schema has room for most
of them.
