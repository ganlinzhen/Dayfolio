// 历史事件工具只读接口；工具导入和删除统一使用 HTML 工具箱。
import { ipcMain } from 'electron';
import { runtimeErrorInfo,type TodoDeskCore } from '../../../../packages/core/src';
export function registerExtensionIpc(core:TodoDeskCore) {
  const routes:Record<string,(input:never)=>unknown>={
    'extensions:describe':()=>({api:{major:1,minor:0},limits:{packageBytes:20*1024*1024,eventBatchCount:500,eventBatchBytes:5*1024*1024,pageSize:500,maxRangeDays:100,requestBytes:65536}}),
    'extensions:list':core.extensions.list,
    'extensions:get':core.extensions.get,
    'extensions:getHelp':core.extensions.getHelp,
  };
  for(const[channel,handler]of Object.entries(routes))ipcMain.handle(channel,async(event,input:unknown)=>{
    try{if(!event.senderFrame||event.senderFrame!==event.sender.mainFrame)throw Object.assign(new Error('管理操作只允许受信宿主主页面'),{code:'PERMISSION_DENIED'});return {ok:true,data:await handler(input as never)};}
    catch(error){const info=runtimeErrorInfo(error);return {ok:false,error:info.message,code:info.code,retryable:info.retryable};}
  });
}
