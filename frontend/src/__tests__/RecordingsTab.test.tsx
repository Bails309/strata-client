import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RecordingsTab from "../pages/admin/RecordingsTab";
import * as api from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof api>("../api");
  return { ...actual, updateRecordings: vi.fn().mockResolvedValue({}) };
});

describe("RecordingsTab", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders defaults when settings are empty", () => {
    render(<RecordingsTab settings={{}} onSave={vi.fn()} />);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByLabelText("Retention (days)")).toHaveValue(30);
  });

  it("hydrates state from settings prop", () => {
    render(
      <RecordingsTab
        settings={{
          recordings_enabled: "true",
          recordings_retention_days: "90",
          recordings_storage_type: "azure_blob",
          recordings_azure_account_name: "acct",
          recordings_azure_container_name: "cont",
          recordings_azure_access_key: "key",
        }}
        onSave={vi.fn()}
      />
    );
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByLabelText("Retention (days)")).toHaveValue(90);
    expect(screen.getByLabelText("Account Name")).toHaveValue("acct");
    expect(screen.getByLabelText("Container Name")).toHaveValue("cont");
    expect(screen.getByLabelText("Access Key")).toHaveValue("key");
  });

  it("toggles enabled checkbox", async () => {
    render(<RecordingsTab settings={{}} onSave={vi.fn()} />);
    const checkbox = screen.getByRole("checkbox");
    await userEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  it("updates retention days", () => {
    render(<RecordingsTab settings={{}} onSave={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Retention (days)"), { target: { value: "60" } });
    expect(screen.getByLabelText("Retention (days)")).toHaveValue(60);
  });

  it("hides Azure fields when storage type is local", () => {
    render(<RecordingsTab settings={{}} onSave={vi.fn()} />);
    expect(screen.queryByLabelText("Account Name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Container Name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Access Key")).not.toBeInTheDocument();
  });

  it("shows Azure fields when storage type is azure_blob", () => {
    render(<RecordingsTab settings={{ recordings_storage_type: "azure_blob" }} onSave={vi.fn()} />);
    expect(screen.getByLabelText("Account Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Container Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Access Key")).toBeInTheDocument();
  });

  it("updates Azure account/container/key fields", () => {
    render(<RecordingsTab settings={{ recordings_storage_type: "azure_blob" }} onSave={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Account Name"), { target: { value: "myacct" } });
    fireEvent.change(screen.getByLabelText("Container Name"), { target: { value: "myc" } });
    fireEvent.change(screen.getByLabelText("Access Key"), { target: { value: "abc==" } });
    expect(screen.getByLabelText("Account Name")).toHaveValue("myacct");
    expect(screen.getByLabelText("Container Name")).toHaveValue("myc");
    expect(screen.getByLabelText("Access Key")).toHaveValue("abc==");
  });

  it("calls updateRecordings with local storage payload and invokes onSave", async () => {
    const onSave = vi.fn();
    render(<RecordingsTab settings={{}} onSave={onSave} />);
    await userEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText("Retention (days)"), { target: { value: "45" } });
    await userEvent.click(screen.getByRole("button", { name: "Save Recording Settings" }));
    await waitFor(() => expect(api.updateRecordings).toHaveBeenCalled());
    expect(api.updateRecordings).toHaveBeenCalledWith({
      enabled: true,
      retention_days: 45,
      storage_type: "local",
      azure_account_name: undefined,
      azure_container_name: undefined,
      azure_access_key: undefined,
    });
    expect(onSave).toHaveBeenCalled();
  });

  it("calls updateRecordings with azure_blob payload including azure fields", async () => {
    const onSave = vi.fn();
    render(
      <RecordingsTab
        settings={{
          recordings_storage_type: "azure_blob",
          recordings_azure_account_name: "a",
          recordings_azure_container_name: "c",
          recordings_azure_access_key: "k",
        }}
        onSave={onSave}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Save Recording Settings" }));
    await waitFor(() => expect(api.updateRecordings).toHaveBeenCalled());
    expect(api.updateRecordings).toHaveBeenCalledWith({
      enabled: false,
      retention_days: 30,
      storage_type: "azure_blob",
      azure_account_name: "a",
      azure_container_name: "c",
      azure_access_key: "k",
    });
    expect(onSave).toHaveBeenCalled();
  });

  it("re-syncs state when settings prop changes", () => {
    const { rerender } = render(
      <RecordingsTab settings={{ recordings_retention_days: "10" }} onSave={vi.fn()} />
    );
    expect(screen.getByLabelText("Retention (days)")).toHaveValue(10);
    rerender(<RecordingsTab settings={{ recordings_retention_days: "120" }} onSave={vi.fn()} />);
    expect(screen.getByLabelText("Retention (days)")).toHaveValue(120);
  });
});
