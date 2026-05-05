import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import VaultTab from "../pages/admin/VaultTab";
import * as api from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof api>("../api");
  return {
    ...actual,
    getServiceHealth: vi.fn().mockResolvedValue({
      vault: { configured: false, mode: null, address: "" },
      database: { ok: true },
    }),
    updateSettings: vi.fn().mockResolvedValue({}),
    updateVault: vi.fn().mockResolvedValue({}),
  };
});

describe("VaultTab", () => {
  beforeEach(() => vi.clearAllMocks());

  it("toggles to External mode and shows URL/token inputs", async () => {
    render(<VaultTab settings={{}} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "External" }));
    expect(screen.getByLabelText("Vault URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Vault Token / AppRole")).toBeInTheDocument();
  });

  it("hydrates credential TTL from settings prop and clamps to 1..12", () => {
    const { rerender } = render(
      <VaultTab settings={{ credential_ttl_hours: "20" }} onSave={vi.fn()} />
    );
    expect(screen.getByLabelText("Time-to-Live (hours)")).toHaveValue("12");
    rerender(<VaultTab settings={{ credential_ttl_hours: "0" }} onSave={vi.fn()} />);
    expect(screen.getByLabelText("Time-to-Live (hours)")).toHaveValue("1");
    rerender(<VaultTab settings={{ credential_ttl_hours: "abc" }} onSave={vi.fn()} />);
    expect(screen.getByLabelText("Time-to-Live (hours)")).toHaveValue("12");
  });

  it("updates credTtl via slider and saves it", async () => {
    const onSave = vi.fn();
    render(<VaultTab settings={{ credential_ttl_hours: "4" }} onSave={onSave} />);
    const slider = screen.getByLabelText("Time-to-Live (hours)");
    fireEvent.change(slider, { target: { value: "8" } });
    expect(screen.getByText("8h")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save Expiry Setting" }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(api.updateSettings).toHaveBeenCalledWith([
      { key: "credential_ttl_hours", value: "8" },
    ]);
    expect(onSave).toHaveBeenCalled();
  });

  it("calls updateVault with local mode payload by default", async () => {
    const onSave = vi.fn();
    render(<VaultTab settings={{}} onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: "Save Vault Settings" }));
    await waitFor(() => expect(api.updateVault).toHaveBeenCalled());
    expect(api.updateVault).toHaveBeenCalledWith({
      mode: "local",
      transit_key: "guac-master-key",
    });
    expect(onSave).toHaveBeenCalled();
  });

  it("calls updateVault with external mode payload when External selected", async () => {
    const onSave = vi.fn();
    render(<VaultTab settings={{}} onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: "External" }));
    fireEvent.change(screen.getByLabelText("Vault URL"), {
      target: { value: "http://vault:8200" },
    });
    fireEvent.change(screen.getByLabelText("Vault Token / AppRole"), {
      target: { value: "s.token" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save Vault Settings" }));
    await waitFor(() => expect(api.updateVault).toHaveBeenCalled());
    expect(api.updateVault).toHaveBeenCalledWith({
      mode: "external",
      address: "http://vault:8200",
      token: "s.token",
      transit_key: "guac-master-key",
    });
  });

  it("displays current vault mode banner from health response", async () => {
    (api.getServiceHealth as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      vault: { configured: true, mode: "external", address: "http://prod:8200" },
      database: { ok: true },
    });
    render(<VaultTab settings={{}} onSave={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText("External", { selector: "strong" })).toBeInTheDocument()
    );
    expect(screen.getByText("http://prod:8200")).toBeInTheDocument();
  });
});
