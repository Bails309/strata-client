import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CoPilotOverlay from "../co-pilot/CoPilotOverlay";
import { COLOR_PALETTE, type RosterEntry } from "../co-pilot/protocol";
import type { RemoteCursor, ChatMessage } from "../co-pilot/useCoPilotRoom";

const ownerPid = "00000000-0000-0000-0000-000000000001";
const peerPid = "00000000-0000-0000-0000-000000000002";

function baseProps(overrides: Partial<React.ComponentProps<typeof CoPilotOverlay>> = {}) {
  const roster: RosterEntry[] = [
    {
      pid: ownerPid,
      display_name: "Owner",
      color: COLOR_PALETTE[0],
      has_input: true,
      is_owner: true,
    },
    {
      pid: peerPid,
      display_name: "Peer",
      color: COLOR_PALETTE[1],
      has_input: false,
      is_owner: false,
    },
  ];
  const cursors = new Map<string, RemoteCursor>([
    [peerPid, { pid: peerPid, x: 100, y: 200, ts: Date.now() }],
  ]);
  const chat: ChatMessage[] = [];
  return {
    roster,
    cursors,
    chat,
    allowChat: true,
    hasInput: false,
    selfPid: peerPid,
    onClaimInput: vi.fn(),
    onReleaseInput: vi.fn(),
    onSendChat: vi.fn(() => true),
    displayScale: 1,
    ...overrides,
  };
}

describe("CoPilotOverlay", () => {
  it("renders the participant count and roster entries with owner star and self marker", () => {
    render(<CoPilotOverlay {...baseProps()} />);
    expect(screen.getByText(/PARTICIPANTS \(2\)/)).toBeInTheDocument();
    expect(screen.getByText(/Owner ★/)).toBeInTheDocument();
    expect(screen.getByText(/Peer \(you\)/)).toBeInTheDocument();
  });

  it("renders the CTRL badge next to the participant currently holding input", () => {
    render(<CoPilotOverlay {...baseProps()} />);
    expect(screen.getByText("CTRL")).toBeInTheDocument();
  });

  it("shows 'Take control' when the local participant does not hold input and fires onClaimInput", () => {
    const props = baseProps();
    render(<CoPilotOverlay {...props} />);
    const take = screen.getByRole("button", { name: /take control/i });
    fireEvent.click(take);
    expect(props.onClaimInput).toHaveBeenCalledTimes(1);
    expect(props.onReleaseInput).not.toHaveBeenCalled();
  });

  it("shows 'Release control' when the local participant holds input and fires onReleaseInput", () => {
    const props = baseProps({ hasInput: true });
    render(<CoPilotOverlay {...props} />);
    const release = screen.getByRole("button", { name: /release control/i });
    fireEvent.click(release);
    expect(props.onReleaseInput).toHaveBeenCalledTimes(1);
  });

  it("hides the chat button when allowChat is false", () => {
    render(<CoPilotOverlay {...baseProps({ allowChat: false })} />);
    expect(screen.queryByRole("button", { name: /chat/i })).toBeNull();
  });

  it("opens and closes the chat panel and shows the empty state initially", () => {
    render(<CoPilotOverlay {...baseProps()} />);
    expect(screen.queryByLabelText("Multiplayer chat")).toBeNull();

    const toggle = screen.getByRole("button", { name: /^chat$/i });
    fireEvent.click(toggle);
    expect(screen.getByLabelText("Multiplayer chat")).toBeInTheDocument();
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /hide chat/i }));
    expect(screen.queryByLabelText("Multiplayer chat")).toBeNull();
  });

  it("submits a chat draft via onSendChat and clears the input on success", () => {
    const props = baseProps();
    render(<CoPilotOverlay {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /^chat$/i }));
    const input = screen.getByLabelText("Chat message") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello world" } });
    fireEvent.submit(input.closest("form")!);
    expect(props.onSendChat).toHaveBeenCalledWith("hello world");
    expect(input.value).toBe("");
  });

  it("keeps the draft text when onSendChat returns false (e.g. over-length or rate limited)", () => {
    const props = baseProps({ onSendChat: vi.fn(() => false) });
    render(<CoPilotOverlay {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /^chat$/i }));
    const input = screen.getByLabelText("Chat message") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "rejected" } });
    fireEvent.submit(input.closest("form")!);
    expect(input.value).toBe("rejected");
  });

  it("renders an existing chat message with its sender's color, name, and text", () => {
    const props = baseProps({
      chat: [{ id: "m1", pid: ownerPid, text: "hi there", ts: 0 }],
    });
    render(<CoPilotOverlay {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /^chat$/i }));
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("hi there")).toBeInTheDocument();
  });

  it("renders a remote cursor scaled by displayScale", () => {
    const { container } = render(<CoPilotOverlay {...baseProps({ displayScale: 2 })} />);
    const cursorWrap = container.querySelector(
      "div[style*=\"left: 200\"], div[style*='left: 200px']",
    );
    expect(cursorWrap).not.toBeNull();
  });

  it("ignores cursors whose pid is no longer in the roster", () => {
    const cursors = new Map<string, RemoteCursor>([
      ["ghost-pid", { pid: "ghost-pid", x: 10, y: 20, ts: Date.now() }],
    ]);
    const { container } = render(<CoPilotOverlay {...baseProps({ cursors })} />);
    expect(container.querySelectorAll("svg")).toHaveLength(0);
  });
});
