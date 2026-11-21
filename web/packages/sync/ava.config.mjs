export default {
  files: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  extensions: ["ts", "tsx"],
  nodeArguments: ["--import=tsx"],
  environmentVariables: { TSX_TSCONFIG_PATH: "tsconfig.test.json" },
  timeout: "120s",
  workerThreads: false,
};
