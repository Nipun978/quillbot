/**
 * ttyManager.js
 *
 * Windows Console & TTY Stream Lifecycle Manager.
 *
 * ROOT CAUSE OF CLI INPUT FREEZING ON WINDOWS:
 * In Node.js on Windows, whenever an @inquirer prompt settles (such as when the user
 * hits Enter to select a dropdown choice in @inquirer/select), Inquirer's screen.done()
 * calls this.rl.close(). Node's built-in readline.close() invokes:
 *   1) this.pause() -> process.stdin.pause() (which halts libuv via uv_tty_read_stop)
 *   2) this._setRawMode(false) -> process.stdin.setRawMode(false) (which restores
 *      ENABLE_LINE_INPUT and ENABLE_ECHO_INPUT in the Windows console driver).
 *
 * When the subsequent prompt (such as @inquirer/input or replInputPrompt) begins, it calls
 * process.stdin.setRawMode(true) and process.stdin.resume(). However, because the previous prompt
 * closed right upon receiving Enter, the Windows console driver enters a line-buffered state
 * where libuv's TTY reader is blocked waiting for a carriage return / Enter keypress to flush.
 * During this state, keystrokes are buffered by the OS kernel and NOT delivered as individual
 * keypress events to @inquirer/input (which mutes console echo). The CLI appears completely
 * frozen and unresponsive until the user presses Enter, which flushes the line buffer and
 * synchronizes libuv's raw mode reader.
 *
 * SOLUTION:
 * enableStdinProtection() maintains process.stdin in an active, raw state during the
 * interactive CLI session. It intercepts process.stdin.pause() and process.stdin.setRawMode(false)
 * so that internal prompt teardowns (rl.close()) between chained prompts do not halt libuv's
 * console reader thread or drop the Windows console into line-buffered mode.
 */

let isProtected = false;
let originalPause = null;
let originalSetRawMode = null;
let cleanupRegistered = false;

/**
 * Ensures process.stdin is resumed, referenced, and in raw mode if running in a TTY.
 */
export function ensureStdinRaw() {
  if (process.stdin.isTTY) {
    try {
      if (typeof process.stdin.ref === 'function') {
        process.stdin.ref();
      }
      if (process.stdin.isPaused()) {
        process.stdin.resume();
      }
      if (!process.stdin.isRaw && typeof process.stdin.setRawMode === 'function') {
        process.stdin.setRawMode(true);
      }
    } catch {}
  }
}

/**
 * Enables TTY stream protection to prevent process.stdin from being paused
 * or downgraded to cooked mode by intermediate readline.close() calls.
 *
 * Returns a restore function that can be called upon process exit.
 */
export function enableStdinProtection() {
  if (!process.stdin.isTTY) {
    return () => {};
  }

  if (isProtected) {
    ensureStdinRaw();
    return disableStdinProtection;
  }

  originalPause = process.stdin.pause;
  originalSetRawMode = process.stdin.setRawMode;

  ensureStdinRaw();

  isProtected = true;

  process.stdin.pause = function () {
    if (isProtected) {
      // Prevent intermediate prompt close() from pausing the stream on Windows
      return this;
    }
    return originalPause ? originalPause.apply(this, arguments) : this;
  };

  process.stdin.setRawMode = function (mode) {
    if (isProtected && mode === false) {
      // Prevent intermediate prompt close() from dropping to cooked/line-input mode
      return this;
    }
    return originalSetRawMode ? originalSetRawMode.apply(this, arguments) : this;
  };

  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once('exit', () => {
      disableStdinProtection();
    });
  }

  return disableStdinProtection;
}

/**
 * Disables TTY stream protection and restores original stdin methods.
 */
export function disableStdinProtection() {
  if (!isProtected) return;

  isProtected = false;

  if (originalPause) {
    process.stdin.pause = originalPause;
    originalPause = null;
  }

  if (originalSetRawMode) {
    process.stdin.setRawMode = originalSetRawMode;
    originalSetRawMode = null;
  }

  if (process.stdin.isTTY) {
    try {
      if (typeof process.stdin.setRawMode === 'function') {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    } catch {}
  }
}

/**
 * Temporarily suspends TTY stream protection (for launching external editors like Notepad or Nano)
 * and returns a callback to resume protection once the child process completes.
 */
export function suspendStdinProtection() {
  if (!isProtected || !process.stdin.isTTY) {
    return () => {};
  }

  isProtected = false;

  try {
    if (originalSetRawMode) {
      originalSetRawMode.call(process.stdin, false);
    }
    if (originalPause) {
      originalPause.call(process.stdin);
    }
  } catch {}

  return function resumeProtection() {
    isProtected = true;
    ensureStdinRaw();
  };
}
