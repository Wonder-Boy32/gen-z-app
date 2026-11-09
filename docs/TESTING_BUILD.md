# Testing build — install once, then every change is live

This app cannot run in Expo Go. It needs native modules Expo Go does not ship
(`ffmpeg-expo`, `expo-camera` with the capture surface, `expo-screen-capture`,
`react-native-qrcode-svg`). So testing means a **development build**: a real
APK with `expo-dev-client` baked in.

The point of that build is that **you only install it once**. After that, the
Metro bundler serves the JavaScript, and every save reaches the phone in about
a second. No new APK per change.

```
APK (native, install once)  ──connects to──▶  Metro (npx expo start)
                                                   ▲
                                            your code changes
```

If you rebuild the APK for every change you are doing the slow version. Only
rebuild when you add or update a **native** dependency, change `app.json`
(plugins, icons, permissions, splash), or bump the Expo SDK.

---

## First time only

```powershell
npm run build:dev
```

Cloud build on EAS (the `development` profile in `eas.json`), Android APK,
internal distribution. Takes roughly 10–15 minutes. When it finishes, EAS
prints a URL and a QR code — open the URL on the phone and install the APK.
Android will warn that it is from an unknown source; allow it.

Only one person needs to run this. The same APK works for anyone who scans it.

---

## Every day after that

```powershell
npm run dev
```

That is `expo start --dev-client`. It prints a QR code:

1. Phone and laptop on the **same Wi-Fi**.
2. Open the Gen Z dev app on the phone.
3. It lists the Metro server automatically — tap it. Or scan the QR with the
   camera / the dev client's own scanner.

The app boots against the bundle Metro is serving. Now edit a file and save:
Fast Refresh applies it in place, usually without losing the screen you are on.

Useful keys in the Metro terminal:

| Key | Does |
|---|---|
| `r` | reload the app |
| `j` | open the JS debugger |
| `m` | toggle the developer menu on the phone |
| `shift+m` | open the dev menu |

---

## When Wi-Fi is not an option

Tethered or on mobile data, use a tunnel:

```powershell
npx expo start --dev-client --tunnel
```

Slower, but it works across networks.

---

## The three builds, and when each is right

| Command | Profile | What it is | Rebuild needed? |
|---|---|---|---|
| `npm run build:dev` | `development` | Dev client + Metro. Live reload. | Once, then only for native changes |
| `npm run build:preview` | `preview` | Release JS baked in. No Metro. | Every change |
| `npm run build:prod` | `production` | Same, versioned for the store. | Every release |

For "I want to see the new update right now", it is `dev`. `preview` exists for
handing someone a build that works with no laptop nearby.

---

## If it will not connect

- **Same network.** A laptop on `5GHz` and a phone on a guest SSID is still
  two networks.
- **Windows Firewall.** Metro listens on 8081. If the phone never sees the
  server, allow `node.exe` on private networks — the first run usually prompts,
  and dismissing that prompt silently blocks it.
- **The dev app is stale.** If it opens to a blank screen, shake the phone and
  pick *Reload*, or press `r` in Metro.
- **Wrong build installed.** A `preview` or `production` APK has no dev client
  and cannot talk to Metro at all. Check the app name/icon of what you
  installed.

---

## Not built yet: over-the-air updates

Everything above needs the laptop running Metro. To check a new update from
anywhere with no laptop, the app would need `expo-updates` and an EAS Update
channel — the build pulls the new JS bundle on next launch, like a store update
but instant.

That is a separate decision: it changes how releases work (a published update
reaches every install, and needs its own rollback story). Say the word and I
will wire it, but it is not required for the loop above.
