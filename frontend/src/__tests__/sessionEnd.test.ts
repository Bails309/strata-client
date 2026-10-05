import { describe, expect, it } from "vitest";
import { describeSessionEnd, SessionEndStatus } from "../utils/sessionEnd";

describe("describeSessionEnd", () => {
  it("titles a clean remote end as ended, not as an error", () => {
    const end = describeSessionEnd(
      "You signed out of the remote session.",
      SessionEndStatus.SESSION_CLOSED
    );
    expect(end.title).toBe("Session Ended");
    expect(end.terminatedByAdmin).toBe(false);
  });

  it("distinguishes idle timeouts, takeovers and network loss", () => {
    expect(describeSessionEnd("idle", SessionEndStatus.SESSION_TIMEOUT).title).toBe(
      "Session Timed Out"
    );
    expect(describeSessionEnd("elsewhere", SessionEndStatus.SESSION_CONFLICT).title).toBe(
      "Session Disconnected"
    );
    expect(describeSessionEnd("lost", SessionEndStatus.UPSTREAM_ERROR).title).toBe(
      "Connection Lost"
    );
  });

  it("titles a refusal at admission as a limit, not a lost connection", () => {
    const end = describeSessionEnd(
      "The server is at capacity. Try again in a few minutes.",
      SessionEndStatus.CLIENT_TOO_MANY
    );
    expect(end.title).toBe("Session Limit Reached");
    expect(end.terminatedByAdmin).toBe(false);
  });

  it("still recognises an administrator kill by its text", () => {
    const end = describeSessionEnd(
      "Session terminated by administrator",
      SessionEndStatus.SESSION_CONFLICT
    );
    expect(end.title).toBe("Session Terminated");
    expect(end.terminatedByAdmin).toBe(true);
  });

  it("falls back on the text when there is no status code", () => {
    expect(describeSessionEnd("The remote session has ended.").title).toBe("Session Ended");
    expect(describeSessionEnd("Connection lost. Reconnection cancelled.").title).toBe(
      "Connection Lost"
    );
    expect(describeSessionEnd("connection reset").label).toBe("Connection Lost");
    expect(describeSessionEnd("something odd", 0x0300).title).toBe("Connection Error");
  });
});
