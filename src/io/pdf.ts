import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";

export async function inspectPdf(filePath: string): Promise<{ pages: number; isPdf: boolean }> {
  const bytes = await readFile(filePath);
  const isPdf = bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (!isPdf) {
    return { pages: 0, isPdf: false };
  }
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return { pages: doc.getPageCount(), isPdf: true };
}
