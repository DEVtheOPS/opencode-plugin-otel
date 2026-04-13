import ts from "typescript"

export const JSDOC_COVERAGE_THRESHOLD = 0.8
const SOURCE_DIR = new URL("../src/", import.meta.url)

function hasJSDoc(node, sourceFile) {
  const ranges = ts.getLeadingCommentRanges(sourceFile.getFullText(), node.getFullStart()) ?? []
  return ranges.some((range) => sourceFile.getFullText().slice(range.pos, range.end).startsWith("/**"))
}

function visit(node, sourceFile, counts) {
  if (ts.isFunctionDeclaration(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
    counts.total += 1
    if (hasJSDoc(node, sourceFile)) counts.documented += 1
  }

  if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
    counts.total += 1
    if (hasJSDoc(node, sourceFile)) counts.documented += 1
  }

  if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
    counts.total += 1
    if (hasJSDoc(node, sourceFile)) counts.documented += 1
  }

  ts.forEachChild(node, (child) => visit(child, sourceFile, counts))
}

async function getSourceFiles(dirUrl) {
  const cwd = Bun.fileURLToPath(dirUrl)
  return Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd, absolute: true }))
}

export async function getJSDocCoverage(dirUrl = SOURCE_DIR) {
  const files = await getSourceFiles(dirUrl)
  const counts = { total: 0, documented: 0 }

  for (const file of files) {
    const sourceText = await Bun.file(file).text()
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    visit(sourceFile, sourceFile, counts)
  }

  return {
    ...counts,
    coverage: counts.total === 0 ? 1 : counts.documented / counts.total,
  }
}

if (import.meta.main) {
  const result = await getJSDocCoverage()
  if (result.coverage < JSDOC_COVERAGE_THRESHOLD) {
    console.error(`JSDoc coverage ${(result.coverage * 100).toFixed(2)}% is below required ${(JSDOC_COVERAGE_THRESHOLD * 100).toFixed(2)}% (${result.documented}/${result.total})`)
    process.exit(1)
  }

  console.log(`JSDoc coverage ${(result.coverage * 100).toFixed(2)}% (${result.documented}/${result.total})`)
}
