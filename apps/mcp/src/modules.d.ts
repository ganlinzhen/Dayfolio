// esbuild 以 --loader:.md=text 把帮助文档内嵌为字符串（学习闭环规范与帮助面板同源）
declare module '*.md' {
  const content: string;
  export default content;
}
