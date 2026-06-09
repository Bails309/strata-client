import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

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
      </ToastProvider>
    );
    expect(container.querySelector("[role='region']")).toBeNull();
  });

  it("publishes a warning toast and shows its title + description", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <ToastProvider>
        <Trigger variant="warning" title="Heads up" description="Something's coming." />
      </ToastProvider>
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
      </ToastProvider>
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
      </ToastProvider>
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
        <Trigger variant="warning" title="Action me" actionLabel="Renew now" onAction={action} />
      </ToastProvider>
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
      </ToastProvider>
    );
    await user.click(screen.getByText("fire"));
    expect(screen.getByText("Closable")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Dismiss notification"));
    expect(screen.queryByText("Closable")).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Progress bar                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/** Trigger variant that publishes a sticky toast with a determinate or
 *  indeterminate progress value. Mirrors the upload-progress pattern
 *  used by SessionManager + QuickShare in production. */
function ProgressTrigger({
  progress,
  title = "Uploading",
  description,
}: {
  progress: number | "indeterminate";
  title?: string;
  description?: string;
}) {
  const toast = useToast();
  return (
    <button
      onClick={() =>
        toast.info({
          key: "upload-1",
          title,
          description,
          duration: null,
          progress,
        })
      }
    >
      fire-progress
    </button>
  );
}

describe("ToastProvider — progress bar", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a progressbar role with the rounded percentage in aria-valuenow", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <ToastProvider>
        <ProgressTrigger progress={0.73} description="73 of 100" />
      </ToastProvider>
    );
    await user.click(screen.getByText("fire-progress"));
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuenow", "73");
    expect(bar).toHaveAttribute("aria-label", "73% complete");
  });

  it("clamps out-of-range progress values into [0, 100]", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    function Multi() {
      const toast = useToast();
      return (
        <>
          <button
            onClick={() =>
              toast.info({ key: "over", title: "Over", duration: null, progress: 1.5 })
            }
          >
            fire-over
          </button>
          <button
            onClick={() =>
              toast.info({ key: "under", title: "Under", duration: null, progress: -0.3 })
            }
          >
            fire-under
          </button>
        </>
      );
    }
    render(
      <ToastProvider>
        <Multi />
      </ToastProvider>
    );
    await user.click(screen.getByText("fire-over"));
    await user.click(screen.getByText("fire-under"));
    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(2);
    const values = bars.map((b) => b.getAttribute("aria-valuenow"));
    expect(values).toContain("100");
    expect(values).toContain("0");
  });

  it("renders an indeterminate progressbar without aria-valuenow", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <ToastProvider>
        <ProgressTrigger progress="indeterminate" title="Scanning" />
      </ToastProvider>
    );
    await user.click(screen.getByText("fire-progress"));
    const bar = screen.getByRole("progressbar");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).toHaveAttribute("aria-label", "In progress");
  });

  it("updates the same toast in place when re-published with the same key", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    function Stepper() {
      const toast = useToast();
      const [step, setStep] = useState(0);
      const next = () => {
        setStep((s) => s + 1);
        if (step === 0) {
          toast.info({ key: "u", title: "Uploading", duration: null, progress: 0.4 });
        } else if (step === 1) {
          toast.info({ key: "u", title: "Uploading", duration: null, progress: 0.9 });
        } else {
          toast.info({
            key: "u",
            title: "Scanning",
            duration: null,
            progress: "indeterminate",
          });
        }
      };
      return <button onClick={next}>step</button>;
    }
    render(
      <ToastProvider>
        <Stepper />
      </ToastProvider>
    );
    // step 1: 40 %
    await user.click(screen.getByText("step"));
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    // step 2: 90 % — still one toast, in-place update
    await user.click(screen.getByText("step"));
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "90");
    // step 3: indeterminate — still one toast, no aria-valuenow
    await user.click(screen.getByText("step"));
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByText("Scanning")).toBeInTheDocument();
  });

  it("does not render a progressbar when progress is undefined", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <ToastProvider>
        <Trigger variant="info" title="No bar" />
      </ToastProvider>
    );
    await user.click(screen.getByText("fire"));
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
