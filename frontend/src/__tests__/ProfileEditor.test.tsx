import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProfileEditor, { type EditingProfile } from "../pages/credentials/ProfileEditor";
import type { CheckoutRequest, CredentialProfile } from "../api";

const baseEditing: EditingProfile = {
  label: "",
  username: "",
  password: "",
  ttl_hours: 4,
};

function makeCheckout(overrides: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return {
    id: "co-1",
    requester_user_id: "u1",
    managed_ad_dn: "CN=admin,DC=corp,DC=local",
    status: "Active",
    requested_duration_mins: 60,
    expires_at: "2099-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeProfile(overrides: Partial<CredentialProfile> = {}): CredentialProfile {
  return {
    id: "p1",
    label: "Domain Admin",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    expired: false,
    ttl_hours: 4,
    ...overrides,
  };
}

function renderEditor(opts: {
  editing?: EditingProfile;
  profiles?: CredentialProfile[];
  activeCheckouts?: CheckoutRequest[];
  allCheckouts?: CheckoutRequest[];
  saving?: boolean;
  setEditing?: (p: EditingProfile | null) => void;
  onSave?: () => void;
  onLinkCheckout?: (profileId: string, checkoutId: string | null) => Promise<void>;
  isCheckoutLive?: (c: CheckoutRequest) => boolean;
  isCheckoutExpired?: (c: CheckoutRequest) => boolean;
}) {
  const setEditing = opts.setEditing ?? vi.fn();
  const onSave = opts.onSave ?? vi.fn();
  const onLinkCheckout = opts.onLinkCheckout ?? vi.fn().mockResolvedValue(undefined);
  const isCheckoutLive = opts.isCheckoutLive ?? ((c) => c.status === "Active");
  const isCheckoutExpired = opts.isCheckoutExpired ?? ((c) => c.status === "Expired");
  return {
    setEditing,
    onSave,
    onLinkCheckout,
    ...render(
      <ProfileEditor
        editing={opts.editing ?? baseEditing}
        setEditing={setEditing}
        saving={opts.saving ?? false}
        profiles={opts.profiles ?? []}
        activeCheckouts={opts.activeCheckouts ?? []}
        allCheckouts={opts.allCheckouts ?? []}
        onSave={onSave}
        onLinkCheckout={onLinkCheckout}
        isCheckoutLive={isCheckoutLive}
        isCheckoutExpired={isCheckoutExpired}
        getTimeRemaining={(d) => (d ? "1h 0m" : "—")}
        formatDateTime={(d) => (d ? "2026-01-01 12:00" : "—")}
      />
    ),
  };
}

describe("ProfileEditor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders 'New Credential Profile' heading when editing has no id", () => {
    renderEditor({});
    expect(screen.getByText("New Credential Profile")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Profile" })).toBeInTheDocument();
  });

  it("renders 'Edit Profile' heading and Update button when editing has id", () => {
    renderEditor({ editing: { ...baseEditing, id: "p1", label: "Existing" } });
    expect(screen.getByText("Edit Profile")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
  });

  it("updates label via setEditing on input change", async () => {
    const setEditing = vi.fn();
    renderEditor({ setEditing });
    const labelInput = screen.getByLabelText("Label");
    fireEvent.change(labelInput, { target: { value: "Foo" } });
    expect(setEditing).toHaveBeenCalledWith(expect.objectContaining({ label: "Foo" }));
  });

  it("updates username and password via setEditing", () => {
    const setEditing = vi.fn();
    renderEditor({ setEditing });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "jsmith" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    expect(setEditing).toHaveBeenCalledWith(expect.objectContaining({ username: "jsmith" }));
    expect(setEditing).toHaveBeenCalledWith(expect.objectContaining({ password: "secret" }));
  });

  it("updates ttl_hours via range slider", () => {
    const setEditing = vi.fn();
    renderEditor({ setEditing });
    fireEvent.change(screen.getByLabelText("Password Expiry"), { target: { value: "8" } });
    expect(setEditing).toHaveBeenCalledWith(expect.objectContaining({ ttl_hours: 8 }));
  });

  it("displays singular 'hour' when ttl_hours is 1", () => {
    renderEditor({ editing: { ...baseEditing, ttl_hours: 1 } });
    expect(screen.getByText("1 hour")).toBeInTheDocument();
  });

  it("displays plural 'hours' when ttl_hours > 1", () => {
    renderEditor({ editing: { ...baseEditing, ttl_hours: 6 } });
    expect(screen.getByText("6 hours")).toBeInTheDocument();
  });

  it("shows managed-account banner with friendly_name when managed_ad_dn is set", () => {
    renderEditor({
      editing: {
        ...baseEditing,
        managed_ad_dn: "CN=svc,DC=corp",
        friendly_name: "Service Account",
      },
    });
    expect(screen.getByText("Service Account")).toBeInTheDocument();
    expect(screen.getAllByText("Managed Account").length).toBeGreaterThan(0);
  });

  it("falls back to managed_ad_dn when friendly_name is absent", () => {
    renderEditor({
      editing: { ...baseEditing, managed_ad_dn: "CN=svc,DC=corp" },
    });
    expect(screen.getByText("CN=svc,DC=corp")).toBeInTheDocument();
  });

  it("shows '[managed]' label banner when label starts with '[managed]'", () => {
    renderEditor({ editing: { ...baseEditing, label: "[managed] something" } });
    expect(screen.getByText("Linked to system checkout")).toBeInTheDocument();
  });

  it("shows linked-checkout banner with live status when checkout is active", () => {
    const checkout = makeCheckout({ status: "Active" });
    const profile = makeProfile({ checkout_id: checkout.id });
    renderEditor({
      editing: { ...baseEditing, id: profile.id, label: profile.label },
      profiles: [profile],
      allCheckouts: [checkout],
    });
    expect(screen.getByText("Managed Account Linked")).toBeInTheDocument();
    expect(screen.getAllByText(/Expires 2026-01-01 12:00/).length).toBeGreaterThan(0);
  });

  it("shows 'Checked in — password scrambled' for CheckedIn linked checkout", () => {
    const checkout = makeCheckout({ status: "CheckedIn" });
    const profile = makeProfile({ checkout_id: checkout.id });
    renderEditor({
      editing: { ...baseEditing, id: profile.id, label: profile.label },
      profiles: [profile],
      allCheckouts: [checkout],
      isCheckoutLive: () => false,
    });
    expect(screen.getAllByText(/Checked in . password scrambled/).length).toBeGreaterThan(0);
  });

  it("shows 'Checkout expired' when status is Expired", () => {
    const checkout = makeCheckout({ status: "Expired" });
    const profile = makeProfile({ checkout_id: checkout.id });
    renderEditor({
      editing: { ...baseEditing, id: profile.id, label: profile.label },
      profiles: [profile],
      allCheckouts: [checkout],
      isCheckoutLive: () => false,
      isCheckoutExpired: () => true,
    });
    expect(screen.getAllByText(/Checkout expired/).length).toBeGreaterThan(0);
  });

  it("shows raw status text for other (e.g. Denied) statuses", () => {
    const checkout = makeCheckout({ status: "Denied" });
    const profile = makeProfile({ checkout_id: checkout.id });
    renderEditor({
      editing: { ...baseEditing, id: profile.id, label: profile.label },
      profiles: [profile],
      allCheckouts: [checkout],
      isCheckoutLive: () => false,
      isCheckoutExpired: () => false,
    });
    expect(screen.getAllByText(/Denied/).length).toBeGreaterThan(0);
  });

  it("hides username/password/ttl inputs when a checkout is linked", () => {
    const checkout = makeCheckout();
    const profile = makeProfile({ checkout_id: checkout.id });
    renderEditor({
      editing: { ...baseEditing, id: profile.id },
      profiles: [profile],
      allCheckouts: [checkout],
    });
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Password Expiry")).not.toBeInTheDocument();
  });

  it("calls onSave when Create Profile button is clicked", async () => {
    const onSave = vi.fn();
    renderEditor({ onSave });
    await userEvent.click(screen.getByRole("button", { name: "Create Profile" }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("disables save button and shows 'Saving…' when saving is true", () => {
    renderEditor({ saving: true });
    const btn = screen.getByRole("button", { name: "Saving…" });
    expect(btn).toBeDisabled();
  });

  it("calls setEditing(null) when Cancel button is clicked", async () => {
    const setEditing = vi.fn();
    renderEditor({ setEditing });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(setEditing).toHaveBeenCalledWith(null);
  });

  it("renders Unlink button and calls onLinkCheckout(id, null) on click", async () => {
    const onLinkCheckout = vi.fn().mockResolvedValue(undefined);
    const checkout = makeCheckout();
    const profile = makeProfile({ checkout_id: checkout.id });
    renderEditor({
      editing: { ...baseEditing, id: profile.id },
      profiles: [profile],
      activeCheckouts: [checkout],
      allCheckouts: [checkout],
      onLinkCheckout,
    });
    const unlink = screen.getByRole("button", { name: "Unlink" });
    await userEvent.click(unlink);
    expect(onLinkCheckout).toHaveBeenCalledWith(profile.id, null);
  });

  it("does not render checkout-link section when no live checkouts and no linked checkout", () => {
    renderEditor({
      editing: { ...baseEditing, id: "p1" },
      profiles: [makeProfile()],
      activeCheckouts: [],
      allCheckouts: [],
    });
    expect(screen.queryByText("Link Checked-Out Account")).not.toBeInTheDocument();
  });

  it("renders Select dropdown with active checkouts when none linked", () => {
    const live = makeCheckout({ id: "co-live", status: "Active" });
    const profile = makeProfile();
    renderEditor({
      editing: { ...baseEditing, id: profile.id },
      profiles: [profile],
      activeCheckouts: [live],
      allCheckouts: [live],
    });
    expect(screen.getByText("Link Checked-Out Account")).toBeInTheDocument();
  });
});
