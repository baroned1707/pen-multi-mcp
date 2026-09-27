// <PenProbe> for React Native / Expo dev builds: lets pen-multi's `verify` read the current screen
// (boxes, text, colors, typography) instead of guessing from a screenshot.
//
//   import { PenProbe } from "./PenProbe";
//   export default function App() { return <PenProbe><Root /></PenProbe>; }
//
// It does nothing in release builds (__DEV__ is false). While a dev build runs it polls
// http://<host>:<port>/pen-probe/next every 1.5 s; pen-multi only listens there during a capture,
// so the polls fail silently the rest of the time. Mark views with testID="pen:<layer address>".
import React from "react";
import { Dimensions, PixelRatio, StyleSheet, UIManager, processColor } from "react-native";
import { snapshotElements } from "./collect";

/** Measures a Fabric view that has no public instance yet, or a Paper view by its tag. */
function measureFallback(stateNode, done) {
  const fabric = global.nativeFabricUIManager;
  if (fabric && stateNode && stateNode.node) {
    fabric.measureInWindow(stateNode.node, done);
    return true;
  }
  const tag = stateNode && (stateNode._nativeTag ?? stateNode.canonical?.nativeTag ?? stateNode.nativeTag);
  if (typeof tag === "number" && UIManager.measureInWindow) {
    UIManager.measureInWindow(tag, done);
    return true;
  }
  return false;
}

export class PenProbe extends React.Component {
  componentDidMount() {
    if (typeof __DEV__ === "undefined" || !__DEV__ || this.props.enabled === false) return;
    this.timer = setInterval(() => this.poll(), this.props.interval ?? 1500);
  }

  componentWillUnmount() {
    clearInterval(this.timer);
  }

  get base() {
    return `http://${this.props.host ?? "localhost"}:${this.props.port ?? 7357}/pen-probe`;
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await fetch(`${this.base}/next`);
      if (res.status !== 200) return;
      const { id } = await res.json();
      if (!id || id === this.lastId) return;
      this.lastId = id;
      // React keeps a class component's fiber here (older React: _reactInternalFiber).
      const fiber = this._reactInternals ?? this._reactInternalFiber;
      const elements = await snapshotElements(fiber, { flatten: StyleSheet.flatten, processColor, measureFallback });
      const { width, height } = Dimensions.get("window");
      await fetch(`${this.base}/snapshot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, window: { width, height, scale: PixelRatio.get() }, elements }),
      });
    } catch {
      // pen-multi is not capturing right now
    } finally {
      this.busy = false;
    }
  }

  render() {
    return this.props.children ?? null;
  }
}

export default PenProbe;
