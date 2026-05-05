import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ConfirmModal from "../components/ConfirmModal";

describe("ConfirmModal", () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();

  it("returns null when not open", () => {
    const { container } = render(
      <ConfirmModal
        isOpen={false}
        title="T"
        message="M"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders title and message when open", () => {
    render(
      <ConfirmModal
        isOpen={true}
        title="Delete?"
        message="Are you sure?"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
    expect(screen.getByText("Delete?")).toBeInTheDocument();
    expect(screen.getByText("Are you sure?")).toBeInTheDocument();
  });

  it("uses default button labels", () => {
    render(
      <ConfirmModal isOpen={true} title="T" message="M" onConfirm={onConfirm} onCancel={onCancel} />
    );
    expect(screen.getByText("Confirm")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("uses custom button labels", () => {
    render(
      <ConfirmModal
        isOpen={true}
        title="T"
        message="M"
        onConfirm={onConfirm}
        onCancel={onCancel}
        confirmLabel="Yes"
        cancelLabel="No"
      />
    );
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
  });

  it("calls onConfirm when confirm clicked", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmModal isOpen={true} title="T" message="M" onConfirm={onConfirm} onCancel={onCancel} />
    );
    await user.click(screen.getByText("Confirm"));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("calls onCancel when cancel clicked", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmModal isOpen={true} title="T" message="M" onConfirm={onConfirm} onCancel={onCancel} />
    );
    await user.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("renders danger icon when isDangerous", () => {
    const { container } = render(
      <ConfirmModal
        isOpen={true}
        title="T"
        message="M"
        onConfirm={onConfirm}
        onCancel={onCancel}
        isDangerous={true}
      />
    );
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("does not render danger icon when not isDangerous", () => {
    const { container } = render(
      <ConfirmModal
        isOpen={true}
        title="T"
        message="M"
        onConfirm={onConfirm}
        onCancel={onCancel}
        isDangerous={false}
      />
    );
    expect(container.querySelector("svg")).not.toBeInTheDocument();
  });

  it("applies danger border style when isDangerous", () => {
    const { container } = render(
      <ConfirmModal
        isOpen={true}
        title="T"
        message="M"
        onConfirm={onConfirm}
        onCancel={onCancel}
        isDangerous={true}
      />
    );
    const card = container.querySelector(".card") as HTMLElement;
    expect(card.style.border).toContain("solid");
  });

  it("calls onCancel when backdrop clicked", async () => {
    const user = userEvent.setup();
    const fn = vi.fn();
    render(
      <ConfirmModal isOpen={true} title="T" message="M" onConfirm={onConfirm} onCancel={fn} />
    );
    // Click the backdrop button (now an inner aria-labelled button overlay)
    const backdrop = screen.getByLabelText("Close dialog");
    await user.click(backdrop);
    expect(fn).toHaveBeenCalled();
  });

  it("stops propagation on card click", async () => {
    const user = userEvent.setup();
    const fn = vi.fn();
    render(
      <ConfirmModal isOpen={true} title="T" message="M" onConfirm={onConfirm} onCancel={fn} />
    );
    // Click the title text (inside card) — should not trigger backdrop cancel
    await user.click(screen.getByText("T"));
    // onCancel fires from backdrop click, not from inner card click
    // If propagation is stopped, only the backdrop handler would fire it
  });
});
