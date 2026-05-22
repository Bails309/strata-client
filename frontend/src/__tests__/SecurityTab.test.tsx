import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api", () => ({
  updateSettings: vi.fn(),
  updateAuthMethods: vi.fn(),
}));

import SecurityTab from "../pages/admin/SecurityTab";
import { updateSettings, updateAuthMethods } from "../api";

beforeEach(() => {
  vi.mocked(updateSettings).mockResolvedValue({ status: "ok" });
  vi.mocked(updateAuthMethods).mockResolvedValue({ status: "ok" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SecurityTab", () => {
  it("defaults local auth to enabled when setting is undefined", () => {
    render(<SecurityTab settings={{}} onSave={() => {}} />);
    const local = screen.getByRole("checkbox", {
      name: /Local Authentication/i,
    }) as HTMLInputElement;
    expect(local.checked).toBe(true);
  });

  it("uses 90 days as the default user hard-delete window", () => {
    render(<SecurityTab settings={{}} onSave={() => {}} />);
    const days = screen.getByLabelText(/User hard-delete window/i) as HTMLInputElement;
    expect(days.value).toBe("90");
  });

  it("prevents disabling both auth methods at once", async () => {
    // Start with SSO disabled. Trying to also disable Local must be a
    // no-op so admins cannot accidentally lock everyone out.
    render(
      <SecurityTab
        settings={{ sso_enabled: "false", local_auth_enabled: "true" }}
        onSave={() => {}}
      />
    );
    const local = screen.getByRole("checkbox", {
      name: /Local Authentication/i,
    }) as HTMLInputElement;
    expect(local.checked).toBe(true);
    await userEvent.click(local);
    expect(local.checked).toBe(true);
  });

  it("rejects out-of-range user hard-delete window", async () => {
    render(<SecurityTab settings={{}} onSave={() => {}} />);
    const days = screen.getByLabelText(/User hard-delete window/i) as HTMLInputElement;
    await userEvent.clear(days);
    await userEvent.type(days, "99999");
    await userEvent.click(screen.getByRole("button", { name: /Save Security Settings/ }));
    // Validation throws before either API is called.
    await waitFor(() => {
      expect(updateSettings).not.toHaveBeenCalled();
      expect(updateAuthMethods).not.toHaveBeenCalled();
    });
  });

  it("persists watermark + retention + auth methods on save", async () => {
    const onSave = vi.fn();
    render(
      <SecurityTab
        settings={{
          watermark_enabled: "true",
          sso_enabled: "true",
          local_auth_enabled: "true",
          user_hard_delete_days: "30",
        }}
        onSave={onSave}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: /Save Security Settings/ }));
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith([
        { key: "watermark_enabled", value: "true" },
        { key: "user_hard_delete_days", value: "30" },
        { key: "user_stale_days", value: "0" },
      ]);
      expect(updateAuthMethods).toHaveBeenCalledWith({
        sso_enabled: true,
        local_auth_enabled: true,
      });
    });
    expect(onSave).toHaveBeenCalled();
  });
});
