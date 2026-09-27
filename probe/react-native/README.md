# pen-probe for React Native / Expo

Lets pen-multi's `verify` and `capture` read a React Native screen as data (boxes, text, colors, typography, radius, borders, markers) instead of guessing from a screenshot.

## Install

Copy `PenProbe.js` and `collect.js` into the app (e.g. `src/dev/`) and wrap the root once:

```jsx
import { PenProbe } from "./src/dev/PenProbe";

export default function App() {
  return (
    <PenProbe>
      <Root />
    </PenProbe>
  );
}
```

It is inert in release builds (`__DEV__` is false). In a dev build it polls `http://localhost:7357/pen-probe/next` every 1.5 s; pen-multi only listens there while a capture runs, so the polls fail silently the rest of the time.

Mark what you implement with the layer addresses `inspect` prints:

```jsx
<View testID="pen:Header">…</View>
<Text testID="pen:Header/Title">Checkout</Text>
```

## Use

```js
verify({ filePath: "app.pen", target: "Checkout", source: { kind: "probe", platform: "android" } })
verify({ filePath: "app.pen", target: "Checkout", source: { kind: "probe", platform: "ios", deepLink: "myapp://checkout" } })
```

- Android emulator / USB device: pen-multi runs `adb reverse tcp:7357 tcp:7357`, so `localhost` works.
- iOS simulator: shares the Mac's `localhost`.
- A device on Wi-Fi: `<PenProbe host="192.168.1.20">` (the Mac's LAN IP) and `PEN_MULTI_PROBE_LAN=1` for pen-multi.
- Props: `host`, `port` (7357), `interval` (1500 ms), `enabled`.

Works with the old (Paper) and new (Fabric) architectures. Nested `<Text>` spans are folded into their paragraph.
