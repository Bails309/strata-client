import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../api", () => ({
  getTrustedCas: vi.fn(),
  createTrustedCa: vi.fn(),
  deleteTrustedCa: vi.fn(),
}));

import TrustedCAsTab from "../pages/admin/TrustedCAsTab";
import { getTrustedCas, createTrustedCa, deleteTrustedCa } from "../api";

const summary = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Corp Root",
  description: "Issued 2024",
  subject: "CN=Corp Root CA",
  not_after: "2034-01-01T00:00:00Z",
  fingerprint: "abcdef1234567890abcdef1234567890abcdef1234567890",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

describe("TrustedCAsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getTrustedCas as any).mockResolvedValue([summary]);
    (createTrustedCa as any).mockResolvedValue(summary);
    (deleteTrustedCa as any).mockResolvedValue(undefined);
  });

  it("renders heading and existing rows from the API", async () => {
    render(<TrustedCAsTab onSave={vi.fn()} />);
    expect(screen.getByText("Trusted Certificate Authorities")).toBeInTheDocument();
    await screen.findByText("Corp Root");
    expect(screen.getByText("Stored bundles (1)")).toBeInTheDocument();
    expect(screen.getByText("CN=Corp Root CA")).toBeInTheDocument();
  });

  it("shows empty state when no CAs", async () => {
    (getTrustedCas as any).mockResolvedValue([]);
    render(<TrustedCAsTab onSave={vi.fn()} />);
    await screen.findByText("No trusted CAs configured yet.");
  });

  it("shows validation error when name or PEM is empty", async () => {
    render(<TrustedCAsTab onSave={vi.fn()} />);
    await screen.findByText("Corp Root");
    fireEvent.click(screen.getByRole("button", { name: /Add Trusted CA/ }));
    await screen.findByText("Name and PEM are both required.");
    expect(createTrustedCa).not.toHaveBeenCalled();
  });

  it("submits the form and reloads on success", async () => {
    const onSave = vi.fn();
    render(<TrustedCAsTab onSave={onSave} />);
    await screen.findByText("Corp Root");

    fireEvent.change(screen.getByPlaceholderText("Internal Corp Root CA"), {
      target: { value: "New CA" },
    });
    fireEvent.change(screen.getByPlaceholderText(/BEGIN CERTIFICATE/), {
      target: { value: "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add Trusted CA/ }));

    await waitFor(() => expect(createTrustedCa).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalled();
  });

  it("surfaces API errors on load", async () => {
    (getTrustedCas as any).mockRejectedValue(new Error("boom"));
    render(<TrustedCAsTab onSave={vi.fn()} />);
    await screen.findByText(/boom/);
  });

  it("deletes a row when confirmed", async () => {
    const onSave = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<TrustedCAsTab onSave={onSave} />);
    await screen.findByText("Corp Root");
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    await waitFor(() => expect(deleteTrustedCa).toHaveBeenCalledWith(summary.id));
    expect(onSave).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("does not delete when confirm is cancelled", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<TrustedCAsTab onSave={vi.fn()} />);
    await screen.findByText("Corp Root");
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(deleteTrustedCa).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
