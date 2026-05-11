import { describe, it, expect } from "vitest";
import { preparePastePayload } from "../components/pastePayload";

describe("preparePastePayload", () => {
  it("passes RDP payloads through untouched", () => {
    const text = "line one\nline two\r\nline three";
    expect(preparePastePayload(text, "rdp")).toBe(text);
  });

  it("passes VNC payloads through untouched", () => {
    const text = "hello\nworld";
    expect(preparePastePayload(text, "vnc")).toBe(text);
  });

  it("wraps multi-line SSH payloads in bracketed paste markers", () => {
    const out = preparePastePayload("hi\nthere", "ssh");
    expect(out.startsWith("\x1b[200~")).toBe(true);
    expect(out.endsWith("\x1b[201~")).toBe(true);
  });

  it("passes single-line SSH payloads through untouched (password-prompt safety)", () => {
    // Password prompts (sudo, ssh password auth, mysql -p, …) read stdin
    // in raw no-echo mode and are not bracketed-paste-aware. Wrapping a
    // single-line payload would cause the literal escape bytes to be
    // ingested as part of the password. See preparePastePayload.ts
    // header comment for the full rationale.
    expect(preparePastePayload("hunter2", "ssh")).toBe("hunter2");
    expect(preparePastePayload("hunter2", "telnet")).toBe("hunter2");
    expect(preparePastePayload("p@ss w0rd!", "ssh")).toBe("p@ss w0rd!");
  });

  it("does not add a trailing CR to a single-line SSH paste", () => {
    // A trailing CR would auto-submit the password prompt, which is
    // never what a copy-paste of a password should do — pressing Enter
    // is the user's job, not the paste handler's.
    const out = preparePastePayload("hunter2", "ssh");
    expect(out.endsWith("\r")).toBe(false);
    expect(out.endsWith("\n")).toBe(false);
  });

  it("translates LF to CR for SSH so the remote PTY sees real Enter", () => {
    const out = preparePastePayload("a\nb\nc", "ssh");
    // Strip wrappers
    const inner = out.slice("\x1b[200~".length, -"\x1b[201~".length);
    expect(inner).toBe("a\rb\rc");
  });

  it("collapses CRLF to a single CR (not CR CR) for SSH", () => {
    const out = preparePastePayload("a\r\nb", "ssh");
    const inner = out.slice("\x1b[200~".length, -"\x1b[201~".length);
    expect(inner).toBe("a\rb");
  });

  it("treats telnet the same as ssh", () => {
    const out = preparePastePayload("a\nb", "telnet");
    expect(out).toBe("\x1b[200~a\rb\x1b[201~");
  });

  it("is case-insensitive on protocol", () => {
    const out = preparePastePayload("a\nb", "SSH");
    expect(out).toBe("\x1b[200~a\rb\x1b[201~");
  });
});
