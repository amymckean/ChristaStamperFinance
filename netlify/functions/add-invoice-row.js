// Keeps the Invoices Google Sheet in sync with invoices actually sent from
// invoice.html, so the reminder script (ReminderEmails.gs) and the Stripe
// webhook (stripe-webhook.js) — both of which look a row up by
// invoice_number — always have something to find. Without this, sending an
// invoice from the tool never touched the sheet, and nothing downstream
// could track it.
//
// Reuses the same Google service account already configured for the
// webhook (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_KEY /
// GOOGLE_SHEET_ID) — no new secrets needed.

const { google } = require("googleapis");

const SHEET_NAME = "Invoices";

// Fallback header order, only used if the sheet has no header row yet.
const DEFAULT_COLUMNS = [
  "invoice_number", "to_name", "email", "church_name", "issue_date", "due_date",
  "amount_due", "card_total", "card_fee", "card_link", "ach_total", "bank_link",
  "notes", "status", "reminder_sent_on",
];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let invoice;
  try {
    invoice = JSON.parse(event.body || "{}");
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (!invoice.invoice_number) {
    return { statusCode: 400, body: JSON.stringify({ error: "invoice_number is required" }) };
  }

  try {
    const sheets = getSheetsClient_();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    if (!spreadsheetId) throw new Error("Missing GOOGLE_SHEET_ID environment variable");

    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEET_NAME}!A1:Z1000`,
    });
    const rows = data.values || [];
    const headers = rows.length ? rows[0] : DEFAULT_COLUMNS;

    const invoiceCol = headers.indexOf("invoice_number");
    if (invoiceCol === -1) throw new Error(`No "invoice_number" column found in the "${SHEET_NAME}" sheet.`);

    const existingIndex = rows.findIndex((row, i) => i > 0 && row[invoiceCol] === invoice.invoice_number);
    const existingRow = existingIndex === -1 ? null : rows[existingIndex];

    // Build the row in whatever order the sheet's own headers are in, so this
    // keeps working even if columns get reordered later. On an update
    // (resending a corrected invoice), status and reminder_sent_on are left
    // exactly as they were — this never un-marks a paid invoice or resets
    // reminder pacing.
    const rowValues = headers.map((h, idx) => {
      if (h === "status") return existingRow ? (existingRow[idx] || "Unpaid") : "Unpaid";
      if (h === "reminder_sent_on") return existingRow ? (existingRow[idx] || "") : "";
      const v = invoice[h];
      return v != null ? String(v) : "";
    });

    if (existingIndex === -1) {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [rowValues] },
      });
    } else {
      const sheetRowNumber = existingIndex + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${SHEET_NAME}!A${sheetRowNumber}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [rowValues] },
      });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, updated: existingIndex !== -1 }) };
  } catch (err) {
    console.error("Failed to sync invoice row:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

function getSheetsClient_() {
  const privateKey = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "").replace(/\\n/g, "\n");
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    privateKey,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth });
}
