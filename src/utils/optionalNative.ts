// ============================================================
// src/utils/optionalNative.ts
// ============================================================
// Optional native modules, probed safely.
//
// THE BUG THIS PREVENTS:
// A native module can be present in package.json and still be ABSENT from the
// running binary — a JS reload cannot add native code, only a rebuild can.
// When that happens, importing it at module scope throws immediately:
//
//     [runtime not ready]: Error: Cannot find native module 'ExpoDocumentPicker'
//
// and because the import sits at the top of a screen, the ENTIRE app fails to
// boot. One missing module silently removes every feature.
//
// HOW TO READ THIS: `available` runs the loader exactly once, inside a
// try/catch. `get()` returns the module or null. Never require an optional
// native module anywhere else in the app.
//
// ⚠️ EVERY require() IN THIS FILE USES A STATIC STRING LITERAL, AND THAT IS
// MANDATORY. Metro resolves requires at BUILD time by reading the source; it
// cannot follow `require(someVariable)`. Doing so fails the bundle outright:
//
//     Android Bundling failed
//     Error: src/utils/optionalNative.ts:Invalid call at line 48: require(id)
//
// That is exactly what the first version of this file did. So the probe takes
// a LOADER FUNCTION whose body contains a literal, rather than an id string.
// ============================================================

/* eslint-disable @typescript-eslint/no-var-requires */

declare function require(id: string): unknown;

export interface OptionalModule {
  /** true once probed and the native module resolved */
  available: boolean;
  /** the module, or null when it is missing from this build */
  get: () => unknown;
  /** human-readable reason it is unavailable, or null when it is fine */
  reason: () => string | null;
}

/**
 * Wrap a literal-argument require in a lazy, single-shot probe.
 *
 * `loader` MUST be `() => require('literal-string')`. Passing a computed id
 * here breaks the Metro bundle.
 */
function makeProbe(loader: () => unknown, label: string): OptionalModule {
  let probed = false;
  let value: unknown = null;

  const run = (): void => {
    if (probed) return;
    probed = true;
    try {
      value = loader();
    } catch {
      value = null;
    }
  };

  return {
    get available(): boolean {
      run();
      return value !== null;
    },
    get(): unknown {
      run();
      return value;
    },
    reason(): string | null {
      run();
      return value === null
        ? `${label} is not in this build — rebuild the app to enable it`
        : null;
    },
  };
}

/**
 * Probed once per app launch, on first use rather than at import, so a missing
 * module costs nothing until the user actually reaches for that feature.
 */
export const documentPicker = makeProbe(
  () => require('expo-document-picker'),
  'File sharing'
);

export const cameraModule = makeProbe(() => require('expo-camera'), 'The camera');

export const imageManipulator = makeProbe(
  () => require('expo-image-manipulator'),
  'The photo editor'
);

export const locationModule = makeProbe(() => require('expo-location'), 'Location sharing');

export const localAuth = makeProbe(
  () => require('expo-local-authentication'),
  'Biometric app lock'
);

/**
 * Resolve a screen component that DEPENDS on an optional native module.
 *
 * Two things make this subtle, and both were wrong in an earlier version:
 *
 * 1. We must require the SCREEN file, not the native module. The native module
 *    is not a React component; casting `require('expo-camera')` to a component
 *    type compiles fine and fails at runtime. The cast was the smell.
 *
 * 2. Every `require` here uses a STATIC STRING LITERAL, for the Metro reason
 *    explained at the top of this file. That is why this is a switch over fixed
 *    ids rather than a generic path helper.
 *
 * Returns null when the native module is missing from this build, so callers
 * render a disabled control instead of crashing the whole app.
 */
export function optionalComponentById<P>(
  id: 'camera' | 'editor' | 'location',
  nativeProbe: OptionalModule
): React.ComponentType<P> | null {
  if (!nativeProbe.available) return null;

  try {
    switch (id) {
      case 'camera': {
        // From src/utils/ the screen lives one level up: ../screens/…
        const mod = require('../screens/CameraScreen') as {
          default?: React.ComponentType<P>;
        };
        return mod.default ?? null;
      }
      case 'editor': {
        const mod = require('../screens/MediaEditorScreen') as {
          default?: React.ComponentType<P>;
        };
        return mod.default ?? null;
      }
      case 'location': {
        const mod = require('../components/chat/LocationPicker') as {
          default?: React.ComponentType<P>;
        };
        return mod.default ?? null;
      }
      default:
        return null;
    }
  } catch {
    // The screen threw on load even though the native module resolved — treat
    // it as unavailable rather than taking the app down.
    return null;
  }
}
