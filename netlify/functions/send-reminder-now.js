// Sends one overdue-payment reminder email immediately for a single invoice,
// via Resend — the same sender the daily Apps Script job (ReminderEmails.gs)
// uses. Used by the dashboard's "Send reminder" button, as a manual override
// that bypasses the script's normal 7-day cooldown.
//
// The email's HTML lives in ./templates/reminder-email.html (plain
// {{placeholders}}, no build step) so the look of the email can be edited
// without touching this file — this file only fills in the placeholders.
//
// After sending, updates reminder_sent_on to today in the sheet, so the
// Apps Script job paces its *next* automatic reminder from this send
// instead of firing one again right away.
//
// POST body: { invoice_number: "INV-..." }
//
// Needs one Netlify environment variable:
//   RESEND_API_KEY   (resend.com → API Keys)
//
// If the "from" address below is ever changed, update ReminderEmails.gs to
// match — it sends the same reminder through the same Resend account.

const { google } = require("googleapis");
const { loadTemplate_, render_ } = require("./lib/email-render");

const SHEET_NAME = "Invoices";
const FROM_EMAIL = "Christa Stamper <invoices@christastamper.com>";

const REMINDER_TEMPLATE = loadTemplate_("reminder-email.html");

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

  const { invoice_number } = body;
  if (!invoice_number) {
    return { statusCode: 400, body: JSON.stringify({ error: "invoice_number is required" }) };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Missing RESEND_API_KEY environment variable" }),
    };
  }

  try {
    const sheets = getSheetsClient_();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    if (!spreadsheetId) throw new Error("Missing GOOGLE_SHEET_ID environment variable");

    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId, range: `${SHEET_NAME}!A1:Z1000`,
    });
    const rows = data.values || [];
    if (rows.length === 0) throw new Error(`"${SHEET_NAME}" sheet appears empty`);

    const headers = rows[0];
    const col = {};
    headers.forEach((h, i) => { col[h] = i; });

    if (col["invoice_number"] === undefined) {
      throw new Error(`No "invoice_number" column found in the "${SHEET_NAME}" sheet.`);
    }

    const rowIndex = rows.findIndex((row, i) => i > 0 && row[col["invoice_number"]] === invoice_number);
    if (rowIndex === -1) {
      return { statusCode: 404, body: JSON.stringify({ error: `No invoice found with number ${invoice_number}` }) };
    }
    const row = rows[rowIndex];
    const get = (name) => (col[name] !== undefined ? (row[col[name]] || "") : "");

    const email = get("email");
    if (!email) {
      return { statusCode: 400, body: JSON.stringify({ error: "This invoice has no email address on file" }) };
    }

    const dueDateRaw = get("due_date");
    let daysOverdue = "";
    const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;
    if (dueDate && !isNaN(dueDate)) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      dueDate.setHours(0, 0, 0, 0);
      daysOverdue = String(Math.floor((today - dueDate) / (1000 * 60 * 60 * 24)));
    }

    const reminderData = {
      to_name: get("to_name"),
      invoice_number: get("invoice_number"),
      issue_date: formatDate_(get("issue_date")),
      due_date: formatDate_(dueDateRaw),
      days_overdue: daysOverdue,
      church_name: get("church_name"),
      amount_due: get("amount_due"),
      card_total: get("card_total"),
      card_fee: get("card_fee"),
      card_link: get("card_link"),
      ach_total: get("ach_total"),
      bank_link: get("bank_link"),
      notes: get("notes"),
    };

    const html = buildReminderEmailHtml_(reminderData);
    const text = buildReminderText_(reminderData);

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [email],
        reply_to: FROM_EMAIL.match(/<(.+)>/)?.[1] || FROM_EMAIL,
        subject: `Payment reminder: Invoice ${reminderData.invoice_number}${reminderData.church_name ? ` — ${reminderData.church_name}` : ""}`,
        html,
        text,
      }),
    });

    if (!response.ok) {
      const text2 = await response.text();
      throw new Error(`Resend send failed (${response.status}): ${text2}`);
    }

    // Keep the Apps Script's 7-day pacing in sync with this manual send, so
    // it doesn't fire another one right behind this.
    if (col["reminder_sent_on"] !== undefined) {
      const today = new Date();
      const columnLetter = columnLetter_(col["reminder_sent_on"]);
      const sheetRowNumber = rowIndex + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${SHEET_NAME}!${columnLetter}${sheetRowNumber}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[today.toISOString().slice(0, 10)]] },
      });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("Failed to send reminder:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

function getSheetsClient_() {
  const privateKey = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "").replace(/\\n/g, "\n");
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null, privateKey,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth });
}

function columnLetter_(index) {
  let letter = "";
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

function formatDate_(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d)) return String(value);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function esc_(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildReminderText_(d) {
  return `Payment reminder: Invoice ${d.invoice_number}
${d.church_name || ""}

This invoice is ${d.days_overdue} day${Number(d.days_overdue) === 1 ? "" : "s"} overdue.

Issued: ${d.issue_date}
Due: ${d.due_date}
Amount due: ${d.amount_due}

If paying by card: ${d.card_total}${d.card_link ? ` — ${d.card_link}` : ""}
If paying by bank transfer: ${d.ach_total}${d.bank_link ? ` — ${d.bank_link}` : ""}
${d.notes ? `\n${d.notes}\n` : ""}
Questions? Just reply to this email.`;
}

function buildReminderEmailHtml_(d) {
  return render_(REMINDER_TEMPLATE, {
    to_name: esc_(d.to_name || d.church_name || ""),
    invoice_number: esc_(d.invoice_number),
    days_overdue: esc_(d.days_overdue),
    issue_date: esc_(d.issue_date),
    due_date: esc_(d.due_date),
    church_name: esc_(d.church_name),
    amount_due: esc_(d.amount_due),
    card_total: esc_(d.card_total),
    card_fee: esc_(d.card_fee),
    card_link: esc_(d.card_link),
    ach_total: esc_(d.ach_total),
    bank_link: esc_(d.bank_link),
    notes: esc_(d.notes).replace(/\n/g, "<br>"),
  });
}
