// 刷新任务只暴露业务状态；租约、令牌及授权快照不离开可信宿主。
import type { EventImportResult } from './runtime-types';
export interface ProviderError { code:string;message:string;retryable:boolean }
export type ProviderRunStatus='queued'|'fetching'|'validating'|'committing'|'succeeded'|'failed'|'cancelled';
export interface ProviderRun {id:string;providerId:string;status:ProviderRunStatus;error:ProviderError|null;mode:'http-json'|'external-agent';createdAt:string;finishedAt:string|null}
export interface ProviderRefreshInput {providerId:string}
export interface ProviderRunInput {runId:string}
export interface ProviderStatus {revision:number;lastSuccessAt:string|null;activeRun:ProviderRun|null;lastError:ProviderError|null;mode:'http-json'|'external-agent'}
export interface ProviderRefreshApi {
  refresh:(input:ProviderRefreshInput)=>{effect:'queued'|'reused';run:ProviderRun};
  getRun:(input:ProviderRunInput)=>ProviderRun;
  getStatus:(input:ProviderRefreshInput)=>ProviderStatus;
}
export interface ProviderNetworkOptions {signal:AbortSignal;maxBytes:number;timeoutMs:number}
export type ProviderNetwork=(url:string,options:ProviderNetworkOptions)=>Promise<unknown>;
export interface ProviderWorker {start:()=>void;stop:()=>Promise<void>;tick:()=>Promise<boolean>;scheduleDue:()=>number}
export interface RefreshContext {extensionId:string;extensionRevision:number;releaseId:string;grantDigest:string;providerRevision:number;kind:string;configJson:string}
export interface RefreshResult {runId:string;result:EventImportResult}
