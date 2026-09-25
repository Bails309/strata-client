import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { render, screen, fireEvent } from "@testing-library/react";
import { useConnectionFilter, FilterState, ConnectionFilterItem } from "../hooks/useConnectionFilter";
import ConnectionEmptyState from "../components/ConnectionEmptyState";
import ActiveFilterChips from "../components/ActiveFilterChips";

describe("useConnectionFilter hook", () => {
  const sampleConnections: ConnectionFilterItem[] = [
    {
      id: "conn-1",
      name: "Prod Database Primary",
      protocol: "SSH",
      hostname: "db1.prod.internal",
      description: "Postgres primary cluster",
      isFavorite: true,
      tags: ["tag-prod", "tag-db"],
    },
    {
      id: "conn-2",
      name: "Staging Web Gateway",
      protocol: "SSH",
      hostname: "web.staging.internal",
      description: "Nginx reverse proxy",
      isFavorite: false,
      tags: ["tag-staging"],
    },
    {
      id: "conn-3",
      name: "Prod Windows Bastion",
      protocol: "RDP",
      hostname: "bastion.prod.internal",
      description: "Windows Server jump host",
      isFavorite: true,
      tags: ["tag-prod", "tag-bastion"],
    },
    {
      id: "conn-4",
      name: "Legacy Telnet Switch",
      protocol: "TELNET",
      hostname: "switch1.local",
      description: "Core switch management",
      isFavorite: false,
      tags: [],
    },
  ];

  it("returns all connections when filters are at defaults", () => {
    const { result } = renderHook(() => useConnectionFilter(sampleConnections));

    expect(result.current.filteredConnections).toHaveLength(4);
    expect(result.current.globalSearchMatches).toHaveLength(0); // empty searchQuery returns []
  });

  it("computes scoped view and parallel ambient global search match", () => {
    const { result } = renderHook(() =>
      useConnectionFilter(sampleConnections, {
        searchQuery: "Bastion",
        favoritesOnly: false,
        selectedTag: "tag-db", // conn-3 does NOT have tag-db!
        selectedProtocol: "ALL",
      })
    );

    // Scoped view has 0 matches because conn-3 doesn't match selectedTag: tag-db
    expect(result.current.filteredConnections).toHaveLength(0);

    // Global search unscoped view finds conn-3 ("Prod Windows Bastion") ignoring tag restrictions
    expect(result.current.globalSearchMatches).toHaveLength(1);
    expect(result.current.globalSearchMatches[0].name).toBe("Prod Windows Bastion");
  });

  it("evaluates matches across name, hostname, and description", () => {
    // Search hostname
    const { result: r1 } = renderHook(() =>
      useConnectionFilter(sampleConnections, { searchQuery: "staging.internal" })
    );
    expect(r1.current.filteredConnections).toHaveLength(1);
    expect(r1.current.filteredConnections[0].id).toBe("conn-2");

    // Search description
    const { result: r2 } = renderHook(() =>
      useConnectionFilter(sampleConnections, { searchQuery: "cluster" })
    );
    expect(r2.current.filteredConnections).toHaveLength(1);
    expect(r2.current.filteredConnections[0].id).toBe("conn-1");
  });

  it("filters by protocol case-insensitively and allows ALL", () => {
    const { result: r1 } = renderHook(() =>
      useConnectionFilter(sampleConnections, { selectedProtocol: "ssh" })
    );
    expect(r1.current.filteredConnections).toHaveLength(2);

    const { result: r2 } = renderHook(() =>
      useConnectionFilter(sampleConnections, { selectedProtocol: "ALL" })
    );
    expect(r2.current.filteredConnections).toHaveLength(4);
  });

  it("filters by favoritesOnly and selectedTag", () => {
    const { result } = renderHook(() =>
      useConnectionFilter(sampleConnections, {
        favoritesOnly: true,
        selectedTag: "tag-bastion",
      })
    );

    expect(result.current.filteredConnections).toHaveLength(1);
    expect(result.current.filteredConnections[0].id).toBe("conn-3");
  });

  it("preserves exact searchQuery when calling clearScope", () => {
    const { result } = renderHook(() =>
      useConnectionFilter(sampleConnections, {
        searchQuery: "Bastion",
        favoritesOnly: true,
        selectedTag: "tag-db",
      })
    );

    expect(result.current.filters.favoritesOnly).toBe(true);
    expect(result.current.filters.selectedTag).toBe("tag-db");
    expect(result.current.filters.searchQuery).toBe("Bastion");

    act(() => {
      result.current.clearScope();
    });

    expect(result.current.filters.favoritesOnly).toBe(false);
    expect(result.current.filters.selectedTag).toBeNull();
    // searchQuery must be strictly preserved
    expect(result.current.filters.searchQuery).toBe("Bastion");
    // After clearing scope, conn-3 matches
    expect(result.current.filteredConnections).toHaveLength(1);
    expect(result.current.filteredConnections[0].name).toBe("Prod Windows Bastion");
  });

  it("resets all filters to initial state with resetAllFilters", () => {
    const { result } = renderHook(() =>
      useConnectionFilter(sampleConnections, {
        searchQuery: "Switch",
        favoritesOnly: true,
        selectedTag: "tag-prod",
        selectedProtocol: "SSH",
      })
    );

    act(() => {
      result.current.resetAllFilters();
    });

    expect(result.current.filters).toEqual({
      searchQuery: "",
      favoritesOnly: false,
      selectedTag: null,
      selectedProtocol: "ALL",
    });
    expect(result.current.filteredConnections).toHaveLength(4);
  });
});

