import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SsoTab from "../pages/admin/SsoTab";
import * as api from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof api>("../api");
  return {
    ...actual,
    testSsoConnection: vi.fn(),
    updateSso: vi.fn().mockResolvedValue({}),
  };
});

const baseSettings = {
  sso_issuer_url: "https://idp.example.com/realms/strata",
  sso_client_id: "strata",
  sso_client_secret: "shh",
};

describe("SsoTab", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hydrates inputs from settings prop", () => {
    render(<SsoTab settings={baseSettings} onSave={vi.fn()} />);
    expect(screen.getByLabelText("Issuer URL")).toHaveValue(
      "https://idp.example.com/realms/strata"
    );
    expect(screen.getByLabelText("Client ID")).toHaveValue("strata");
    expect(screen.getByLabelText("Client Secret")).toHaveValue("shh");
  });

  it("renders empty inputs when settings missing", () => {
    render(<SsoTab settings={{}} onSave={vi.fn()} />);
    expect(screen.getByLabelText("Issuer URL")).toHaveValue("");
  });

  it("edits inputs and saves SSO settings", async () => {
    const onSave = vi.fn();
    render(<SsoTab settings={baseSettings} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Issuer URL"), {
      target: { value: "https://new.example.com" },
    });
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "new-client" } });
    fireEvent.change(screen.getByLabelText("Client Secret"), { target: { value: "new-secret" } });
    await userEvent.click(screen.getByRole("button", { name: "Save SSO Settings" }));
    await waitFor(() => expect(api.updateSso).toHaveBeenCalled());
    expect(api.updateSso).toHaveBeenCalledWith({
      issuer_url: "https://new.example.com",
      client_id: "new-client",
      client_secret: "new-secret",
    });
    expect(onSave).toHaveBeenCalled();
  });

  it("Test Connection button disabled when fields blank", () => {
    render(<SsoTab settings={{}} onSave={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeDisabled();
  });

  it("shows success result when test succeeds", async () => {
    (api.testSsoConnection as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "success",
      message: "Connected!",
    });
    render(<SsoTab settings={baseSettings} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await waitFor(() => expect(screen.getByText("Connected!")).toBeInTheDocument());
  });

  it("shows failure result when test rejects", async () => {
    (api.testSsoConnection as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Bad issuer")
    );
    render(<SsoTab settings={baseSettings} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await waitFor(() => expect(screen.getByText("Bad issuer")).toBeInTheDocument());
  });

  it("shows generic failure message when error is not Error instance", async () => {
    (api.testSsoConnection as ReturnType<typeof vi.fn>).mockRejectedValueOnce("nope");
    render(<SsoTab settings={baseSettings} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await waitFor(() => expect(screen.getByText("Test failed")).toBeInTheDocument());
  });

  it("shows API failure status as failure result", async () => {
    (api.testSsoConnection as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "error",
      message: "Invalid client",
    });
    render(<SsoTab settings={baseSettings} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await waitFor(() => expect(screen.getByText("Invalid client")).toBeInTheDocument());
  });
});
