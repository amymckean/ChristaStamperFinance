// Sends one overdue-payment reminder email immediately for a single invoice,
// via the same EmailJS reminder template the daily Apps Script job
// (ReminderEmails.gs) uses — service_n8ttajd / template_uq241g6. Used by the
// dashboard's "Send reminder" button, as a manual override that bypasses
// the script's normal 7-day cooldown.
//
// After sending, updates reminder_sent_on to today in the sheet, so the
// Apps Script job paces its *next* automatic reminder from this send
// instead of firing one again right away.
//
// POST body: { invoice_number: "INV-..." }
//
// Needs two Netlify environment variables Apps Script already has as Script
// Properties — copy the same values over:
//   EMAILJS_PUBLIC_KEY    (EmailJS Account > General)
//   EMAILJS_PRIVATE_KEY   (EmailJS Account > Security > Private Key)
//
// If the reminder template in EmailJS is ever recreated under a different
// service/template ID, update the two constants below to match
// ReminderEmails.gs.

const { google } = require("googleapis");

const SHEET_NAME = "Invoices";
const EMAILJS_SERVICE_ID = "service_n8ttajd";
const EMAILJS_TEMPLATE_ID = "template_uq241g6";

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

  const publicKey = process.env.EMAILJS_PUBLIC_KEY;
  const privateKey = process.env.EMAILJS_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Missing EMAILJS_PUBLIC_KEY / EMAILJS_PRIVATE_KEY environment variables" }),
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

    const templateParams = {
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
      email: email,
    };

    const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: publicKey,
        accessToken: privateKey,
        template_params: templateParams,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`EmailJS send failed (${response.status}): ${text}`);
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
