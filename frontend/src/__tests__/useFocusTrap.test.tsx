import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useFocusTrap } from "../components/useFocusTrap";

// jsdom does no layout, so offsetParent is always null and the hook would
// treat every control as hidden. Report attached elements as visible.
const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement;
    },
  });
});
afterAll(() => {
  if (offsetParent) Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent);
});

function Dialog({ open, empty = false }: { open: boolean; empty?: boolean }) {
  const ref = useFocusTrap<HTMLDivElement>(open);
  if (!open) return null;
  return (
    <div ref={ref} role="dialog" aria-label="dialog">
      {!empty && (
        <>
          <button>first</button>
          <button disabled>disabled</button>
          <input aria-label="middle" />
          <button>last</button>
        </>
      )}
    </div>
  );
}

function Harness({ empty }: { empty?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen((o) => !o)}>opener</button>
      <Dialog open={open} empty={empty} />
    </>
  );
}

function openDialog(empty?: boolean) {
  render(<Harness empty={empty} />);
  const opener = screen.getByRole("button", { name: "opener" });
  opener.focus();
  act(() => opener.click());
  return opener;
}

describe("useFocusTrap", () => {
  it("moves focus into the dialog and returns it to the opener on close", () => {
    const opener = openDialog();
    expect(screen.getByRole("button", { name: "first" })).toHaveFocus();

    act(() => opener.click());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("wraps Tab from the last control and Shift+Tab from the first", () => {
    openDialog();
    const first = screen.getByRole("button", { name: "first" });
    const last = screen.getByRole("button", { name: "last" });

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("leaves Tab between inner controls to the browser", () => {
    openDialog();
    const first = screen.getByRole("button", { name: "first" });
    const notCancelled = fireEvent.keyDown(first, { key: "Tab" });
    expect(notCancelled).toBe(true);
    expect(first).toHaveFocus();
  });

  it("focuses the dialog itself when it has no controls", () => {
    openDialog(true);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("tabindex", "-1");
    expect(dialog).toHaveFocus();

    const notCancelled = fireEvent.keyDown(dialog, { key: "Tab" });
    expect(notCancelled).toBe(false);
    expect(dialog).toHaveFocus();
  });
});
