import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NotificationsTab from "../pages/admin/NotificationsTab";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    getSmtpConfig: vi.fn(),
    updateSmtpConfig: vi.fn(),
    testSmtpSend: vi.fn(),
    listEmailDeliveries: vi.fn(),
  };
});

import {
  getSmtpConfig,
  updateSmtpConfig,
  testSmtpSend,
  listEmailDeliveries,
  ApiError,
  SmtpConfig,
  EmailDelivery,
} from "../api";

const defaultCfg = (over: Partial<SmtpConfig> = {}): SmtpConfig => ({
  enabled: false,
  host: "",
  port: 587,
  username: "",
  tls_mode: "starttls",
  from_address: "",
  from_name: "Strata Client",
  password_set: false,
  branding_accent_color: "#2563eb",
  ...over,
});

const onSave = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  onSave.mockReset();
  vi.mocked(getSmtpConfig).mockResolvedValue(defaultCfg());
  vi.mocked(listEmailDeliveries).mockResolvedValue([]);
  vi.mocked(updateSmtpConfig).mockResolvedValue({ status: "smtp_updated" });
  vi.mocked(testSmtpSend).mockResolvedValue({ status: "sent" });
});

describe("NotificationsTab", () => {
  it("shows a loading state before the SMTP config arrives", () => {
    vi.mocked(getSmtpConfig).mockReturnValue(new Promise(() => {}));
    render(<NotificationsTab onSave={onSave} />);
    expect(screen.getByText(/Loading SMTP settings/i)).toBeInTheDocument();
  });

  it("renders a load error when getSmtpConfig rejects with an ApiError", async () => {
    vi.mocked(getSmtpConfig).mockRejectedValue(new ApiError(500, "boom"));
    render(<NotificationsTab onSave={onSave} />);
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });

  it("falls back to a generic message when the load rejection is not an ApiError", async () => {
    vi.mocked(getSmtpConfig).mockRejectedValue(new Error("x"));
    render(<NotificationsTab onSave={onSave} />);
    expect(await screen.findByText(/Failed to load SMTP settings/)).toBeInTheDocument();
  });

  it("shows form fields only after enabling SMTP", async () => {
    render(<NotificationsTab onSave={onSave} />);
    await waitFor(() => expect(getSmtpConfig).toHaveBeenCalled());
    expect(screen.queryByLabelText(/SMTP host/i)).not.toBeInTheDocument();

    const toggle = screen.getByRole("checkbox", { name: /Enable notification emails/i });
    await userEvent.click(toggle);
    expect(screen.getByText(/SMTP host/i)).toBeInTheDocument();
    expect(screen.getByText(/From address/i)).toBeInTheDocument();
  });

  it("pre-fills form fields from the loaded config", async () => {
    vi.mocked(getSmtpConfig).mockResolvedValue(
      defaultCfg({
        enabled: true,
        host: "smtp.corp.local",
        port: 2525,
        username: "svc@corp.local",
        tls_mode: "implicit",
        from_address: "no-reply@corp.local",
        from_name: "Acme Strata",
        branding_accent_color: "#112233",
        password_set: true,
      })
    );
    render(<NotificationsTab onSave={onSave} />);
    expect(await screen.findByDisplayValue("smtp.corp.local")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2525")).toBeInTheDocument();
    expect(screen.getByDisplayValue("svc@corp.local")).toBeInTheDocument();
    expect(screen.getByDisplayValue("no-reply@corp.local")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Acme Strata")).toBeInTheDocument();
    // password placeholder surfaces the sealed-in-vault hint
    expect(screen.getByPlaceholderText(/sealed in Vault/i)).toBeInTheDocument();
  });

  it("surfaces a validation warning and disables Save when host/from are empty with SMTP enabled", async () => {
    render(<NotificationsTab onSave={onSave} />);
    await waitFor(() => expect(getSmtpConfig).toHaveBeenCalled());
    const toggle = screen.getByRole("checkbox", { name: /Enable notification emails/i });
    await userEvent.click(toggle);
    expect(screen.getByText(/Host is required when SMTP is enabled/i)).toBeInTheDocument();
    const saveBtn = screen.getByRole("button", { name: /Save SMTP Settings/i });
    expect(saveBtn).toBeDisabled();
  });

  it("submits updated settings and calls onSave on success", async () => {
    vi.mocked(getSmtpConfig)
      .mockResolvedValueOnce(
        defaultCfg({
          enabled: true,
          host: "smtp.corp.local",
          from_address: "from@corp.local",
          password_set: false,
        })
      )
      .mockResolvedValueOnce(
        defaultCfg({
          enabled: true,
          host: "smtp.corp.local",
          from_address: "from@corp.local",
          password_set: true,
        })
      );
    render(<NotificationsTab onSave={onSave} />);
    await screen.findByDisplayValue("smtp.corp.local");
    // Type a new password so the update includes it
    const pwInput = screen.getByPlaceholderText(/Not set/i);
    await userEvent.type(pwInput, "sekret");
    const saveBtn = screen.getByRole("button", { name: /Save SMTP Settings/i });
    await userEvent.click(saveBtn);
    await waitFor(() => expect(updateSmtpConfig).toHaveBeenCalledTimes(1));
    const body = vi.mocked(updateSmtpConfig).mock.calls[0][0];
    expect(body.host).toBe("smtp.corp.local");
    expect(body.password).toBe("sekret");
    expect(onSave).toHaveBeenCalled();
  });

  it("shows the save error banner when updateSmtpConfig rejects", async () => {
    vi.mocked(getSmtpConfig).mockResolvedValue(
      defaultCfg({
        enabled: true,
        host: "smtp.corp.local",
        from_address: "from@corp.local",
      })
    );
    vi.mocked(updateSmtpConfig).mockRejectedValue(new ApiError(400, "vault sealed"));
    render(<NotificationsTab onSave={onSave} />);
    await screen.findByDisplayValue("smtp.corp.local");
    await userEvent.click(screen.getByRole("button", { name: /Save SMTP Settings/i }));
    expect(await screen.findByText("vault sealed")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('"Clear" button sets password to empty string; "Keep existing" reverts to undefined', async () => {
    vi.mocked(getSmtpConfig).mockResolvedValue(
      defaultCfg({
        enabled: true,
        host: "smtp.corp.local",
        from_address: "from@corp.local",
        password_set: true,
      })
    );
    render(<NotificationsTab onSave={onSave} />);
    await screen.findByPlaceholderText(/sealed in Vault/i);

    // Click Clear → password becomes ""
    await userEvent.click(screen.getByRole("button", { name: /Clear/i }));
    await userEvent.click(screen.getByRole("button", { name: /Save SMTP Settings/i }));
    await waitFor(() => expect(updateSmtpConfig).toHaveBeenCalled());
    expect(vi.mocked(updateSmtpConfig).mock.calls[0][0].password).toBe("");

    // Type a value, then Keep existing → password becomes undefined
    vi.mocked(updateSmtpConfig).mockClear();
    const pwInput = screen.getByPlaceholderText(/sealed in Vault/i);
    await userEvent.type(pwInput, "new");
    await userEvent.click(screen.getByRole("button", { name: /Keep existing/i }));
    await userEvent.click(screen.getByRole("button", { name: /Save SMTP Settings/i }));
    await waitFor(() => expect(updateSmtpConfig).toHaveBeenCalled());
    expect(vi.mocked(updateSmtpConfig).mock.calls[0][0].password).toBeUndefined();
  });

  it("test-send button is disabled until SMTP is enabled in the saved config", async () => {
    render(<NotificationsTab onSave={onSave} />);
    await waitFor(() => expect(getSmtpConfig).toHaveBeenCalled());
    const btn = screen.getByRole("button", { name: /Send test/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/Enable SMTP and save before running a test/i)).toBeInTheDocument();
  });

  it("rejects an invalid test recipient without calling the API", async () => {
    vi.mocked(getSmtpConfig).mockResolvedValue(
      defaultCfg({ enabled: true, host: "h", from_address: "f@x.y" })
    );
    render(<NotificationsTab onSave={onSave} />);
    await screen.findByDisplayValue("h");
    const recipient = screen.getByPlaceholderText("you@corp.example.com");
    await userEvent.type(recipient, "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: /Send test/i }));
    expect(await screen.findByText(/Enter a valid recipient address/)).toBeInTheDocument();
    expect(testSmtpSend).not.toHaveBeenCalled();
  });

  it("runs a successful test-send and shows the accepted banner", async () => {
    vi.mocked(getSmtpConfig).mockResolvedValue(
      defaultCfg({ enabled: true, host: "h", from_address: "f@x.y" })
    );
    render(<NotificationsTab onSave={onSave} />);
    await screen.findByDisplayValue("h");
    const recipient = screen.getByPlaceholderText("you@corp.example.com");
    await userEvent.type(recipient, "probe@corp.local");
    await userEvent.click(screen.getByRole("button", { name: /Send test/i }));
    expect(
      await screen.findByText(/Test message accepted by the relay for probe@corp.local/)
    ).toBeInTheDocument();
    expect(testSmtpSend).toHaveBeenCalledWith("probe@corp.local");
  });

  it("surfaces the SMTP response on a failed test-send", async () => {
    vi.mocked(getSmtpConfig).mockResolvedValue(
      defaultCfg({ enabled: true, host: "h", from_address: "f@x.y" })
    );
    vi.mocked(testSmtpSend).mockRejectedValue(new ApiError(500, "550 rejected"));
    render(<NotificationsTab onSave={onSave} />);
    await screen.findByDisplayValue("h");
    await userEvent.type(screen.getByPlaceholderText("you@corp.example.com"), "probe@corp.local");
    await userEvent.click(screen.getByRole("button", { name: /Send test/i }));
    expect(await screen.findByText("550 rejected")).toBeInTheDocument();
  });

  it("renders the deliveries table and re-queries when the status filter changes", async () => {
    const rows: EmailDelivery[] = [
      {
        id: "00000000-0000-0000-0000-000000000001",
        template_key: "checkout_pending",
        recipient_email: "approver@corp.local",
        subject: "Checkout request awaiting your approval",
        status: "sent",
        attempts: 1,
        last_error: null,
        created_at: "2026-04-24T12:00:00Z",
        sent_at: "2026-04-24T12:00:01Z",
      },
    ];
    vi.mocked(listEmailDeliveries).mockResolvedValue(rows);
    render(<NotificationsTab onSave={onSave} />);
    expect(await screen.findByText("checkout_pending")).toBeInTheDocument();
    expect(screen.getByText("approver@corp.local")).toBeInTheDocument();

    // Change filter → the API should be re-called with the new status
    const filter = screen.getByRole("combobox");
    await userEvent.selectOptions(filter, "sent");
    await waitFor(() => {
      expect(listEmailDeliveries).toHaveBeenCalledWith("sent", 50);
    });
  });

  it("shows the empty-state copy when the deliveries list is empty", async () => {
    render(<NotificationsTab onSave={onSave} />);
    expect(await screen.findByText(/No deliveries recorded yet/)).toBeInTheDocument();
  });

  it("swallows deliveries load errors without crashing", async () => {
    vi.mocked(listEmailDeliveries).mockRejectedValue(new Error("deliveries boom"));
    render(<NotificationsTab onSave={onSave} />);
    // Header still renders; no banner
    expect(await screen.findByText("Recent deliveries")).toBeInTheDocument();
  });
});
