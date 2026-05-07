import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api", () => ({
  updateSettings: vi.fn(),
}));

import DisplayTab from "../pages/admin/DisplayTab";
import { updateSettings } from "../api";

beforeEach(() => {
  vi.mocked(updateSettings).mockResolvedValue({ status: "ok" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DisplayTab", () => {
  it("falls back to UTC + ISO date + 24h time when settings are empty", () => {
    render(<DisplayTab settings={{}} onSave={() => {}} />);
    // The Select component renders an underlying combobox; assert via
    // accessible role to keep the test resilient to its internal
    // markup.
    expect(screen.getByLabelText(/Display Timezone/i)).toBeInTheDocument();
    // Preview row mirrors the chosen format. With ISO + 24h the date
    // segment must be `YYYY-MM-DD` shape.
    const preview = screen.getByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(preview).toBeInTheDocument();
  });

  it("renders existing display settings values", () => {
    render(
      <DisplayTab
        settings={{
          display_timezone: "Europe/London",
          display_date_format: "DD/MM/YYYY",
          display_time_format: "hh:mm:ss A",
        }}
        onSave={() => {}}
      />
    );
    // 12-hour preview must include AM or PM
    const preview = screen.getByText(/\b(AM|PM)\b/);
    expect(preview).toBeInTheDocument();
  });

  it("persists settings via updateSettings on save and invokes onSave", async () => {
    const onSave = vi.fn();
    render(<DisplayTab settings={{}} onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: /Save Display Settings/ }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith([
      { key: "display_timezone", value: "UTC" },
      { key: "display_date_format", value: "YYYY-MM-DD" },
      { key: "display_time_format", value: "HH:mm:ss" },
    ]);
    expect(onSave).toHaveBeenCalled();
  });

  it("does not call onSave if updateSettings throws", async () => {
    vi.mocked(updateSettings).mockRejectedValueOnce(new Error("boom"));
    const onSave = vi.fn();
    render(<DisplayTab settings={{}} onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: /Save Display Settings/ }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();
  });
});
