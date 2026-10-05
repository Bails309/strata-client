import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  getMyConnectionFacets: vi.fn(),
  getMyConnectionsPage: vi.fn(),
  getMyConnectionsByIds: vi.fn(),
}));

import {
  getMyConnectionFacets,
  getMyConnectionsByIds,
  getMyConnectionsPage,
  type Connection,
} from "../api";
import useDashboardConnections, { HEALTH_REFRESH_MS } from "../hooks/useDashboardConnections";

const conn = (id: string, health: Connection["health_status"]): Connection => ({
  id,
  name: id,
  protocol: "rdp",
  hostname: `${id}.example`,
  port: 3389,
  health_status: health,
  health_checked_at: "2026-10-05T09:00:00Z",
});

const options = { filters: {}, folderView: false, page: 1, pageSize: 50 };

describe("useDashboardConnections reachability refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getMyConnectionFacets).mockResolvedValue({
      total: 1,
      search_total: 1,
      all_total: 1,
      protocols: ["rdp"],
      folders: [],
    });
    vi.mocked(getMyConnectionsPage).mockResolvedValue({
      items: [conn("a", "offline")],
      total: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("picks up a host coming back online without reloading the page", async () => {
    vi.mocked(getMyConnectionsByIds).mockResolvedValue([
      { ...conn("a", "online"), health_checked_at: "2026-10-05T09:02:00Z" },
    ]);
    const { result } = renderHook(() => useDashboardConnections(options));
    await waitFor(() => expect(result.current.pageRows?.items[0].health_status).toBe("offline"));
    const pageCalls = vi.mocked(getMyConnectionsPage).mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTH_REFRESH_MS);
    });

    await waitFor(() => expect(result.current.pageRows?.items[0].health_status).toBe("online"));
    expect(getMyConnectionsByIds).toHaveBeenCalledWith(["a"]);
    // Patched in place: the listing itself is not fetched again.
    expect(vi.mocked(getMyConnectionsPage).mock.calls.length).toBe(pageCalls);
  });

  it("does not poll while the tab is hidden", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { result } = renderHook(() => useDashboardConnections(options));
    await waitFor(() => expect(result.current.pageRows).not.toBeNull());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTH_REFRESH_MS * 2);
    });

    expect(getMyConnectionsByIds).not.toHaveBeenCalled();
    visibility.mockRestore();
  });
});
