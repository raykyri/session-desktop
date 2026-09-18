export default {
  files: ["test/**/*.test.ts"],
  extensions: ["ts"],
  nodeArguments: ["--import=tsx"],
  environmentVariables: { TSX_TSCONFIG_PATH: "tsconfig.test.json" },
  timeout: "60s",
  workerThreads: false,
};
