// 导出面执法点(balsa-docs api-reference §6 / §7「导出面 = 文档面」,框架侧前置 #82):
// 被公共签名引用的类型必须能从**某个子路径入口** import——参考树只生成各入口导出的符号,
// 缺导出即无页、交叉链接断链。
//
// 为什么不在框架侧跑 TypeDoc:文档侧的零警告红线不充分(api-reference §3:同一入口在不同解析
// 环境下 0 警告 vs 10 警告),警告出现与否依赖解析环境;本检查对着 dist/*.d.ts 判定,与 TypeDoc
// 消费的是同一份产物,零额外工具链。
//
// 判定口径:
//   1. 入口 = `package.json` 的 exports 表;E(入口) = 该入口产物的导出名(含 `as` 改名与 `export *`)。
//   2. 只扫**公共声明**:从某入口可达(相对导入/再导出图)、且名字在该入口导出表里的顶层声明。
//      私有声明(内部 helper、只在同一文件里用的类型)的引用不构成缺口。
//   3. 公共声明文本里**类型位置**的标识符必须解析到某个入口导出的名字。判定保守:成员名
//      (后跟 `(` / `?`,或后跟 `:` 的成员与参数位)、命名空间限定成员(前缀 `.`)不算引用;
//      产物里解析不到的标识符(外部包类型、全局工具类型、泛型参数)不在执法面。
//   4. 唯一排除通道 = 声明上方 JSDoc 里的 `@internal`(与文档侧 excludeInternal 同源),不另设白名单。
//
// 退出码契约(沿 ADR-0015):0 = 导出面干净;1 = 有缺口(需处理);2 = 配置/产物硬错误(检查坏了)。
// 落位(ADR-0015 M5 修订):共享实现居根 scripts/,各包以 `node ../../scripts/check-export-surface.mjs`
// 薄脚本指回(或显式传包目录);产物缺失时报错,不把「没测成」读成「干净」。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { readManifestOrHardError } from './lib.mjs';

const EXIT_GAP = 1;
const EXIT_HARD_ERROR = 2;

/** 顶层声明形态:只有这些行首语句进目录(接口成员、命名空间体都带缩进)。 */
const DECLARATION_RE =
  /^(export\s+)?(declare\s+)?(abstract\s+)?(type|interface|class|enum|namespace|function|const|let|var)\s+([\w$]+)/gm;

/** 硬错误 = 口径或产物问题,退出码 2,CI 不容忍。 */
function hardError(message) {
  console.error(message);
  process.exit(EXIT_HARD_ERROR);
}

/** 注释替换为等长空白(保留换行):偏移与原文一致,字符串字面量照旧可读。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => ' '.repeat(line.length));
}

/** 注释与字符串字面量都替换为等长空白(保留引号与换行):偏移不变,扫标识符时字符串内容不误报。 */
function stripNoise(source) {
  return stripComments(source)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (literal) => `'${' '.repeat(literal.length - 2)}'`)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (literal) => `"${' '.repeat(literal.length - 2)}"`);
}

/** 相对说明符 → 产物里的 .d.ts 路径;非相对说明符(包/内置)不在本包产物里,返回 null。 */
function resolveArtifact(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier.replace(/\.js$/, ''));
  return [`${base}.d.ts`, join(base, 'index.d.ts')].find((candidate) => existsSync(candidate)) ?? null;
}

/** 一个产物文件里,相对说明符的集合(注释已剥离:注释里的 `from '…'` 不算)。 */
function relativeSpecifiers(file) {
  const specs = new Set();
  for (const line of stripComments(readFileSync(file, 'utf8')).split('\n')) {
    if (!/^\s*(import|export)\b/.test(line)) continue;
    for (const match of line.matchAll(/['"]([^'"]+)['"]/g)) specs.add(match[1]);
  }
  return specs;
}

/** 从入口出发可达的产物文件集合(相对导入 / 再导出图)。 */
function reachableArtifacts(entryFile) {
  const seen = new Set([entryFile]);
  const stack = [entryFile];
  while (stack.length > 0) {
    const file = stack.pop();
    for (const specifier of relativeSpecifiers(file)) {
      const target = resolveArtifact(file, specifier);
      if (target !== null && !seen.has(target)) {
        seen.add(target);
        stack.push(target);
      }
    }
  }
  return seen;
}

/** 入口的导出名:显式 `export { … }`(含 `as` 改名)+ 就地声明 + `export * from` 递归跟随。 */
function exportedNames(file, seen = new Set()) {
  const raw = readFileSync(file, 'utf8');
  const text = stripNoise(raw);
  const names = new Set();
  for (const match of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const piece of match[1].split(',')) {
      const entry = piece.trim().replace(/^type\s+/, '');
      if (entry === '') continue;
      const renamed = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(entry);
      names.add(renamed === null ? entry : renamed[2]);
    }
  }
  for (const match of text.matchAll(
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:type|interface|class|enum|namespace|function|const|let|var)\s+([\w$]+)/g,
  )) {
    names.add(match[1]);
  }
  // 说明符要从「只剥注释」的文本里读——剥掉字符串内容就问不出 `export *` 的来源了。
  for (const match of stripComments(raw).matchAll(/export\s+\*\s+from\s*['"]([^'"]+)['"]/g)) {
    const target = resolveArtifact(file, match[1]);
    if (target === null || seen.has(target)) continue;
    seen.add(target);
    for (const name of exportedNames(target, seen)) names.add(name);
  }
  return names;
}

