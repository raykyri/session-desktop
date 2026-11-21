// The acceptance suite over HTTP (`test/conformance/`, `01` A1) takes about
// half an hour, most of it the convergence sequences, so `npm test` leaves it
// out; it runs when it is named:
//   npm test --workspace @session/server -- 'test/conformance/**'
// or with SESSION_CONFORMANCE=1.
import process from "node:process";

const conformance =
  process.env.SESSION_CONFORMANCE === "1" ||
  process.argv.some((arg) => arg.includes("test/conformance"));

export default {
  files: conformance ? ["test/**/*.test.ts"] : ["test/**/*.test.ts", "!test/conformance/**"],
  extensions: ["ts"],
  nodeArguments: ["--import=tsx", "--expose-gc"],
  environmentVariables: { TSX_TSCONFIG_PATH: "tsconfig.test.json" },
  timeout: conformance ? "20m" : "60s",
  workerThreads: false,
};
