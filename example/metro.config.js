const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

// The SDK is the repo root package. bun will not link a root package as a workspace
// member, and `file:..` hardlinks go stale on atomic writes, so Metro resolves it instead.
const root = path.resolve(__dirname, '..');
const config = getDefaultConfig(__dirname);

config.watchFolders = [...config.watchFolders, root];

// Watching the whole root means the SDK's own build outputs look like source edits:
// `bun run build` writes `lib/`, `test:core` writes `lib-test/`, and each run made Metro
// rebundle and reload the running app mid-use. Only `src/` is ever resolved from the root,
// so the rest is noise.
const IGNORED_IN_ROOT = ['lib', 'lib-test', 'dist', 'coverage', '.git', '.specs'];
const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList)
    ? config.resolver.blockList
    : config.resolver.blockList
      ? [config.resolver.blockList]
      : []),
  new RegExp(`^${escapedRoot}/(${IGNORED_IN_ROOT.join('|')})/.*`),
];
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@mentiora/react-native-sdk': root,
};

// Selects the `src/` branch of the root exports map instead of the built `lib/`.
config.resolver.unstable_conditionNames = [
  'mentiora-react-native-sdk-source',
  ...config.resolver.unstable_conditionNames,
];

// SDK sources import siblings as `.js` for the ESM build; Metro will not map `.js` to
// `.ts`, so strip it for relative imports originating in the SDK's `src/`.
const sdkSource = path.join(root, 'src');
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const rewritten =
    moduleName.startsWith('.') &&
    moduleName.endsWith('.js') &&
    context.originModulePath.startsWith(sdkSource)
      ? moduleName.slice(0, -'.js'.length)
      : moduleName;
  return context.resolveRequest(context, rewritten, platform);
};

module.exports = config;
