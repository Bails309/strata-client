import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EnterpriseCheckbox } from "../components/EnterpriseCheckbox";

describe("EnterpriseCheckbox component", () => {
  it("renders unchecked state by default", () => {
    render(<EnterpriseCheckbox id="test-cb" aria-label="Test checkbox" />);
    const input = screen.getByRole("checkbox", { name: "Test checkbox" }) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.checked).toBe(false);
    expect(input.indeterminate).toBe(false);
  });

  it("renders checked state with checkmark SVG", () => {
    const { container } = render(
      <EnterpriseCheckbox id="test-cb" checked={true} aria-label="Test checkbox" />
    );
    const input = screen.getByRole("checkbox", { name: "Test checkbox" }) as HTMLInputElement;
    expect(input.checked).toBe(true);

    const polyline = container.querySelector("polyline");
    expect(polyline).toBeInTheDocument();
    expect(polyline).toHaveAttribute("points", "3.5 8.5 6.5 11.5 12.5 4.5");
  });

  it("renders indeterminate state with dash SVG", () => {
    const { container } = render(
      <EnterpriseCheckbox id="test-cb" indeterminate={true} aria-label="Test checkbox" />
    );
    const input = screen.getByRole("checkbox", { name: "Test checkbox" }) as HTMLInputElement;
    expect(input.indeterminate).toBe(true);

    const line = container.querySelector("line");
    expect(line).toBeInTheDocument();
    expect(line).toHaveAttribute("x1", "4");
    expect(line).toHaveAttribute("x2", "12");
  });

  it("invokes onCheckedChange when clicked", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <EnterpriseCheckbox
        id="test-cb"
        checked={false}
        onCheckedChange={onCheckedChange}
        aria-label="Test checkbox"
      />
    );

    const input = screen.getByRole("checkbox", { name: "Test checkbox" });
    await user.click(input);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("handles keyboard navigation and Space toggle", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <EnterpriseCheckbox
        id="test-cb"
        checked={false}
        onCheckedChange={onCheckedChange}
        aria-label="Test checkbox"
      />
    );

    const input = screen.getByRole("checkbox", { name: "Test checkbox" });
    input.focus();
    expect(input).toHaveFocus();

    await user.keyboard(" ");
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("disables the input and applies disabled styling when disabled=true", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <EnterpriseCheckbox
        id="test-cb"
        disabled={true}
        onCheckedChange={onCheckedChange}
        aria-label="Disabled checkbox"
      />
    );

    const input = screen.getByRole("checkbox", { name: "Disabled checkbox" });
    expect(input).toBeDisabled();
    await user.click(input);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
