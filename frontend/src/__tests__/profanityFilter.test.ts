import { describe, it, expect } from "vitest";
import { isProfane, normaliseForProfanity } from "../utils/profanityFilter";

describe("profanityFilter", () => {
  it("allows ordinary names", () => {
    for (const name of ["Alice", "Bob", "Jean-Luc", "李雷", "O'Brien", "Sam_42"]) {
      expect(isProfane(name)).toBe(false);
    }
  });

  it("rejects an unambiguous obscenity", () => {
    expect(isProfane("fuck")).toBe(true);
    expect(isProfane("Fucker")).toBe(true);
  });

  it("rejects substring obscenities inside a longer name", () => {
    expect(isProfane("megashithead")).toBe(true);
  });

  it("rejects leet-speak substitutions", () => {
    expect(isProfane("5h1t")).toBe(true);
    expect(isProfane("@$$hole")).toBe(true);
    expect(isProfane("f.u.c.k")).toBe(true);
  });

  it("strips diacritics before matching", () => {
    expect(isProfane("fück")).toBe(true);
  });

  it("returns false for empty / whitespace input", () => {
    expect(isProfane("")).toBe(false);
    expect(isProfane("   ")).toBe(false);
  });

  it("normaliseForProfanity collapses spacers and lowercases", () => {
    expect(normaliseForProfanity("S.h.I.t")).toBe("shit");
    expect(normaliseForProfanity("Alex 42!")).toBe("alexai");
  });
});
