// Updates one or more columns on a single invoice row in the Invoices
// Google Sheet, matched by invoice_number. Used by the dashboard
// (dashboard.html) for "Mark Paid" / "Mark Unpaid" and editing a due date.
//
// POST body: { invoice_number: "INV-...", status?: "Paid"|"Unpaid", due_date?: "YYYY-MM-DD" }
// Only the fields provided are changed — anything else on the row is left alone.
//
// Reuses the same Google service account as the other functions
// (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_KEY / GOOGLE_SHEET_ID).

const { google } = require("googleapis");

const SHEET_NAME = "Invoices";
const EDITABLE_COLUMNS = ["status", "due_date"];

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

  const updates = EDITABLE_COLUMNS.filter(col => body[col] !== undefined);
  if (updates.length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Nothing to update — provide one of: ${EDITABLE_COLUMNS.join(", ")}` }),
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
    const invoiceCol = headers.indexOf("invoice_number");
    if (invoiceCol === -1) throw new Error(`No "invoice_number" column found in the "${SHEET_NAME}" sheet.`);

    const rowIndex = rows.findIndex((row, i) => i > 0 && row[invoiceCol] === invoice_number);
    if (rowIndex === -1) {
      return { statusCode: 404, body: JSON.stringify({ error: `No invoice found with number ${invoice_number}` }) };
    }
    const sheetRowNumber = rowIndex + 1; // 1-indexed, matches the sheet's own row numbers

    const writes = [];
    for (const col of updates) {
      const colIndex = headers.indexOf(col);
      if (colIndex === -1) continue; // sheet doesn't have this column — skip quietly
      const columnLetter = columnLetter_(colIndex);
      writes.push({
        range: `${SHEET_NAME}!${columnLetter}${sheetRowNumber}`,
        values: [[String(body[col])]],
      });
    }

    if (writes.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `None of [${updates.join(", ")}] exist as columns in the sheet` }),
      };
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data: writes },
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("Failed to update invoice:", err.message);
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
