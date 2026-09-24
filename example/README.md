# example

An Expo app exercising both entry points of `@mentiora/react-native-sdk`, named on the
home screen the way the rest of the industry names them:

- **Modal** — `Mentiora.open()`. `<MentioraHost />` presents the widget over the whole app
  in an overlay and parks it on the page's close control. Call it from anywhere: a header
  button, a push-notification tap, a deep link. The first open loads the page; later ones
  reveal the same warm one, so only the first costs seconds. `<MentioraHost />` is the
  last child in `app/_layout.tsx` — an overlay covers the navigator only by being later in
  the tree, where a Modal made order irrelevant.
- **Inline** — `<MentioraWidget />`. An ordinary component the app places in its own
  layout. The SDK never presents or dismisses it; it reports `{ type: 'close' }` and the
  host decides. `app/inline.tsx` navigates back.

The inline route hides the navigator header. The SDK injects the WINDOW's safe-area insets,
so a header above the widget makes the page pad for a status bar the header already cleared
— the same double-count a tab bar caused below it.

`<MentioraWidget />` fills the whole screen, which is what a customer embedding
full-screen ships and what the SDK's window-level safe-area insets are correct for. A
tab bar underneath both looked wrong and broke the layout: the SDK injects the WINDOW's
insets, so a tab bar occupying the bottom inset made the page pad for it twice.

The controls live on the home screen — `Mentiora.open()` /
`close()` / `logout()` and a log of every `onEvent` payload. For an SDK whose public
surface is a callback stream, that log is the demo. `<MentioraHost />` is mounted once
above the navigator in `app/_layout.tsx`; `Mentiora.open()` throws without it.

**The page's own close control is handled by the host app, not the SDK.** Embedded, the
SDK cannot know what closing means in your UI, so it emits `{ type: 'close' }` and stops
there — only `<MentioraHost />` dismisses anything by itself, because only it owns a
overlay to park. `app/inline.tsx` navigates back; a real app decides for itself.

An Expo example covers the bare React Native path too, because this package ships no
native module; the reverse is not true.

## Configure it first

One variable: the widget's hosted-page URL, origin and embed key in a single string.

```sh
cp example/.env.example example/.env.local
```

```
EXPO_PUBLIC_MENTIORA_WIDGET_URL=https://widget.acme.mentiora.ai/h/rn/pk_wgt_a1b2c3d4e5f6
```

The SDK takes that URL as `widgetUrl` unchanged. `src/config.ts` only checks its shape, so a
value that is set but malformed gets its own setup screen, distinct from not set at all,
rather than an exception from `Mentiora.configure()`.

### Signing in

`EXPO_PUBLIC_MENTIORA_IDENTITY_SECRET` is optional; omitted means anonymous chat and a
disabled Sign in. Get one from Mentiora admin — Embed → Identity keys → Generate secret,
shown exactly once.

**In your app that secret does not exist.** It belongs on your server, which is the only
party that knows who is signed in. `src/fake-backend.ts` stands in for that server, and
its header says so at length; it is faked only so the identified path runs without
deploying a backend first. Ship the secret in a real bundle and anyone who unzips the app
can forge a token for any user.

The emulation keeps the seam honest. `issueIdentityToken` is async, sleeps a network
round trip, and throws when nobody is signed in — the way a real endpoint answers 204 for
a signed-out caller. The app reaches it through `MentioraIdentity.getToken`, so swapping
in the real thing changes one function body in `src/config.ts`:

```ts
getToken: async () => {
  const res = await fetch('https://api.acme.com/identity/token', {
    method: 'POST',
    headers: { authorization: `Bearer ${yourSessionToken}` },
  });
  return (await res.json()).token;
}
```

The SDK's declarative `{ endpoint, headers, body }` form does the same thing without the
closure. `getToken` is used here only because a fake server has to live somewhere.

Sign in mints nothing by itself; the token is fetched when the widget next boots, so sign
in first and then open it. A failed mint is logged to the Events panel rather than
swallowed.

