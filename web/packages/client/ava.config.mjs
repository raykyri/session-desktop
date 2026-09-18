export default {
  files: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  extensions: ["ts", "tsx"],
  nodeArguments: ["--import=tsx", "--import=./test/setup.ts"],
  environmentVariables: { TSX_TSCONFIG_PATH: "tsconfig.test.json" },
  timeout: "60s",
  workerThreads: false,
};
