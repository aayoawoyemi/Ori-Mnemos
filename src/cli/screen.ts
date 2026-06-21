/**
 * Alternate screen buffer + parchment background for interactive commands.
 * Used by ori init (boot sequence) and future TUI modes.
 * One-shot commands (status, health, query, etc.) do NOT use this.
 */

// OSC escape sequences for terminal color control
const ENTER_ALT = "\x1b[?1049h";
const EXIT_ALT = "\x1b[?1049l";
const SET_BG = "\x1b]11;#1a1816\x07";
const SET_FG = "\x1b]10;#e8e0d4\x07";
const RESET_BG = "\x1b]111\x07";
const RESET_FG = "\x1b]110\x07";
const CLEAR = "\x1b[2J\x1b[H";

let active = false;

function cleanup(): void {
  if (!active) return;
  process.stdout.write(RESET_FG + RESET_BG + EXIT_ALT);
  active = false;
}

/**
 * Enter parchment mode: alternate screen buffer + warm background.
 * Terminal transforms into the Ori parchment world.
 * Call exitParchment() or Ctrl+C to restore.
 */
export function enterParchment(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(ENTER_ALT + SET_BG + SET_FG + CLEAR);
  active = true;

  // Ensure clean restore on any exit path
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", cleanup);
}

/**
 * Exit parchment mode: restore original screen and colors.
 */
export function exitParchment(): void {
  cleanup();
  process.removeListener("SIGINT", cleanup);
  process.removeListener("SIGTERM", cleanup);
  process.removeListener("exit", cleanup);
}

/**
 * Whether parchment mode is currently active.
 */
export function isParchmentActive(): boolean {
  return active;
}
