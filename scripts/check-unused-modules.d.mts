import type { CompilerOptions } from "typescript";

export function unreachableModules(
  sourceFiles: readonly string[],
  entrypoints: readonly string[],
  compilerOptions?: CompilerOptions,
): string[];

export function unusedExports(
  sourceFiles: readonly string[],
  compilerOptions?: CompilerOptions,
): { file: string; exportName: string; line: number }[];
