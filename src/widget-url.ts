import { originOf } from './links.js';

export type WidgetPage = {
  /** Lower-cased `scheme://host[:port]`. */
  origin: string;
  embedKey: string;
  url: string;
};

// A query or fragment would be dropped from the loaded page, so it is refused.
const WIDGET_URL_RE = /^(https?:\/\/[^/?#]+)\/h\/rn\/([^/?#]+)\/?$/i;

const invalid = (widgetUrl: unknown): Error =>
  new Error(
    `mentiora: widgetUrl must be the hosted-page URL from the Mentiora install snippet, ` +
      `like https://widget.acme.mentiora.ai/h/rn/pk_wgt_…; got ${JSON.stringify(widgetUrl)}.`,
  );

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
