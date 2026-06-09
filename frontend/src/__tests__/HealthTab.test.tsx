import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import HealthTab from "../pages/admin/HealthTab";
import {
  getServiceHealth,
  getMetrics,
  getCertificates,
  ServiceHealth,
  MetricsSummary,
  CertificatesResponse,
} from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    getServiceHealth: vi.fn(),
    getMetrics: vi.fn(),
    getCertificates: vi.fn(),
  };
});

const health = (over: Partial<ServiceHealth> = {}): ServiceHealth => ({
  version: "1.5.3",
  database: { connected: true, mode: "external", host: "db.local", latency_ms: 4 },
  guacd: { reachable: true, host: "guacd", port: 4822 },
  vault: { configured: true, mode: "vault", address: "https://vault" },
  schema: { status: "ok", applied_migrations: 44, expected_migrations: 44 },
  av: { backend: "off", enabled: false, reachable: false, fail_mode: "block", address: null },
  uptime_secs: 3661,
  environment: "production",
  ...over,
});

const metrics = (over: Partial<MetricsSummary> = {}): MetricsSummary => ({
  active_sessions: 2,
  total_bytes_from_guacd: 0,
  total_bytes_to_guacd: 0,
  sessions_by_protocol: { ssh: 2 },
  guacd_pool_size: 4,
  recommended_per_instance: 8,
  system_total_memory: 8 * 1024 * 1024 * 1024,
  system_cpu_cores: 4,
  ...over,
});

const certs = (over: Partial<CertificatesResponse> = {}): CertificatesResponse => ({
  certificates: [],
  errors: [],
  ...over,
});

const onNavigateVault = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServiceHealth).mockResolvedValue(health());
  vi.mocked(getMetrics).mockResolvedValue(metrics());
  vi.mocked(getCertificates).mockResolvedValue(certs());
});

describe("HealthTab", () => {
  it("shows the loading state until the first health response arrives", () => {
    vi.mocked(getServiceHealth).mockReturnValue(new Promise(() => {}));
    render(<HealthTab onNavigateVault={onNavigateVault} />);
    expect(screen.getByText(/Loading service health/i)).toBeInTheDocument();
  });

  it("shows a retry-able error when /admin/health rejects", async () => {
    vi.mocked(getServiceHealth).mockRejectedValue(new Error("boom"));
    render(<HealthTab onNavigateVault={onNavigateVault} />);
    expect(await screen.findByText(/Failed to load service health/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
  });

  it("renders the System Health header once data resolves", async () => {
    render(<HealthTab onNavigateVault={onNavigateVault} />);
    await waitFor(() => expect(getServiceHealth).toHaveBeenCalled());
    expect(await screen.findByRole("heading", { name: /System Health/i })).toBeInTheDocument();
    // All three sources are queried in parallel.
    expect(getServiceHealth).toHaveBeenCalledTimes(1);
    expect(getMetrics).toHaveBeenCalledTimes(1);
    expect(getCertificates).toHaveBeenCalledTimes(1);
  });

  it("survives partial outages — metrics or certs failure does not blank the page", async () => {
    vi.mocked(getMetrics).mockRejectedValue(new Error("metrics down"));
    vi.mocked(getCertificates).mockRejectedValue(new Error("certs down"));
    render(<HealthTab onNavigateVault={onNavigateVault} />);
    // Header still renders because /admin/health succeeded.
    expect(await screen.findByRole("heading", { name: /System Health/i })).toBeInTheDocument();
  });

  it("hides the Antivirus card when STRATA_AV_BACKEND=off", async () => {
    // Default fixture has av.enabled = false.
    render(<HealthTab onNavigateVault={onNavigateVault} />);
    await screen.findByRole("heading", { name: /System Health/i });
    expect(screen.queryByRole("heading", { name: /^Antivirus$/i })).not.toBeInTheDocument();
  });

  it("renders the Antivirus card with backend + address when ClamAV is enabled and reachable", async () => {
    vi.mocked(getServiceHealth).mockResolvedValue(
      health({
        av: {
          backend: "clamav",
          enabled: true,
          reachable: true,
          fail_mode: "block",
          address: "clamav:3310",
        },
      })
    );
    render(<HealthTab onNavigateVault={onNavigateVault} />);
    expect(await screen.findByRole("heading", { name: /^Antivirus$/i })).toBeInTheDocument();
    expect(screen.getByText("ClamAV")).toBeInTheDocument();
    expect(screen.getByText("clamav:3310")).toBeInTheDocument();
  });

  it("marks the Antivirus card as Unreachable in fail-block mode when clamd probe fails", async () => {
    vi.mocked(getServiceHealth).mockResolvedValue(
      health({
        av: {
          backend: "clamav",
          enabled: true,
          reachable: false,
          fail_mode: "block",
          address: "clamav:3310",
        },
      })
    );
    render(<HealthTab onNavigateVault={onNavigateVault} />);
    await screen.findByRole("heading", { name: /^Antivirus$/i });
    expect(screen.getByText("Unreachable")).toBeInTheDocument();
  });
});
