// 运行时包的固定合同；领域差异只能出现在配置、资源与事件 payload。
import type { ExternalEventInput, Json } from './runtime-types';
export type ExtensionCapability = 'events.read'|'events.import'|'subscriptions.write'|'providers.refresh'|'navigation.openTodo';
export interface ExtensionPermission { name:ExtensionCapability;providerLocalId:string }
export interface FieldMapping { path?:string;literal?:null|string|number|boolean }
export interface HttpJsonConfig { url:string;itemsPath:string;fieldMappings:Record<string,FieldMapping>;statusMap?:Record<string,'scheduled'|'postponed'|'cancelled'|'finished'> }
export interface ExtensionManifest {
  schemaVersion:1;id:string;version:string;title:string;description:string;icon?:string;minAppVersion?:string;
  hostApi:{major:number;minMinor:number};entry:string;help:string;
  collections:Array<{localId:string;title:string;color:'blue'|'green'|'violet'|'amber'|'rose'|'slate';sortOrder:number}>;
  providers:Array<{localId:string;collectionLocalId:string;kind:'import'|'http-json';config:Record<string,Json>|HttpJsonConfig;refreshSeconds?:number}>;
  capabilities:ExtensionPermission[];
  contributions?:{calendarActions:Array<{localId:string;title:string;position:'calendar.actions';kind:'open_tool'|'refresh_provider';providerLocalId:string}>};
  seed?:{file:string;providerLocalId:string};files:Record<string,string>;
}
export interface ExtensionPreview {extensionId:string;title:string;version:string;digest:string;currentRevision:number|null;currentVersion:string|null;requestedPermissions:ExtensionPermission[];permissionDelta:ExtensionPermission[];networkTargets:string[];networkChanges:string[];authorizationRef:string|null;collections:ExtensionManifest['collections'];providers:ExtensionManifest['providers']}
export interface ExtensionInstallInput {stagingDirectory:string;expectedExtensionRevision:number|null;expectedPackageDigest:string;authorizationRef:string}
export interface ExtensionInstallResult {extensionId:string;version:string;digest:string;effect:'installed'|'updated'|'unchanged'|'repaired';revision:number}
export interface ExtensionLifecycleInput {extensionId:string;expectedRevision:number}
export interface ExtensionEnableInput extends ExtensionLifecycleInput {enabled:boolean}
export interface ExtensionRollbackInput extends ExtensionLifecycleInput {version:string;authorizationRef?:string}
