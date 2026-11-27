// Sends an invoice email (with the generated PDF attached) via Resend.
//
// Replaces the old client-side `emailjs.send()` call in invoice.html.
// EmailJS's free plan has no attachment allowance at all, and Resend's API
// key is a true secret (full send-as-your-domain privilege) rather than a
// safely-embeddable public key, so it can only live here, server-side —
// never in the browser.
//
// The email's HTML lives in ./templates/invoice-email.html (plain
// {{placeholders}}, no build step) so the look of the email can be edited
// without touching this file — this file only fills in the placeholders.
//
// POST body (sent by invoice.html's sendInvoice()):
//   to_email, to_name, church_name, invoice_number, issue_date, due_date,
//   amount_due, card_total, card_fee, ach_total, total_due, notes,
//   card_link, bank_link, manual_bank_info,
//   previous_balance_label, previous_balance_amount,
//   invoice_text, invoice_pdf (base64), invoice_pdf_filename,
//   lines: [{ date, counselee, description, sessions, rate, amount, notes }]
//
// Needs one Netlify environment variable:
//   RESEND_API_KEY   (resend.com → API Keys)
//
// Also needs a domain verified in Resend (resend.com → Domains) that
// matches FROM_EMAIL below — until that's done, Resend can only deliver to
// the account owner's own inbox. See SETUP.md.

const { loadTemplate_, render_ } = require("./lib/email-render");

// Update the domain part once it's verified in Resend (see SETUP.md). The
// display name is what shows up as the sender in the church's inbox.
const FROM_EMAIL = "Christa Stamper <invoices@christastamper.com>";

const INVOICE_TEMPLATE = loadTemplate_("invoice-email.html");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Missing RESEND_API_KEY environment variable" }),
    };
  }

  const {
    to_email, to_name, church_name, invoice_number, issue_date, due_date,
    amount_due, card_total, card_fee, ach_total, notes,
    card_link, bank_link, manual_bank_info,
    previous_balance_label, previous_balance_amount,
    invoice_text, invoice_pdf, invoice_pdf_filename,
    lines,
  } = body;

  if (!to_email) {
    return { statusCode: 400, body: JSON.stringify({ error: "to_email is required" }) };
  }
  if (!invoice_number) {
    return { statusCode: 400, body: JSON.stringify({ error: "invoice_number is required" }) };
  }

  try {
    const html = buildInvoiceEmailHtml({
      to_name, church_name, invoice_number, issue_date, due_date,
      amount_due, card_total, card_fee, ach_total, notes,
      card_link, bank_link, manual_bank_info,
      previous_balance_label, previous_balance_amount,
      lines: Array.isArray(lines) ? lines : [],
    });

    const payload = {
      from: FROM_EMAIL,
      to: [to_email],
      reply_to: FROM_EMAIL.match(/<(.+)>/)?.[1] || FROM_EMAIL,
      subject: `Invoice ${invoice_number}${church_name ? ` — ${church_name}` : ""}`,
      html,
      text: invoice_text || undefined,
    };

    if (invoice_pdf) {
      payload.attachments = [
        {
          filename: invoice_pdf_filename || `Invoice-${invoice_number}.pdf`,
          content: invoice_pdf,
        },
      ];
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Resend send failed (${response.status}): ${text}`);
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("Failed to send invoice email:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

function esc_(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nl2br_(value) {
  return esc_(value).replace(/\n/g, "<br>");
}

// Formats a line-item rate/amount as currency, falling back to the raw
// (escaped) value if it isn't a plain number — these come straight from the
// invoice form's text inputs, so they aren't guaranteed to be numeric.
function money_(value) {
  const n = Number(value);
  return value !== "" && !isNaN(n) ? `$${n.toFixed(2)}` : esc_(value);
}

// Short date for a single line item, e.g. "11/1/2026" — issue_date/due_date
// up top are already formatted long-form by the client (fmtDate), but a
// per-line date is sent as the raw yyyy-mm-dd string from the date input.
function shortDate_(value) {
  if (!value) return "";
  const d = new Date(`${value}T00:00:00Z`);
  if (isNaN(d)) return esc_(value);
  return d.toLocaleDateString("en-US", { timeZone: "UTC" });
}

function buildInvoiceEmailHtml(data) {
  const {
    to_name, church_name, invoice_number, issue_date, due_date,
    amount_due, card_total, card_fee, ach_total, notes,
    card_link, bank_link, manual_bank_info,
    previous_balance_label, previous_balance_amount,
    lines,
  } = data;

  const lineItemsRows = lines.map(l => {
    const noteHtml = l.notes ? `<div class="line-note">${esc_(l.notes)}</div>` : "";
    return `<tr>
          <td>${shortDate_(l.date)}</td>
          <td>${esc_(l.counselee || "")}</td>
          <td>${esc_(l.description || "")}${noteHtml}</td>
          <td class="right">${esc_(l.sessions || "")}</td>
          <td class="right">${money_(l.rate)}</td>
          <td class="amount">${money_(l.amount)}</td>
        </tr>`;
  }).join("\n        ");

  const previousBalanceRow = previous_balance_amount
    ? `<div class="meta-row"><span class="meta-label">${esc_(previous_balance_label || "Previous balance")}</span><span class="meta-value">${esc_(previous_balance_amount)}</span></div>`
    : "";

  const manualBankBlock = (manual_bank_info || "").trim()
    ? `<div class="payment-method">
        <div class="payment-method-row">
          <span class="payment-method-name">Bank transfer (manual)</span>
        </div>
        <div class="payment-method-note">No processing fee — transfer directly from your bank using the details below.</div>
        <div class="payment-method-note" style="margin-top:6px;white-space:pre-wrap;">${nl2br_(manual_bank_info)}</div>
      </div>`
    : "";

  return render_(INVOICE_TEMPLATE, {
    to_name: esc_(to_name || church_name || ""),
    invoice_number: esc_(invoice_number),
    issue_date: esc_(issue_date),
    due_date: esc_(due_date),
    church_name: esc_(church_name),
    previous_balance_row: previousBalanceRow,
    line_items_rows: lineItemsRows,
    amount_due: esc_(amount_due),
    card_total: esc_(card_total),
    card_fee: esc_(card_fee),
    card_link: esc_(card_link),
    ach_total: esc_(ach_total),
    bank_link: esc_(bank_link),
    manual_bank_block: manualBankBlock,
    notes: nl2br_(notes),
  });
}
