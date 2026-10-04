import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field } from "../components/Field";
import RecordingStatusBadge from "../components/RecordingStatusBadge";
import {
  WELCOME_STORAGE_KEY,
  WHATS_NEW_STORAGE_KEY,
  whatsNewPending,
} from "../components/whatsNewState";
import { PROTOCOLS, protocolDescriptor } from "../pages/admin/protocolFields";

describe("Field", () => {
  it("labels its control with a generated id", () => {
    render(
      <Field label="Hostname">
        <input />
      </Field>
    );
    expect(screen.getByLabelText("Hostname").id).not.toBe("");
  });

  it("keeps an id the control already has", () => {
    render(
      <Field label="Port" title="TCP port">
        <input id="port" />
      </Field>
    );
    expect(screen.getByLabelText("Port")).toHaveAttribute("id", "port");
    expect(screen.getByText("Port")).toHaveAttribute("title", "TCP port");
  });
});

describe("RecordingStatusBadge", () => {
  it("says nothing about a complete recording", () => {
    const { container } = render(<RecordingStatusBadge recording={{ status: "complete" }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("flags an unfinished recording and explains a failed one", () => {
    const { rerender } = render(<RecordingStatusBadge recording={{ status: "recording" }} />);
    expect(screen.getByText("In progress")).toBeInTheDocument();

    rerender(
      <RecordingStatusBadge recording={{ status: "failed", failure: "Permission denied" }} />
    );
    expect(screen.getByText("Failed")).toHaveAttribute("title", "Permission denied");

    rerender(<RecordingStatusBadge recording={{ status: "incomplete" }} />);
    expect(screen.getByText("Incomplete")).toBeInTheDocument();
  });
});

describe("whatsNewPending", () => {
  beforeEach(() => localStorage.clear());

  it("never shows before a user is known", () => {
    expect(whatsNewPending(undefined)).toBe(false);
  });

  it("shows until both the welcome and this version's notes are dismissed", () => {
    expect(whatsNewPending("u1")).toBe(true);
    localStorage.setItem(`${WELCOME_STORAGE_KEY}-u1`, "1");
    expect(whatsNewPending("u1")).toBe(true);
    localStorage.setItem(`${WHATS_NEW_STORAGE_KEY}-u1`, __APP_VERSION__);
    expect(whatsNewPending("u1")).toBe(false);
  });

  it("shows again after an upgrade and is tracked per user", () => {
    localStorage.setItem(`${WELCOME_STORAGE_KEY}-u1`, "1");
    localStorage.setItem(`${WHATS_NEW_STORAGE_KEY}-u1`, "0.0.1");
    expect(whatsNewPending("u1")).toBe(true);

    localStorage.setItem(`${WHATS_NEW_STORAGE_KEY}-u1`, __APP_VERSION__);
    expect(whatsNewPending("u2")).toBe(true);
  });
});

describe("protocol field registry", () => {
  it("lists each protocol once", () => {
    const values = PROTOCOLS.map((p) => p.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("hides the network target fields for Strata-spawned workloads", () => {
    for (const key of ["web", "vdi"]) {
      const p = protocolDescriptor(key);
      expect([p.showHostname, p.showPort, p.showDomain]).toEqual([false, false, false]);
    }
    expect(protocolDescriptor("kubernetes").showDomain).toBe(false);
  });

  it("falls back to RDP for an unknown protocol", () => {
    expect(protocolDescriptor("telnet").value).toBe("rdp");
    expect(protocolDescriptor("ssh").defaultPort).toBe(22);
  });
});
