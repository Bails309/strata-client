import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api", () => ({
  updateDns: vi.fn(),
}));

import NetworkTab from "../pages/admin/NetworkTab";
import { updateDns } from "../api";

beforeEach(() => {
  vi.mocked(updateDns).mockResolvedValue({
    status: "ok",
    restart_required: false,
    message: "",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NetworkTab", () => {
  it("hides DNS-server inputs until DNS is enabled", () => {
    render(<NetworkTab settings={{}} onSave={() => {}} />);
    expect(screen.queryByLabelText(/DNS Server Addresses/i)).not.toBeInTheDocument();
  });

  it("reveals DNS inputs when toggled on", async () => {
    render(<NetworkTab settings={{}} onSave={() => {}} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /Enable Custom DNS/i }));
    expect(screen.getByRole("textbox", { name: /DNS Server Addresses/i })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Search Domains/i })).toBeInTheDocument();
  });

  it("rejects malformed DNS server addresses (non-numeric octet)", async () => {
    render(
      <NetworkTab
        settings={{ dns_enabled: "true", dns_servers: "10.0.0.1,not-an-ip" }}
        onSave={() => {}}
      />
    );
    expect(screen.getByText(/Invalid DNS server address/i)).toBeInTheDocument();
    // Save button must be disabled while validation fails.
    const btn = screen.getByRole("button", { name: /Save Network Settings/ });
    expect(btn).toBeDisabled();
  });

  it("rejects octet > 255", async () => {
    render(
      <NetworkTab settings={{ dns_enabled: "true", dns_servers: "10.0.0.999" }} onSave={() => {}} />
    );
    expect(screen.getByText(/Invalid IP address/i)).toBeInTheDocument();
  });

  it("rejects > 6 search domains (resolv.conf limit)", () => {
    render(
      <NetworkTab
        settings={{
          dns_enabled: "true",
          dns_servers: "10.0.0.1",
          dns_search_domains: "a.com,b.com,c.com,d.com,e.com,f.com,g.com",
        }}
        onSave={() => {}}
      />
    );
    expect(screen.getByText(/at most 6 search domains/i)).toBeInTheDocument();
  });

  it("accepts ip:port form", async () => {
    render(
      <NetworkTab
        settings={{ dns_enabled: "true", dns_servers: "10.0.0.1:5353" }}
        onSave={() => {}}
      />
    );
    expect(screen.queryByText(/Invalid/i)).not.toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /Save Network Settings/ });
    expect(btn).not.toBeDisabled();
  });

  it("calls updateDns + onSave with trimmed values, surfaces restart banner", async () => {
    vi.mocked(updateDns).mockResolvedValueOnce({
      status: "ok",
      restart_required: true,
      message: "",
    });
    const onSave = vi.fn();
    render(
      <NetworkTab
        settings={{
          dns_enabled: "true",
          dns_servers: "  10.0.0.1  ",
          dns_search_domains: "  example.com  ",
        }}
        onSave={onSave}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: /Save Network Settings/ }));
    await waitFor(() =>
      expect(updateDns).toHaveBeenCalledWith({
        dns_enabled: true,
        dns_servers: "10.0.0.1",
        dns_search_domains: "example.com",
      })
    );
    expect(onSave).toHaveBeenCalled();
    expect(await screen.findByText(/Restart required/i)).toBeInTheDocument();
  });
});
