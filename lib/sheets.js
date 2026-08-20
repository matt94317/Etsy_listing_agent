// Reads/writes one shop's Listings sheet — the source of truth for both
// each item's raw facts and its status through the pipeline. Column order
// doesn't matter, only the header names in row 1 (case-sensitive, must
// match what publish-listing.js reads/writes exactly).

import { google } from "googleapis";
import { auth } from "./google-auth.js";

const sheets = google.sheets({ version: "v4", auth });

const TAB = "Listings";

function columnLetter(index) {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function getHeader(sheetId) {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB}!1:1`,
  });
  return (data.values && data.values[0]) || [];
}

// Returns every row as { _row: <sheet row number>, "Column Name": value, ... }
export async function getRows(sheetId) {
  const header = await getHeader(sheetId);
  if (header.length === 0) return [];

  // Range width has to cover every header column — a fixed A:Z silently
  // truncates anything past column 26, which real sheets exceed easily
  // once reference-only columns pile up.
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB}!A2:${columnLetter(header.length - 1)}`,
  });
  const rows = data.values || [];
  return rows.map((row, i) => {
    const obj = { _row: i + 2 }; // +1 for 1-indexing, +1 for the header row
    header.forEach((key, colIndex) => {
      obj[key.trim()] = row[colIndex] || "";
    });
    return obj;
  });
}

// fields: { "Status": "Drafted", "Title": "...", ... } — column names must
// already exist in row 1.
export async function updateRowFields(sheetId, rowNumber, fields) {
  const header = await getHeader(sheetId);
  const data = Object.entries(fields).map(([key, value]) => {
    const colIndex = header.findIndex((h) => h.trim() === key);
    if (colIndex === -1) {
      throw new Error(`Column "${key}" not found in row 1 of the sheet`);
    }
    return {
      range: `${TAB}!${columnLetter(colIndex)}${rowNumber}`,
      values: [[value]],
    };
  });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { valueInputOption: "RAW", data },
  });
}