describe("ConnectionEmptyState component", () => {
  const baseFilters: FilterState = {
    searchQuery: "Bastion",
    favoritesOnly: true,
    selectedTag: null,
    selectedProtocol: "ALL",
  };

  it("renders resolution card when constrained search yields 0 in-scope and > 0 global matches", () => {
    const handleClearScope = vi.fn();
    const handleResetAll = vi.fn();

    render(
      <ConnectionEmptyState
        filters={baseFilters}
        filteredCount={0}
        globalCount={3}
        onClearScope={handleClearScope}
        onResetAll={handleResetAll}
        totalConnections={10}
      />
    );

    expect(screen.getByText("No matches in current filter")).toBeDefined();
    expect(screen.getByText(/Found/i)).toBeDefined();
    expect(screen.getByText(/3 connections/i)).toBeDefined();
    expect(screen.getByText(/outside your active scope/i)).toBeDefined();

    const showAllBtn = screen.getByRole("button", { name: /Show all 3 results/i });
    fireEvent.click(showAllBtn);
    expect(handleClearScope).toHaveBeenCalledTimes(1);

    const clearAllBtn = screen.getByRole("button", { name: /Clear all filters/i });
    fireEvent.click(clearAllBtn);
    expect(handleResetAll).toHaveBeenCalledTimes(1);
  });

  it("renders singular 'connection' text when globalCount is 1", () => {
    render(
      <ConnectionEmptyState
        filters={baseFilters}
        filteredCount={0}
        globalCount={1}
        onClearScope={vi.fn()}
        onResetAll={vi.fn()}
        totalConnections={10}
      />
    );

    expect(screen.getByText(/1 connection/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /Show all 1 results/i })).toBeDefined();
  });

  it("renders standard empty message when unconstrained or globalCount is 0", () => {
    render(
      <ConnectionEmptyState
        filters={{ ...baseFilters, favoritesOnly: false, selectedTag: null }}
        filteredCount={0}
        globalCount={0}
        onClearScope={vi.fn()}
        onResetAll={vi.fn()}
        totalConnections={10}
      />
    );

    expect(screen.getByText("No connections found matching your query.")).toBeDefined();
  });

  it("renders administrator onboarding message when totalConnections is 0", () => {
    render(
      <ConnectionEmptyState
        filters={baseFilters}
        filteredCount={0}
        globalCount={0}
        onClearScope={vi.fn()}
        onResetAll={vi.fn()}
        totalConnections={0}
      />
    );

    expect(
      screen.getByText(/No connections available\. Ask your administrator to assign connections to your role\./i)
    ).toBeDefined();
  });
});

describe("ActiveFilterChips component", () => {
  it("renders nothing when no filters are active", () => {
    const { container } = render(
      <ActiveFilterChips
        filters={{
          searchQuery: "",
          favoritesOnly: false,
          selectedTag: null,
          selectedProtocol: "ALL",
        }}
        setFilter={vi.fn()}
        resetAllFilters={vi.fn()}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders chips for active filters and handles dismissal", () => {
    const handleSetFilter = vi.fn();
    const handleResetAll = vi.fn();

    render(
      <ActiveFilterChips
        filters={{
          searchQuery: "linux",
          favoritesOnly: true,
          selectedTag: "tag-1",
          selectedProtocol: "SSH",
        }}
        setFilter={handleSetFilter}
        resetAllFilters={handleResetAll}
        selectedTagName="Production"
      />
    );

    expect(screen.getByText("Active:")).toBeDefined();
    expect(screen.getByText(/★ Favorites/i)).toBeDefined();
    expect(screen.getByText(/🏷️ Production/i)).toBeDefined();
    expect(screen.getByText(/SSH/i)).toBeDefined();
    expect(screen.getByText(/"linux"/i)).toBeDefined();

    // Click Favorites chip
    fireEvent.click(screen.getByRole("button", { name: /★ Favorites/i }));
    expect(handleSetFilter).toHaveBeenCalledWith("favoritesOnly", false);

    // Click Tag chip
    fireEvent.click(screen.getByRole("button", { name: /🏷️ Production/i }));
    expect(handleSetFilter).toHaveBeenCalledWith("selectedTag", null);

    // Click Protocol chip
    fireEvent.click(screen.getByRole("button", { name: /SSH/i }));
    expect(handleSetFilter).toHaveBeenCalledWith("selectedProtocol", "ALL");

    // Click Search chip
    fireEvent.click(screen.getByRole("button", { name: /"linux"/i }));
    expect(handleSetFilter).toHaveBeenCalledWith("searchQuery", "");

    // Click Reset all
    fireEvent.click(screen.getByRole("button", { name: /Reset all/i }));
    expect(handleResetAll).toHaveBeenCalledTimes(1);
  });
});
