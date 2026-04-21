import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";

// Mock the api module
vi.mock("../api", () => ({
  initialize: vi.fn().mockResolvedValue({ status: "ok" }),
}));

import SetupWizard from "../pages/SetupWizard";
import { initialize } from "../api";

function renderSetup(onComplete = vi.fn()) {
  return render(
    <BrowserRouter>
      <SetupWizard onComplete={onComplete} />
    </BrowserRouter>
  );
}

describe("SetupWizard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders setup heading", () => {
    renderSetup();
    expect(screen.getByText("Strata Client Setup")).toBeInTheDocument();
  });

  it("has vault mode options", () => {
    renderSetup();
    expect(screen.getByText(/local/i)).toBeInTheDocument();
  });

  it("has external vault option", () => {
    renderSetup();
    expect(screen.getByText(/external/i)).toBeInTheDocument();
  });

  it("has skip vault option", () => {
    renderSetup();
    expect(screen.getByText(/skip/i)).toBeInTheDocument();
  });

  it("calls onComplete after successful initialization", async () => {
    const onComplete = vi.fn();
    const user = userEvent.setup();
    renderSetup(onComplete);

    const btn = screen.getByRole("button", { name: /initialize|setup|continue|save|complete/i });
    await user.click(btn);

    await vi.waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
  });

  it("shows error on initialization failure", async () => {
    vi.mocked(initialize).mockRejectedValueOnce(new Error("Connection refused"));

    const user = userEvent.setup();
    renderSetup();

    const btn = screen.getByRole("button", { name: /initialize|setup|continue|save|complete/i });
    await user.click(btn);

    expect(await screen.findByText("Connection refused")).toBeInTheDocument();
  });

  it("shows external vault fields when external is selected", async () => {
    const user = userEvent.setup();
    renderSetup();

    // Find the external option and click it
    const externalOption = screen.getByText(/external/i);
    await user.click(externalOption);

    expect(screen.getByPlaceholderText(/vault/i)).toBeInTheDocument();
  });

  it("shows transit key field for non-skip modes", () => {
    renderSetup();
    expect(screen.getByDisplayValue(/guac-master-key/i)).toBeInTheDocument();
  });

  it("hides transit key field when skip is selected", async () => {
    const user = userEvent.setup();
    renderSetup();
    await user.click(screen.getByText(/skip for now/i));
    expect(screen.queryByDisplayValue(/guac-master-key/i)).not.toBeInTheDocument();
  });

  it("shows Initializing… text while loading", async () => {
    // Make initialize hang
    vi.mocked(initialize).mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    renderSetup();
    await user.click(screen.getByRole("button", { name: /complete setup/i }));
    expect(screen.getByText("Initializing…")).toBeInTheDocument();
  });

  it("disables button while loading", async () => {
    vi.mocked(initialize).mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    renderSetup();
    await user.click(screen.getByRole("button", { name: /complete setup/i }));
    expect(screen.getByText("Initializing…").closest("button")).toBeDisabled();
  });

  it("submits with local vault mode by default", async () => {
    const user = userEvent.setup();
    renderSetup();
    await user.click(screen.getByRole("button", { name: /complete setup/i }));
    await waitFor(() => {
      expect(initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          vault_mode: "local",
          vault_transit_key: "guac-master-key",
        })
      );
    });
  });

  it("submits with external vault fields", async () => {
    const user = userEvent.setup();
    renderSetup();
    await user.click(screen.getByText(/external vault/i));
    const urlInput = screen.getByPlaceholderText(/vault/i);
    const tokenInput = screen.getByPlaceholderText(/s\./i);
    await user.type(urlInput, "http://vault:8200");
    await user.type(tokenInput, "mytoken");
    await user.click(screen.getByRole("button", { name: /complete setup/i }));
    await waitFor(() => {
      expect(initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          vault_mode: "external",
          vault_address: "http://vault:8200",
          vault_token: "mytoken",
        })
      );
    });
  });

  it("submits skip mode without vault params", async () => {
    const user = userEvent.setup();
    renderSetup();
    await user.click(screen.getByText(/skip for now/i));
    await user.click(screen.getByRole("button", { name: /complete setup/i }));
    await waitFor(() => {
      expect(initialize).toHaveBeenCalledWith({});
    });
  });

  it("handles non-Error exception during initialization", async () => {
    vi.mocked(initialize).mockRejectedValueOnce("string error");
    const user = userEvent.setup();
    renderSetup();
    await user.click(screen.getByRole("button", { name: /complete setup/i }));
    expect(await screen.findByText("Initialization failed")).toBeInTheDocument();
  });

  it("shows description text", () => {
    renderSetup();
    expect(screen.getByText(/database is configured automatically/i)).toBeInTheDocument();
  });

  it("has vault mode radio buttons", () => {
    renderSetup();
    const radios = screen.getAllByRole("radio");
    expect(radios.length).toBe(3);
  });

  it("local vault is selected by default", () => {
    renderSetup();
    const radios = screen.getAllByRole("radio");
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
  });
});
