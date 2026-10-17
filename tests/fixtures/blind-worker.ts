import { BlindRunner } from "../../src/blind-runner.js";
import { config } from "../../src/config.js";
import { blindBundle, blindProvider } from "./blind-provider.js";
const [path, boundary] = process.argv.slice(2);
const runner = new BlindRunner(path!);
await runner.execute(
  blindBundle,
  blindProvider(undefined, boundary),
  { ...config(), model: "blind-fixture", leaseTtlMs: 600 },
  {
    afterReply: () => {
      if (boundary === "response") process.kill(process.pid, "SIGKILL");
    },
  },
);
throw Error("Expected termination boundary not reached");
