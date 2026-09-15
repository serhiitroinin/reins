import { createInterface } from "node:readline/promises";
import { IncidentHarnessHost, type IncidentTerminal } from "./host.ts";

function automaticTerminal(): IncidentTerminal {
  return {
    line: (text) => console.log(text),
    async confirm(request) {
      console.log(`[host confirmation:${request.kind}] ${request.title} -> approved`);
      return true;
    },
  };
}

async function runDemo(): Promise<void> {
  const host = new IncidentHarnessHost(automaticTerminal());
  console.log("INCIDENT TERMINAL — offline reference host");
  await host.renderDiscovery();

  console.log("\nTURN 1 — inspect and acknowledge");
  await host.turn("Inspect and acknowledge INC-104.");

  console.log("\nHOST RESTART — exercise durable resume contract");
  await host.restart();
  await host.turn("Show the current state of INC-104.");

  console.log("\nTURN 3 — cancellation");
  await host.turn("Start a slow investigation of INC-104, then wait for cancellation.", {
    cancelAfterFirstAssistant: true,
  });
  await host.close();
}

async function runInteractive(): Promise<void> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const terminal: IncidentTerminal = {
    line: (text) => console.log(text),
    async confirm(request) {
      const answer = await input.question(`[${request.kind}] ${request.title} [y/N] `);
      return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
    },
  };
  const host = new IncidentHarnessHost(terminal);

  console.log("INCIDENT TERMINAL — type a request, /restart, /cancel-demo, or /quit");
  await host.renderDiscovery();
  try {
    for (;;) {
      const prompt = (await input.question("incident> ")).trim();
      if (prompt === "/quit") break;
      if (prompt === "/restart") {
        await host.restart();
        continue;
      }
      if (prompt === "/cancel-demo") {
        await host.turn("Start a slow investigation of INC-104, then wait for cancellation.", {
          cancelAfterFirstAssistant: true,
        });
        continue;
      }
      if (prompt !== "") await host.turn(prompt);
    }
  } finally {
    await host.close();
    input.close();
  }
}

if (process.argv.includes("--interactive")) await runInteractive();
else await runDemo();
