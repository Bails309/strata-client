import { describe, it, expect, vi } from "vitest";
import { createWinKeyProxy } from "../utils/winKeyProxy";

const CTRL_R = 0xffe4;
const SUPER_L = 0xffeb;

describe("createWinKeyProxy", () => {
  it("passes normal key presses through unchanged", () => {
    const sendKey = vi.fn();
    const proxy = createWinKeyProxy(sendKey);

    proxy.onkeydown(0x61); // 'a'
    expect(sendKey).toHaveBeenCalledWith(1, 0x61);

    proxy.onkeyup(0x61);
    expect(sendKey).toHaveBeenCalledWith(0, 0x61);
    expect(sendKey).toHaveBeenCalledTimes(2);
  });

  it("swallows Right Ctrl down (does not send Control_R)", () => {
    const sendKey = vi.fn();
    const proxy = createWinKeyProxy(sendKey);

    const handled = proxy.onkeydown(CTRL_R);
    expect(handled).toBe(true);
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("sends Super tap when Right Ctrl is tapped alone", () => {
    const sendKey = vi.fn();
    const proxy = createWinKeyProxy(sendKey);

    proxy.onkeydown(CTRL_R);
    proxy.onkeyup(CTRL_R);

    expect(sendKey).toHaveBeenCalledTimes(2);
    expect(sendKey).toHaveBeenNthCalledWith(1, 1, SUPER_L); // press
    expect(sendKey).toHaveBeenNthCalledWith(2, 0, SUPER_L); // release
  });

  it("sends Super+key combo when Right Ctrl is held with another key", () => {
    const sendKey = vi.fn();
    const proxy = createWinKeyProxy(sendKey);

    proxy.onkeydown(CTRL_R);
    proxy.onkeydown(0x65); // 'e'  → should send Super_L↓ then e↓

    expect(sendKey).toHaveBeenNthCalledWith(1, 1, SUPER_L);
    expect(sendKey).toHaveBeenNthCalledWith(2, 1, 0x65);

    proxy.onkeyup(0x65);
    expect(sendKey).toHaveBeenNthCalledWith(3, 0, 0x65);

    proxy.onkeyup(CTRL_R);
    expect(sendKey).toHaveBeenNthCalledWith(4, 0, SUPER_L);
    expect(sendKey).toHaveBeenCalledTimes(4);
  });

  it("sends Super_L down only once for multi-key combos", () => {
    const sendKey = vi.fn();
    const proxy = createWinKeyProxy(sendKey);

    proxy.onkeydown(CTRL_R);
    proxy.onkeydown(0xffe1); // Shift
    proxy.onkeydown(0x73); // 's'

    const superDownCalls = sendKey.mock.calls.filter((c) => c[0] === 1 && c[1] === SUPER_L);
    expect(superDownCalls).toHaveLength(1);
  });

  it("handles key repeat on Right Ctrl gracefully", () => {
    const sendKey = vi.fn();
    const proxy = createWinKeyProxy(sendKey);

    proxy.onkeydown(CTRL_R);
    proxy.onkeydown(CTRL_R); // repeat
    proxy.onkeydown(CTRL_R); // repeat

    expect(sendKey).not.toHaveBeenCalled();

    proxy.onkeyup(CTRL_R);
    // Still a tap (no other key pressed)
    expect(sendKey).toHaveBeenCalledTimes(2);
    expect(sendKey).toHaveBeenNthCalledWith(1, 1, SUPER_L);
    expect(sendKey).toHaveBeenNthCalledWith(2, 0, SUPER_L);
  });

  it("reset() clears proxy state so next keys are normal", () => {
    const sendKey = vi.fn();
    const proxy = createWinKeyProxy(sendKey);

    proxy.onkeydown(CTRL_R);
    proxy.reset();

    // Next key should pass through normally
    proxy.onkeydown(0x61);
    expect(sendKey).toHaveBeenCalledWith(1, 0x61);

    const superCalls = sendKey.mock.calls.filter((c) => c[1] === SUPER_L);
    expect(superCalls).toHaveLength(0);
  });

  it("works correctly across multiple separate combos", () => {
    const sendKey = vi.fn();
    const proxy = createWinKeyProxy(sendKey);

    // First combo: Win+E
    proxy.onkeydown(CTRL_R);
    proxy.onkeydown(0x65);
    proxy.onkeyup(0x65);
    proxy.onkeyup(CTRL_R);

    // Second combo: Win+R
    proxy.onkeydown(CTRL_R);
    proxy.onkeydown(0x72);
    proxy.onkeyup(0x72);
    proxy.onkeyup(CTRL_R);

    expect(sendKey).toHaveBeenCalledTimes(8);
    // First combo
    expect(sendKey).toHaveBeenNthCalledWith(1, 1, SUPER_L);
    expect(sendKey).toHaveBeenNthCalledWith(2, 1, 0x65);
    expect(sendKey).toHaveBeenNthCalledWith(3, 0, 0x65);
    expect(sendKey).toHaveBeenNthCalledWith(4, 0, SUPER_L);
    // Second combo
    expect(sendKey).toHaveBeenNthCalledWith(5, 1, SUPER_L);
    expect(sendKey).toHaveBeenNthCalledWith(6, 1, 0x72);
    expect(sendKey).toHaveBeenNthCalledWith(7, 0, 0x72);
    expect(sendKey).toHaveBeenNthCalledWith(8, 0, SUPER_L);
  });
});
