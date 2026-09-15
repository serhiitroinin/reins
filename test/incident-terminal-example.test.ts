import { describe, expect, test } from "bun:test";
import {
  IncidentHarnessHost,
  type IncidentConfirmationKind,
  type IncidentTerminal,
} from "../examples/incident-terminal/host.ts";

class RecordingTerminal implements IncidentTerminal {
  readonly lines: string[] = [];
  readonly confirmations: Array<{ kind: IncidentConfirmationKind; title: string }> = [];

  constructor(private readonly answers: Partial<Record<IncidentConfirmationKind, boolean>> = {}) {}

  line(text: string): void {
    this.lines.push(text);
  }

  async confirm(request: { kind: IncidentConfirmationKind; title: string }): Promise<boolean> {
    this.confirmations.push({ kind: request.kind, title: request.title });
    return this.answers[request.kind] ?? true;
  }
}

describe("incident terminal reference host", () => {
  test("renders discovery, separates confirmations, resumes, and retains cancellation output", async () => {
    const terminal = new RecordingTerminal();
    const host = new IncidentHarnessHost(terminal);

    await host.renderDiscovery();
    expect(await host.turn("Inspect and acknowledge INC-104.")).toBe("completed");
    await host.restart();
    expect(await host.turn("Show the current state of INC-104.")).toBe("completed");
    expect(await host.turn("Start a slow investigation of INC-104 and cancel.", {
      cancelAfterFirstAssistant: true,
    })).toBe("interrupted");
    await host.close();

    expect(host.incidents.get("INC-104")).toMatchObject({
      status: "acknowledged",
      owner: "operator-ada",
    });
    expect(host.state.adapter.openedWith).toEqual([null, "incident-terminal:v1"]);
    expect(host.state.adapter.cancellations).toBe(1);
    expect(host.state.adapter.contexts).toHaveLength(3);
    expect(host.state.toolContexts).toHaveLength(3);
    expect(host.state.toolContexts[0]?.context).toBe(host.state.adapter.contexts[0]);
    expect(host.state.toolContexts[1]?.context).toBe(host.state.adapter.contexts[0]);
    expect(host.state.toolContexts[2]?.context).toBe(host.state.adapter.contexts[1]);

    expect(terminal.confirmations.map((entry) => entry.kind)).toEqual([
      "provider-permission",
      "application-write",
      "provider-permission",
    ]);
    expect(terminal.lines.some((line) => line.startsWith("Capabilities: "))).toBe(true);
    expect(terminal.lines.some((line) => line.startsWith("Profile: "))).toBe(true);
    expect(terminal.lines.some((line) => line.startsWith("Models: "))).toBe(true);
    expect(terminal.lines.some((line) => line.startsWith("Limits: "))).toBe(true);
    expect(terminal.lines.some((line) => line.includes("example:service-tier") && line.includes("fast"))).toBe(true);
    expect(terminal.lines.some((line) => line.includes("Resumed after the host restart."))).toBe(true);
    expect(terminal.lines.some((line) => line.includes("Partial investigation retained before cancellation."))).toBe(true);
    expect(terminal.lines.at(-1)).toBe("[turn] interrupted");
    expect(terminal.lines.join("\n")).not.toContain("raw-pager-token=DO-NOT-PRINT");
    expect(terminal.lines.join("\n")).toContain("Context source \"ops:on-call-notes\" is unavailable.");
    expect(host.state.contextErrors).toHaveLength(3);
    expect(String(host.state.contextErrors[0])).toContain("raw-pager-token=DO-NOT-PRINT");

    const sequences = host.events.map((event) => event.sequence);
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
    expect(host.events.filter((event) => event.payload.kind === "turn-completed").map((event) =>
      event.payload.kind === "turn-completed" ? event.payload.status : null)).toEqual([
      "completed",
      "completed",
      "interrupted",
    ]);
  });

  test("a declined application confirmation leaves the incident unchanged", async () => {
    const terminal = new RecordingTerminal({ "application-write": false });
    const host = new IncidentHarnessHost(terminal);

    expect(await host.turn("Inspect and acknowledge INC-104.")).toBe("completed");
    await host.close();

    expect(host.incidents.get("INC-104")).toMatchObject({ status: "open" });
    expect(host.events.some((event) => event.payload.kind === "tool-completed"
      && event.payload.toolKind === "incident-write"
      && event.payload.status === "declined")).toBe(true);
    expect(terminal.lines.join("\n")).toContain("The incident was not changed.");
  });

  test("a denied provider permission never reaches application confirmation", async () => {
    const terminal = new RecordingTerminal({ "provider-permission": false });
    const host = new IncidentHarnessHost(terminal);

    expect(await host.turn("Inspect and acknowledge INC-104.")).toBe("completed");
    await host.close();

    expect(host.incidents.get("INC-104")).toMatchObject({ status: "open" });
    expect(terminal.confirmations.map((entry) => entry.kind)).toEqual(["provider-permission"]);
    expect(host.events.some((event) => event.payload.kind === "tool-started")).toBe(false);
  });

  test("tool validation and required context failures are safe", async () => {
    const terminal = new RecordingTerminal();
    const host = new IncidentHarnessHost(terminal);

    expect(await host.turn("Use invalid input while inspecting INC-104.")).toBe("completed");
    expect(await host.turn("Inspect INC-999.")).toBe("error");
    await host.close();

    const output = terminal.lines.join("\n");
    expect(output).toContain("Invalid input for tool: incident_get");
    expect(output).toContain("INCIDENT_NOT_FOUND: Incident INC-999 is not available.");
    expect(output).not.toContain("invalid incident id");
    expect(output).not.toContain("raw-pager-token=DO-NOT-PRINT");
  });
});
