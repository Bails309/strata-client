import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api", () => ({
  updateSettings: vi.fn(),
}));

import VdiTab from "../pages/admin/VdiTab";
import { updateSettings } from "../api";

beforeEach(() => {
  vi.mocked(updateSettings).mockResolvedValue(undefined as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VdiTab", () => {
  it("renders existing settings", () => {
    render(
      <VdiTab
        settings={{ vdi_image_whitelist: "strata/img:1\nstrata/img:2", max_vdi_containers: "5" }}
        onSave={() => {}}
      />
    );
    expect(screen.getByDisplayValue("5")).toBeInTheDocument();
    // The line count is wrapped in <strong>; assert via the <strong> directly.
    const counts = screen.getAllByText("2");
    expect(counts.some((el) => el.tagName === "STRONG")).toBe(true);
  });

  it("updates whitelist line count as user types", async () => {
    render(<VdiTab settings={{}} onSave={() => {}} />);
    const ta = screen.getByLabelText("Image whitelist");
    await userEvent.type(ta, "a{Enter}b{Enter}# comment{Enter}c");
    const counts = screen.getAllByText("3");
    expect(counts.some((el) => el.tagName === "STRONG")).toBe(true);
  });

  it("rejects negative max_vdi_containers", async () => {
    render(<VdiTab settings={{}} onSave={() => {}} />);
    const input = screen.getByLabelText("Max concurrent containers");
    await userEvent.type(input, "-1");
    await userEvent.click(screen.getByRole("button", { name: /Save VDI settings/ }));
    expect(screen.getByText(/non-negative integer/)).toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("saves valid settings and invokes onSave", async () => {
    const onSave = vi.fn();
    render(
      <VdiTab settings={{ vdi_image_whitelist: "img:1", max_vdi_containers: "" }} onSave={onSave} />
    );
    await userEvent.click(screen.getByRole("button", { name: /Save VDI settings/ }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalled();
  });

  it("surfaces backend save error", async () => {
    vi.mocked(updateSettings).mockRejectedValueOnce(new Error("boom"));
    render(<VdiTab settings={{}} onSave={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /Save VDI settings/ }));
    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
  });
});
