// Gates the admin pages and the data-exposing functions behind HTTP Basic
// Auth, with the real username/password stored only in Netlify's
// environment variables (Site settings > Environment variables) — never
// committed to git, unlike the old netlify.toml-header approach this
// replaces (which had the password sitting in plaintext in git history).
//
// SETUP: in Netlify, Site settings > Environment variables, add:
//   BASIC_AUTH_USER
//   BASIC_AUTH_PASS
// Make sure the variable's "Scopes" includes "Edge functions" (or "All
// scopes") — a var scoped only to "Builds"/"Functions" won't be readable
// here.
//
// stripe-webhook is deliberately NOT in the protected path list below:
// Stripe's servers call it directly and can't supply a Basic-Auth header,
// so it relies on its own signature verification (STRIPE_WEBHOOK_SECRET)
// instead — that's the correct auth mechanism for a webhook.

export default async (request, context) => {
  const expectedUser = Netlify.env.get("BASIC_AUTH_USER");
  const expectedPass = Netlify.env.get("BASIC_AUTH_PASS");

  if (!expectedUser || !expectedPass) {
    // Misconfigured — fail closed rather than leaving these pages open.
    return new Response(
      "Auth not configured. Set BASIC_AUTH_USER and BASIC_AUTH_PASS in Netlify's environment variables (scoped to Edge functions).",
      { status: 500 }
    );
  }

  const authHeader = request.headers.get("authorization") || "";
  const expected = "Basic " + btoa(`${expectedUser}:${expectedPass}`);

  if (authHeader !== expected) {
    return new Response("Authentication required.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Christa Stamper Finance"' },
    });
  }

  return context.next();
};

export const config = {
  path: [
    "/",
    "/index.html",
    "/invoice.html",
    "/dashboard.html",
    "/.netlify/functions/list-invoices",
    "/.netlify/functions/update-invoice",
    "/.netlify/functions/send-reminder-now",
    "/.netlify/functions/add-invoice-row",
    "/.netlify/functions/create-payment-link",
  ],
};
