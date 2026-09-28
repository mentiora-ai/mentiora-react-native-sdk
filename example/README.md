# Example

An Expo app that drives both entry points of `@mentiora/react-native-sdk` against your real widget. The home screen opens the overlay or the inline screen and logs every `onEvent` payload.

## Configure

Copy the env file and set the widget URL from the install snippet in Mentiora admin. Restart the bundler after every edit, because Expo inlines these values at bundle time.

```sh
cp example/.env.example example/.env.local
```

```
EXPO_PUBLIC_MENTIORA_WIDGET_URL=https://widget.<your-workspace>.mentiora.ai/h/rn/pk_wgt_…
```

## Sign in

Set an identity secret from Mentiora admin (Embed → Identity keys) to enable Sign in. `src/fake-backend.ts` stands in for your server; in a real app the secret never leaves your backend.

```
EXPO_PUBLIC_MENTIORA_IDENTITY_SECRET=pik_live_…
```

## Run on iOS

Needs Xcode and the Simulator.

```sh
bun install
cd example && bun run ios
```

## Run on a phone

Install Expo Go, join the same Wi-Fi as your computer, and scan the QR code. Use `--tunnel` if the phone cannot reach your computer.

```sh
cd example && bun run start
```

## Run on Android

Needs JDK 17, the Android command-line tools and an arm64 emulator image.

```sh
brew install --cask temurin@17 android-commandlinetools android-platform-tools
export ANDROID_HOME="$HOME/Library/Android/sdk" PATH="$HOME/Library/Android/sdk/emulator:$HOME/Library/Android/sdk/platform-tools:$PATH"
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" "platform-tools" "platforms;android-36" "emulator" "system-images;android-36;google_apis;arm64-v8a"
avdmanager create avd --name mentiora --package "system-images;android-36;google_apis;arm64-v8a" --device pixel_7
emulator -avd mentiora &
cd example && bun run android
```

## Push notifications

`src/push.ts` asks for permission, logs the device token and `installRef`, and routes taps through `Mentiora.handleNotificationOpen`. Put a real thread id into `push/reply.apns` and send it to a development build on the Simulator.

```sh
xcrun simctl push booted ai.mentiora.example.dev example/push/reply.apns
```

## Checks

These type-check the example and bundle it for both platforms.

```sh
cd example
bun x tsc --noEmit
bun x expo export --platform ios
bun x expo export --platform android
```
