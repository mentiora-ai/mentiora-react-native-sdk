/**
 * `widgetUrl` is the hosted-page URL from the admin install snippet. The SDK needs its two
 * parts separately: the origin gates navigation, and the embed key keys the per-widget
 * runtime and storage.
 */
import { originOf } from './links.js';

export type WidgetPage = {
  /** Lower-cased `scheme://host[:port]`. */
  origin: string;
  embedKey: string;
  /** The page the WebView loads. */
  url: string;
};

// Exactly `/h/rn/<key>`: a query or fragment would be dropped from the loaded page,
// so it is refused rather than silently ignored.
const WIDGET_URL_RE = /^(https?:\/\/[^/?#]+)\/h\/rn\/([^/?#]+)\/?$/i;

const invalid = (widgetUrl: unknown): Error =>
  new Error(
    `mentiora: widgetUrl must be the hosted-page URL from the Mentiora install snippet, ` +
      `like https://widget.acme.mentiora.ai/h/rn/pk_wgt_…; got ${JSON.stringify(widgetUrl)}.`,
  );

/** Throws on anything that is not `http(s)://<host>/h/rn/<key>`. */
export const parseWidgetUrl = (widgetUrl: string): WidgetPage => {
  const m = typeof widgetUrl === 'string' ? WIDGET_URL_RE.exec(widgetUrl.trim()) : null;
  const origin = m ? originOf(m[1] as string) : null;
  if (!m || origin === null) throw invalid(widgetUrl);
  let embedKey: string;
  try {
    embedKey = decodeURIComponent(m[2] as string);
  } catch {
    throw invalid(widgetUrl);
  }
  return { origin, embedKey, url: `${origin}/h/rn/${encodeURIComponent(embedKey)}` };
};
