/**
 * Massage a clipboard payload before it is pushed to the remote
 * Guacamole clipboard for protocols whose terminals are picky about
 * line endings and paste framing.
 *
 * Background — why this exists
 * ----------------------------
 * Browsers normalise clipboard text to LF (`\n`) only per the HTML
 * spec. guacd's SSH/telnet protocol forwards clipboard payload bytes
 * verbatim into the SSH channel, with no line-ending translation.
 *
 * On a real keyboard, the Enter key transmits CR (`\r`); SSH PTYs
 * (and the line-discipline / raw-mode applications running inside
 * them, such as `nano`, `vim`, and bash's readline) are written to
 * recognise CR — not LF — as "the user pressed Enter". When LF
 * arrives instead, what happens is application-specific: nano in raw
 * mode may insert a literal `^J`, bash may treat the LF as
 * whitespace-equivalent, and tmux/screen may collapse runs of
 * whitespace. The user-visible symptom is that pasted multi-line
 * code arrives as one long line with the line breaks replaced by
 * spaces.
 *
 * Two transformations make this reliable:
 *
 *   1. Translate every `\n` (and `\r\n`) to a single `\r`. This is
 *      what an OS-level Enter keypress would have produced; the
 *      remote PTY's `icrnl` setting will then translate to `\n`
 *      where the application expects it (cooked mode), or pass `\r`
 *      through (raw mode) where the application binds CR to
 *      "newline" anyway.
 *
 *   2. Wrap the whole payload in bracketed paste markers
 *      (`ESC[200~ … ESC[201~`). Modern paste-aware applications —
 *      bash 4.4+, zsh 5.1+, vim 8+, nano 5.7+, tmux, screen — see
 *      these markers and switch into "paste mode" for the duration:
 *      auto-indent is suspended, key bindings on individual bytes
 *      are skipped, and the contents are inserted literally. Apps
 *      that do not understand the markers ignore them harmlessly
 *      because they are valid CSI sequences.
 *
 * RDP and VNC have their own clipboard semantics (RDP_CLIPRDR over
 * its own virtual channel; VNC's `cuttext`) and do NOT want either
 * transformation, so this helper returns the original text unchanged
 * for those protocols.
 *
 * Single-line SSH payloads — why we skip the wrappers
 * ---------------------------------------------------
 * Bracketed paste exists to make multi-line paste safe inside
 * paste-aware applications. A single-line payload (no `\n`, no
 * `\r`) does not need that protection: there is no auto-indent
 * concern, no per-keystroke binding hazard, and no line-ending
 * translation to do. More importantly, **password prompts**
 * (`sudo`, `ssh` password auth, `passwd`, `mysql -p`, …) read
 * stdin in raw no-echo mode and are not paste-aware, so the
 * literal bytes `\x1b[200~` and `\x1b[201~` would be ingested as
 * part of the password and authentication would fail. Skipping
 * the wrappers when the payload is a single line preserves the
 * common "paste my password" workflow while keeping the
 * multi-line protection above for code / config blocks.
 */
export function preparePastePayload(text: string, protocol: string): string {
  const proto = protocol.toLowerCase();
  if (proto !== "ssh" && proto !== "telnet") {
    // RDP / VNC / Kubernetes / etc. — leave the payload alone.
    return text;
  }

  // Single-line payload: pass through byte-for-byte. Bracketed-paste
  // markers and CR translation only matter when newlines are present;
  // wrapping a single line breaks password prompts (see comment block
  // above).
  if (!/[\r\n]/.test(text)) {
    return text;
  }

  // Normalise line endings: collapse CRLF to LF first so we don't
  // double-translate Windows clipboard input.
  const normalised = text.replace(/\r\n/g, "\n").replace(/\n/g, "\r");

  // Wrap in bracketed paste markers. The `\x1b[200~` opener tells a
  // paste-aware application to enter paste mode; `\x1b[201~` closes
  // it. Applications that do not implement bracketed paste will
  // silently ignore both sequences (they are valid CSI codes with no
  // visible effect).
  return `\x1b[200~${normalised}\x1b[201~`;
}
