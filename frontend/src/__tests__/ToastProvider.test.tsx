import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import ToastProvider, { useToast } from "../components/ToastProvider";

function Trigger({
  variant,
  ...rest
}: {
  variant: "info" | "success" | "warning" | "error";
  title?: string;
  description?: string;
  duration?: number | null;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const toast = useToast();
  return (
    <button
      onClick={() =>
        toast[variant]({
          title: rest.title ?? "Hello",
          description: rest.description,
          duration: rest.duration,
          action: rest.actionLabel
            ? {
                label: rest.actionLabel,
                onClick: () => {
                  rest.onAction?.();
                },
              }
            : undefined,
        })
      }
    >
      fire
    </button>
  );
}

describe("ToastProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws when useToast is used outside the provider", () => {
    function Bad() {
      useToast();
      return null;
    }
    // React logs the error; suppress to keep test output clean.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Bad />)).toThrow(/useToast must be used inside/);
    spy.mockRestore();
  });

  it("renders nothing until a toast is published", () => {
    const { container } = render(
      <ToastProvider>
        <div />
      </ToastProvider>,
    );
    expect(container.querySelector("[role='region']")).toBeNull();
  });

  it("publishes a warning toast and shows its title + description", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <ToastProvider>
        <Trigger variant="warning" title="Heads up" description="Something's coming." />
      </ToastProvider>,
    );
    await user.click(screen.getByText("fire"));
    expect(screen.getByText("Heads up")).toBeInTheDocument();
    expect(screen.getByText("Something's coming.")).toBeInTheDocument();
  });

  it("auto-dismisses an info toast after its default duration", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <ToastProvider>
        <Trigger variant="info" title="Tick" />
      </ToastProvider>,
    );
    await user.click(screen.getByText("fire"));
    expect(screen.getByText("Tick")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(6_500);
    });
    expect(screen.queryByText("Tick")).toBeNull();
  });

  it("does not auto-dismiss an error toast (sticky)", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <ToastProvider>
        <Trigger variant="error" title="Boom" />
      </ToastProvider>,
    );
    await user.click(screen.getByText("fire"));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("Boom")).toBeInTheDocument();
  });

  it("invokes the action handler and dismisses the toast", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const action = vi.fn();
    render(
      <ToastProvider>
        <Trigger
          variant="warning"
          title="Action me"
          actionLabel="Renew now"
          onAction={action}
        />
      </ToastProvider>,
    );
    await user.click(screen.getByText("fire"));
    await user.click(screen.getByText("Renew now"));
    expect(action).toHaveBeenCalledOnce();
    expect(screen.queryByText("Action me")).toBeNull();
  });

  it("allows manual dismiss via the close button", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <ToastProvider>
        <Trigger variant="warning" title="Closable" />
      </ToastProvider>,
    );
    await user.click(screen.getByText("fire"));
    expect(screen.getByText("Closable")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Dismiss notification"));
    expect(screen.queryByText("Closable")).toBeNull();
  });
});
