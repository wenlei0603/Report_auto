export function sanitizeFilename(name: string, maxLength = 140): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return (cleaned || "report").slice(0, maxLength);
}