/** 声明上方紧邻的 JSDoc 里是否标了 `@internal`(唯一排除通道)。 */
function isInternal(raw, start) {
  const comment = /\/\*\*[\s\S]*?\*\/\s*$/.exec(raw.slice(0, start));
  return comment !== null && /@internal\b/.test(comment[0]);
}

/** 一个产物文件里的顶层声明(名字 / 是否导出 / 文本 / @internal)。 */
function declarations(file) {
  const raw = readFileSync(file, 'utf8');
  const text = stripNoise(raw);
  const starts = [...text.matchAll(DECLARATION_RE)].map((match) => ({
    name: match[5],
    exported: match[1] !== undefined,
    start: match.index,
  }));
  return starts.map((declaration, index) => ({
    ...declaration,
    // 声明文本止于下一条顶层声明;行首的 import / export{…} 语句不属于声明体。
    text: text
      .slice(declaration.start, index + 1 < starts.length ? starts[index + 1].start : undefined)
      .split('\n')
      .filter((line, lineIndex) => lineIndex === 0 || !/^(import\b|export\s+(?:type\s+)?[{*])/.test(line))
      .join('\n'),
    internal: isInternal(raw, declaration.start),
  }));
}

/** dist 全量的声明目录:名字 → 全部标了 `@internal`(内部面,放行)/ 都没从所在模块导出(修法多一步)。 */
function declarationCatalogue(dir, catalogue = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      declarationCatalogue(path, catalogue);
      continue;
    }
    if (!entry.name.endsWith('.d.ts')) continue;
    for (const declaration of declarations(path)) {
      const previous = catalogue.get(declaration.name);
      catalogue.set(declaration.name, {
        allInternal: (previous?.allInternal ?? true) && declaration.internal,
        noneExported: (previous?.noneExported ?? true) && !declaration.exported,
      });
    }
  }
  return catalogue;
}

/** 声明文本里**类型位置**的标识符。保守判定:漏报成员名好过把成员读成类型引用。 */
function typeReferences(text) {
  const references = new Set();
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = match[0];
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + name.length);
    const previousCharacter = (before.match(/\S(?=\s*$)/) ?? [''])[0];
    const nextCharacter = (after.match(/^\s*(\S)/) ?? ['', ''])[1];
    if (previousCharacter === '.') continue; // 命名空间限定成员(如 StandardSchemaV1.InferInput):外层符号由入口负责
    if (nextCharacter === '(' || nextCharacter === '?') continue; // 方法名 / 可选属性名
    if (nextCharacter === ':' && previousCharacter !== '?') continue; // 成员名 / 参数名(条件类型真分支除外)
    references.add(name);
  }
  return references;
}

const packageDir = resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? process.cwd());
const { name, exports: exportMap } = readManifestOrHardError(packageDir);

const entries = Object.entries(exportMap ?? {});
if (entries.length === 0) hardError(`${name}: exports 表为空,没有子路径入口可执法`);
if (!existsSync(join(packageDir, 'dist'))) {
  hardError(`${name}: 缺产物目录 dist——本检查对着产物判定,先 \`pnpm build\``);
}

const publicNames = new Map();
const face = new Set();
for (const [subpath, target] of entries) {
  const declared = target?.types;
  if (typeof declared !== 'string') hardError(`${name}: 子路径 ${subpath} 的 exports 条目缺 types 字段`);
  if (!existsSync(join(packageDir, declared))) {
    hardError(`${name}: 子路径 ${subpath} 声明的产物缺失 ${declared}——先 \`pnpm build\``);
  }
  const names = exportedNames(join(packageDir, declared));
  publicNames.set(subpath, names);
  for (const exported of names) face.add(exported);
}

const catalogue = declarationCatalogue(join(packageDir, 'dist'));
const gaps = new Map();

for (const [subpath, target] of entries) {
  const names = publicNames.get(subpath);
  for (const artifact of reachableArtifacts(join(packageDir, target.types))) {
    for (const declaration of declarations(artifact)) {
      if (!names.has(declaration.name)) continue; // 只看文档会生成页的公共声明
      for (const reference of typeReferences(declaration.text)) {
        const carrier = catalogue.get(reference);
        if (carrier === undefined || face.has(reference) || carrier.allInternal) continue;
        const where = relative(packageDir, artifact);
        gaps.set(`${reference}\u0000${declaration.name}\u0000${where}`, {
          reference,
          declaration: declaration.name,
          where,
          hint: carrier.noneExported ? ';声明也未从所在模块导出' : '',
        });
      }
    }
  }
  console.log(`ok  ${subpath === '.' ? name : `${name}/${subpath.slice('./'.length)}`}`);
}

if (gaps.size === 0) {
  console.log(`导出面无缺口(${entries.length} 个子路径)`);
} else {
  console.error(
    `\n导出面缺口 ${gaps.size} 处(被公共签名引用、但没有任何子路径入口导出——导出它们,或把声明标 @internal):`,
  );
  for (const gap of [...gaps.values()].sort((left, right) =>
    `${left.reference}${left.where}`.localeCompare(`${right.reference}${right.where}`),
  )) {
    console.error(`缺口  ${gap.reference} ← ${gap.declaration} (${gap.where}${gap.hint})`);
  }
  process.exitCode = EXIT_GAP;
}
