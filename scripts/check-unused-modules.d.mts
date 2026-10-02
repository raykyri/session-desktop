import type { CompilerOptions } from "typescript";

export function unreachableModules(
  sourceFiles: readonly string[],
  entrypoints: readonly string[],
  compilerOptions?: CompilerOptions,
): string[];
