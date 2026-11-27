// Tiny {{placeholder}} template renderer shared by the invoice and reminder
// email functions. Templates live as plain .html files in ./templates so
// they can be opened and tweaked without touching any JS — this module just
// loads one and swaps in the values computed by the caller.

const fs = require("fs");
const path = require("path");

function loadTemplate_(filename) {
  return fs.readFileSync(path.join(__dirname, "..", "templates", filename), "utf8");
}

// Replaces every {{key}} in the template with data[key] (empty string if the
// key is missing or null/undefined). Values are inserted as-is — callers are
// responsible for HTML-escaping anything that isn't already safe markup
// (see esc_() in each function file), since a block value like a pre-built
// row of <tr> markup needs to pass through unescaped.
function render_(template, data) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = data[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

module.exports = { loadTemplate_, render_ };
