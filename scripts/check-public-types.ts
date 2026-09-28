// Names every exported type from outside the package, so a missing one is a TS2305.
// The negative cases catch a union widened to `string`. ci.yml compiles it against the
// packed tarball; `bun run typecheck` resolves the import to `src` via `customConditions`.
import type {
  MentioraConfig,
  MentioraErrorCode,
  MentioraErrorRenderProps,
  MentioraEvent,
  MentioraIdentity,
  MentioraIdentityCallback,
  MentioraIdentityFetcher,
  MentioraStorage,
  MentioraStrings,
  MentioraWidgetProps,
  StorageUnavailableReason,
} from '@mentiora-ai/react-native-sdk';

const storage: MentioraStorage = {
  getItem: async () => null,
  setItem: async () => {},
  removeItem: async () => {},
};
const callback: MentioraIdentityCallback = { getToken: () => 'jwt' };
const fetcher: MentioraIdentityFetcher = {
  endpoint: 'https://api.acme.com/mentiora/token',
  headers: () => ({ Authorization: 'Bearer x' }),
  body: () => ({ scope: 'widget' }),
};
const identity: MentioraIdentity = callback satisfies MentioraIdentity;
const strings: Partial<MentioraStrings> = { retry: 'Nochmal' };
const code: MentioraErrorCode = 'handshake_timeout';
const reason: StorageUnavailableReason = 'peer-absent';

const events: MentioraEvent[] = [
  { type: 'ready' },
  { type: 'close' },
  { type: 'identityError', reason: 'identity_required' },
  { type: 'openUrl', url: 'https://example.com' },
  { type: 'error', code },
  { type: 'storageUnavailable', reason },
  { type: 'unreadCountChanged', count: 3 },
  { type: 'installRefChanged', installRef: null },
  { type: 'installRefChanged', installRef: 'ab' },
];

// `.ts`, so no JSX: `null` is a valid ReactNode.
const renderError = ({ code: shown, retry, dismiss }: MentioraErrorRenderProps) => {
  if (shown === 'load_failed') retry();
  else dismiss();
  return null;
};

const config: MentioraConfig = {
  widgetUrl: 'https://widget.acme.mentiora.ai/h/rn/pk_wgt_x',
  identity,
  storage,
  strings,
  renderError,
  onEvent: (event: MentioraEvent) => void event,
  onOpenUrl: (url: string) => url.startsWith('https:'),
};
const props: MentioraWidgetProps = config;

// @ts-expect-error not a MentioraErrorCode
const badCode: MentioraErrorCode = 'nope';
// @ts-expect-error not a MentioraEvent variant
const badEvent: MentioraEvent = { type: 'nope' };
// @ts-expect-error widgetUrl is required
const badConfig: MentioraConfig = { identity };
// @ts-expect-error 'override' means storage WORKS: it can never accompany the event
const badReason: StorageUnavailableReason = 'override';
// @ts-expect-error the count is a number, never a string
const badCount: MentioraEvent = { type: 'unreadCountChanged', count: '3' };

export default {
  fetcher,
  events,
  config,
  props,
  badCode,
  badEvent,
  badConfig,
  badReason,
  badCount,
};
