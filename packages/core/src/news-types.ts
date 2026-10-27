import type { NewsItem, NewsTask, NewsCandidateTopic } from './types';

/** 结构化采集设置是动态提示词的唯一输入，历史长提示词另行保留。 */
export interface NewsContentOptions {
  summary_depth: 'brief' | 'standard' | 'deep';
  image_policy: 'prefer_original' | 'none';
  image_display?: 'list_thumbnail' | 'detail_only';
  show_background: boolean;
  show_impact: boolean;
  show_uncertainty: boolean;
}
export interface NewsFeedModule {
  id: string; name: string; enabled: boolean; kind: 'public' | 'topic' | 'events';
  scope: string; exclusions: string; window_hours: number; headline_count: number; max_items: number;
  content: Partial<NewsContentOptions>;
  source_preferences?: string[]; source_exclusions?: string[]; extra_instructions?: string;
}
export interface NewsFeedConfig {
  revision: number; updated_at: string | null;
  modules: NewsFeedModule[];
  content: NewsContentOptions;
  schedule: { enabled: boolean; timezone: 'Asia/Shanghai'; times: string[] };
  learning: { enabled: boolean; exploration_enabled: boolean };
  budget_minutes: number;
}
export interface NewsEventFollow {
  id: string; name: string; scope: string; status: 'active' | 'paused' | 'ended';
  expires_at: string | null; revision: number; updated_at: string;
  last_viewed_at: string | null; reminder_due: boolean;
}
export interface NewsFeedBatchModule {
  module_id: string; name: string; phase: 1 | 2; target: number;
  accepted_count: number; task_id: number | null;
  status: 'waiting' | 'pending' | 'claimed' | 'completed' | 'cancelled' | 'skipped';
  note: string | null;
}
export interface NewsFeedBatch {
  id: string; status: 'active' | 'completed' | 'stopped' | 'budget_exhausted' | 'invalidated';
  trigger: 'manual' | 'scheduled'; created_at: string; finished_at: string | null;
  config_revision: number; learning_epoch: number; deadline_at: string;
  window_end: string; modules: NewsFeedBatchModule[]; next_task_id: number | null;
  config_snapshot?: NewsFeedConfig;
}
export interface NewsTopicInterest {
  key: string; name: string; score: number;
  state: 'inferred' | 'followed' | 'reduced' | 'removed';
  reasons: string[]; evidence_count: number; cooldown_until: string | null;
  scope?: string;
  reduced?: boolean;
  candidate_cooldown_until?: string | null;
}
export interface NewsInterestState {
  enabled: boolean; epoch: number; topics: NewsTopicInterest[];
  events: NewsEventFollow[];
  exploration: NewsCandidateTopic | null;
  exploration_seed: { scope: string; basis_module_id?: string } | null;
  reduced_sources: string[];
}
export type NewsFeedbackKind = 'open' | 'read' | 'source_open' | 'star' | 'unstar' | 'interested' | 'less_topic' | 'less_source' | 'hide' | 'undo_hide';
export interface NewsFeedbackInput {
  news_id: number; kind: NewsFeedbackKind; source: 'app' | 'explicit';
  idempotency_key: string; topic_key?: string; reading_seconds?: number;
}
export interface NewsTopicInput {
  key: string; name?: string; action: 'follow' | 'unfollow' | 'reduce' | 'remove' | 'restore';
}
export interface NewsSourceInput { source_name: string; action: 'reduce' | 'restore'; }
export interface NewsEventInput {
  id: string; name?: string; scope?: string; status?: NewsEventFollow['status'];
  expires_at?: string | null; expected_revision: number;
}
export interface NewsCorrection {
  id: string; news_id: number; summary: string; evidence_url: string;
  created_at: string; acknowledged: boolean;
}
export interface NewsCorrectionInput { news_id: number; summary: string; evidence_url: string; }
export interface NewsFeedItem extends NewsItem {
  hidden: boolean; corrections: NewsCorrection[];
  selection_kind?: 'headline' | 'supplement';
}
export type NewsDailyFilter = 'all' | 'unread' | 'starred' | 'hidden';
/** 每个北京时间日期、每个模块只有一条记录，条目保存当天各批次的去重并集。 */
export interface NewsDailyEdition {
  id: string; date: string; module_id: string; module_name: string;
  summary: string | null; summary_news_ids: number[];
  summary_status: 'ready' | 'pending' | 'stale';
  news_count: number; matching_count: number; unread_count: number;
  starred_count: number; hidden_count: number; revision: number;
  created_at: string; updated_at: string; preview_titles: string[];
}
export interface NewsDailyEditionQuery {
  filter?: NewsDailyFilter; search?: string; limit?: number; offset?: number;
}
export interface NewsDailyEditionDetailQuery extends NewsDailyEditionQuery { id: string; }
export interface NewsDailyEditionPage {
  edition: NewsDailyEdition; items: NewsFeedItem[]; total: number; has_more: boolean;
}
export interface NewsDailyEditionSummaryInput {
  edition_id: string; summary: string; news_ids: number[]; expected_revision: number;
}
export interface NewsTaskDailyEdition {
  edition: NewsDailyEdition;
  news: Array<{ id: number; title: string; summary: string; published_at: string | null; url: string; corrections: NewsCorrection[] }>;
}
export interface NewsTaskContext {
  task: NewsTask; batch_id: string | null; module_id: string | null;
  instructions: string; window_start: string; window_end: string;
  remaining: number; accepted_ids: number[]; excluded_ids: number[];
  config_revision: number | null; learning_epoch: number;
  event_revisions: Record<string, number>;
  interests: NewsTopicInterest[];
  interest_evidence: Array<{ news_id: number; title: string; topic_keys: string[]; signals: string[] }>;
  exploration_seed: { scope: string; basis_module_id?: string } | null;
  candidate_topic: NewsCandidateTopic | null;
  daily_edition?: NewsTaskDailyEdition;
}
export interface NewsFeedPreview { config_revision: number; modules: Array<{ module_id: string; name: string; instructions: string }>; }
