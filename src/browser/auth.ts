const AUTH_TEXT_PATTERNS = [
  /\bsigned\s+in\s+to\s+another\s+device\b/i,
  /\bsession\s+(?:is\s+)?expired\b/i,
  /\bsign\s+in\b/i,
  /\blog\s+in\b/i
];

export function hasAuthSessionText(text: string): boolean {
  return AUTH_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}
