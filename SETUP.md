# Christa Stamper Finance — setup

This repo holds the invoicing admin tool (`invoice.html`), the new invoices/
reminders dashboard (`dashboard.html`), and the serverless functions behind
both. It used to live inside the public marketing site's repo
(`ChristaStamperCounseling`) — it's been split out here so admin tooling has
its own deploy, its own domain, and (new) a real way to keep the gate
password out of git.

## What changed from the old setup

- **Auth is no longer a password committed to git.** The old repo's
  `netlify.toml` had `Basic-Auth = "christa:Stamper$Counsel24!"` sitting in
  plaintext in version control — anyone with read access to that repo could
  read it straight out of the file (or git history, forever, even if it's
  later removed). This repo gates `/invoice.html`, `/dashboard.html`, and the
  functions that read/write invoice data with an **Edge Function**
  (`netlify/edge-functions/basic-auth.js`) that checks against two Netlify
  environment variables instead — set once in Netlify's dashboard, never in
  a file. Since the old password is already exposed in git history, **this
  is a new password**, not the old one:

      Username: christa
      Password: (set in Netlify's dashboard — Site settings > Environment
      variables > BASIC_AUTH_PASS. Ask whoever set it up for the current
      value, or change it there. It is intentionally never written in this
      file or anywhere else in git.)

  (Change it any time in Netlify's env vars — Christa doesn't need to know
  it's changeable, just give her the current one. **Never paste the real
  password into this file, or anywhere else in this repo, when following
  these steps** — type it only into Netlify's own dashboard. This file
  already leaked a real password once; don't let it happen again.)

- **Two new functions** power the dashboard: `list-invoices.js` (reads the
  sheet) and `update-invoice.js` (marks an invoice Paid/Unpaid, edits a due
  date). A third, `send-reminder-now.js`, sends one reminder email on demand
  — through the same Resend account the daily Apps Script job uses — and
  updates `reminder_sent_on` so the Apps Script job's normal 7-day pacing
  picks up from there instead of firing again right away.

- **Email sending moved from EmailJS to [Resend](https://resend.com).**
  EmailJS's free plan can't attach a PDF to an email at all, and upgrading
  wasn't wanted, so invoice emails (`send-invoice-email.js`) and reminder
  emails (`send-reminder-now.js`, and `ReminderEmails.gs` in Apps Script)
  now build their own HTML (from `netlify/functions/templates/*.html`) and
  send through Resend's API instead of an EmailJS dashboard template. See
  the `RESEND_API_KEY` step below for the one-time setup this needs.

- `create-payment-link.js`, `stripe-webhook.js`, and `add-invoice-row.js`
  moved over unchanged.

## One-time setup

1. **Push this repo to GitHub** as `ChristaStamperFinance` (or whatever you
   named it), then in Netlify: **Add new site > Import an existing
   project**, pick this repo. Build settings: no build command needed, no
   publish directory needed (leave publish directory as `.` / the repo
   root) — Netlify will pick up `netlify.toml` for the functions config.

2. **Environment variables** — Site settings > Environment variables. Copy
   these over from the *old* site (Netlify dashboard for
   `ChristaStamperCounseling` > Site settings > Environment variables —
   copy the values, don't regenerate them):

   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `GOOGLE_SERVICE_ACCOUNT_KEY` (paste the whole private key value as-is)
   - `GOOGLE_SHEET_ID`
   - `STRIPE_SECRET_KEY`

   This one is **new** — invoices and reminders send through
   [Resend](https://resend.com) now, not EmailJS:

   - `RESEND_API_KEY` — Resend dashboard > API Keys > Create API Key.

   Before Resend can deliver to anyone besides your own Resend account
   email, verify a sending domain: Resend dashboard > Domains > Add Domain
   (e.g. `christastamper.com`), then add the DNS records it gives you
   wherever christastamper.com's DNS is managed — the same place you'll add
   the CNAME for the custom domain in step 3 below. Until that domain shows
   "Verified" in Resend, sends only reach the Resend account's own address.
   The `FROM_EMAIL` constant near the top of
   `netlify/functions/send-invoice-email.js` and
   `netlify/functions/send-reminder-now.js` (currently
   `invoices@christastamper.com`) must use that verified domain — update
   both files together if you use a different address.

   **EmailJS is no longer used anywhere in this app.** If you still have
   `EMAILJS_PUBLIC_KEY` / `EMAILJS_PRIVATE_KEY` set on this Netlify site, or
   as Apps Script Script Properties for `ReminderEmails.gs`, they're safe to
   delete once you've confirmed sending works through Resend — nothing
   reads them anymore.

   And set these two new ones for the auth gate (scope them to include
   **Edge functions**, not just Builds/Functions, or the gate will 500):

   - `BASIC_AUTH_USER` = `christa`
   - `BASIC_AUTH_PASS` = *(choose your own value and type it directly into
     Netlify's dashboard — never into this file, or any other file in this
     repo. This field has already leaked a real password into git history
     once; whatever you set here now, set it ONLY in Netlify's UI.)*

   `STRIPE_WEBHOOK_SECRET` — see the Stripe step below; it gets a **new**
   value here, not copied from the old site.

3. **Custom domain.** In the new Netlify site's Domain settings, add a
   custom domain — e.g. `finance.christastamper.com` — and add the CNAME
   record it gives you wherever christastamper.com's DNS is managed. (If
   you'd rather use `admin.christastamper.com` or something else, same
   steps, just a different subdomain.)

4. **Stripe webhook — important, do this before relying on auto-marking
   invoices Paid.** The webhook endpoint Stripe calls moves to the new
   domain, and Stripe ties its signing secret to the specific endpoint URL,
   so this isn't a copy-paste:
   - Stripe Dashboard > Developers > Webhooks > **Add endpoint**:
     `https://christastamperfinance.netlify.app/.netlify/functions/stripe-webhook`,
     event: `payment_intent.succeeded`.
   - Copy the new endpoint's signing secret (`whsec_...`) into
     `STRIPE_WEBHOOK_SECRET` on the new Netlify site.
   - Once you've confirmed the new one works (see test checklist below),
     delete or disable the old webhook endpoint pointed at the old domain.

5. **Google Sheet access** — no change needed. It's the same service
   account, same sheet; sharing from the old setup still applies.

6. **Retire the old copies.** On the old `ChristaStamperCounseling` repo,
   `invoice.html` and the three functions have been removed and
   `netlify.toml` trimmed back to just the public site (no more Basic-Auth
   header, no more functions directory) — review the diff and commit/push
   when you're ready to cut over.

## Test checklist once the new site is live

- Open `https://<your-new-domain>/invoice.html` — your browser should
  prompt for a username/password (the new ones above), not just load.
- Generate a test invoice, confirm it appears on
  `https://<your-new-domain>/dashboard.html`.
- Click "Send reminder" on a test row and confirm the email arrives.
- Click "Mark Paid" / "Mark Unpaid" and confirm the sheet's `status` column
  updates.
- Edit a due date from the dashboard and confirm the sheet updates and the
  "days overdue" badge recalculates.
- Send a real (or Stripe test-mode) payment through a generated card link
  and confirm the webhook still flips the row to Paid automatically.
