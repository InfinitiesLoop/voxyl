// Keeping an accidental Ctrl+W (the user flies with W) from closing the tab. What a page can
// and cannot do about it:
//
// - Chrome handles Ctrl+W, Ctrl+T and Ctrl+N itself, before the page sees the key, and does
//   not let `preventDefault` stop them in a normal tab. Pointer lock does not change that.
// - The Keyboard Lock API does hand those keys to the page, but only while the page is
//   fullscreen through `requestFullscreen()` (the browser's own F11 does not count).
//   So the Fullscreen button locks them; outside it nothing can.
// - What works everywhere is `beforeunload`: closing the tab then asks "Leave site?". It is
//   offered while it matters: flying, or a project that was never saved.

/** Keys a browser keeps for itself that the editor wants while it is fullscreen. */
export const TAB_KEYS: readonly string[] = [
  "KeyW",
  "KeyT",
  "KeyN",
  ...Array.from({ length: 9 }, (_, i) => `Digit${i + 1}`),
];

/** Whether closing the tab should ask first. */
export function tabGuardWanted(state: {
  hasProject: boolean;
  saved: boolean;
  flying: boolean;
}): boolean {
  return state.hasProject && (state.flying || !state.saved);
}

interface KeyboardLockApi {
  lock(codes?: readonly string[]): Promise<void>;
  unlock(): void;
}

function keyboardApi(): KeyboardLockApi | null {
  const keyboard = (navigator as { keyboard?: KeyboardLockApi }).keyboard;
  return keyboard && typeof keyboard.lock === "function" ? keyboard : null;
}

/** Whether this browser can capture Ctrl+W at all (Chromium only, and only fullscreen). */
export const canLockKeys = (): boolean => keyboardApi() !== null;

/** Fullscreen on or off. Entering it locks the tab-closing keys to the page. */
export async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  await document.documentElement.requestFullscreen();
}

/**
 * Installs the guards. `state` is read when a key or the close happens, so it is always
 * current. Returns the function that takes them off again.
 */
export function installTabGuard(state: () => Parameters<typeof tabGuardWanted>[0]): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  window.addEventListener(
    "beforeunload",
    (event) => {
      if (!tabGuardWanted(state())) return;
      event.preventDefault();
      // Older browsers read this; the text is never shown.
      event.returnValue = "";
    },
    { signal },
  );
  // Where the page does get the key (fullscreen with the keys locked), don't let it close.
  document.addEventListener(
    "keydown",
    (event) => {
      if ((event.ctrlKey || event.metaKey) && event.code === "KeyW" && state().flying) {
        event.preventDefault();
      }
    },
    { capture: true, signal },
  );
  document.addEventListener(
    "fullscreenchange",
    () => {
      const keyboard = keyboardApi();
      if (!keyboard) return;
      if (document.fullscreenElement) keyboard.lock(TAB_KEYS).catch(() => {});
      else keyboard.unlock();
    },
    { signal },
  );
  return () => controller.abort();
}
