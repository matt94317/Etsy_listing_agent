// Fetches a specific item's pre-processed photos, given that item's Drive
// folder — identity comes from the Sheet row's explicit folder link, never
// from folder creation order, so re-processing/re-uploading photos into
// the same folder never causes a mismatch with a different row.

import { google } from "googleapis";
import { auth } from "./google-auth.js";

const drive = google.drive({ version: "v3", auth });

export function folderIdFromUrl(urlOrId) {
  const match = urlOrId.match(/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : urlOrId.trim();
}

export async function listFolderContents(folderId) {
  const { data } = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: "files(id, name, mimeType)",
    pageSize: 100,
  });
  return data.files;
}

export async function downloadFile(fileId) {
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}
