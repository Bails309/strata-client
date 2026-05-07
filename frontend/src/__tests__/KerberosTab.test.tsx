import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import KerberosTab from "../pages/admin/KerberosTab";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    getKerberosRealms: vi.fn(),
    createKerberosRealm: vi.fn(),
    updateKerberosRealm: vi.fn(),
    deleteKerberosRealm: vi.fn(),
  };
});

import {
  getKerberosRealms,
  createKerberosRealm,
  updateKerberosRealm,
  deleteKerberosRealm,
  KerberosRealm,
} from "../api";

const realm = (over: Partial<KerberosRealm> = {}): KerberosRealm => ({
  id: "11111111-1111-1111-1111-111111111111",
  realm: "EXAMPLE.COM",
  kdc_servers: "dc1.example.com,dc2.example.com",
  admin_server: "dc1.example.com",
  ticket_lifetime: "10h",
  renew_lifetime: "7d",
  is_default: true,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  ...over,
});

const onSave = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  onSave.mockReset();
  vi.mocked(getKerberosRealms).mockResolvedValue([]);
  vi.mocked(createKerberosRealm).mockResolvedValue(realm());
  vi.mocked(updateKerberosRealm).mockResolvedValue(realm());
  vi.mocked(deleteKerberosRealm).mockResolvedValue(undefined as never);
});

describe("KerberosTab", () => {
  it("loads existing realms on mount", async () => {
    vi.mocked(getKerberosRealms).mockResolvedValue([realm()]);
    render(<KerberosTab onSave={onSave} />);
    await waitFor(() => expect(getKerberosRealms).toHaveBeenCalled());
    expect(await screen.findByText("EXAMPLE.COM")).toBeInTheDocument();
  });

  it("surfaces a load error when the API rejects", async () => {
    vi.mocked(getKerberosRealms).mockRejectedValue(new Error("nope"));
    render(<KerberosTab onSave={onSave} />);
    expect(await screen.findByText(/Failed to load Kerberos realms/i)).toBeInTheDocument();
  });

  it("opening 'Add Realm' shows the create form with default lifetimes", async () => {
    render(<KerberosTab onSave={onSave} />);
    await waitFor(() => expect(getKerberosRealms).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /Add Realm/i }));
    expect(screen.getByText(/New Kerberos Realm/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue("10h")).toBeInTheDocument();
    expect(screen.getByDisplayValue("7d")).toBeInTheDocument();
  });

  it("blocks save when realm name is empty", async () => {
    render(<KerberosTab onSave={onSave} />);
    await waitFor(() => expect(getKerberosRealms).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /Add Realm/i }));
    await userEvent.click(screen.getByRole("button", { name: /Create Realm/i }));
    expect(await screen.findByText(/Realm name is required/i)).toBeInTheDocument();
    expect(createKerberosRealm).not.toHaveBeenCalled();
  });

  it("creates a realm with trimmed KDC list and fires onSave", async () => {
    render(<KerberosTab onSave={onSave} />);
    await waitFor(() => expect(getKerberosRealms).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /Add Realm/i }));
    await userEvent.type(screen.getByLabelText(/Realm Name/i), "EXAMPLE.COM");
    await userEvent.type(screen.getByPlaceholderText(/KDC 1/i), "dc1.example.com");
    await userEvent.type(screen.getByLabelText(/Admin Server/i), "dc1.example.com");
    await userEvent.click(screen.getByRole("button", { name: /Create Realm/i }));
    await waitFor(() => expect(createKerberosRealm).toHaveBeenCalled());
    const payload = vi.mocked(createKerberosRealm).mock.calls[0][0];
    expect(payload.realm).toBe("EXAMPLE.COM");
    expect(payload.kdc_servers).toEqual(["dc1.example.com"]);
    expect(payload.admin_server).toBe("dc1.example.com");
    expect(onSave).toHaveBeenCalled();
  });
});
