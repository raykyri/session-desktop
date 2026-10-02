import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Follow static, type-only, re-export, and literal dynamic imports from every entrypoint. */
export function unreachableModules(sourceFiles, entrypoints, compilerOptions = {}) {
  const sourceSet = new Set(sourceFiles.map((file) => resolve(file)));
  const visited = new Set();
  const pending = entrypoints.map((file) => resolve(file));
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        specifier = node.moduleSpecifier;
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        specifier = node.arguments[0];
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        specifier = node.argument.literal;
      }
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const imported = ts.resolveModuleName(specifier.text, file, {
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          ...compilerOptions,
        }, ts.sys).resolvedModule;
        if (imported && sourceSet.has(resolve(imported.resolvedFileName))) {
          pending.push(resolve(imported.resolvedFileName));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...sourceSet].filter((file) => !visited.has(file)).sort();
}

function sourceFilesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesIn(file);
    return [".ts", ".tsx"].includes(extname(file)) && !file.endsWith(".d.ts") ? [file] : [];
  });
}

/** Find exports with no references outside their defining module, following aliases and barrels. */
export function unusedExports(sourceFiles, compilerOptions = {}) {
  const program = ts.createProgram(sourceFiles, {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.Latest,
    jsx: ts.JsxEmit.ReactJSX,
    ...compilerOptions,
  });
  const checker = program.getTypeChecker();
  const sources = new Set(sourceFiles.map((file) => resolve(file)));
  const candidates = new Map();
  const canonical = (symbol) => {
    if (!symbol) return undefined;
    return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  };
  for (const source of program.getSourceFiles()) {
    if (!sources.has(resolve(source.fileName))) continue;
    const module = checker.getSymbolAtLocation(source);
    if (!module) continue;
    for (const exported of checker.getExportsOfModule(module)) {
      const symbol = canonical(exported);
      const declaration = symbol?.declarations?.find((node) => node.getSourceFile() === source);
      if (!declaration) continue; // A barrel does not establish a consumer.
      candidates.set(symbol, {
        file: resolve(source.fileName), exportName: exported.name,
        line: source.getLineAndCharacterOfPosition(declaration.getStart()).line + 1,
      });
    }
  }
  const used = new Set();
  for (const source of program.getSourceFiles()) {
    if (!sources.has(resolve(source.fileName))) continue;
    const mark = (symbol) => {
      const target = canonical(symbol);
      const candidate = candidates.get(target);
      if (candidate && candidate.file !== resolve(source.fileName)) used.add(target);
    };
    const visit = (node) => {
      // Import/re-export declarations only connect modules; actual uses count below.
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const imported = ts.resolveModuleName(node.arguments[0].text, source.fileName, program.getCompilerOptions(), ts.sys).resolvedModule;
        const importedSource = imported && program.getSourceFile(imported.resolvedFileName);
        const module = importedSource && checker.getSymbolAtLocation(importedSource);
        const value = ts.isAwaitExpression(node.parent) ? node.parent : node;
        const binding = ts.isVariableDeclaration(value.parent) ? value.parent.name : undefined;
        if (module) {
          const exports = checker.getExportsOfModule(module);
          if (binding && ts.isObjectBindingPattern(binding)) {
            for (const element of binding.elements) {
              if (element.dotDotDotToken) exports.forEach(mark);
              else {
                const name = element.propertyName ?? element.name;
                if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
                  mark(exports.find((item) => item.name === name.text));
                }
              }
            }
          } else if (binding || !ts.isVoidExpression(value.parent)) {
            exports.forEach(mark); // Escaping/lazy namespaces can consume exports dynamically.
          }
        }
      }
      if (ts.isIdentifier(node)) {
        const symbol = canonical(checker.getSymbolAtLocation(node));
        const isDeclaration = symbol?.declarations?.some((decl) => decl.name === node);
        if (!isDeclaration) {
          mark(symbol);
          // Passing a namespace as a value can access any of its exports dynamically.
          if (symbol?.flags & ts.SymbolFlags.Module &&
              !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) &&
              !(ts.isQualifiedName(node.parent) && node.parent.left === node)) {
            for (const exported of checker.getExportsOfModule(symbol)) mark(exported);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...candidates].filter(([symbol]) => !used.has(symbol)).map(([, item]) => item)
    .sort((a, b) => a.file.localeCompare(b.file) || a.exportName.localeCompare(b.exportName));
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sources = ["src"].flatMap((directory) => sourceFilesIn(resolve(root, directory)));
  const tests = ["tests"].flatMap((directory) => sourceFilesIn(resolve(root, directory)))
    .filter((file) => /\.test\.tsx?$/.test(file));
  // Report app-only reachability separately; tests must not silently keep modules alive.
  const roots = ["src/main.tsx"]
    .map((file) => resolve(root, file));
  const configPath = resolve(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  }));
  const files = [...new Set([...sources, ...tests])];
  const contracts = JSON.parse(readFileSync(resolve(root, "scripts/module-contracts.json"), "utf8"));
  const unused = unreachableModules(files, [...roots, ...tests], parsed.options);
  const appOnlyUnused = unreachableModules(sources, roots, parsed.options);
  const exports = unusedExports(files, parsed.options).filter((item) => sources.includes(item.file));
  const errors = unused.map((file) => `Module unreachable from app or tests: ${relative(root, file)}`);
  const expectedModules = contracts.testOnlyModules;
  for (const file of appOnlyUnused) {
    const name = relative(root, file);
    if (!expectedModules[name]?.trim()) errors.push(`Unreviewed test-only module: ${name}`);
  }
  for (const [name, reason] of Object.entries(expectedModules)) {
    if (!reason.trim() || !appOnlyUnused.includes(resolve(root, name))) {
      errors.push(`Stale or unexplained test-only module contract: ${name}`);
    }
  }
  for (const item of exports) {
    const file = relative(root, item.file);
    const contract = contracts.exports[file];
    if (!contract?.reason?.trim() || !contract.names.includes(item.exportName)) {
      errors.push(`Unconsumed export: ${file}:${item.line} ${item.exportName}`);
    }
  }
  for (const [file, contract] of Object.entries(contracts.exports)) {
    for (const name of contract.names) {
      if (!contract.reason?.trim() || !exports.some((item) => item.file === resolve(root, file) && item.exportName === name)) {
        errors.push(`Stale or unexplained export contract: ${file} ${name}`);
      }
    }
  }
  if (errors.length) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Desktop app reachability and export consumers checked.\nRetained test-only contracts:\n${appOnlyUnused.map((file) => `  ${relative(root, file)} — ${expectedModules[relative(root, file)]}`).join("\n")}\nRetained ${exports.length} explicitly documented compatibility exports.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
