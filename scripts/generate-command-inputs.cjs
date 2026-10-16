const path=require('node:path');const fs=require('node:fs');const root=path.resolve(__dirname,'..');
const ts=require(path.join(root,'node_modules/typescript'));
const esbuild=require(path.join(root,'node_modules/esbuild'));
esbuild.buildSync({entryPoints:[path.join(root,'packages/core/src/ontology/commands.ts')],bundle:true,platform:'node',format:'cjs',outfile:path.join(require('node:os').tmpdir(),`dayfolio-command-defs-${process.pid}.cjs`),external:['node:*'],logLevel:'silent'});
const bundle=path.join(require('node:os').tmpdir(),`dayfolio-command-defs-${process.pid}.cjs`);const defs=require(bundle).COMMAND_DEFS;fs.unlinkSync(bundle);
const config=ts.readConfigFile(path.join(root,'packages/core/tsconfig.json'),ts.sys.readFile);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,path.join(root,'packages/core'));
const program=ts.createProgram(parsed.fileNames,parsed.options);const checker=program.getTypeChecker();
const file=program.getSourceFile(path.join(root,'packages/core/src/index.ts'));const node=file.statements.find(n=>ts.isInterfaceDeclaration(n)&&n.name.text==='TodoDeskCore');
const core=checker.getTypeAtLocation(node);
function schema(type,depth=0){
 if(depth>7)return {};
 if(type.isUnion()){
  const types=type.types.filter(t=>!(t.flags&ts.TypeFlags.Undefined));
  if(types.every(t=>t.flags&(ts.TypeFlags.StringLiteral|ts.TypeFlags.NumberLiteral|ts.TypeFlags.BooleanLiteral))){return {enum:types.map(t=>t.value??(t.intrinsicName==='true'))};}
  return {anyOf:types.map(t=>schema(t,depth+1))};
 }
 if(type.flags&ts.TypeFlags.Null)return {type:'null'};
 if(type.flags&ts.TypeFlags.StringLike)return type.isStringLiteral()?{const:type.value}:{type:'string'};
 if(type.flags&ts.TypeFlags.NumberLike)return {type:'number'};
 if(type.flags&ts.TypeFlags.BooleanLike)return {type:'boolean'};
 if(type.flags&(ts.TypeFlags.Any|ts.TypeFlags.Unknown))return {};
 if(checker.isArrayType(type)||checker.isTupleType(type)){const args=checker.getTypeArguments(type);return {type:'array',items:schema(args[0],depth+1)};}
 const properties={};const required=[];
 for(const p of checker.getPropertiesOfType(type)){
  const decl=p.valueDeclaration??p.declarations?.[0]??node;
  properties[p.name]=schema(checker.getTypeOfSymbolAtLocation(p,decl),depth+1);
  if(!(p.flags&ts.SymbolFlags.Optional))required.push(p.name);
 }
 return {type:'object',properties,required,additionalProperties:checker.getIndexTypeOfType(type,ts.IndexKind.String)?schema(checker.getIndexTypeOfType(type,ts.IndexKind.String),depth+1):false};
}
const inputs={};
for(const d of defs){
 const service=checker.getPropertyOfType(core,d.service);const serviceType=checker.getTypeOfSymbolAtLocation(service,node);
 const method=checker.getPropertyOfType(serviceType,d.method);const methodType=checker.getTypeOfSymbolAtLocation(method,node);
 const sig=checker.getSignaturesOfType(methodType,ts.SignatureKind.Call)[0];
 const native=sig.parameters.map(p=>schema(checker.getTypeOfSymbolAtLocation(p,p.valueDeclaration??node)));
 inputs[d.apiName]=native;
}
const output=path.join(root,'packages/core/src/ontology/command-inputs.ts');const content='// 命令输入契约来自现有 TypeScript 业务接口；保持为静态数据，不在运行时加载编译器。\nexport const COMMAND_INPUTS: Record<string,unknown[]> = '+JSON.stringify(inputs,null,2)+';\n';if(!fs.existsSync(output)||fs.readFileSync(output,'utf8')!==content)fs.writeFileSync(output,content);
console.log(`已生成 ${defs.length} 个命令的输入契约`);