> Editing `src/config.ts` while the app is running does not change the identity the SDK
> holds. `Mentiora.configure` keeps the object it was given, and Fast Refresh hands the
> module a new one, so the running SDK goes on calling the old `getToken`. Cold-start the
> app after touching that file — reloading the bundle is not enough.

The app points at a **real** widget deployment. There is no stub page, deliberately: a
stub would be our reading of the bridge protocol, so a misreading would make the example
pass while the real widget fails.

> Expo inlines `EXPO_PUBLIC_*` at **bundle time**, so restart the bundler after editing
> `.env.local`. A hot reload will not pick it up. It also only inlines a literal
> `process.env.EXPO_PUBLIC_X` property access — `process.env[name]` and destructuring
> silently yield `undefined`.

### Against a local mentiora-cx stack

In the `mentiora-cx` checkout:

```sh
just dev -d      # brings the stack up; widget dev server lands on 5504
just widget      # creates a project, imports scripts/widget-dev/bundle, prints the key
```

`just widget` prints `embed key pk_wgt_…` and two tunnel URLs. Combine the key with the
widget dev server's port:

```
EXPO_PUBLIC_MENTIORA_WIDGET_URL=http://localhost:5504/h/rn/pk_wgt_2ybfz3g780wt
```

The iOS Simulator shares the host's loopback, so `localhost` needs no forwarding. On the
Android emulator run `adb reverse tcp:5504 tcp:5504` first and keep the same URL.

`just widget` also opens two cloudflared tunnels for its browser host page. The RN example
needs neither for the widget itself — `/h/rn/<key>` is served by the widget dev server
directly, and the page is same-origin with the WebView, so no embedding allow-list applies.

Sign-in needs neither tunnel either. `just widget` keeps its project's identity secret
in-process and never prints it, so rotate your own against the same project and put that
in `EXPO_PUBLIC_MENTIORA_IDENTITY_SECRET` — admin keeps two keys live, so the harness's
own key goes on working.

## Run on iOS

Needs Xcode and its Simulator, nothing else.

```sh
bun install                 # from the repo root, once
cd example
bun run ios
```

That opens Expo Go on the iOS Simulator. `react-native-webview`,
`@react-native-async-storage/async-storage` and `react-native-safe-area-context` are all
compiled into the Expo Go binary for SDK 57, so no native build is needed.

Expo Go on iOS sets `NSAllowsArbitraryLoads`, so a `http://localhost:…` widget origin
loads without further configuration.

## Run on a real phone

Expo Go from the App Store or Play Store, nothing built or signed. The three native peers
are compiled into that binary for SDK 57, so the phone runs the same JavaScript the
Simulator does.

1. Install **Expo Go** on the phone.
2. Put the phone on the same Wi-Fi as this machine. Metro binds every interface, so the
   phone reaches it at `exp://<your-lan-ip>:8081`.
3. `cd example && bun run start`, then open the project one of two ways:
   - **Scan the QR** in the terminal — the Camera app on iOS, the scanner inside Expo Go
     on Android.
   - **Type the URL.** On Expo Go's home screen tap *Enter URL manually* and enter
     `exp://<your-lan-ip>:8081`.

**Do not sign in to Expo Go.** Its account prompt exists only to populate the
*Development servers* list, which needs the app and the CLI logged into the same Expo
account. Neither route above uses that list, and no account is needed to run this project.
A QR also needs a real terminal: a bundler started in the background renders none, so run
`bun run start` yourself or type the URL.

If the two cannot share a network — a guest SSID with client isolation, or a phone on
mobile data — run `bun x expo start --tunnel` instead. It proxies through ngrok, needs no
LAN path, and is slower to reload.

Do not pass `--localhost`: it binds loopback only and the phone cannot reach it at all.

A widget origin on `http://localhost:…` is meaningless to a phone — that is the phone's
own loopback. Point `EXPO_PUBLIC_MENTIORA_WIDGET_URL` at a reachable https origin, which
is what a hosted or staging deployment already gives you.

## Run on Android

`adb` is not installed by default on macOS. Install the command-line tools once — no
Android Studio GUI required.

