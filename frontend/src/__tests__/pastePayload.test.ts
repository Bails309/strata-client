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

  it("wraps SSH payloads in bracketed paste markers", () => {
    const out = preparePastePayload("hi", "ssh");
    expect(out.startsWith("\x1b[200~")).toBe(true);
    expect(out.endsWith("\x1b[201~")).toBe(true);
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
