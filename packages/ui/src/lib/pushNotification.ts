// Push payload parsing for the service worker (pure). The daemon sends a JSON
// body { title, body, url }; the SW's `push` handler parses it here and calls
// showNotification(title, { body, data: { url } }). Kept pure + tested so the SW
// itself stays a thin shell (it can't be unit-tested directly).

export interface ParsedPushNotification {
  title: string;
  body: string;
  url: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

// Tolerant parse: a malformed or partial payload returns null so the SW can fall
// back to a generic notification rather than throwing inside the push handler.
export function parsePushPayload(raw: string): ParsedPushNotification | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (!isNonEmptyString(record.title) || !isNonEmptyString(record.body) || !isNonEmptyString(record.url)) {
    return null;
  }
  return { title: record.title, body: record.body, url: record.url };
}

// The notification the SW shows for a payload — or a generic fallback when the
// payload is missing/malformed. Deep-link url is null in the fallback.
export interface NotificationView {
  title: string;
  body: string;
  url: string | null;
}

const FALLBACK: NotificationView = { title: 'VIMES', body: 'A session needs your attention', url: null };

export function notificationViewFrom(raw: string | undefined): NotificationView {
  if (raw === undefined) {
    return FALLBACK;
  }
  const parsed = parsePushPayload(raw);
  return parsed === null ? FALLBACK : { title: parsed.title, body: parsed.body, url: parsed.url };
}
