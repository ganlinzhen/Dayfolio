// 底座构建时生成独立作者校验器；新工具只使用产物，不重新编译宿主。
import { readExtensionPackage } from '../../../packages/core/src/services/extension-package';
try {
  const pkg = readExtensionPackage(process.argv[2]);
  console.log(JSON.stringify({ 有效: true, 工具: pkg.manifest.id, 版本: pkg.manifest.version, 摘要: pkg.digest, 资源数: pkg.files.size, 字节: pkg.bytes, 种子事件: pkg.seed.length }, null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
