import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api", () => ({ getFailingAdSyncs: vi.fn() }));

import { getFailingAdSyncs, type FailingAdSync } from "../api";
import AdSyncFailureBanner, { failingFor } from "../components/AdSyncFailureBanner";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const FAILING: FailingAdSync[] = [
  {
    config_id: "ssh",
    label: "Corp SSH",
    protocol: "ssh",
    failures: 3,
    failing_since: hoursAgo(3),
    last_failure_at: hoursAgo(1),
    last_error: "LDAP bind failed: rc=49, invalid credentials",
  },
];

describe("failingFor", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  it("picks a readable unit", () => {
    expect(failingFor("2026-10-04T11:59:50Z", now)).toBe("1 minute");
    expect(failingFor("2026-10-04T11:15:00Z", now)).toBe("45 minutes");
    expect(failingFor("2026-10-04T09:00:00Z", now)).toBe("3 hours");
    expect(failingFor("2026-10-02T12:00:00Z", now)).toBe("2 days");
  });
});

describe("AdSyncFailureBanner", () => {
  beforeEach(() => {
    vi.mocked(getFailingAdSyncs).mockReset();
  });

  it("renders nothing while every source is healthy", async () => {
    vi.mocked(getFailingAdSyncs).mockResolvedValue([]);
    const { container } = render(<AdSyncFailureBanner />);
    await vi.waitFor(() => expect(getFailingAdSyncs).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the status cannot be read", async () => {
    vi.mocked(getFailingAdSyncs).mockRejectedValue(new Error("403"));
    const { container } = render(<AdSyncFailureBanner />);
    await vi.waitFor(() => expect(getFailingAdSyncs).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("names the failing source, how long it has failed and the last error", async () => {
    vi.mocked(getFailingAdSyncs).mockResolvedValue(FAILING);
    const onViewHistory = vi.fn();
    const onFailingChange = vi.fn();
    render(<AdSyncFailureBanner onViewHistory={onViewHistory} onFailingChange={onFailingChange} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("An AD sync source is failing");
    expect(alert).toHaveTextContent("Corp SSH");
    expect(alert).toHaveTextContent("failing for 3 hours, 3 failed runs");
    expect(alert).toHaveTextContent("rc=49, invalid credentials");
    expect(onFailingChange).toHaveBeenCalledWith(FAILING);

    await userEvent.click(screen.getByRole("button", { name: "History" }));
    expect(onViewHistory).toHaveBeenCalledWith("ssh");
  });

  it("links to the AD Sync page only inside the router", async () => {
    vi.mocked(getFailingAdSyncs).mockResolvedValue(FAILING);
    const { unmount } = render(<AdSyncFailureBanner linkToAdSync />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    unmount();

    render(
      <MemoryRouter>
        <AdSyncFailureBanner linkToAdSync />
      </MemoryRouter>
    );
    await screen.findByRole("alert");
    expect(screen.getByRole("link", { name: "Open AD Sync" })).toHaveAttribute(
      "href",
      "/admin/ad-sync"
    );
  });
});
