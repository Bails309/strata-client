import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SsoTab from "../pages/admin/SsoTab";
import * as api from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof api>("../api");
  return {
    ...actual,
    getSsoProviders: vi.fn(),
    createSsoProvider: vi.fn().mockResolvedValue({}),
    updateSsoProvider: vi.fn().mockResolvedValue({}),
    deleteSsoProvider: vi.fn().mockResolvedValue({}),
    testSsoConnection: vi.fn(),
  };
});

const mockProviders = [
  {
    id: "1",
    name: "Keycloak",
    issuer_url: "https://idp.example.com/realms/strata",
    client_id: "strata",
    created_at: "2026-05-19T00:00:00Z",
    updated_at: "2026-05-19T00:00:00Z",
  },
];

describe("SsoTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when no providers exist", async () => {
    (api.getSsoProviders as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    render(<SsoTab settings={{}} onSave={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("No providers configured")).toBeInTheDocument();
    });
  });

  it("renders provider list when providers exist", async () => {
    (api.getSsoProviders as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockProviders);
    render(<SsoTab settings={{}} onSave={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Keycloak")).toBeInTheDocument();
      expect(screen.getByText("https://idp.example.com/realms/strata")).toBeInTheDocument();
    });
  });

  it("can add a new provider", async () => {
    (api.getSsoProviders as ReturnType<typeof vi.fn>).mockResolvedValue(mockProviders);
    const onSave = vi.fn();
    render(<SsoTab settings={{}} onSave={onSave} />);

    await waitFor(() => {
      expect(screen.getByText("Add Provider")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: /Add Provider/i }));

    expect(screen.getByLabelText("Provider Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Issuer URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Client Secret")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Provider Name"), { target: { value: "Okta" } });
    fireEvent.change(screen.getByLabelText("Issuer URL"), {
      target: { value: "https://okta.example.com" },
    });
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "okta-client" } });
    fireEvent.change(screen.getByLabelText("Client Secret"), { target: { value: "okta-secret" } });

    await userEvent.click(screen.getByRole("button", { name: "Add Provider" }));

    await waitFor(() => expect(api.createSsoProvider).toHaveBeenCalled());
    expect(api.createSsoProvider).toHaveBeenCalledWith({
      name: "Okta",
      issuer_url: "https://okta.example.com",
      client_id: "okta-client",
      client_secret: "okta-secret",
    });
    expect(onSave).toHaveBeenCalled();
  });

  it("can edit an existing provider", async () => {
    (api.getSsoProviders as ReturnType<typeof vi.fn>).mockResolvedValue(mockProviders);
    const onSave = vi.fn();
    render(<SsoTab settings={{}} onSave={onSave} />);

    await waitFor(() => {
      expect(screen.getByText("Keycloak")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByLabelText("Provider Name")).toHaveValue("Keycloak");
    expect(screen.getByLabelText("Issuer URL")).toHaveValue(
      "https://idp.example.com/realms/strata"
    );
    expect(screen.getByLabelText("Client ID")).toHaveValue("strata");

    fireEvent.change(screen.getByLabelText("Provider Name"), {
      target: { value: "Keycloak Custom" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(api.updateSsoProvider).toHaveBeenCalled());
    expect(api.updateSsoProvider).toHaveBeenCalledWith("1", {
      name: "Keycloak Custom",
      issuer_url: "https://idp.example.com/realms/strata",
      client_id: "strata",
    });
    expect(onSave).toHaveBeenCalled();
  });

  it("can delete a provider", async () => {
    (api.getSsoProviders as ReturnType<typeof vi.fn>).mockResolvedValue(mockProviders);
    const onSave = vi.fn();
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SsoTab settings={{}} onSave={onSave} />);

    await waitFor(() => {
      expect(screen.getByText("Keycloak")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(confirmMock).toHaveBeenCalled();
    await waitFor(() => expect(api.deleteSsoProvider).toHaveBeenCalledWith("1"));
    expect(onSave).toHaveBeenCalled();
  });

  it("shows success result when test succeeds", async () => {
    (api.getSsoProviders as ReturnType<typeof vi.fn>).mockResolvedValue(mockProviders);
    (api.testSsoConnection as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "success",
      message: "Connected!",
    });

    render(<SsoTab settings={{}} onSave={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Test Connection" }));

    await waitFor(() => expect(screen.getByText("Connected!")).toBeInTheDocument());
  });

  it("shows failure result when test rejects", async () => {
    (api.getSsoProviders as ReturnType<typeof vi.fn>).mockResolvedValue(mockProviders);
    (api.testSsoConnection as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Bad issuer")
    );

    render(<SsoTab settings={{}} onSave={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Test Connection" }));

    await waitFor(() => expect(screen.getByText("Bad issuer")).toBeInTheDocument());
  });
});
