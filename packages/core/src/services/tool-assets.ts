// 工具记录与文件的共用编排：先暂存，保留旧目录，失败时恢复。
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inTx, type DbAdapter } from '../db';
import { MAX_TOOL_FILES_BYTES, sanitizeToolPath, toolsRootForDb } from '../utils/tool-files';
import type { ToolService } from './tool';
import type { NewToolInput, UpdateToolInput, ToolItem } from '../types';

export function createToolAssetService(db:DbAdapter,service:ToolService,dbPath:string,onFiles?:(toolId:number,root:string,previousRoot?:string)=>void):ToolService {
  const root=toolsRootForDb(dbPath);
  const write=(input:NewToolInput|UpdateToolInput,id?:number):ToolItem=>{
    const files=input.files;
    if(!files?.length)return id===undefined?service.addTool(input as NewToolInput):service.updateTool(id,input);
    const names=files.map(f=>sanitizeToolPath(f.name));
    if(new Set(names).size!==names.length)throw new Error('工具文件名重复');
    const entry=input.entry_file ?? (id===undefined?'':service.getTool(id).entry_file);
    if(!names.includes(entry))throw new Error('入口文件不在本批文件中');
    const bytes=files.reduce((n,f)=>n+Buffer.from(f.contentBase64,'base64').length,0);
    if(bytes>MAX_TOOL_FILES_BYTES)throw new Error('工具文件超过大小限制');
    mkdirSync(root,{recursive:true});
    const stage=join(root,`.stage-${randomUUID()}`),backup=join(root,`.backup-${randomUUID()}`);
    let target:string|undefined,published=false,oldMoved=false;
    try {
      mkdirSync(stage);
      files.forEach((f,i)=>{const path=join(stage,names[i]);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,Buffer.from(f.contentBase64,'base64'));});
      const result=inTx(db,()=>{
        const tool=id===undefined?service.addTool(input as NewToolInput):service.updateTool(id,input);
        target=join(root,String(tool.id));
        if(existsSync(target)){renameSync(target,backup);oldMoved=true;}
        renameSync(stage,target);published=true;
        onFiles?.(tool.id,target,oldMoved?backup:undefined);
        return tool;
      });
      // 提交后清理旧目录，失败保留备份，不将已完成的提交伪装为回滚。
      try{rmSync(backup,{recursive:true,force:true});}catch{/* 保留旧文件副本供下次维护 */}
      return result;
    } catch(error) {
      if(published&&target)rmSync(target,{recursive:true,force:true});
      if(oldMoved&&target)renameSync(backup,target);
      throw error;
    } finally {rmSync(stage,{recursive:true,force:true});}
  };
  return {...service,addTool:(input)=>write(input),updateTool:(id,patch)=>write(patch,id),deleteTool:(id)=>{
    const target=join(root,String(id)),backup=join(root,`.deleted-${randomUUID()}`);let moved=false;
    try {inTx(db,()=>{service.deleteTool(id);if(existsSync(target)){renameSync(target,backup);moved=true;}});}
    catch(error){if(moved)renameSync(backup,target);throw error;}
    if(moved){try{rmSync(backup,{recursive:true,force:true});}catch{/* 数据库已成功删除，保留可清理目录 */}}
  }};
}
