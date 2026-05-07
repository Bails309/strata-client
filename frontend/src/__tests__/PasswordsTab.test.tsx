import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PasswordsTab, { __parseDN as parseDN } from "../pages/admin/PasswordsTab";
import { SettingsProvider } from "../contexts/SettingsContext";
import {
  getApprovalRoles,
  getRoleAssignments,
  getRoleAccounts,
  getAccountMappings,
  getCheckoutRequests,
  getUnmappedAccounts,
  ApprovalRole,
} from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    getApprovalRoles: vi.fn(),
    getRoleAssignments: vi.fn(),
    getRoleAccounts: vi.fn(),
    getAccountMappings: vi.fn(),
    getCheckoutRequests: vi.fn(),
    getUnmappedAccounts: vi.fn(),
    createApprovalRole: vi.fn(),
    deleteApprovalRole: vi.fn(),
    setRoleAssignments: vi.fn(),
    setRoleAccounts: vi.fn(),
    createAccountMapping: vi.fn(),
    deleteAccountMapping: vi.fn(),
    updateAccountMapping: vi.fn(),
    getTimeSettings: vi.fn().mockResolvedValue({
      timezone: "UTC",
      date_format: "yyyy-MM-dd",
      time_format: "HH:mm",
    }),
  };
});

const role = (over: Partial<ApprovalRole> = {}): ApprovalRole => ({
  id: "r1",
  name: "DBAs",
  description: "Database admins",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApprovalRoles).mockResolvedValue([]);
  vi.mocked(getRoleAssignments).mockResolvedValue([]);
  vi.mocked(getRoleAccounts).mockResolvedValue([]);
  vi.mocked(getAccountMappings).mockResolvedValue([]);
  vi.mocked(getCheckoutRequests).mockResolvedValue([]);
  vi.mocked(getUnmappedAccounts).mockResolvedValue([]);
});

const renderTab = () =>
  render(
    <SettingsProvider>
      <PasswordsTab users={[]} adSyncConfigs={[]} onSave={vi.fn()} />
    </SettingsProvider>
  );

describe("PasswordsTab.parseDN", () => {
  it("returns the em-dash placeholder for empty input", () => {
    expect(parseDN("")).toBe("\u2014");
  });

  it("renders DOMAIN\\CN when both are present", () => {
    expect(parseDN("CN=svc-prod-db,OU=Service Accounts,DC=corp,DC=example,DC=com")).toBe(
      "corp.example.com\\svc-prod-db"
    );
  });

  it("falls back to bare CN when no DC components are present", () => {
    expect(parseDN("CN=svc-only,OU=Service")).toBe("svc-only");
  });

  it("unescapes backslash-escaped commas inside the CN", () => {
    expect(parseDN("CN=Smith\\, John,DC=corp,DC=example,DC=com")).toBe(
      "corp.example.com\\Smith, John"
    );
  });

  it("returns 'Unknown' when no CN component is present", () => {
    expect(parseDN("OU=NoCN,DC=corp,DC=example,DC=com")).toBe("corp.example.com\\Unknown");
  });

  it("is case-insensitive on attribute names", () => {
    expect(parseDN("cn=svc,dc=corp,dc=example,dc=com")).toBe("corp.example.com\\svc");
  });
});

describe("PasswordsTab", () => {
  it("loads approval roles, assignments, and account scopes on mount", async () => {
    vi.mocked(getApprovalRoles).mockResolvedValue([role()]);
    renderTab();
    await waitFor(() => expect(getApprovalRoles).toHaveBeenCalled());
    await waitFor(() => expect(getRoleAssignments).toHaveBeenCalledWith("r1"));
    await waitFor(() => expect(getRoleAccounts).toHaveBeenCalledWith("r1"));
    expect(await screen.findByText("DBAs")).toBeInTheDocument();
  });

  it("renders three sub-tabs and switches between them", async () => {
    renderTab();
    await waitFor(() => expect(getApprovalRoles).toHaveBeenCalled());
    const mappingsBtn = await screen.findByRole("button", { name: /Account Mappings/i });
    await userEvent.click(mappingsBtn);
    // The mappings list loader fires once when its tab is rendered.
    await waitFor(() => expect(getAccountMappings).toHaveBeenCalled());
  });
});
