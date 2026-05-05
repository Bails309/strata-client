import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import RequestCheckoutForm from "../pages/credentials/RequestCheckoutForm";
import type { UserAccountMapping } from "../api";

const makeAccount = (over: Partial<UserAccountMapping> = {}): UserAccountMapping => ({
  id: "m1",
  user_id: "u1",
  ad_sync_config_id: "ads-1",
  managed_ad_dn: "CN=admin,DC=corp",
  friendly_name: "Domain Admin",
  can_self_approve: true,
  created_at: "2026-01-01T00:00:00Z",
  pm_allow_emergency_bypass: false,
  ...over,
});

function renderForm(over: Partial<React.ComponentProps<typeof RequestCheckoutForm>> = {}) {
  const setDuration = vi.fn();
  const setScheduledStart = vi.fn();
  const setScheduleEnabled = vi.fn();
  const setJustification = vi.fn();
  const setEmergencyBypass = vi.fn();
  const setSelectedDn = vi.fn();
  const onRequest = vi.fn();
  return {
    setDuration,
    setScheduledStart,
    setScheduleEnabled,
    setJustification,
    setEmergencyBypass,
    setSelectedDn,
    onRequest,
    ...render(
      <RequestCheckoutForm
        managedAccounts={[makeAccount()]}
        allCheckouts={[]}
        selectedDn="CN=admin,DC=corp"
        setSelectedDn={setSelectedDn}
        duration={5}
        setDuration={setDuration}
        justification=""
        setJustification={setJustification}
        emergencyBypass={false}
        setEmergencyBypass={setEmergencyBypass}
        scheduleEnabled={false}
        setScheduleEnabled={setScheduleEnabled}
        scheduledStart=""
        setScheduledStart={setScheduledStart}
        submitting={false}
        isCheckoutExpired={() => false}
        onRequest={onRequest}
        {...over}
      />
    ),
  };
}

describe("RequestCheckoutForm — extra coverage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clamps duration via direct input onChange", () => {
    const { setDuration } = renderForm();
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "9999" } });
    expect(setDuration).toHaveBeenLastCalledWith(720); // clamped to default cap
  });

  it("clamps to 1 when input value is below 1", () => {
    const { setDuration } = renderForm();
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "0" } });
    expect(setDuration).toHaveBeenLastCalledWith(1);
  });

  it("clamps onBlur as well", () => {
    const { setDuration } = renderForm();
    const input = screen.getByRole("spinbutton");
    fireEvent.blur(input, { target: { value: "10000" } });
    expect(setDuration).toHaveBeenCalledWith(720);
  });

  it("sets scheduledStart when datetime-local input changes (schedule enabled)", () => {
    const { setScheduledStart } = renderForm({
      scheduleEnabled: true,
      scheduledStart: "2099-01-01T12:00",
    });
    const dt = document.querySelector("input[type='datetime-local']") as HTMLInputElement;
    expect(dt).toBeTruthy();
    fireEvent.change(dt, { target: { value: "2099-02-02T08:30" } });
    expect(setScheduledStart).toHaveBeenCalledWith("2099-02-02T08:30");
  });

  it("renders 'No managed accounts' message when managedAccounts empty", () => {
    renderForm({ managedAccounts: [] });
    expect(screen.getByText(/No managed accounts assigned to you/)).toBeInTheDocument();
  });

  it("renders 'all blocked' message when every account has an active checkout", () => {
    renderForm({
      managedAccounts: [makeAccount()],
      allCheckouts: [
        {
          id: "c",
          requester_user_id: "u1",
          managed_ad_dn: "CN=admin,DC=corp",
          status: "Active",
          requested_duration_mins: 60,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    expect(
      screen.getByText(/All managed accounts already have active checkouts/)
    ).toBeInTheDocument();
  });
});