```sh
# 1. JDK 17. Gradle 9.3 and AGP 8.12 are happy on it.
brew install --cask temurin@17
export JAVA_HOME="/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home"

# 2. SDK command-line tools and adb.
brew install --cask android-commandlinetools android-platform-tools

# 3. Environment. ANDROID_HOME is the current name; ANDROID_SDK_ROOT is deprecated but
#    still read by some Gradle scripts, so exporting both costs nothing.
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
export PATH="/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin:$PATH"
mkdir -p "$ANDROID_HOME"

# 4. Licences and packages. Pass --sdk_root explicitly: the Homebrew cask installs into
#    the Cellar, and anything landing there is wiped on the next upgrade.
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" \
  "platform-tools" "platforms;android-36" "build-tools;36.0.0" \
  "emulator" "system-images;android-36;google_apis;arm64-v8a"

# 5. An AVD. arm64-v8a is mandatory on Apple Silicon — x86_64 images will not boot.
avdmanager --verbose create avd \
  --name "mentiora_api36" --force \
  --package "system-images;android-36;google_apis;arm64-v8a" --device "pixel_7"

# 6. Boot it, then wait for it.
emulator -avd mentiora_api36 &
adb wait-for-device shell 'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done'
```

Add those `export` lines to `~/.zshrc` to avoid repeating step 3.

Then:

```sh
cd example
bun run android
```

### Pointing at a widget server on your machine

```sh
adb reverse tcp:3000 tcp:3000
```

That makes the emulator's own `localhost:3000` reach your machine, so
`EXPO_PUBLIC_WIDGET_ORIGIN=http://localhost:3000` works unchanged on both platforms and
on a USB-attached physical device. `10.0.2.2` would also work on the emulator, but it is
a second code path that breaks everywhere else.

Cleartext http is allowed in debug builds: Expo's debug manifest sets
`usesCleartextTraffic="true"`, and `app.json` carries the matching iOS ATS entry. Release
builds block it.

## If you get a blank screen

None of these are SDK failures; all three cost me time, so they are written down.

**Check the simulator is actually booted.** `xcrun simctl list devices | grep Booted`.
A shut-down device shows as an empty pane, including inside Orca's emulator pane.

**Do not pass `--localhost`.** On this machine Metro then binds `[::1]:8081` — IPv6
loopback only — while Expo Go dials the IPv4 literal `127.0.0.1:8081` and reports "Could
not connect to the server". Plain `expo start` binds `*:8081`, which both reach. Confirm
with:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8081/status   # want 200
```

**A stale entry under Expo Go's RECENTLY OPENED does nothing when tapped.** It stores the
URL from a previous run, and with more than one active network interface that address may
not be the one the current bundler advertises. Use the live entry under DEVELOPMENT
SERVERS instead, or "Try again" on the error screen.

**A blank tab with the tab bar still visible** is the widget after its error card was
dismissed. Dismiss is component state and there is no page behind it, so the area stays
empty until the screen remounts. Fix the origin rather than the app.

## How it resolves the SDK

The example declares **no dependency** on `@mentiora/react-native-sdk`. bun refuses to
link the workspace root package as a member, and `file:..` gives a hardlink farm where
new files never appear and an atomic write leaves this app reading stale source.

So `metro.config.js` does the wiring: it adds the repo root to `watchFolders`, maps the
package name to the root directory, selects the private
`mentiora-react-native-sdk-source` export condition, and strips the `.js` extension from
the library's internal sibling imports — those exist for the ESM build, and Metro
resolves the TypeScript directly.

The effect is that this app runs `src/` live, never `lib/`. A verified bundle contains
every `src/**` file and no `lib/` output at all.

## Checks

```sh
cd example
bun x tsc --noEmit            # public API shape, no simulator needed
bun x expo export --platform ios
bun x expo export --platform android
```

## Known limits

The absent-optional-peer paths cannot be reached here. Expo Go bundles all three peers,
and `expo-router` requires `react-native-safe-area-context` outright, so
`storageUnavailable` with reason `peer-absent` is unreachable in any expo-router app.
That branch is covered by the unit tests and by the consumer-install CI job, which
installs the packed tarball under npm with the optional peer absent.
