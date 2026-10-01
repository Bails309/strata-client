import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api", () => ({
  updateDns: vi.fn(),
  updateSettings: vi.fn(),
}));

import NetworkTab from "../pages/admin/NetworkTab";
import { updateDns, updateSettings } from "../api";

beforeEach(() => {
  vi.mocked(updateDns).mockResolvedValue({
    status: "ok",
    restart_required: false,
    message: "",
  });
  vi.mocked(updateSettings).mockResolvedValue({ status: "updated" } as never);
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

  it("calls updateDns + onSave with trimmed values, and confirms which servers will be used", async () => {
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
    // Since v2.0.0 the engine resolves in-process, so saving takes effect on
    // the next session. Naming the servers back is the only confirmation the
    // operator gets that the value landed.
    expect(await screen.findByText(/Saved/i)).toBeInTheDocument();
    expect(screen.getByText(/10\.0\.0\.1/)).toBeInTheDocument();
  });

  it("saves web-session allowed networks only when they changed", async () => {
    render(<NetworkTab settings={{ web_allowed_networks: "10.0.0.0/8" }} onSave={() => {}} />);
    const field = screen.getByRole("textbox", { name: /Allowed Networks/i });
    expect(field).toHaveValue("10.0.0.0/8");

    await userEvent.click(screen.getByRole("button", { name: /Save Network Settings/ }));
    await waitFor(() => expect(updateDns).toHaveBeenCalled());
    expect(updateSettings).not.toHaveBeenCalled();

    await userEvent.type(field, "\n192.168.1.5 ");
    await userEvent.click(screen.getByRole("button", { name: /Save Network Settings/ }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith([
        { key: "web_allowed_networks", value: "10.0.0.0/8\n192.168.1.5" },
      ])
    );
  });

  it("blocks saving a malformed allowed network", async () => {
    render(<NetworkTab settings={{ web_allowed_networks: "intranet" }} onSave={() => {}} />);
    expect(screen.getByText(/Invalid network/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save Network Settings/ })).toBeDisabled();
  });
});
