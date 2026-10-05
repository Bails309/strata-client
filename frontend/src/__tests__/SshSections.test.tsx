import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({ discoverHostKey: vi.fn() }));

import { discoverHostKey } from "../api";
import { SshSections } from "../pages/admin/connectionForm";

/** The manual connection form's SSH sections, with the extra map exposed. */
function Harness({ onChange }: { onChange: (extra: Record<string, string>) => void }) {
  const [extra, setExtra] = useState<Record<string, string>>({});
  const ex = (k: string) => extra[k] || "";
  const setEx = (k: string, v: string) => {
    const next = { ...extra, [k]: v };
    setExtra(next);
    onChange(next);
  };
  return <SshSections ex={ex} setEx={setEx} connectionId="c1" />;
}

describe("SshSections host key settings", () => {
  it("lets a manually created SSH connection choose how its host key is verified", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Allow legacy SSH algorithms"));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ "ssh-legacy-algorithms": "true" })
    );
    expect(screen.getByText("Host Key Verification")).toBeInTheDocument();
    expect(screen.getByText(/Required: the session is refused/)).toBeInTheDocument();
  });

  it("fetches the host key with the unsaved legacy choice", async () => {
    vi.mocked(discoverHostKey).mockResolvedValue({
      algorithm: "ssh-rsa",
      fingerprint: "SHA256:x",
      public_key: "ssh-rsa AAAA",
    });
    render(<Harness onChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Allow legacy SSH algorithms"));
    fireEvent.click(screen.getByRole("button", { name: "Fetch from server" }));
    expect(discoverHostKey).toHaveBeenCalledWith("c1", true);
    expect(await screen.findByText("SHA256:x")).toBeInTheDocument();
  });
});
