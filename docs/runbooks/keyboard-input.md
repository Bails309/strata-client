# Runbook — Keyboard input problems in remote sessions

## Purpose

Find out why keystrokes in an RDP or SSH session produce the wrong
character, nothing at all, or a key that stays held down, and fix the
connection setting responsible.

## When to use

- _"`\` comes out as `#`"_, _"`@` and `"` are swapped"_, _"`£` types
  something else"_ — wrong characters.
- _"I can't type at the PowerShell prompt on Server Core, but Notepad
  works"_ — nothing typed reaches a console prompt.
- _"The numeric keypad does nothing"_ or _"the keypad moves the cursor"_.
- _"Caps Lock is on in the session but not on my keyboard"_.
- _"A key is stuck down"_ — every click selects, every letter is a
  shortcut.

This runbook applies to **v2.3.1 and later**. From v2.1.1 to v2.3.0 every
printable character was sent as a Unicode event regardless of layout, the
keypad digits were dropped, and Caps Lock and Num Lock were forwarded; on
those builds the procedure below does not apply.

## Prerequisites

- Admin access to **Admin → Connections** and **Admin → AD Sync**.
- Optionally, shell access to the backend host (`docker compose logs
  backend`) and read access to the database.
- From the user: the **connection name**, the **character they pressed and
  the character that appeared**, their **own** keyboard layout, and whether
  it happens in every application or only some (a console prompt, Notepad, a
  browser).

## Safety checks

1. **Do not restart the backend.** Every live session runs inside the
   backend process; a restart ends all of them.
2. A layout change applies to **new** sessions only. Ask the user to
   disconnect and reconnect after you change it; do not end their session for
   them.

## Procedure

### 1. Classify the symptom

| Symptom | Most likely cause | Go to |
| ------- | ----------------- | ----- |
| Wrong symbols; letters and digits fine | The connection's keyboard layout is not the remote user's layout | Step 2 |
| Letters swapped (`y`/`z`, `a`/`q`) | Same, with a QWERTZ or AZERTY remote user | Step 2 |
| Nothing typed at PowerShell / a console prompt, Notepad fine | The connection is set to **Failsafe (Unicode events)** or an unrecognised layout | Step 3 |
| Keypad digits do nothing | The user's **own** Num Lock is off (the browser then reports arrow keys), or the build predates v2.3.1 | Step 4 |
| Remote lock indicators differ from the user's keyboard | Expected — see Step 4 | Step 4 |
| A key stays held | A browser that lost focus mid-keystroke | Step 5 |

### 2. Wrong characters — match the layout to the remote user

Strata types each character on the connection's **Keyboard layout**, so that
setting must match the layout the **remote** Windows user has. The user's
own keyboard does not matter. A blank setting means **UK English**.

1. Find what the remote user actually has. In the remote session (any
   PowerShell window):

   ```powershell
   Get-WinUserLanguageList | Select-Object LanguageTag, InputMethodTips
   ```

   Expected output on a UK profile:

   ```
   LanguageTag InputMethodTips
   ----------- ---------------
   en-GB       {0809:00000809}
   ```

   The four hex digits after the colon are the keyboard layout:
   `00000809` UK, `00000409` US, `00000407` German, `0000040C` French, and so
   on.
2. Find what the connection says. **Admin → Connections → (connection) →
   Keyboard layout**, or in SQL:

   ```sql
   SELECT name, extra->>'server-layout' AS layout
     FROM connections
    WHERE protocol = 'rdp' AND name = '<connection name>';
   ```

   For connections created by AD sync, check the source too — it rewrites
   `extra` on every sync:

   ```sql
   SELECT label, connection_defaults->>'server-layout' AS layout
     FROM ad_sync_configs;
   ```

3. Set the layout to the remote user's (on the AD sync source as well, if the
   connection is synced). `NULL` or empty means `en-gb-qwerty`.
4. Ask the user to reconnect and retype the character.

If the remote user's layout is not one of the 19 Strata offers, choose
**Failsafe (Unicode events)**: every character then arrives correctly in GUI
applications, but console prompts on Server 2019/2022 will not accept typed
text (Step 3).

### 3. Nothing reaches a console prompt

The PSReadLine module built into Windows PowerShell on Server 2019 and 2022
ignores Unicode key events. Strata sends Unicode only when the connection's
layout is **Failsafe (Unicode events)**, when the layout name is not one it
knows, or for a single character that the layout has no key for.

1. Check the connection's layout as in Step 2. If it is `failsafe`, change it
   to the remote user's layout.
2. If it is anything else that is not in the admin panel's list (for example
   an old value imported from guacd, such as `cs-cz-qwertz`), the backend logs
   at session start:

   ```bash
   docker compose logs backend 2>&1 | grep 'unknown server-layout'
   ```

   ```
   WARN … layout="cs-cz-qwertz" unknown server-layout; sending Unicode key events
   ```

   Change it to a listed layout.
3. If only one particular character fails at the prompt, that character has
   no key on the configured layout and is sent as Unicode. Paste it instead
   (Ctrl+V reaches the console as a key press).
4. A bundled layout table that failed to parse would also fall back to
   Unicode. This should never happen in a released build; check for:

   ```bash
   docker compose logs backend 2>&1 | grep 'bundled keymap failed to parse'
   ```

### 4. Keypad and lock keys

- Strata does **not** forward Caps Lock or Num Lock to RDP. The browser
  applies both before reporting a key, and Strata keeps the remote side at
  **Num Lock on, Caps Lock off**. The remote session's own lock indicators
  (for example the on-screen keyboard or the logon screen's Caps Lock
  warning) therefore do not follow the user's keyboard. This is expected.
- With the user's Num Lock **on**, keypad digits type digits; Strata sets the
  remote Num Lock on before each one. With it **off**, the browser reports
  Home, End and arrow keys, and the keypad navigates — exactly as on a local
  machine. Ask the user to check their own Num Lock light first.
- The keypad decimal key types the **remote** layout's decimal separator
  (`,` on German and French layouts).
- VNC sessions pass keys to the VNC server unchanged and are outside this
  runbook.

### 5. A key stays held down

Strata releases each key exactly as it was pressed, so a release can no
longer be lost on the Strata side. A key stays down when the browser never
saw the release — typically when the window lost focus with the key held
(Alt+Tab with Shift down, a dialog stealing focus).

1. Ask the user to press and release the stuck key (often Shift, Ctrl or Alt)
   inside the session.
2. If that does not clear it, disconnect and reconnect the session.

## Verification

- In the remote session, the user types ``\ | @ " # ~ £ € ` ¬`` (or the
  equivalent symbols on their layout) into **both** Notepad and a PowerShell
  prompt, and the same characters appear in both.
- Keypad `1 2 3 . 4` types `123.4` (or `123,4` on a comma-decimal layout).

## Rollback

Restore the connection's or AD sync source's previous **Keyboard layout**.
Nothing else is changed by this runbook.

## Related

- [architecture.md § Keyboard: characters typed on the target's layout](../architecture.md#keyboard-characters-typed-on-the-targets-layout-v231)
  — the full per-keystroke decision table, modifier fix-ups and lock-key
  handling.
- [security.md § Layout keymaps and lock state](../security.md#layout-keymaps-and-lock-state-v231)
- [api-reference.md](../api-reference.md) — `server-layout` connection
  parameter and the v2.3.1 keyboard-input note on the WebSocket tunnel.
- [faq.md](../faq.md) — wrong characters, Server Core prompt, numeric keypad.
- [clipboard-diagnostics.md](clipboard-diagnostics.md) — when pasting rather
  than typing is the problem.

_Last reviewed: 2026-10-04 (v2.3.1)._
