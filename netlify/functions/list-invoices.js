// Returns every row of the Invoices Google Sheet as JSON, for the dashboard
// (dashboard.html) to render. Read-only — no sheet writes happen here.
//
// Reuses the same Google service account already set up for
// add-invoice-row.js / stripe-webhook.js (GOOGLE_SERVICE_ACCOUNT_EMAIL /
// GOOGLE_SERVICE_ACCOUNT_KEY / GOOGLE_SHEET_ID) — no new secrets needed.

const { google } = require("googleapis");

const SHEET_NAME = "Invoices";

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
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
    if (rows.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ invoices: [] }) };
    }

    const headers = rows[0];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const invoices = rows.slice(1)
      .filter(row => row.some(cell => cell !== undefined && cell !== ""))
      .map(row => {
        const invoice = {};
        headers.forEach((h, i) => { invoice[h] = row[i] !== undefined ? row[i] : ""; });

        let daysOverdue = null;
        if (invoice.due_date) {
          const dueDate = new Date(invoice.due_date);
          if (!isNaN(dueDate)) {
            dueDate.setHours(0, 0, 0, 0);
            daysOverdue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
          }
        }
        invoice.days_overdue = daysOverdue;

        return invoice;
      });

    return { statusCode: 200, body: JSON.stringify({ invoices }) };
  } catch (err) {
    console.error("Failed to list invoices:", err.message);
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
